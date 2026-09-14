#!/usr/bin/env python3
"""SessionEnd hook: close what this session opened, and nothing else.

Several sessions share this desktop, so "this session" is literal: a window is
closed only if it is proven automated AND it either descends from this
session's agent process or is abandoned (nothing holding it, nothing driving
it). Hand-opened windows and other sessions' browsers survive.

Automation has three proofs, any one enough:
  - argv markers (pw.was_automated) — Playwright's own browser builds;
  - the ` [agent]` title tag — an agent-mode app. Its argv shows neither a
    Playwright path nor a debugging port (the app sets the port from inside
    its main process), so the title the app tagged itself with is the signal
    that survives;
  - the machine's pid registry (pw.registered_agent_pid) — the yabai signal
    proved the window's process descended from a supported agent when the
    window was born, and wrote that down. This is what closes a packaged app
    under its own bundle name, which neither of the other two can see.

The permanent `playwright` desktop is NOT destroyed — it is machine config,
not session state, and the next session is born onto it. Consent grants this
session collected are dropped, so a later session must ask again.
"""

import sys

import pw


def main():
    if not pw.yabai_ok():
        sys.exit(0)

    session = pw.session_pid()
    for window in pw.browser_windows():
        pid = window["pid"]
        automated = (
            pw.was_automated(pid) or window["title"].endswith(pw.AGENT_TITLE_TAG) or pw.registered_agent_pid(pid)
        )
        if not automated:
            continue  # opened by hand — never ours to close
        if pw.is_owned_by(pid, session) or pw.is_abandoned(pid):
            pw.close_window(window)

    if session is not None:
        for path in pw.STATE_DIR.glob(f"consent-*-{session}"):
            path.unlink(missing_ok=True)

    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        sys.exit(0)
