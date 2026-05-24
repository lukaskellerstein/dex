#!/usr/bin/env python3
"""
PreToolUse hook: Record existing Chrome/Chromium windows before browser_navigate.

Stores the list of con_ids in a temp file keyed by tool_use_id.
The PostToolUse hook will use this to identify the new window.
"""

import json
import subprocess
import sys
from pathlib import Path

TEMP_DIR = Path("/tmp/playwright-hooks")

# Browser window classes to track
BROWSER_CLASSES = ("Chromium", "Google-chrome", "chromium", "google-chrome", "Electron")


def get_all_browser_con_ids() -> list[int]:
    """Get all Chrome/Chromium window container IDs from i3 tree."""
    try:
        result = subprocess.run(
            ["i3-msg", "-t", "get_tree"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return []

        tree = json.loads(result.stdout)
        con_ids = []

        def find_browsers(node):
            props = node.get("window_properties", {})
            if props.get("class") in BROWSER_CLASSES:
                con_ids.append(node.get("id"))
            for child in node.get("nodes", []) + node.get("floating_nodes", []):
                find_browsers(child)

        find_browsers(tree)
        return con_ids
    except Exception:
        return []


def main():
    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool_use_id = hook_input.get("tool_use_id", "unknown")

    # Get current browser windows
    con_ids = get_all_browser_con_ids()

    # Store in temp file
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    temp_file = TEMP_DIR / f"{tool_use_id}.json"
    temp_file.write_text(json.dumps({
        "con_ids": con_ids,
        "tool_use_id": tool_use_id
    }))

    sys.exit(0)


if __name__ == "__main__":
    main()
