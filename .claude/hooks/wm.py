#!/usr/bin/env python3
"""Window-manager abstraction shared by the Playwright hooks.

Two backends behind one surface:

  i3 (Linux)     parks windows on a throwaway workspace in the 100-120 range;
                 i3 discards those workspaces on its own once they empty out.
  yabai (macOS)  parks windows on a space labelled `playwright`, created on
                 demand and destroyed at session end if this module created it.

Every entry point degrades to a no-op when the window manager is absent or
unreachable, so a hook can never fail the tool call it is attached to.

macOS caveat: moving a window between spaces requires yabai's scripting
addition. When the SA is not loaded, yabai still exits 0 and silently does
nothing -- so `park()` re-queries and reports which windows did not land. The
caller stashes those with `stash()` (float + refocus) instead, which keeps the
window compositing and therefore keeps Playwright screencasts working.
"""

import json
import os
import platform
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path
from typing import Any

STATE_DIR = Path(tempfile.gettempdir()) / "playwright-hooks"
SCRATCH_STATE = STATE_DIR / "scratch-space.json"

# Window classes (i3) / application names (yabai), compared lowercased. Both
# spellings of each browser are listed because the two window managers report
# different strings: i3 exposes the X11 WM_CLASS ("Google-chrome"), yabai the
# macOS application name ("Google Chrome"). Playwright ships its headed browser
# as "Google Chrome for Testing" on macOS, which is what actually shows up when
# the MCP server launches one.
BROWSER_APPS = frozenset(
    {
        "chromium",
        "chromium-browser",
        "chrome",
        "google-chrome",
        "google chrome",
        "chrome for testing",
        "google-chrome-for-testing",
        "google chrome for testing",
        "chrome canary",
        "google chrome canary",
        "electron",
    }
)

# A browser whose process ancestry contains one of these was spawned by the
# Playwright MCP server rather than opened by hand.
PLAYWRIGHT_ANCESTORS = ("playwright", "npx", "node", "npm")

# Ancestry stops being usable the moment the MCP server exits: the browser is
# reparented to init/launchd and looks user-opened. Playwright's own browser
# builds live under a `ms-playwright` cache directory and its throwaway
# profiles are named `playwright_*`, both of which survive reparenting -- so the
# command line is checked as a second, orphan-proof signal. Deliberately narrow:
# a bare "playwright" would also match a user browsing playwright.dev, and this
# predicate decides what the cleanup hook is allowed to close.
PLAYWRIGHT_COMMAND_MARKERS = ("ms-playwright", "playwright_", "playwright-core")

I3_SCRATCH_MIN = 100
I3_SCRATCH_MAX = 120

YABAI_SCRATCH_LABEL = "playwright"
YABAI_ADOPTABLE_LABELS = frozenset({"playwright", "claude", "scratch"})


# --------------------------------------------------------------------------
# process helpers
# --------------------------------------------------------------------------


def run(cmd: list[str], timeout: int = 5) -> str | None:
    """Run a command; return stdout on success, None on any failure."""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    return result.stdout if result.returncode == 0 else None


def run_json(cmd: list[str], timeout: int = 5) -> Any:
    """Run a command expected to emit JSON; return None if it does not."""
    out = run(cmd, timeout)
    if out is None:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def _ancestors_linux(pid: int) -> list[str]:
    """Walk /proc to collect the process-name chain above `pid`."""
    names: list[str] = []
    while pid and pid > 1:
        try:
            names.append(Path(f"/proc/{pid}/comm").read_text().strip().lower())
            stat = Path(f"/proc/{pid}/stat").read_text()
            # Format: pid (comm may contain spaces) state ppid ...
            close_paren = stat.rfind(")")
            if close_paren < 0:
                break
            fields = stat[close_paren + 1 :].split()
            pid = int(fields[1]) if len(fields) > 1 else 0
        except Exception:
            break
    return names


_PROCESS_TABLE: dict[int, tuple[int, str]] | None = None


def _process_table() -> dict[int, tuple[int, str]]:
    """pid -> (ppid, executable basename). macOS has no /proc, so shell out once."""
    global _PROCESS_TABLE
    if _PROCESS_TABLE is not None:
        return _PROCESS_TABLE

    _PROCESS_TABLE = {}
    for line in (run(["ps", "-axo", "pid=,ppid=,comm="]) or "").splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        # `comm` is a full path here; reduce to a basename so it matches the
        # short names /proc/<pid>/comm reports on Linux.
        _PROCESS_TABLE[pid] = (ppid, Path(parts[2]).name.lower())
    return _PROCESS_TABLE


def _ancestors_darwin(pid: int) -> list[str]:
    table = _process_table()
    names: list[str] = []
    seen: set[int] = set()
    while pid and pid > 1 and pid not in seen:
        seen.add(pid)
        entry = table.get(pid)
        if entry is None:
            break
        pid, name = entry[0], entry[1]
        names.append(name)
    return names


def _command_line(pid: int) -> str:
    """Full argv of a process, lowercased; empty string when unreadable."""
    if platform.system() == "Darwin":
        return (run(["ps", "-p", str(pid), "-o", "command="]) or "").strip().lower()
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except Exception:
        return ""
    return raw.replace(b"\0", b" ").decode("utf-8", "replace").strip().lower()


def is_playwright_browser(pid: int | None) -> bool:
    """True when this browser was spawned by Playwright rather than by the user."""
    if not pid:
        return False

    if any(marker in _command_line(pid) for marker in PLAYWRIGHT_COMMAND_MARKERS):
        return True

    ancestors = _ancestors_darwin(pid) if platform.system() == "Darwin" else _ancestors_linux(pid)
    return any(indicator in name for name in ancestors for indicator in PLAYWRIGHT_ANCESTORS)


# --------------------------------------------------------------------------
# backends
# --------------------------------------------------------------------------


class WindowManager:
    """Common surface. A window is a dict: {id, pid, workspace, app}."""

    name = "none"

    def browser_windows(self) -> list[dict]:
        return []

    def focus_token(self) -> Any:
        """Opaque handle for whatever had focus before we started moving things."""
        return None

    def restore_focus(self, token: Any) -> None:
        pass

    def scratch(self) -> Any:
        """Workspace/space to park on, creating it if needed. None if unavailable."""
        return None

    def is_scratch(self, workspace: Any) -> bool:
        return False

    def park(self, windows: list[dict], scratch: Any) -> list[dict]:
        """Move windows to `scratch`; return the ones that did not land there."""
        return windows

    def stash(self, window: dict) -> None:
        """Fallback for windows that could not be parked."""

    def close(self, window: dict) -> None:
        pass

    def release_scratch(self) -> None:
        """Give back the scratch workspace if this module created it."""


class I3(WindowManager):
    name = "i3"

    def browser_windows(self) -> list[dict]:
        tree = run_json(["i3-msg", "-t", "get_tree"])
        if tree is None:
            return []

        windows: list[dict] = []

        def walk(node: dict, workspace: int | None) -> None:
            if node.get("type") == "workspace":
                workspace = node.get("num")
            app = (node.get("window_properties", {}).get("class") or "").lower()
            if app in BROWSER_APPS:
                windows.append(
                    {
                        "id": node.get("id"),
                        "pid": self._pid(node.get("window")),
                        "workspace": workspace,
                        "app": app,
                    }
                )
            for child in node.get("nodes", []) + node.get("floating_nodes", []):
                walk(child, workspace)

        walk(tree, None)
        return windows

    @staticmethod
    def _pid(window_id: int | None) -> int | None:
        """X11 windows do not carry their PID in the i3 tree; ask xprop."""
        if not window_id:
            return None
        out = run(["xprop", "-id", str(window_id), "_NET_WM_PID"]) or ""
        if "_NET_WM_PID" not in out:
            return None
        parts = out.strip().split("=")
        try:
            return int(parts[1].strip()) if len(parts) == 2 else None
        except ValueError:
            return None

    def _workspaces(self) -> list[dict]:
        return run_json(["i3-msg", "-t", "get_workspaces"]) or []

    def focus_token(self) -> str | None:
        for workspace in self._workspaces():
            if workspace.get("focused"):
                return workspace.get("name")
        return None

    def restore_focus(self, token: Any) -> None:
        if token:
            run(["i3-msg", f'workspace "{token}"'])

    def scratch(self) -> int:
        used = {ws.get("num") for ws in self._workspaces()}
        for num in range(I3_SCRATCH_MIN, I3_SCRATCH_MAX + 1):
            if num not in used:
                return num
        return I3_SCRATCH_MIN

    def is_scratch(self, workspace: Any) -> bool:
        return workspace is not None and I3_SCRATCH_MIN <= workspace <= I3_SCRATCH_MAX

    def park(self, windows: list[dict], scratch: Any) -> list[dict]:
        failed = []
        for window in windows:
            moved = run(
                [
                    "i3-msg",
                    f"[con_id={window['id']}] move container to workspace number {scratch}",
                ]
            )
            if moved is None:
                failed.append(window)
        return failed

    def close(self, window: dict) -> None:
        run(["i3-msg", f"[con_id={window['id']}] kill"])


class Yabai(WindowManager):
    name = "yabai"

    def __init__(self) -> None:
        # Space indices shift whenever spaces are added or removed, so the
        # scratch space is remembered by uuid and resolved to an index once.
        self._index: int | None = None
        self._resolved = False

    def browser_windows(self) -> list[dict]:
        windows = run_json(["yabai", "-m", "query", "--windows"]) or []
        return [
            {
                "id": w.get("id"),
                "pid": w.get("pid"),
                "workspace": w.get("space"),
                "app": (w.get("app") or "").lower(),
                "floating": w.get("is-floating", False),
            }
            for w in windows
            if (w.get("app") or "").lower() in BROWSER_APPS
        ]

    @staticmethod
    def _spaces() -> list[dict]:
        return run_json(["yabai", "-m", "query", "--spaces"]) or []

    def focus_token(self) -> int | None:
        window = run_json(["yabai", "-m", "query", "--windows", "--window"])
        return window.get("id") if isinstance(window, dict) else None

    def restore_focus(self, token: Any) -> None:
        if token:
            run(["yabai", "-m", "window", str(token), "--focus"])

    def _remembered_index(self) -> int | None:
        """Resolve the previously recorded scratch space to a current index."""
        if self._resolved:
            return self._index

        self._resolved = True
        state = self._read_state()
        if state:
            for space in self._spaces():
                if space.get("uuid") == state.get("uuid"):
                    self._index = space.get("index")
                    break
        return self._index

    def scratch(self) -> int | None:
        """Index of the scratch space -- remembered, adopted, or freshly created."""
        remembered = self._remembered_index()
        if remembered is not None:
            return remembered

        spaces = self._spaces()
        for space in spaces:
            if (space.get("label") or "") in YABAI_ADOPTABLE_LABELS:
                self._adopt(space, created=False)
                return self._index

        return self._create_scratch({s.get("uuid") for s in spaces})

    def _create_scratch(self, known_uuids: set) -> int | None:
        """Create + label a space. Returns None when the SA is not loaded.

        `space --create` exits 0 even without the scripting addition, so the
        only reliable signal is a new uuid showing up in a fresh query.
        """
        run(["yabai", "-m", "space", "--create"])
        created = [s for s in self._spaces() if s.get("uuid") not in known_uuids]
        if not created:
            return None

        space = created[0]
        run(["yabai", "-m", "space", str(space.get("index")), "--label", YABAI_SCRATCH_LABEL])
        self._adopt(space, created=True)
        return self._index

    def _adopt(self, space: dict, created: bool) -> None:
        self._index = space.get("index")
        self._resolved = True
        self._write_state(space.get("uuid"), created=created)

    def is_scratch(self, workspace: Any) -> bool:
        remembered = self._remembered_index()
        return remembered is not None and workspace == remembered

    def park(self, windows: list[dict], scratch: Any) -> list[dict]:
        for window in windows:
            run(["yabai", "-m", "window", str(window["id"]), "--space", str(scratch)])

        landed = {w["id"] for w in self.browser_windows() if w["workspace"] == scratch}
        return [w for w in windows if w["id"] not in landed]

    def stash(self, window: dict) -> None:
        """Float the window so it stops disturbing the bsp layout."""
        if not window.get("floating"):
            run(["yabai", "-m", "window", str(window["id"]), "--toggle", "float"])

    def close(self, window: dict) -> None:
        """Close the window, then end the process behind it.

        macOS apps outlive their last window, so `--close` alone leaves an
        orphaned headless-ish browser running. Destroying an X11 client on i3
        takes the browser with it, so terminating here restores parity. Safe
        because ownership was already proven through the process ancestry.
        """
        run(["yabai", "-m", "window", str(window["id"]), "--close"])
        pid = window.get("pid")
        if not pid:
            return
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

    def release_scratch(self) -> None:
        state = self._read_state()
        SCRATCH_STATE.unlink(missing_ok=True)
        if not state or not state.get("created"):
            return
        for space in self._spaces():
            if space.get("uuid") == state.get("uuid") and not space.get("windows"):
                run(["yabai", "-m", "space", str(space.get("index")), "--destroy"])
                return

    @staticmethod
    def _read_state() -> dict | None:
        try:
            return json.loads(SCRATCH_STATE.read_text())
        except Exception:
            return None

    @staticmethod
    def _write_state(uuid: str | None, created: bool) -> None:
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            SCRATCH_STATE.write_text(json.dumps({"uuid": uuid, "created": created}))
        except Exception:
            pass


def detect() -> WindowManager:
    """Pick the backend for this machine; a no-op manager if neither is usable."""
    if platform.system() == "Darwin":
        if shutil.which("yabai") and run_json(["yabai", "-m", "query", "--spaces"]):
            return Yabai()
    elif shutil.which("i3-msg") and run_json(["i3-msg", "-t", "get_workspaces"]):
        return I3()
    return WindowManager()
