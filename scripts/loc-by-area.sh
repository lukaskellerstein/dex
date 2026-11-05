#!/usr/bin/env bash
#
# loc-by-area.sh — lines of non-test TypeScript under src/, per area.
#
# The areas are the ones the 015-lean-core brief measures against
# (specs/015-lean-core/research.md § R14). Test files (*.test.ts, *.test.tsx,
# anything under __tests__/) are excluded, so the number is product code only.
#
# Usage: bash scripts/loc-by-area.sh

set -euo pipefail

cd "$(dirname "$0")/.."

# count <path>... — sum the lines of every non-test .ts/.tsx file under the
# given paths (files or directories). Missing paths count as 0.
count() {
  local existing=()
  for p in "$@"; do
    [ -e "$p" ] && existing+=("$p")
  done
  if [ ${#existing[@]} -eq 0 ]; then
    echo 0
    return
  fi
  find "${existing[@]}" -type f \( -name '*.ts' -o -name '*.tsx' \) \
    ! -name '*.test.ts' ! -name '*.test.tsx' ! -path '*/__tests__/*' -print0 \
    | xargs -0 cat 2>/dev/null | wc -l | tr -d ' '
}

row() {
  printf '%-28s %7s\n' "$1" "$2"
}

row "core total" "$(count src/core)"
row "core time machine" "$(count src/core/checkpoints src/core/checkpoints.ts src/core/conflict-resolver.ts)"
row "core state.ts" "$(count src/core/state.ts)"
row "core loop" "$(count src/core/stages src/core/prompts.ts src/core/parser.ts src/core/agent)"
row "main total" "$(count src/main)"
row "renderer total" "$(count src/renderer)"
row "renderer checkpoints/" "$(count src/renderer/components/checkpoints)"
row "grand total" "$(count src)"
