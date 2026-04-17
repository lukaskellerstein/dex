# Quickstart — Fast-Path Testing via Fixture Branches

**Feature**: 005-testing-improvements

One-time fixture capture + per-test reset workflow. Run every step from the Dex repo root unless noted.

---

## 0. Prerequisites

- `dex-ecommerce` cloned at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`
- `jq` available on `$PATH`
- `dev-setup.sh` running (for the fixture-capture step only)

---

## 1. One-time fixture capture

Skip this section if both `fixture/*` branches already exist on `dex-ecommerce`.

```bash
# Start clean
./dex/scripts/reset-example-to.sh clean

# Open dex-ecommerce in Dex via welcome screen
# (path: /home/lukas/Projects/Github/lukaskellerstein, name: dex-ecommerce)

# Enable Automatic Clarification, click Start Autonomous Loop
# Watch the trace. When state.json shows lastCompletedStage="manifest_extraction"
# (before gap_analysis/specify begins), click Stop (label is "Stop" in the Topbar —
# functionally a pause; orchestrator writes status="paused" in the finally block).

cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# Confirm we're at the right pause point
jq -e '.status == "paused" and .lastCompletedStage == "manifest_extraction"' .dex/state.json

# Rewrite state.json.branchName to the fixture branch name BEFORE committing.
# The reset script's drift check (FR-005) requires this invariant — without the
# rewrite, the fixture restore fails with "fixture drift: state.json branchName != ...".
ORIG=$(jq -r '.branchName' .dex/state.json)
jq '.branchName = "fixture/after-clarification"' .dex/state.json > .dex/state.json.tmp && mv .dex/state.json.tmp .dex/state.json

# Commit + create/force-update fixture branch pointer
git add -A
git commit -m "fixture: after-clarification"
git branch -f fixture/after-clarification HEAD

# Restore the working-tree state.json.branchName so the orchestrator can resume.
# (detectStaleState compares state.branchName to the currently-checked-out branch;
# after the commit we're still on the run branch dex/YYYY-MM-DD-xxxxxx.)
jq --arg b "$ORIG" '.branchName = $b' .dex/state.json > .dex/state.json.tmp && mv .dex/state.json.tmp .dex/state.json

# Back in the UI: navigate Home → reopen dex-ecommerce → click Resume.
# (Stopping sets loopTermination in the UI, which disables the Topbar button even
# though state.json.status is "paused". Home+reopen remounts the orchestrator hook
# and clears loopTermination. If the button stays disabled, call the resume path
# directly from DevTools: await window.dexAPI.startRun({projectDir: ".../dex-ecommerce",
# specDir: "", mode: "loop", model: "claude-opus-4-6", maxIterations: 50, maxTurns: 75,
# phases: "all", resume: true}).)

# Let the loop run through gap_analysis → specify → plan → tasks. When state.json
# shows lastCompletedStage="tasks" and currentSpecDir is populated, click Stop before
# implement begins writing code.

# Confirm
jq -e '.status == "paused" and .lastCompletedStage == "tasks" and .currentSpecDir != null' .dex/state.json

# Capture after-tasks fixture (same branchName-rewrite dance)
jq '.branchName = "fixture/after-tasks"' .dex/state.json > .dex/state.json.tmp && mv .dex/state.json.tmp .dex/state.json
git add -A
git commit -m "fixture: after-tasks"
git branch -f fixture/after-tasks HEAD

# Sanity
git branch -l 'fixture/*'
# Expected: exactly two lines — fixture/after-clarification and fixture/after-tasks
git show fixture/after-clarification:.dex/state.json | jq '{branchName, lastCompletedStage, currentSpecDir}'
# Expected: {branchName: "fixture/after-clarification", lastCompletedStage: "manifest_extraction", currentSpecDir: null}
git show fixture/after-tasks:.dex/state.json | jq '{branchName, lastCompletedStage, currentSpecDir}'
# Expected: {branchName: "fixture/after-tasks", lastCompletedStage: "tasks", currentSpecDir: "specs/NNN-<feature>"}
```

Refresh later (when `GOAL.md`, constitution template, or spec templates evolve) by repeating the same flow. `git branch -f` moves the pointer in place — no `-v2` variants.

---

## 2. Per-test reset (the common path)

```bash
# Pick the checkpoint matching your change's impact:
# - clean: change affects prerequisites, clarification, constitution, or manifest_extraction
# - after-clarification: change affects gap_analysis, specify, plan, tasks
# - after-tasks: change affects implement, implement_fix, verify, learnings

./dex/scripts/reset-example-to.sh after-tasks
# Script prints `git status --short` at the end. Should be empty.
```

Then:

1. Walk through the welcome screen. Submit button reads **Open Existing**.
2. Loop page primary button reads **Resume** (auto-detected from loop history per `App.tsx:297-304`).
3. Click Resume. Orchestrator skips prerequisites, reuses the existing `runId`, and starts from the next stage (`implement` for `after-tasks`, `gap_analysis` or `specify` for `after-clarification`).

---

## 3. Verification matrix

Run after the scripts + docs land. Each row is a pass/fail check.

| # | Scenario | Command / Action | Expected |
|---|----------|------------------|----------|
| V1 | Clean path unchanged | `./dex/scripts/reset-example-to.sh clean` | Same output as legacy `git checkout main && git reset --hard HEAD && git clean -fdx` (SC-003). `ls` shows `GOAL.md` only. |
| V2 | `after-clarification` resume | `./dex/scripts/reset-example-to.sh after-clarification`, welcome → Resume | First emitted stage is `gap_analysis` or `specify`, not `prerequisites`. `~/.dex/dev-logs/electron.log` shows `runLoop: skipping prerequisites (resume)`. |
| V3 | `after-tasks` resume | `./dex/scripts/reset-example-to.sh after-tasks`, welcome → Resume | First emitted stage is `implement` for `specs/001-<feature>`. `reconcileState()` logs zero drift. |
| V4 | Zero-drift invariant (SC-004) | After V3, check orchestrator logs | No `modifiedArtifacts`, no `missingArtifacts`, no `taskRegressions`. |
| V5 | Drift detection still works (SC-006) | After V3 but before clicking Resume: `cd dex-ecommerce && rm specs/001-*/plan.md`, then Resume | `reconcileState()` warns and rewinds feature to `planning`. |
| V6 | Unknown arg (SC-007) | `./dex/scripts/reset-example-to.sh bogus` | Exit 2, stderr: `unknown checkpoint: bogus`. |
| V7 | Missing fixture (SC-007) | Temporarily `git branch -D fixture/after-tasks`, then `./dex/scripts/reset-example-to.sh after-tasks` | Non-zero exit, error from `git rev-parse --verify`. Restore: `git branch fixture/after-tasks <original-sha>`. |
| V8 | Drift detection in reset script (SC-007) | Edit `.dex/state.json` on `fixture/after-tasks` to set `branchName: "main"`, commit, force-update fixture. Run `./dex/scripts/reset-example-to.sh after-tasks` | Non-zero exit, stderr: `fixture drift: state.json branchName != fixture/after-tasks`. Roll back the edit. |
| V9 | Branch count invariant (SC-005) | `git -C dex-ecommerce branch -l 'fixture/*' | wc -l` after 10 mixed test runs | Exactly `2`. |
| V10 | Prune drops aged branches (SC-008) | Create `dex/fake-old` with a commit dated 10 days ago, `dex/fake-new` dated today. Run `./dex/scripts/prune-example-branches.sh` | `dex/fake-old` deleted, `dex/fake-new` remains. |
| V11 | Prune preserves reserved (SC-008) | Ensure `main`, `fixture/after-clarification`, `fixture/after-tasks`, `lukas/full-dex` all exist. Backdate one of them via a test commit. Run prune. | None of them deleted. |
| V12 | Bash syntax | `bash -n dex/scripts/reset-example-to.sh && bash -n dex/scripts/prune-example-branches.sh` | Both exit 0. |

Lightweight checks (fast, zero-cost):

```bash
bash -n dex/scripts/reset-example-to.sh
bash -n dex/scripts/prune-example-branches.sh
./dex/scripts/reset-example-to.sh bogus; echo "exit=$?"   # expect exit=2
```

---

## 4. Troubleshooting

**`fixture drift: state.json branchName != ...`**
The committed `.dex/state.json` on the fixture branch has the wrong `branchName`. Recapture the fixture (section 1) or manually edit `state.json` to match the branch name and `git commit --amend`.

**`fatal: Needed a single revision`**
The named fixture branch doesn't exist. Either you're on a fresh clone, or a previous prune/cleanup deleted it. Recapture per section 1.

**Orchestrator emits `prerequisites` after restore**
`detectStaleState` decided the state is stale — likely because `state.branchName` disagrees with the checked-out branch, or `state.status` is not `paused`. Inspect `~/.dex/dev-logs/electron.log` for the specific reason. Re-verify section 1's capture conditions on `state.json`.

**`reconcileState()` rewinds unexpectedly after restore**
Something in the fixture's committed artifacts disagrees with `state.artifacts.*.sha256`. Usually means the fixture is stale relative to the template that produced it — refresh the fixture (section 1).

---

## 5. Stage-skip reference

```text
Full loop stages (STAGE_ORDER, state.ts:356-372):
prerequisites → clarification → clarification_product → clarification_technical →
clarification_synthesis → constitution → manifest_extraction → gap_analysis →
specify → plan → tasks → implement → implement_fix → verify → learnings

clean                 → runs all stages
after-clarification   → skips through manifest_extraction; first run stage = gap_analysis or specify
after-tasks           → skips through tasks; first run stage = implement
```
