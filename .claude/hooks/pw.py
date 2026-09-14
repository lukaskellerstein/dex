#!/usr/bin/env python3
"""Shared library for the Playwright hooks. yabai/macOS only.

The design rests on three principles, each replacing a piece of runtime state
that used to break on every reboot or yabai restart (measured repeatedly,
2026-08-18 .. 2026-08-30):

  1. THE TEST DESKTOP IS PERMANENT. A desktop labelled `playwright` is declared
     in yabai's own config (mac-setup modules/yabai — yabairc runs
     playwright_space.sh on every start). Hooks only READ the label; the one
     mutation they may make is re-running that same script when the desktop was
     destroyed mid-session. No uuid file in $TMPDIR, nothing to lose.

  2. THE LAUNCH IDENTIFIES THE WINDOW, NOT ITS NAME. The machine's yabai
     signal (mac-setup modules/yabai/pw_route.sh) decides ownership from the
     process tree at the moment a window is born -- a supported agent process
     above it -- and records the pid in a registry (AGENT_PIDS) so the proof
     outlives the launcher. No app name is matched: rex packaged its app,
     macOS called it `REX` instead of `Electron`, and every name-based
     matcher let the window land on the user's desktop (2026-09-07). The two
     permanent yabai rules (Playwright's browser builds by name, agent-mode
     apps by the ` [agent]` title tag an app adds when PW_AGENT=1 is set)
     remain as the fast path that places a window before it is drawn.

  3. OWNERSHIP IS READ FROM THE RUNNING APP, NOT FROM `ps`, wherever the app
     can say. An app in agent mode appends `pw-agent` to its user agent,
     which `/json/version` on its CDP port reports. That answer survives
     reparenting, backgrounding and reboots, because it comes from the
     instance itself. The registry is the same durability for apps with no
     agent mode; live ancestry is the fallback for both.

What this file still guards, and with which grain:

  - MOVE (`is_agent_browser`): the park-fallback for a window an agent
    launched bare, outside the wrapper. Claude or Codex ancestry, or a listener
    whose CDP endpoint carries the agent marker. Deliberately NOT argv
    markers and NOT "some MCP server claims this port" — both fit the USER's
    own window (their npm-launched app answers on the very port an MCP server
    attaches to; that exact false positive parked the user's window, measured
    in rex 2026-08-30).
  - DRIVE (`agent_owns_port`): the PreToolUse gate. Every listener on the port
    must be an agent instance (marker) or descend from a supported agent;
    otherwise the instance is the user's and the call is denied until they
    consent.
  - CLOSE (cleanup hook): argv automation markers or the `[agent]` title tag,
    AND descent from this session's agent process or proven abandonment.
    Ancestry alone cannot close — by session end launchd has reparented the
    tree — and several sessions share this desktop, so anything looser has
    closed another session's browser (measured 2026-08-18).

Every entry point degrades to a no-op when yabai is unreachable, so a hook can
never fail the tool call it is attached to.
"""

import json
import os
import platform
import re
import signal
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

# Consent grants (one file per port+session) are the ONLY state left here.
STATE_DIR = Path(tempfile.gettempdir()) / "playwright-hooks"

SCRATCH_LABEL = "playwright"

# The machine-level script that declares the desktop and its placement rules.
# Lives in mac-setup's yabai module, symlinked to ~/.config/yabai — the same
# file yabairc runs on every start, so a hook re-running it can never disagree
# with the config.
PLAYWRIGHT_SPACE_SH = Path.home() / ".config" / "yabai" / "playwright_space.sh"

# The two halves of "the window declares itself". The title tag is what the
# claude-pw-agent yabai rule matches; the UA marker is what /json/version
# reports. An app honouring PW_AGENT=1 must carry both (contract:
# mac-setup projects/claude-code.md § The agent window contract).
AGENT_TITLE_TAG = "[agent]"
AGENT_UA_MARKER = "pw-agent"

# The machine's registry of proven agent pids, written by the yabai signal the
# moment ancestry proves a window (mac-setup modules/yabai/pw_common.sh,
# PW_PIDS). One `<pid>\t<ps lstart>` per line; the start time is what makes a
# recycled pid harmless. Read-only here.
AGENT_PIDS = Path.home() / ".local" / "state" / "yabai" / "pw-agent-pids"

# The machine's placement authority, runnable with a window id. Used by the
# park-fallback so a hook and the signal can never disagree on where a window
# belongs.
PW_ROUTE_SH = Path.home() / ".config" / "yabai" / "pw_route.sh"

# The labels of the desktops agent windows live on: the shared one, and
# `pw:<project>` for a project with a desktop of its own.
PROJECT_LABEL_PREFIX = "pw:"

# App names (lowercased) a Claude-driven browser can appear under WITHOUT the
# machine having proved it: Playwright's own builds, which the user never runs
# (the MCP is pinned to --browser chromium for exactly that), plus a dev-mode
# Electron. These are only candidates -- nothing in this file moves or closes
# one without the agent tag, the marker, the registry, or a proven ancestry.
# A registered pid is a candidate whatever its app is called.
BROWSER_APPS = frozenset({"chromium", "chrome for testing", "google chrome for testing", "electron"})

# Argv markers that survive reparenting. Playwright's browsers live under an
# ms-playwright cache with playwright_* profiles.
PLAYWRIGHT_COMMAND_MARKERS = ("ms-playwright", "playwright_", "playwright-core")
ATTACHED_COMMAND_MARKERS = ("--remote-debugging-port",)

# Claude Code and Codex process names/install paths. Some versioned binaries
# report a version as their process name, so command paths are checked too.
AGENT_PROCESS_NAMES = frozenset({"claude", "codex"})
AGENT_PROCESS_MARKERS = (
    ".local/share/claude/",
    "claudecode.app",
    "/bin/claude",
    "/bin/codex",
    "/@openai/codex/",
    "/openai/codex/",
    "codex.app",
    "chatgpt.app",
)

# Roots that mean a process tree still belongs to somebody (terminal,
# multiplexer, Claude itself). Anything else at the root of a launchd-adopted
# chain is a dev server whose starter has exited.
SESSION_ROOTS = frozenset(
    {
        "tmux",
        "screen",
        "zellij",
        "ghostty",
        "iterm2",
        "terminal",
        "alacritty",
        "kitty",
        "wezterm",
        "warp",
        "login",
        "sshd",
        "claude",
        "codex",
        "chatgpt",
    }
)

CDP_ENDPOINT_RE = re.compile(r"--cdp-endpoint[=\s]\S*?:(\d{2,5})\b")
DEBUG_PORT_RE = re.compile(r"--remote-debugging-port[=\s](\d{2,5})\b")

_HOOK_WRAPPERS = ("python", "sh", "bash", "zsh", "dash", "env")


# --------------------------------------------------------------------------
# process helpers
# --------------------------------------------------------------------------


def run(cmd, timeout=5):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None
    return result.stdout if result.returncode == 0 else None


def run_json(cmd, timeout=5):
    out = run(cmd, timeout)
    try:
        return json.loads(out) if out is not None else None
    except Exception:
        return None


_PROCESS_TABLE = None
_COMMAND_LINES = {}


def _process_table():
    """pid -> (ppid, basename). macOS has no /proc, so one ps sweep, memoised."""
    global _PROCESS_TABLE
    if _PROCESS_TABLE is None:
        _PROCESS_TABLE = {}
        for line in (run(["ps", "-axo", "pid=,ppid=,comm="]) or "").splitlines():
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            try:
                _PROCESS_TABLE[int(parts[0])] = (int(parts[1]), Path(parts[2]).name.lower())
            except ValueError:
                continue
    return _PROCESS_TABLE


def forget_processes():
    """Drop the ps caches — required across any wait for a new process."""
    global _PROCESS_TABLE
    _PROCESS_TABLE = None
    _COMMAND_LINES.clear()


def _command_line(pid):
    if pid not in _COMMAND_LINES:
        _COMMAND_LINES[pid] = (run(["ps", "-p", str(pid), "-o", "command="]) or "").strip().lower()
    return _COMMAND_LINES[pid]


def _process_name(pid):
    entry = _process_table().get(pid)
    return entry[1] if entry else ""


def _ancestor_pids(pid):
    """Chain above pid, nearest first, stopping short of launchd."""
    chain, seen = [], set()
    entry = _process_table().get(pid)
    parent = entry[0] if entry else None
    while parent and parent > 1 and parent not in seen:
        seen.add(parent)
        chain.append(parent)
        entry = _process_table().get(parent)
        parent = entry[0] if entry else None
    return chain


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def session_pid():
    """The Claude Code or Codex process this hook runs under.

    Found by position (the first non-shell/interpreter ancestor), so it holds
    for any binary name.
    """
    for pid in _ancestor_pids(os.getpid()):
        name = _process_name(pid).lstrip("-")
        if not name.startswith(_HOOK_WRAPPERS):
            return pid
    return None


def _is_agent_process(pid):
    if (_process_name(pid).split(None, 1)[:1] or [""])[0] in AGENT_PROCESS_NAMES:
        return True
    command = _command_line(pid)
    return any(marker in command for marker in AGENT_PROCESS_MARKERS)


def is_owned_by(pid, session):
    return bool(pid and session and session in _ancestor_pids(pid))


def _start_time(pid):
    """`ps lstart` of a live process, or "" -- the same string the machine
    side stores next to the pid, compared verbatim."""
    return (run(["ps", "-o", "lstart=", "-p", str(pid)]) or "").strip()


_REGISTRY = None


def registered_agent_pid(pid):
    """The machine proved this pid at a window's birth (ancestry under a Claude
    process) and it is still that same process. Survives reparenting, which is
    what ancestry alone cannot do."""
    global _REGISTRY
    if not pid:
        return False
    if _REGISTRY is None:
        _REGISTRY = {}
        try:
            for line in AGENT_PIDS.read_text().splitlines():
                parts = line.split("\t", 1)
                if len(parts) == 2 and parts[0].isdigit():
                    _REGISTRY[int(parts[0])] = parts[1].strip()
        except Exception:
            pass
    start = _REGISTRY.get(pid)
    return bool(start) and _start_time(pid) == start


def was_automated(pid):
    """Argv says this was started under automation. Half of the close-path
    grain; the cleanup hook also accepts the `[agent]` title tag, because an
    app that sets its own debugging port from inside the main process shows
    neither marker in argv."""
    if not pid:
        return False
    command = _command_line(pid)
    return any(m in command for m in PLAYWRIGHT_COMMAND_MARKERS + ATTACHED_COMMAND_MARKERS)


def _has_living_owner(pid):
    """The tree above pid is still rooted in something that owns it."""
    chain = _ancestor_pids(pid)
    if not chain:
        return False
    if any(_is_agent_process(a) for a in chain):
        return True
    name = _process_name(chain[-1])
    if name.startswith("-"):  # a login shell — someone is sitting at it
        return True
    return (name.split(None, 1)[:1] or [""])[0] in SESSION_ROOTS


def claimed_cdp_ports():
    """Ports a live MCP server is attached to (--cdp-endpoint on its argv)."""
    ports = set()
    for line in (run(["ps", "-axo", "command="]) or "").splitlines():
        for match in CDP_ENDPOINT_RE.finditer(line):
            ports.add(int(match.group(1)))
    return ports


def listener_pids(port):
    out = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"]) or ""
    return {int(t) for t in out.split() if t.isdigit()}


def _listen_ports_of(pid):
    """TCP ports `pid` listens on. Electron sets its debugging port from inside
    the main process, so argv is silent and the OS is the only witness."""
    out = run(["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"]) or ""
    ports = set()
    for token in out.split():
        match = re.search(r":(\d{2,5})$", token)
        if match:
            ports.add(int(match.group(1)))
    return ports


def _driven_by_live_session(pid):
    """A live MCP server is attached to a port this process serves."""
    ports = claimed_cdp_ports()
    if not ports:
        return False
    match = DEBUG_PORT_RE.search(_command_line(pid))
    if match:
        return int(match.group(1)) in ports
    return bool(_listen_ports_of(pid) & ports)


# --------------------------------------------------------------------------
# the agent marker — principle 3
# --------------------------------------------------------------------------


_AGENT_PORTS = {}


def agent_instance(port):
    """Ask the instance on `port` who it is.

    True: /json/version answered and the user agent carries the marker — an
    agent-mode instance, whoever launched the process. False: it answered
    without the marker — the user's instance. None: no answer, no claim either
    way (the caller falls back to ancestry).
    """
    if port not in _AGENT_PORTS:
        answer = None
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/json/version", timeout=2) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            answer = AGENT_UA_MARKER in (data.get("User-Agent") or "").lower()
        except Exception:
            answer = None
        _AGENT_PORTS[port] = answer
    return _AGENT_PORTS[port]


def is_agent_browser(pid):
    """A Claude or Codex session launched this window, or it is agent-mode.
    The MOVE grain — the park-fallback for a window launched bare, outside the
    wrapper. Narrow enough that a user-opened window can never satisfy it:
    ancestry, or the instance's own marker. Never argv, never a bare port
    claim (see the module docstring for the measured false positive)."""
    if not pid:
        return False
    if registered_agent_pid(pid):
        return True
    if any(_is_agent_process(a) for a in _ancestor_pids(pid)):
        return True
    return any(agent_instance(port) for port in _listen_ports_of(pid))


def is_abandoned(pid):
    """Nothing above it still holding it, nothing driving it. The caller has
    already established the window was automated — this is only the second and
    third gate of the close path."""
    return not _has_living_owner(pid) and not _driven_by_live_session(pid)


# --------------------------------------------------------------------------
# yabai
# --------------------------------------------------------------------------


def yabai(*args):
    return run(["yabai", "-m", *args])


def yabai_json(*args):
    return run_json(["yabai", "-m", *args])


def yabai_ok():
    return platform.system() == "Darwin" and yabai_json("query", "--spaces") is not None


def spaces():
    return yabai_json("query", "--spaces") or []


def browser_windows():
    """Candidate agent windows: Playwright's builds and dev Electron by name,
    plus any window whose pid the machine has proved -- so a packaged app
    under its own bundle name is a candidate too."""
    return [
        {
            "id": w.get("id"),
            "pid": w.get("pid"),
            "space": w.get("space"),
            "app": (w.get("app") or "").lower(),
            "title": w.get("title") or "",
        }
        for w in (yabai_json("query", "--windows") or [])
        if (w.get("app") or "").lower() in BROWSER_APPS or registered_agent_pid(w.get("pid"))
    ]


def current_space_index():
    space = yabai_json("query", "--spaces", "--space")
    return space.get("index") if isinstance(space, dict) else None


def agent_space_indices():
    """Indices of every desktop an agent window may live on: the shared
    `playwright` one and each `pw:<project>` one."""
    return {
        s.get("index")
        for s in spaces()
        if (s.get("label") or "") == SCRATCH_LABEL or (s.get("label") or "").startswith(PROJECT_LABEL_PREFIX)
    }


def window_space_label(window_id):
    """Label of the desktop the window is on ("" when unlabelled or gone)."""
    window = yabai_json("query", "--windows", "--window", str(window_id))
    if not isinstance(window, dict):
        return ""
    for s in spaces():
        if s.get("index") == window.get("space"):
            return s.get("label") or ""
    return ""


def route(window_id):
    """Hand a window to the machine's placement authority -- the same script
    the yabai signal runs -- so a hook never has to know which desktop is the
    right one. Falls back to the shared desktop where the machine module is
    missing."""
    if PW_ROUTE_SH.exists():
        run([str(PW_ROUTE_SH), str(window_id)], timeout=15)
        if window_space_label(window_id):
            return
    index = scratch_index() or ensure_scratch()
    if index is not None:
        park(window_id, index)


def _is_real_window(w):
    """AXStandardWindow and not sticky — same test the sketchybar plugins use."""
    return w.get("subrole") == "AXStandardWindow" and not w.get("is-sticky")


def scratch_index():
    """Index of the permanent `playwright` desktop. Read-only — the desktop is
    declared in yabai's config, not created here. None when it is missing
    (destroyed mid-session, or a machine without the yabai module)."""
    for space in spaces():
        if (space.get("label") or "") == SCRATCH_LABEL:
            return space.get("index")
    return None


def ensure_scratch():
    """Re-establish the desktop and its rules by running the SAME script the
    yabai config runs on every start — the one sanctioned mutation, and it
    cannot disagree with the config because it IS the config."""
    if PLAYWRIGHT_SPACE_SH.exists():
        run([str(PLAYWRIGHT_SPACE_SH)], timeout=10)
    return scratch_index()


def check():
    """Everything placement depends on, as a list of problems (empty = ok).

    Loud beats silent: the old design failed by quietly landing windows on the
    user's desktop; this is the check that turns that into a message at
    session start instead.
    """
    if platform.system() != "Darwin":
        return []
    if not yabai_ok():
        return ["yabai is not reachable — no window placement at all; agent windows will open on the user's desktop"]

    problems = []
    index = scratch_index()
    if index is None:
        problems.append(
            f"no desktop labelled '{SCRATCH_LABEL}' — run {PLAYWRIGHT_SPACE_SH} (the pre-hook also recreates it)"
        )
    if not PLAYWRIGHT_SPACE_SH.exists():
        problems.append(f"{PLAYWRIGHT_SPACE_SH} is missing — this machine's yabai module is not installed")

    rules = {r.get("label"): r for r in yabai_json("rule", "--list") or []}
    for label in ("claude-pw-browsers", "claude-pw-agent"):
        rule = rules.get(label)
        if rule is None:
            problems.append(f"placement rule {label} is missing — run {PLAYWRIGHT_SPACE_SH}")
        elif index is not None and rule.get("space") != index:
            problems.append(
                f"placement rule {label} aims at space {rule.get('space')}, not the "
                f"'{SCRATCH_LABEL}' desktop (space {index}) — run {PLAYWRIGHT_SPACE_SH}"
            )
    return problems


def park(window_id, space):
    yabai("window", str(window_id), "--space", str(space))


def close_window(window):
    """Close the window, then end the process — macOS apps outlive their last
    window, and --close alone leaves a headless browser running."""
    yabai("window", str(window["id"]), "--close")
    pid = window.get("pid")
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass


# --------------------------------------------------------------------------
# CDP ownership (requirement: never drive a user-started instance unasked)
# --------------------------------------------------------------------------


def cdp_port(project_dir):
    """The configured --cdp-endpoint port for Claude Code or Codex."""
    try:
        config = json.loads((Path(project_dir) / ".mcp.json").read_text())
    except Exception:
        config = {}
    for server in (config.get("mcpServers") or {}).values():
        for arg in server.get("args") or []:
            match = CDP_ENDPOINT_RE.search(str(arg).lower())
            if match:
                return int(match.group(1))

    # Codex keeps project MCP servers in .codex/config.toml. Use tomllib where
    # available, with a narrow text fallback for the stock macOS Python.
    codex_config = Path(project_dir) / ".codex" / "config.toml"
    try:
        import tomllib

        parsed = tomllib.loads(codex_config.read_text())
        for server in (parsed.get("mcp_servers") or {}).values():
            for arg in server.get("args") or []:
                match = CDP_ENDPOINT_RE.search(str(arg).lower())
                if match:
                    return int(match.group(1))
    except Exception:
        try:
            match = CDP_ENDPOINT_RE.search(codex_config.read_text().lower())
            if match:
                return int(match.group(1))
        except Exception:
            pass
    return None


def consent_path(port):
    return STATE_DIR / f"consent-{port}-{session_pid()}"


def agent_owns_port(port):
    """Every listener on `port` was started under agent control.

    The instance's own marker settles it first — an agent-mode app says so on
    /json/version, whoever forked whom. Ancestry is the fallback for apps with
    no agent mode (a plain Chromium an agent script launched). An empty port is
    ownable — the agent will launch its own instance. Argv automation markers
    are deliberately NOT accepted: the user's own Playwright-launched browser
    carries them too, and this gate is what keeps the agent out of it.
    """
    listeners = listener_pids(port)
    if not listeners:
        return True
    if agent_instance(port):
        return True
    return all(any(_is_agent_process(a) for a in _ancestor_pids(pid)) for pid in listeners)


# --------------------------------------------------------------------------
# CLI — used by playwright-launch.sh so the shell script stays bash-3.2 trivial
# --------------------------------------------------------------------------


def _cli(argv):
    cmd = argv[0] if argv else ""
    if cmd == "check":
        problems = check()
        for problem in problems:
            print(problem)
        if problems:
            sys.exit(1)
        print(f"ok — agent windows are born on the '{SCRATCH_LABEL}' desktop (space {scratch_index()})")
    elif cmd == "current-space":
        print(current_space_index() or "")
    elif cmd == "ensure-scratch":
        index = ensure_scratch()
        if index is None:
            sys.exit(1)
        print(index)
    elif cmd == "cdp-port":  # the project's configured --cdp-endpoint port
        root = os.environ.get("CODEX_PROJECT_DIR") or os.environ.get("CLAUDE_PROJECT_DIR") or "."
        port = cdp_port(root)
        print(port if port is not None else "")
    elif cmd == "list-windows":  # list-windows → every window id, comma-separated
        print(",".join(str(w.get("id")) for w in yabai_json("query", "--windows") or []))
    elif cmd == "wait-window":
        # wait-window <timeout_s> <exclude_ids_csv> <owner_pid>
        # A window counts only if it did not exist before the launch AND its
        # process is, or descends from, the launched pid. Nothing about the app
        # name is asked: descent is the proof, and a user's own window of the
        # same app can never satisfy it.
        import time

        deadline = time.time() + float(argv[1])
        exclude = {int(t) for t in (argv[2] if len(argv) > 2 else "").split(",") if t}
        owner = int(argv[3]) if len(argv) > 3 and argv[3] else None
        while time.time() < deadline:
            forget_processes()
            for w in yabai_json("query", "--windows") or []:
                if not _is_real_window(w):
                    continue
                if w.get("id") in exclude:
                    continue
                pid = w.get("pid")
                if owner and not (pid == owner or owner in _ancestor_pids(pid)):
                    continue
                print(f"{w.get('id')} {w.get('space')}")
                return
            time.sleep(0.3)
        sys.exit(1)
    elif cmd == "window-space":  # window-space <id> → the space the window is on
        window = yabai_json("query", "--windows", "--window", argv[1])
        print(window.get("space", "") if isinstance(window, dict) else "")
    elif cmd == "window-label":  # window-label <id> → label of its desktop, "" if none
        print(window_space_label(argv[1]))
    elif cmd == "route":  # route <window_id> — the machine decides the desktop
        route(argv[1])
    elif cmd == "park":  # park <window_id> — the shared desktop, by hand
        index = scratch_index() or ensure_scratch()
        if index is None:
            sys.exit(1)
        park(argv[1], index)
    elif cmd == "focus-space":  # focus-space <index>
        yabai("space", argv[1], "--focus")
    elif cmd == "owns-port":  # owns-port <port> — exit 1 if the instance is the user's
        port = int(argv[1])
        if agent_owns_port(port) or consent_path(port).exists():
            print(f"ok: the instance on port {port} is agent-started (or consented)")
        else:
            sys.exit(
                f"DENIED: the instance on CDP port {port} was started by the user. "
                "Do not attach to it — by MCP tool, script, or raw CDP. Start your "
                "own via the repo's playwright-launch.sh hook, or ask the user first."
            )
    else:
        sys.exit(f"unknown command: {cmd!r}")


if __name__ == "__main__":
    if not yabai_ok():
        sys.exit(0)
    _cli(sys.argv[1:])
