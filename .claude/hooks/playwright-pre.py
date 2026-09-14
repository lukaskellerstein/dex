#!/usr/bin/env python3
"""PreToolUse hook on mcp__playwright-<slug>__browser_*.

Two jobs, both before any browser window can exist:

1. Self-heal the permanent `playwright` desktop. It is declared in yabai's own
   config and normally already there; the one way to lose it mid-session is a
   middle-click on its chip (destroy). `pw.ensure_scratch()` re-runs the same
   machine script the config runs, which recreates the desktop and re-points
   the placement rules — so the window about to appear is still born out of
   the user's sight.

2. The CDP ownership gate. In a --cdp-endpoint repo the MCP attaches to
   whatever listens on the port — including an instance the user started by
   hand. That instance is theirs: the call is denied until the user has been
   asked and has explicitly agreed (the consent file below).
"""

import json
import os
import sys

import pw


def deny(reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


def main():
    if not pw.yabai_ok():
        sys.exit(0)

    pw.ensure_scratch()

    project_dir = os.environ.get("CODEX_PROJECT_DIR") or os.environ.get("CLAUDE_PROJECT_DIR") or "."
    port = pw.cdp_port(project_dir)
    if port is not None and not pw.agent_owns_port(port):
        consent = pw.consent_path(port)
        if not consent.exists():
            pw.STATE_DIR.mkdir(parents=True, exist_ok=True)
            deny(
                f"The app on CDP port {port} was started by the user, not by this "
                "session. Do NOT control it. Either start your own instance with "
                "the repo's playwright-launch.sh hook (on a free port — see the "
                "script's own refusal message), or ask the user for permission "
                "— and only after an explicit yes in the conversation, run: "
                f"touch '{consent}'"
            )

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)  # a broken hook must never fail the tool call
