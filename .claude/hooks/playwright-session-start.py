#!/usr/bin/env python3
"""SessionStart hook: heal the placement setup, then say what state it is in.

A SessionStart hook's stdout lands in the agent's context, so this is the
moment a broken setup becomes a message the agent reads FIRST — instead of a
window quietly landing on the user's desktop, which is how the old design
failed. Healing before checking, because the common finding after a yabai
restart (label gone, rules gone) is exactly what `pw.ensure_scratch()` fixes.

Prints nothing when everything is fine except one short ok-line; always exits
0 — a broken desktop must not block the session, only inform it.
"""

import sys

import pw


def main():
    if not pw.yabai_ok():
        print(
            "Playwright placement: yabai is not reachable — agent browser windows "
            "will open on the user's visible desktop. Warn the user before any "
            "headed browser work."
        )
        sys.exit(0)

    pw.ensure_scratch()
    problems = pw.check()
    if problems:
        print("Playwright placement: BROKEN —")
        for problem in problems:
            print(f"  - {problem}")
        print("Warn the user before any headed browser work.")
    else:
        print(
            f"Playwright placement: ok — agent windows are born on the "
            f"'{pw.SCRATCH_LABEL}' desktop (space {pw.scratch_index()})."
        )
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
