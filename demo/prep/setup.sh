#!/usr/bin/env bash
# Put dex-ecommerce into the state the demo records from.
#
# Three things happen here, and all three are re-applied by reset.sh between
# takes so a re-take never inherits the previous one:
#
#   1. The repo is reset to its root commit and every run-produced branch is
#      deleted. The timeline the demo shows must be the run the viewer watches.
#   2. GOAL.md is created from the Eshopy spec. The loop start panel auto-detects
#      only `<projectDir>/GOAL.md` (or a path persisted in state.json from a
#      previous run) — see src/renderer/hooks/useLoopStartForm.ts. Without it the
#      panel opens on an empty editor and section 01 has nothing to show.
#   3. .dex/mock-config.json is overwritten with the demo-grade script.
#
# On (3): dex-ecommerce commits its own mock-config, but that one is a
# regression fixture whose features are named "Authentication" / "Payments" /
# "Final feature" and whose spec dirs are `specs/mock-c1-...`. The word "mock"
# would be on screen. The committed file is restored by `git checkout --
# .dex/mock-config.json` when you are done recording; nothing here is committed.
#
# usage: demo/prep/setup.sh [projectDir]
set -euo pipefail

DEX_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${1:-$HOME/Projects/Github/lukaskellerstein/dex-ecommerce}"

if [[ "$(basename "$PROJECT")" != "dex-ecommerce" ]]; then
  echo "refusing to operate on '$PROJECT' — demo prep only manages dex-ecommerce" >&2
  exit 1
fi
if [[ ! -d "$PROJECT/.git" ]]; then
  echo "'$PROJECT' is not a git repository" >&2
  exit 1
fi

# The root commit is the demo's zero state. Recorded so reset.sh does not have
# to re-derive it (and cannot drift if the run adds commits to main).
ROOT_SHA="$(git -C "$PROJECT" rev-list --max-parents=0 HEAD | tail -1)"

echo "demo-prep: project   $PROJECT"
echo "demo-prep: root      ${ROOT_SHA:0:7}"

bash "$DEX_REPO/demo/prep/reset.sh" "$PROJECT" "$ROOT_SHA"

echo "demo-prep: ready"
echo
git -C "$PROJECT" log --oneline
echo
git -C "$PROJECT" status --short
