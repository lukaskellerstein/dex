#!/usr/bin/env bash
#
# dev-setup.sh — Start all Dex components for development.
#
# Starts Vite dev server (HMR) and Electron with CDP enabled so the
# AI agent can test UI changes via the electron-chrome MCP server.
#
# Usage:
#   ./dev-setup.sh
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Directories ---
LOG_DIR="${HOME}/.dex/dev-logs"
mkdir -p "$LOG_DIR"

# Truncate old logs
> "$LOG_DIR/vite.log"
> "$LOG_DIR/electron.log"

# --- Cleanup on exit ---
PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  pkill -P $$ 2>/dev/null || true
  sleep 0.5
  pkill -9 -P $$ 2>/dev/null || true
  wait 2>/dev/null
  echo "All processes stopped."
}

trap cleanup EXIT INT TERM

# --- Helper: run with prefix, tee to log file ---
run_prefixed() {
  local prefix="$1"
  local logfile="$2"
  shift 2
  "$@" > >(tee -a "$logfile" | sed "s/^/[${prefix}] /") 2>&1 &
  PIDS+=($!)
}

VITE_PORT=5500
DEVTOOLS_PORT=9333

echo "=== Dex Development Environment ==="
echo "  Vite (HMR):    port ${VITE_PORT}"
echo "  Electron:      devtools port ${DEVTOOLS_PORT}"
echo ""
echo "  Log files:"
echo "    ${LOG_DIR}/vite.log"
echo "    ${LOG_DIR}/electron.log"
echo ""

# --- 1. Ensure dependencies are installed ---
if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Installing dependencies..."
  (cd "$ROOT_DIR" && npm install)
fi

# --- 2. Compile TypeScript (main process) ---
echo "Compiling TypeScript..."
(cd "$ROOT_DIR" && npx tsc 2>&1 | sed 's/^/[build] /')

# --- 3. Start Vite dev server for the renderer ---
# Kill any stale process on the Vite port
if lsof -ti ":${VITE_PORT}" > /dev/null 2>&1; then
  echo "Killing stale process on port ${VITE_PORT}..."
  lsof -ti ":${VITE_PORT}" | xargs kill 2>/dev/null || true
  sleep 0.5
fi

echo "Starting Vite dev server on port ${VITE_PORT}..."
(cd "$ROOT_DIR" && npx vite --port "$VITE_PORT" --strict-port) > >(tee -a "$LOG_DIR/vite.log" | sed "s/^/[vite] /") 2>&1 &
PIDS+=($!)

# Wait for Vite to be ready
echo "Waiting for Vite dev server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${VITE_PORT}" > /dev/null 2>&1; then
    echo "Vite dev server is ready."
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo "WARNING: Vite dev server health check timed out."
  fi
  sleep 0.5
done

# --- 4. Start Electron with CDP ---
# Kill any stale process on the devtools port
if lsof -ti ":${DEVTOOLS_PORT}" > /dev/null 2>&1; then
  echo "Killing stale process on port ${DEVTOOLS_PORT}..."
  lsof -ti ":${DEVTOOLS_PORT}" | xargs kill 2>/dev/null || true
  sleep 0.5
fi

echo "Starting Electron app (dev mode, devtools: ${DEVTOOLS_PORT})..."
run_prefixed "elec" "$LOG_DIR/electron.log" npx electron --no-sandbox --remote-debugging-port="${DEVTOOLS_PORT}" "$ROOT_DIR/dist/main/index.js" \
  --dev --vite-port "$VITE_PORT"

echo ""
echo "=== All services running. Press Ctrl+C to stop. ==="
echo ""

# Wait for all background processes
wait
