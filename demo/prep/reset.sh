#!/usr/bin/env bash
# Return dex-ecommerce to the demo's zero state. Run between every take.
#
# Referenced by storyboard sections via `resetBefore`, and called by setup.sh so
# there is exactly one definition of "zero state".
#
# usage: demo/prep/reset.sh [projectDir] [rootSha]
set -euo pipefail

DEX_REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="${1:-$HOME/Projects/Github/lukaskellerstein/dex-ecommerce}"

if [[ "$(basename "$PROJECT")" != "dex-ecommerce" ]]; then
  echo "refusing to operate on '$PROJECT' — demo prep only manages dex-ecommerce" >&2
  exit 1
fi

ROOT_SHA="${2:-$(git -C "$PROJECT" rev-list --max-parents=0 HEAD | tail -1)}"

# A killed or crashed run leaves the lock behind and the next start refuses.
rm -f "$PROJECT/.dex/state.lock"

# Discard the working tree BEFORE switching branches. A completed run commits
# .dex/state.json and .dex/runs/*.json onto its dex/* branch and then keeps
# writing to them, so a plain `checkout main` aborts with "local changes would
# be overwritten" — and with `set -e` that silently leaves the project dirty,
# which the next run happily resumes from. That failure mode cost a full
# validation cycle; hence the -f and the post-conditions at the bottom.
git -C "$PROJECT" reset -q --hard
git -C "$PROJECT" checkout -q -f -B main "$ROOT_SHA"
git -C "$PROJECT" reset -q --hard "$ROOT_SHA"

# Every branch the app produced: dex/* run branches and selected-* navigation
# forks. main is preserved.
for branch in $(git -C "$PROJECT" for-each-ref --format='%(refname:short)' refs/heads/ | grep -v '^main$' || true); do
  git -C "$PROJECT" branch -q -D "$branch"
done

# -fdx, not -fd: .dex/state.json and .dex/feature-manifest.json are gitignored
# runtime state. Left behind, the next start resumes instead of starting fresh
# and the loop dashboard opens mid-run.
git -C "$PROJECT" clean -qfdx

# Restore the committed configs the clean may have touched, then re-apply the
# demo overrides on top.
git -C "$PROJECT" checkout -q -- .dex/dex-config.json .dex/mock-config.json

# GOAL.md — auto-detected by the loop start panel. Untracked on purpose: the run
# stages it into its first checkpoint commit, exactly as a real project would.
cp "$PROJECT/docs/my-specs/001-Initialization/README.md" "$PROJECT/GOAL.md"

# Baseline README, committed onto main so it is in the MERGE BASE of the run
# branch. Storyboard section 05 promotes a run branch into a main that moved
# underneath it, and the resolver only runs for `UU` (both-modified) conflicts.
# A file that exists on neither side of the base produces `AA`, which
# checkpoints/_mergeHelpers classifies as a non-content conflict and aborts the
# merge without ever calling the resolver. Hence: seed it here, the run rewrites
# it, stage-conflict.sh rewrites it differently on main.
cat > "$PROJECT/README.md" <<'MD'
# Eshopy

Storefront for a small online shop. See `docs/my-specs/` for the specifications.

## Modules

_None yet._

## Status

Pre-implementation. No feature work has landed.
MD
git -C "$PROJECT" add README.md
git -C "$PROJECT" -c user.name="Eshopy" -c user.email="dev@eshopy.example" \
  commit -q -m "Add project README"
BASE_SHA="$(git -C "$PROJECT" rev-parse HEAD)"

# Spec-kit init. Without .specify/integration.json the speckit_init prerequisite
# fails, and a failed check blocks the whole run on a "Continue anyway" modal —
# on camera, as a red check in the prerequisites panel.
#
# Dex auto-inits this itself now that the --ai/--integration flag detection is
# fixed, but prep does not rely on that: the demo needs the check green whether
# or not the auto-fix path runs. Bundled templates, no network, ~0.2s.
if [[ ! -f "$PROJECT/.specify/integration.json" ]]; then
  ( cd "$PROJECT" && specify init . --force --integration claude --script sh >/dev/null 2>&1 )
fi
if [[ ! -f "$PROJECT/.specify/integration.json" ]]; then
  echo "FATAL: spec-kit init produced no .specify/integration.json in $PROJECT." >&2
  echo "The prerequisites panel will show a failed check and block the run." >&2
  exit 1
fi

node "$DEX_REPO/demo/prep/build-mock-config.mjs" "$PROJECT"

# Fail loudly here rather than three minutes into a recording session.
AGENT="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agent)' "$PROJECT/.dex/dex-config.json")"
if [[ "$AGENT" != "mock" ]]; then
  echo "FATAL: .dex/dex-config.json selects agent '$AGENT', not 'mock'." >&2
  echo "A demo run against the real backend costs money and is not reproducible." >&2
  exit 1
fi

# ── Post-conditions ───────────────────────────────────────────────────────────
# A reset that half-worked is worse than one that failed loudly: the run resumes
# from leftover state, stages get skipped, and the recording looks wrong for
# reasons nobody can see on camera.

fail() { echo "FATAL: reset did not reach a clean state — $1" >&2; exit 1; }

[[ "$(git -C "$PROJECT" rev-parse HEAD)" == "$BASE_SHA" ]] || fail "HEAD is not the seeded base commit"
[[ "$(git -C "$PROJECT" rev-parse --abbrev-ref HEAD)" == "main" ]] || fail "not on main"
[[ "$(git -C "$PROJECT" rev-list --count HEAD)" == "2" ]] || fail "main should be root + the README commit"
grep -q "_None yet._" "$PROJECT/README.md" || fail "README.md is not the baseline version"

leftover_branches="$(git -C "$PROJECT" for-each-ref --format='%(refname:short)' refs/heads/ | grep -v '^main$' || true)"
[[ -z "$leftover_branches" ]] || fail "run branches survived: $(echo "$leftover_branches" | tr '\n' ' ')"

for stale in .dex/state.json .dex/feature-manifest.json .dex/runs specs src GOAL_clarified.md; do
  [[ ! -e "$PROJECT/$stale" ]] || fail "$stale survived the clean (the next run would resume from it)"
done

[[ -f "$PROJECT/GOAL.md" ]] || fail "GOAL.md missing (the start panel would open on an empty editor)"
[[ -f "$PROJECT/.specify/integration.json" ]] || fail ".specify/integration.json missing"

echo "demo-prep: reset to ${BASE_SHA:0:7} (root ${ROOT_SHA:0:7} + README), agent=mock, GOAL.md + spec-kit in place, no run branches"
