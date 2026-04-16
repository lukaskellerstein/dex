# Fast-Path Testing via Fixture Branches

## Context

Every end-to-end test of the Dex Loop today starts from `git clean -fdx` on `dex-ecommerce` and walks through **prerequisites → clarification (product → technical → synthesis) → constitution → manifest_extraction → gap_analysis → specify → plan → tasks → implement**. The first six of those stages are LLM-heavy and add ~10–15 minutes and non-trivial token cost to every run — even when the change under test only touches the `implement` loop or later stages.

We don't need to reinvent anything. The orchestrator already supports resume:

- `DexState.lastCompletedStage` drives the stage machine (`src/core/state.ts:356-372`).
- `config.resume === true` causes `runLoop` to skip prerequisites, keep the current branch, reuse the `runId`, and call `reconcileState()` to pick the next stage (`src/core/orchestrator.ts:1850-1945`).
- The UI already wires this up: `App.tsx:300-304` calls `handleStartLoop({ resume: true })` whenever the opened project has loop history, and `Topbar.tsx:250` renders the button as **Resume** instead of **Start**.
- `reconcileState()` hash-checks every artifact against `state.artifacts.*.sha256` and falls back to earlier stages if anything is missing or modified — so a well-formed fixture is self-validating.

The missing piece is a way to **restore the filesystem + git state to a known mid-loop checkpoint** in place of the current "wipe everything" reset. That's what this plan adds.

## Approach

Use **git fixture branches** on the `dex-ecommerce` repo itself as snapshots, plus a small reset script to switch between them. No changes to the orchestrator, no changes to the UI.

### Fixture branches

Two long-lived branches on `dex-ecommerce`:

| Branch | Captures | Skips | Time saved |
|---|---|---|---|
| `fixture/after-clarification` | `GOAL_clarified.md`, product/technical domain docs, `.specify/memory/constitution.md`, `.specify/` bootstrap, `.dex/state.json` with `lastCompletedStage: "manifest_extraction"`, `.dex/feature-manifest.json` populated, **no `specs/` yet** | prerequisites, clarification_*, constitution, manifest_extraction | ~5–10 min |
| `fixture/after-tasks` | everything above, plus `specs/001-<feature>/{spec,plan,tasks,data-model,research,quickstart}.md` + `contracts/` + `checklists/`, `.dex/state.json` with `lastCompletedStage: "tasks"` and `currentSpecDir` set, and the feature marked `active` in `feature-manifest.json` | prerequisites, all clarification, constitution, manifest_extraction, gap_analysis, specify, plan, tasks | ~15–20 min |

Each fixture is a regular branch — `.dex/` and `.specify/` are committed. `state.json.branchName` on each fixture equals the fixture branch name itself (so `detectStaleState` at `state.ts:290-295` stays happy).

"Mid-implement" is explicitly out of scope: `state.artifacts.features[X].tasks.taskChecksums` is derived from the live `tasks.md`, which is already captured by `fixture/after-tasks`. If a test needs partial implement progress, it's cheaper to start from `fixture/after-tasks` and hand-check a few boxes in `tasks.md` before launching than to maintain a third fixture.

### Branch hygiene

Addresses the "dead branches pile up" concern:

1. **Fixed set, not growing.** Only two fixture branches, ever. We `git branch -f` them in place when the GOAL/spec evolves — we never create `fixture/after-tasks-v2`, `fixture/after-tasks-new`, etc.
2. **Prefix reservation.** `fixture/*` is reserved. The existing orchestrator-created run branches use `dex/YYYY-MM-DD-xxxxxx`, so there's no collision.
3. **Prune helper for run branches.** Add `dex/scripts/prune-example-branches.sh` that deletes local `dex/*` branches older than 7 days (keeps `fixture/*`, `main`, `lukas/*` untouched). Run manually or on demand — not automated. This is the actual source of branch bloat today (every test run leaves a `dex/*` branch behind), so solving it here is a bonus.
4. **Remote policy.** Fixtures live locally by default. If we push them to `origin/fixture/*` for sharing, the same "force-update in place" rule applies.

### Restore script

New file: `dex/scripts/reset-example-to.sh` (bash, executable).

```bash
#!/usr/bin/env bash
# Usage: reset-example-to.sh <clean|after-clarification|after-tasks>
# Target: /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
set -euo pipefail

TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
CHECKPOINT="${1:-clean}"

cd "$TARGET"

case "$CHECKPOINT" in
  clean)
    # Current behavior: blank slate from main
    git checkout main
    git reset --hard HEAD
    git clean -fdx
    ;;
  after-clarification|after-tasks)
    BRANCH="fixture/$CHECKPOINT"
    # Verify fixture exists
    git rev-parse --verify "$BRANCH" >/dev/null
    # Drop any in-progress changes + untracked files first
    git reset --hard HEAD
    git clean -fdx
    # Switch to the fixture branch (creates or resets local tracking)
    git checkout -B "$BRANCH" "$BRANCH"
    # Sanity: the restored state.json must agree with current branch
    jq -e --arg b "$BRANCH" '.branchName == $b' .dex/state.json >/dev/null \
      || { echo "fixture drift: state.json branchName != $BRANCH"; exit 1; }
    ;;
  *)
    echo "unknown checkpoint: $CHECKPOINT" >&2
    exit 2
    ;;
esac

git status --short
```

The script is the **only authorized destructive path** against `dex-ecommerce` (same trust boundary as the current reset snippet in 06-testing.md).

### Creating the fixtures (one-time, and on refresh)

There is no generator — fixtures are captured from a real orchestrator run:

1. Reset `dex-ecommerce` clean (`reset-example-to.sh clean`).
2. Start the loop as normal via the welcome screen + Automatic Clarification on.
3. When the orchestrator emits `stage_completed` for `manifest_extraction` (visible in the trace), click **Pause**. The orchestrator's pause path already persists `state.json` atomically.
4. On the example repo:
   ```bash
   git add -A && git commit -m "fixture: after-clarification"
   git branch -f fixture/after-clarification HEAD
   ```
5. Un-pause and let the loop continue until `tasks` is complete for the first feature. Pause again.
6. `git add -A && git commit -m "fixture: after-tasks" && git branch -f fixture/after-tasks HEAD`.

Refreshing a fixture later = repeat the same flow; `git branch -f` moves the pointer. Stale commits get GC'd.

### Docs update

Rewrite `.claude/rules/06-testing.md §4c.1` to:

1. Keep the existing "clean reset" commands as the default.
2. Add a new sub-section introducing `reset-example-to.sh <checkpoint>` with a table of which stages each checkpoint skips.
3. Add guidance: "When your change only touches stages ≥ `specify`, use `after-clarification`. When it only touches the implement loop or later, use `after-tasks`."
4. Document that after restore, the welcome screen submit button label will still read **Open Existing**, and the loop page's primary button will read **Resume** (not **Start**) — clicking it triggers `config.resume=true` automatically.
5. Document the `fixture/*` branch naming reservation and the fixture refresh workflow.

No changes to §4c.3 (welcome flow) or §4c.4 (start loop) — both work unchanged because the UI auto-detects loop history.

## Critical files

- `dex/scripts/reset-example-to.sh` — new, as above
- `dex/scripts/prune-example-branches.sh` — new, tiny helper
- `dex/.claude/rules/06-testing.md` — update §4c.1, add fixture sub-section
- No code changes in `src/core/`, `src/main/`, `src/renderer/` — the resume path already works end-to-end

## Functions/utilities we rely on (no changes needed)

- `state.ts:435-654` `reconcileState()` — hash-checks artifacts, computes `nextStage`, handles drift
- `state.ts:356-372` `STAGE_ORDER` — ordinal lookup for "next stage after lastCompletedStage"
- `state.ts:290-295` `detectStaleState` — the reason `state.branchName` must match the checked-out branch
- `orchestrator.ts:1850-1945` resume entry point — skips prerequisites, reuses runId, applies reconciliation patches
- `App.tsx:297-304` `handleStart` — auto-routes to `resume:true` when loop history exists
- `Topbar.tsx:250` — toggles button label to **Resume** when paused

## Verification

End-to-end test matrix (run after the script + docs land):

1. **Clean path unchanged** — `reset-example-to.sh clean` → welcome → start. Observe full run from prerequisites. Confirms we haven't regressed the default flow.
2. **after-clarification** — `reset-example-to.sh after-clarification` → welcome (submit reads `Open Existing`) → loop page (button reads `Resume`) → click. Expect orchestrator's first emitted stage to be `gap_analysis` or `specify`, not `prerequisites`. Confirm via `/tmp/dex-logs/electron.log` and the trace view.
3. **after-tasks** — same flow. Expect the first emitted stage to be `implement` for `specs/001-<feature>`. Confirm `state.json.lastCompletedStage` is `"tasks"` before the click, and that `reconcileState()` warnings in the log mention zero drift.
4. **Drift detection still works** — from `after-tasks`, manually delete `specs/001-<feature>/plan.md`, then launch. Expect `reconcileState()` to warn and rewind that feature to `planning`. Proves fixtures don't bypass safety.
5. **Branch hygiene** — after the run, `git branch -l 'fixture/*'` on `dex-ecommerce` shows exactly 2 entries; no duplicated `-v2` branches.

Lightweight checks first:
- `npx tsc --noEmit` (n/a — no TS changes)
- `bash -n dex/scripts/reset-example-to.sh` (syntax check)
- Run the script with a bogus arg → exit 2
- Run it with `clean` and confirm `git status` matches current reset behavior byte-for-byte
