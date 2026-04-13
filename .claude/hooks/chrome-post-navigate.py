#!/usr/bin/env python3
"""
PostToolUse hook: Move chrome-devtools-mcp browser windows to workspace 100+.

Finds all MCP-spawned browser windows (via process tree verification)
and moves any that are NOT already on workspace 100-120.
This ensures both new and existing MCP windows get moved,
while leaving user-opened browsers untouched.
"""

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

TEMP_DIR = Path("/tmp/chrome-mcp-hooks")
WORKSPACE_MIN = 100
WORKSPACE_MAX = 120
WINDOW_APPEAR_DELAY = 0.5  # seconds to wait for window to appear

# Browser window classes to track
BROWSER_CLASSES = ("Chromium", "Google-chrome", "chromium", "google-chrome")

# Process names that indicate a chrome-devtools-mcp-spawned browser
MCP_PROCESS_INDICATORS = ["chrome-devtools", "playwright", "npx", "node", "npm"]


def get_pid_from_window_id(window_id: int) -> Optional[int]:
    """Get PID from X11 window ID using xprop."""
    if not window_id:
        return None
    try:
        result = subprocess.run(
            ["xprop", "-id", str(window_id), "_NET_WM_PID"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and "_NET_WM_PID" in result.stdout:
            # Output: "_NET_WM_PID(CARDINAL) = 12345"
            parts = result.stdout.strip().split("=")
            if len(parts) == 2:
                return int(parts[1].strip())
        return None
    except Exception:
        return None


def get_all_browser_windows() -> list[dict]:
    """Get all Chrome/Chromium windows with their con_id, window ID, PID, and workspace from i3 tree."""
    try:
        result = subprocess.run(
            ["i3-msg", "-t", "get_tree"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return []

        tree = json.loads(result.stdout)
        windows = []

        def find_browsers(node, workspace_num: Optional[int] = None):
            # Track workspace number as we descend
            if node.get("type") == "workspace":
                workspace_num = node.get("num")

            props = node.get("window_properties", {})
            if props.get("class") in BROWSER_CLASSES:
                window_id = node.get("window")
                pid = get_pid_from_window_id(window_id)
                windows.append({
                    "con_id": node.get("id"),
                    "window_id": window_id,
                    "pid": pid,
                    "workspace": workspace_num,
                })
            for child in node.get("nodes", []) + node.get("floating_nodes", []):
                find_browsers(child, workspace_num)

        find_browsers(tree)
        return windows
    except Exception:
        return []


def get_process_ancestors(pid: int) -> list[str]:
    """Get list of process names in the ancestry chain of a PID."""
    ancestors = []
    current_pid = pid

    try:
        while current_pid and current_pid > 1:
            # Get process name
            comm_path = Path(f"/proc/{current_pid}/comm")
            if comm_path.exists():
                ancestors.append(comm_path.read_text().strip().lower())

            # Get parent PID - handle process names with spaces
            stat_path = Path(f"/proc/{current_pid}/stat")
            if stat_path.exists():
                stat_content = stat_path.read_text()
                # PPID is after the closing ) of the process name
                # Format: pid (comm with spaces) state ppid ...
                close_paren = stat_content.rfind(')')
                if close_paren > 0:
                    parts = stat_content[close_paren + 1:].split()
                    # parts[0] = state, parts[1] = ppid
                    current_pid = int(parts[1]) if len(parts) > 1 else 0
                else:
                    break
            else:
                break
    except Exception:
        pass

    return ancestors


def is_mcp_browser(pid: int) -> bool:
    """Check if a Chrome/Chromium process was spawned by chrome-devtools-mcp."""
    if not pid:
        return False

    ancestors = get_process_ancestors(pid)

    # Check if any ancestor is an MCP-related process
    for ancestor in ancestors:
        for indicator in MCP_PROCESS_INDICATORS:
            if indicator in ancestor:
                return True

    return False


def is_on_mcp_workspace(workspace: Optional[int]) -> bool:
    """Check if a workspace number is in the MCP workspace range (100-120)."""
    if workspace is None:
        return False
    return WORKSPACE_MIN <= workspace <= WORKSPACE_MAX


def get_available_workspace() -> int:
    """Find the first available workspace in the 100-120 range."""
    try:
        result = subprocess.run(
            ["i3-msg", "-t", "get_workspaces"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            workspaces = json.loads(result.stdout)
            used = {ws.get("num") for ws in workspaces}
            for num in range(WORKSPACE_MIN, WORKSPACE_MAX + 1):
                if num not in used:
                    return num
        return WORKSPACE_MIN
    except Exception:
        return WORKSPACE_MIN


def get_current_workspace() -> Optional[str]:
    """Get the currently focused workspace name."""
    try:
        result = subprocess.run(
            ["i3-msg", "-t", "get_workspaces"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            for ws in json.loads(result.stdout):
                if ws.get("focused"):
                    return ws.get("name")
        return None
    except Exception:
        return None


def move_container(con_id: int, workspace: int) -> bool:
    """Move a container to specified workspace."""
    try:
        result = subprocess.run(
            ["i3-msg", f"[con_id={con_id}] move container to workspace number {workspace}"],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def focus_workspace(workspace_name: str) -> bool:
    """Focus a workspace by name."""
    try:
        result = subprocess.run(
            ["i3-msg", f'workspace "{workspace_name}"'],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_use_id = hook_input.get("tool_use_id", "unknown")

    # Clean up temp file from pre-hook (if exists)
    temp_file = TEMP_DIR / f"{tool_use_id}.json"
    temp_file.unlink(missing_ok=True)

    # Remember current workspace before any changes
    original_workspace = get_current_workspace()

    # Wait for browser window to appear
    time.sleep(WINDOW_APPEAR_DELAY)

    # Get current browser windows (with PIDs and workspaces)
    current_windows = get_all_browser_windows()

    # Find MCP browser windows that are NOT already on workspace 100+
    windows_to_move = []
    for window in current_windows:
        # Skip windows already on MCP workspace (100-120)
        if is_on_mcp_workspace(window.get("workspace")):
            continue
        # Only move windows that are MCP-spawned (not user-opened browsers)
        if is_mcp_browser(window["pid"]):
            windows_to_move.append(window["con_id"])

    if not windows_to_move:
        sys.exit(0)

    # Move MCP windows to available workspace in 100-120 range
    target_ws = get_available_workspace()
    for con_id in windows_to_move:
        move_container(con_id, target_ws)

    # Return focus to original workspace
    if original_workspace:
        focus_workspace(original_workspace)

    sys.exit(0)


if __name__ == "__main__":
    main()
