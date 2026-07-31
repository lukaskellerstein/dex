#!/usr/bin/env python3
"""SessionEnd hook: close the Playwright browser windows this session spawned.

Ownership is decided by process ancestry, so hand-opened browsers survive. On
macOS the scratch space is destroyed afterwards if this hook created it and
nothing else moved in.
"""

import sys

import wm


def main() -> None:
    manager = wm.detect()
    if manager.name == "none":
        sys.exit(0)

    for window in manager.browser_windows():
        if wm.is_playwright_browser(window["pid"]):
            manager.close(window)

    manager.release_scratch()
    sys.exit(0)


if __name__ == "__main__":
    main()
