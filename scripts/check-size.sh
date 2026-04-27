#!/usr/bin/env bash
#
# check-size.sh — Wave-A required deliverable (011-refactoring T010).
#
# Fail when any source file in src/ exceeds 600 LOC, except for the
# documented exceptions in docs/my-specs/011-refactoring/file-size-exceptions.md.
#
# Run via `npm run check:size` — wired into package.json.

set -euo pipefail

# Allow-list mirrors docs/my-specs/011-refactoring/file-size-exceptions.md.
# Two perpetual exceptions plus three scheduled deferrals (each retires when
# its target wave lands). See the exceptions doc for per-file rationale.
ALLOWLIST=(
  src/core/state.ts                       # perpetual — 01X-state-reconciliation
  src/core/agent/ClaudeAgentRunner.ts     # perpetual — TBD SDK-adapter spec
  # main-loop.ts retired from allow-list when A4.5 landed (824 → 573 LOC).
  src/renderer/hooks/useOrchestrator.ts   # scheduled — Wave B (Phase 5)
  src/renderer/App.tsx                    # scheduled — Wave C-rest (Phase 6)
)

# Find files >600 LOC under src/. `wc -l` emits a trailing "total" line we filter out.
VIOLATIONS=$(
  find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + \
    | awk '$2 != "total" && $1 > 600 { printf "%s %s\n", $1, $2 }'
)

fail=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  loc=${line%% *}
  file=${line#* }
  exempt=0
  for allowed in "${ALLOWLIST[@]}"; do
    if [ "$file" = "$allowed" ]; then exempt=1; break; fi
  done
  if [ $exempt -eq 0 ]; then
    echo "FAIL: $file ($loc LOC > 600)" >&2
    fail=1
  fi
done <<< "$VIOLATIONS"

if [ $fail -ne 0 ]; then
  echo "" >&2
  echo "See docs/my-specs/011-refactoring/file-size-exceptions.md for the allow-list." >&2
  exit 1
fi
