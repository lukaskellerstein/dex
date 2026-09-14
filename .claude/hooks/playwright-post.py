#!/usr/bin/env python3
"""PostToolUse hook on mcp__playwright-<slug>__browser_* AND on Bash.

One job: the park-fallback. Placement normally happens at window CREATION —
the permanent claude-pw-* yabai rules for the windows they recognise, and the
machine's window_created signal (mac-setup pw_route.sh, deciding from the
process tree) for every agent window whatever it is called — so this hook
finds nothing to do. What is left for it is a window that slipped both: an
app launched bare by an agent's own script, backgrounded so its launcher was
gone before the window appeared, in a repo whose app does not honour
PW_AGENT. The Bash trigger is the only hook that ever sees those (no MCP tool
fires for them — measured in ca-p-tcha 2026-08-23).

A window found off every agent desktop is handed to pw.route — the same
machine script the signal runs — so a hook never has an opinion of its own
about which desktop is right (the shared one, or the project's `pw:` one).
Parking straight to the shared desktop was this hook's old move, and it would
undo the project split on every Bash call.

Safe on every Bash call because the ownership test is pw.is_agent_browser —
the machine's pid registry, Claude/Codex ancestry, or the instance's own
/json/version marker; never argv and never a bare "some MCP server claims this
port". The looser port-claim test parked the USER's own app while an agent was
merely attached to it (measured in rex 2026-08-30, the repo's old hook set);
this grain cannot.

Deliberately NO automatic walk-back of the visible space. The old set dragged
the user home whenever the scratch space was visible — but with placement at
birth, `showInactive()` in agent apps, and the two macOS keys defaults.sh
pins (`workspaces-auto-swoosh=false`, `AppleSpacesSwitchOnActivate=false`),
nothing switches the desktop in the first place (measured through a CDP
bringToFront storm, 2026-08-30). What remained of the walk-back was only its
false positive: yanking the user off the `playwright` desktop they had
deliberately switched to in order to watch the agent work.
"""

import sys

import pw


def main():
    if not pw.yabai_ok():
        sys.exit(0)

    if pw.scratch_index() is None:
        sys.exit(0)  # reported by session-start and healed by the pre hook

    home = pw.agent_space_indices()
    for window in pw.browser_windows():
        if window["space"] not in home and pw.is_agent_browser(window["pid"]):
            pw.route(window["id"])

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
