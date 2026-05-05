#!/usr/bin/env bash
# Shared helpers for the 014 branch-management test runner.
# All scenarios source this file and use its functions for pre/post snapshots
# and consistent artifact paths.
set -uo pipefail

DEX=/home/lukas/Projects/Github/lukaskellerstein/dex
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
RESULTS=$DEX/test-results
SCREENSHOTS=$RESULTS/screenshots
cdp() { node "$DEX/scripts/test-014-cdp.mjs" "$@"; }

mkdir -p "$RESULTS" "$SCREENSHOTS"

git_state() {
  cd "$DXE" || return 1
  echo "{"
  echo "  \"head\": \"$(git rev-parse --abbrev-ref HEAD 2>&1)\","
  echo "  \"head_sha\": \"$(git rev-parse --short HEAD 2>&1)\","
  echo "  \"status\": \"$(git status --short 2>&1 | sed 's/"/\\"/g' | tr '\n' ',' )\","
  echo "  \"dex_branches\": \"$(git branch --list 'dex/*' --format='%(refname:short)' | tr '\n' ',')\","
  echo "  \"feature_branches\": \"$(git branch --list 'feature/*' --format='%(refname:short)' | tr '\n' ',')\","
  echo "  \"selected_branches\": \"$(git branch --list 'selected-*' --format='%(refname:short)' | tr '\n' ',')\","
  echo "  \"main_subject\": \"$(git log -1 --format=%s main 2>/dev/null | sed 's/"/\\"/g')\","
  echo "  \"main_parents\": \"$(git log -1 --format=%P main 2>/dev/null | tr ' ' ',')\","
  echo "  \"promoted_tags\": \"$(git tag --list 'checkpoint/promoted-*' | tr '\n' ',')\""
  echo "}"
}

pristine() {
  bash "$DEX/scripts/reset-example-to.sh" pristine 2>&1 | sed 's/^/[pristine] /'
  # CATALOG DEVIATION: origin/main on github.com/lukaskellerstein/dex-ecommerce
  # has no step-commits, so the timeline renders the `timeline-empty` placeholder
  # instead of any branch badges. Seed a single step-commit on main so the
  # timeline renders for every fixture. The resulting state still matches the
  # catalog's intent for every scenario — fixtures that branch from main inherit
  # this commit, fixtures that add their own step-commits stack on top.
  # Also bake the catalog's default dex-config.json into the baseline commit
  # so the working tree stays clean (origin/main ships a stub `{agent:mock}`
  # config that would otherwise show as a dirty modification).
  cd "$DXE"
  if ! git log main --grep='^\[checkpoint:' --oneline -1 | grep -q .; then
    echo "baseline step-commit" > .dex-baseline.txt
    mkdir -p .dex
    cat > .dex/dex-config.json <<'CFG'
{
  "agent": "claude",
  "conflictResolver": {
    "model": "claude-sonnet-4-6",
    "maxIterations": 5,
    "maxTurnsPerIteration": 10,
    "costCapUsd": 0.50,
    "verifyCommand": null
  }
}
CFG
    git add .dex-baseline.txt .dex/dex-config.json
    git -c user.email=test@dex -c user.name=Test commit -q \
      -m "dex: specify completed [cycle:0] [feature:specs/baseline]" \
      -m "[checkpoint:specify:0]"
  fi
}

reload_app() {
  cdp reload > /dev/null 2>&1
  sleep 2
  # Drive the welcome screen if it's showing.
  cdp open > /dev/null 2>&1 || true
  sleep 1
}

reset_config() {
  # Default config is now baked into the pristine baseline commit, so this
  # function is a no-op for the standard case. Scenarios that need a
  # different config (US3-G cost cap, US4-A maxIterations=1) overwrite
  # the file manually and amend the baseline commit so the tree stays clean.
  :
}

# Override the dex-config.json AND amend the baseline commit so the working
# tree stays clean. Used by scenarios that need non-default resolver settings.
override_config_in_baseline() {
  cd "$DXE"
  cat > .dex/dex-config.json
  git add .dex/dex-config.json
  git -c user.email=test@dex -c user.name=Test commit --amend -q --no-edit
}

pre_flight() {
  # $1 = scenario id (1A, 1B, ...) — used for the actions log
  local id="$1"
  : > "$RESULTS/$id-actions.txt"
  pristine 2>&1 | tee -a "$RESULTS/$id-actions.txt"
  reset_config 2>&1 | tee -a "$RESULTS/$id-actions.txt"
}

snap_pre() {
  local id="$1"
  git_state > "$RESULTS/$id-pre.json" 2>&1
  cdp snap > "$RESULTS/$id-pre-ui.json" 2>&1 || true
}

snap_post() {
  local id="$1"
  git_state > "$RESULTS/$id-post.json" 2>&1
  cdp snap > "$RESULTS/$id-post-ui.json" 2>&1 || true
}

cleanup() {
  cd "$DXE" || return
  git merge --abort 2>/dev/null || true
  git reset --hard HEAD 2>/dev/null
  git clean -fd 2>/dev/null
  git checkout -q main 2>/dev/null || git checkout -q master 2>/dev/null || true
  for b in $(git branch --format='%(refname:short)' | grep -E '^(dex/|selected-|attempt-|feature/)' || true); do
    git branch -D "$b" 2>/dev/null || true
  done
  reset_config
}
