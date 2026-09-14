#!/bin/bash
# Launch the project's desktop app as an AGENT instance, for --cdp-endpoint
# (Electron) repos. The ONLY sanctioned way for an agent to start the app:
#
#   .claude/hooks/playwright-launch.sh npm run dev
#   REX_CDP_PORT=9444 .claude/hooks/playwright-launch.sh npm run dev
#   .claude/hooks/playwright-launch.sh ./dist/mac-arm64/REX.app/Contents/MacOS/REX
#
# What it does, and why each half exists:
#
#   The app is started as a CHILD of this script, and this script is a
#   descendant of the Claude Code or Codex session. That ancestry identifies the
#   window as an agent's: the machine's yabai signal (pw_route.sh, mac-setup
#   modules/yabai) sees a supported agent above the window's process and moves
#   the window to the project's own desktop, whatever the app is called. No
#   app name is matched anywhere -- rex packaged its app, macOS called it `REX`
#   instead of `Electron`, and every name-based matcher on the machine let the
#   window land on the user's desktop while reporting success (2026-09-07).
#   The machine remembers the pid afterwards, so the proof outlives this script.
#
#   PW_AGENT=1 is exported, and an app that honours it (contract: mac-setup
#   projects/claude-code.md § The agent window contract) titles its window
#   ` [agent]`, shows it without activation, and marks its user agent. The
#   title tag is what the claude-pw-agent yabai rule matches, so such a window
#   is BORN off-screen and never seen at all. An app that ignores PW_AGENT is
#   still placed -- by ancestry -- but is on screen for the milliseconds the
#   signal takes.
#
#   The script waits for the NEW window (never a pre-existing one -- a user's
#   own instance must never be touched), then verifies it sits on an agent
#   desktop, routing and parking it itself if the signal did not, and exits
#   non-zero if even that failed. No window at all is ALSO an error: a
#   placement that cannot be verified must be reported, never assumed.
#
# Refuses `open`: launchd starts the app, not this script, so the ancestry
# that proves ownership is never there. Run the binary directly instead.
#
# Refuses to launch onto a busy CDP port: the new instance would silently not
# get the port, and every browser tool would keep driving whatever already
# holds it -- usually the user's own instance. Pick a free port via the app's
# own env (e.g. REX_CDP_PORT=9444) or ask the user.
#
# Env overrides: PW_CDP_PORT (default: read from ./.mcp.json),
# PW_LAUNCH_TIMEOUT seconds to wait for the window (default 60 -- a cold
# `npm run dev` can take a while, and once this script exits the ancestry is
# gone, so waiting is cheaper than guessing). Must run on bash 3.2 (stock
# macOS).

set -u

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"
pw() { python3 "$HOOKS_DIR/pw.py" "$@"; }
ROUTE="$HOME/.config/yabai/pw_route.sh"
TIMEOUT="${PW_LAUNCH_TIMEOUT:-60}"
LOG="${TMPDIR:-/tmp}/playwright-hooks/launch-$$.log"

if [ "$#" -eq 0 ]; then
    echo "usage: playwright-launch.sh <command...>" >&2
    exit 2
fi

case "$(basename "$1")" in
    open)
        echo "REFUSED: 'open' hands the app to launchd, so nothing links the window to" >&2
        echo "this session and it cannot be placed. Run the app's binary directly, e.g." >&2
        echo "  playwright-launch.sh ./dist/mac-arm64/App.app/Contents/MacOS/App" >&2
        exit 2
        ;;
esac

PORT="${PW_CDP_PORT:-$(pw cdp-port || true)}"
if [ -n "$PORT" ] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "REFUSED: CDP port $PORT already has a listener — a new instance would not" >&2
    echo "get the port, and browser tools would keep driving the instance that holds" >&2
    echo "it (usually the user's). Launch on a free port instead, or ask the user." >&2
    exit 2
fi

# The desktop and its placement rules, before the window exists. A failure here
# is loud but not fatal: the app may still be worth starting (e.g. yabai down),
# it will just be visible.
SCRATCH="$(pw ensure-scratch || true)"
[ -z "$SCRATCH" ] && echo "warning: no playwright desktop — the window will NOT be hidden" >&2

BEFORE_SPACE="$(pw current-space || true)"
# Windows that already exist (a user's own instance) must never be touched.
BEFORE_IDS="$(pw list-windows || true)"

export PW_AGENT=1
mkdir -p "$(dirname "$LOG")"
nohup "$@" >"$LOG" 2>&1 &
APP_PID=$!

# The first real window whose process descends from the one just started.
WINDOW="$(pw wait-window "$TIMEOUT" "$BEFORE_IDS" "$APP_PID" || true)"

if [ -z "$WINDOW" ]; then
    if kill -0 "$APP_PID" 2>/dev/null; then
        echo "ERROR: pid $APP_PID is running but opened no window within ${TIMEOUT}s, so its" >&2
        echo "placement could not be verified. If it opens one later it will be placed only" >&2
        echo "if the app honours PW_AGENT (title tag); otherwise it lands on the user's" >&2
        echo "desktop. Read the log, then either kill $APP_PID and relaunch with a larger" >&2
        echo "PW_LAUNCH_TIMEOUT, or tell the user. Log: $LOG" >&2
    else
        echo "ERROR: the app exited before opening a window. Log: $LOG" >&2
    fi
    exit 1
fi

WINDOW_ID="${WINDOW%% *}"

# The signal normally has it on an agent desktop already; give it a beat.
LABEL=""
i=0
while [ "$i" -lt 10 ]; do
    LABEL="$(pw window-label "$WINDOW_ID" || true)"
    [ -n "$LABEL" ] && break
    i=$((i + 1))
    sleep 0.3
done

if [ -z "$LABEL" ]; then
    # The signal did not act (yabai signal missing, or the machine module is
    # older than this script). This script is still the window's ancestor, so
    # the same authority can be run by hand with the same result.
    [ -x "$ROUTE" ] && "$ROUTE" "$WINDOW_ID" >/dev/null 2>&1
    LABEL="$(pw window-label "$WINDOW_ID" || true)"
fi

if [ -z "$LABEL" ] && [ -n "$SCRATCH" ]; then
    # Last resort: the shared desktop, by hand.
    pw park "$WINDOW_ID" || true
    LABEL="$(pw window-label "$WINDOW_ID" || true)"
    echo "note: the yabai signal did not place the window; parked it on the shared desktop" >&2
fi

if [ -z "$LABEL" ]; then
    FINAL="$(pw window-space "$WINDOW_ID" || true)"
    echo "ERROR: window $WINDOW_ID is on space ${FINAL:-?}, not on an agent desktop — placement failed (log: $LOG)" >&2
    exit 1
fi

# Nothing above is supposed to move the visible space; walk back if it did.
AFTER_SPACE="$(pw current-space || true)"
if [ -n "$BEFORE_SPACE" ] && [ "$AFTER_SPACE" != "$BEFORE_SPACE" ]; then
    pw focus-space "$BEFORE_SPACE" || true
fi

echo "launched pid=$APP_PID window=$WINDOW_ID desktop=$LABEL log=$LOG"
