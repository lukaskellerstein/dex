#!/usr/bin/env bash
# Top-level driver for the 014 branch-management test catalog.
# Sourced by per-scenario sh fragments in this directory.
set -uo pipefail

source "$(dirname "$0")/_lib.sh"

# Append a single line to the per-scenario results CSV.
# Format: id,status,note
log_result() {
  local id="$1" status="$2" note="${3:-}"
  echo "${id}|${status}|${note}" >> "$RESULTS/results.csv"
}

# Run a fixture pre-flight + capture pre-state + run a body + capture post-state.
# Args: <id> <fixture_fn> <action_fn>
run_scenario() {
  local id="$1" fixture_fn="$2" action_fn="$3"
  echo "==== $id ===="
  pre_flight "$id"
  $fixture_fn 2>&1 | tee -a "$RESULTS/$id-actions.txt"
  reload_app 2>&1 | tee -a "$RESULTS/$id-actions.txt"
  snap_pre "$id"
  $action_fn 2>&1 | tee -a "$RESULTS/$id-actions.txt"
  snap_post "$id"
  cleanup
}
