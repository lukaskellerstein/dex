#!/usr/bin/env bash
# Usage: prune-example-branches.sh [--dry-run]
#
# Deletes local dex/* branches whose tip commit is older than 7 days. Never
# touches main, fixture/*, lukas/*, checkpoint/* (tags immune anyway). The
# currently-checked-out branch is git-enforced skipped.
#
# Note (post-013-cleanup-2): the running app no longer produces attempt-*
# or capture/* branches. Fixture-only attempt-* branches minted by
# scripts/reset-example-to.sh linger until manually deleted — that's fine
# for a test fixture.
set -euo pipefail

TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
DEX_THRESHOLD=$(( $(date +%s) - 7 * 24 * 60 * 60 ))
DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

cd "$TARGET"

prune() {
  local ref_glob="$1"
  local threshold="$2"
  local label="$3"
  git for-each-ref --format='%(refname:short) %(committerdate:unix)' "$ref_glob" \
    | awk -v t="$threshold" '$2 < t { print $1 }' \
    | while read -r branch; do
        if [ -z "$branch" ]; then continue; fi
        if [ "$DRY_RUN" = "true" ]; then
          echo "[dry-run] would delete $label branch: $branch"
        else
          git branch -D "$branch" || true
        fi
      done
}

prune "refs/heads/dex/" "$DEX_THRESHOLD" "dex/*"

# main, fixture/*, lukas/*, attempt-* (fixture-only post-013), and any
# pre-existing capture/* refs are not in any of the globs above — they
# are implicitly preserved.
