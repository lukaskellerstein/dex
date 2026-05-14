#!/usr/bin/env python3
"""
SessionEnd hook: Close all Playwright browser windows.

Finds all Playwright-spawned browser windows (via process tree verification)
and closes them. User-opened browsers are left untouched.
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

# Browser window classes to track
BROWSER_CLASSES = ("Chromium", "Google-chrome", "chromium", "google-chrome", "Electron")

# Process names that indicate a Playwright-spawned browser
PLAYWRIGHT_PROCESS_INDICATORS = ["playwright", "npx", "node", "npm"]


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
            parts = result.stdout.strip().split("=")
            if len(parts) == 2:
                return int(parts[1].strip())
        return None
    except Exception:
        return None


def get_all_browser_windows() -> list[dict]:
    """Get all Chrome/Chromium windows with their con_id, window ID, and PID."""
    try:
        result = subprocess.run(
            ["i3-msg", "-t", "get_tree"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return []

        tree = json.loads(result.stdout)
        windows = []

        def find_browsers(node):
            props = node.get("window_properties", {})
            if props.get("class") in BROWSER_CLASSES:
                window_id = node.get("window")
                pid = get_pid_from_window_id(window_id)
                windows.append({
                    "con_id": node.get("id"),
                    "window_id": window_id,
                    "pid": pid,
                })
            for child in node.get("nodes", []) + node.get("floating_nodes", []):
                find_browsers(child)

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
            comm_path = Path(f"/proc/{current_pid}/comm")
            if comm_path.exists():
                ancestors.append(comm_path.read_text().strip().lower())

            stat_path = Path(f"/proc/{current_pid}/stat")
            if stat_path.exists():
                stat_content = stat_path.read_text()
                close_paren = stat_content.rfind(')')
                if close_paren > 0:
                    parts = stat_content[close_paren + 1:].split()
                    current_pid = int(parts[1]) if len(parts) > 1 else 0
                else:
                    break
            else:
                break
    except Exception:
        pass

    return ancestors


def is_playwright_browser(pid: int) -> bool:
    """Check if a Chrome/Chromium process was spawned by Playwright."""
    if not pid:
        return False

    ancestors = get_process_ancestors(pid)

    for ancestor in ancestors:
        for indicator in PLAYWRIGHT_PROCESS_INDICATORS:
            if indicator in ancestor:
                return True

    return False


def close_container(con_id: int) -> bool:
    """Close a container via i3-msg."""
    try:
        result = subprocess.run(
            ["i3-msg", f"[con_id={con_id}] kill"],
            capture_output=True, text=True, timeout=5
        )
        return result.returncode == 0
    except Exception:
        return False


def main():
    # Read hook input from stdin (required by hook system)
    try:
        json.load(sys.stdin)
    except Exception:
        pass

    # Get all browser windows
    windows = get_all_browser_windows()

    # Close all Playwright-spawned browsers
    for window in windows:
        if is_playwright_browser(window["pid"]):
            close_container(window["con_id"])

    sys.exit(0)


if __name__ == "__main__":
    main()
