#!/usr/bin/env bash
# Usage: prune-example-branches.sh
#
# Deletes local dex/* branches on dex-ecommerce whose tip commit is older
# than 7 days. Never touches main, fixture/*, or lukas/*. Never modifies
# remotes. The currently-checked-out branch is skipped (git-enforced).
set -euo pipefail

TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
THRESHOLD=$(( $(date +%s) - 7 * 24 * 60 * 60 ))

cd "$TARGET"

git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/dex/ \
  | awk -v t="$THRESHOLD" '$2 < t { print $1 }' \
  | xargs -r -n1 git branch -D
