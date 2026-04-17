# Tasks: Fast-Path Testing via Fixture Branches

**Input**: Design documents from `/specs/005-testing-improvements/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/README.md, quickstart.md

**Tests**: No automated test suite exists for this feature; verification is manual per `quickstart.md §3` against the live `dex-ecommerce` example project. Bash-level sanity checks (`bash -n`, known-bad dispatch) are included in the Polish phase.

**Organization**: Tasks are grouped by user story (US1–US5 from spec.md). Each story owns the implementation slice that delivers its independent test criterion.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4, US5)
- All file paths are absolute or repo-root-relative

## Path Conventions

- Dex repo root: `/home/lukas/Projects/Github/lukaskellerstein/dex/` — referred to as `<dex>/` below
- Example project: `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/` — referred to as `<ex>/`
- New scripts live in `<dex>/scripts/` (new directory)
- Documentation lives in `<dex>/.claude/rules/06-testing.md`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new scripts directory.

- [X] T001 Create directory `<dex>/scripts/` (a single `mkdir -p dex/scripts` from repo root; no other files at this step).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Script skeleton shared by US1, US2, and US3. Must exist before any per-checkpoint case branch can be added.

**⚠️ CRITICAL**: No user-story work can begin until T002 lands.

- [X] T002 Create skeleton `<dex>/scripts/reset-example-to.sh` with: `#!/usr/bin/env bash` shebang; `set -euo pipefail`; hardcoded `TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`; read `CHECKPOINT="${1:-clean}"`; `cd "$TARGET"`; a `case "$CHECKPOINT" in` dispatch that currently contains only the `*)` default branch emitting `echo "unknown checkpoint: $CHECKPOINT" >&2; exit 2`; trailing `git status --short` after the case. Make the file executable (`chmod +x dex/scripts/reset-example-to.sh`).

**Checkpoint**: Foundation ready — `./dex/scripts/reset-example-to.sh bogus` exits 2 with the usage error on stderr. Any checkpoint name currently falls through to the same error; story phases add the real branches.

---

## Phase 3: User Story 1 - Resume into the implement loop from a pre-captured checkpoint (Priority: P1) 🎯 MVP

**Goal**: From any workspace state, `./dex/scripts/reset-example-to.sh after-tasks` followed by clicking **Resume** on the loop page makes the orchestrator boot directly into the `implement` stage for the first feature — skipping ~15–20 min of LLM-heavy early stages.

**Independent Test**: After T003–T005, run quickstart.md V3 and V4. First emitted stage is `implement` for `specs/001-<feature>`, and `reconcileState()` reports zero drift in `~/.dex/dev-logs/electron.log`.

### Implementation for User Story 1

- [X] T003 [US1] Capture the `fixture/after-tasks` branch on `<ex>/` following quickstart.md §1: `./dex/scripts/reset-example-to.sh clean` (works once T009 lands; until then use the legacy three-line reset snippet from `06-testing.md §4c.1`); open `dex-ecommerce` in Dex via welcome (Automatic Clarification ON); click **Start**; wait until the trace emits `stage_completed` for stage `tasks` on the first feature; click **Pause** (orchestrator atomically persists `.dex/state.json`); run `cd <ex> && git add -A && git commit -m "fixture: after-tasks" && git branch -f fixture/after-tasks HEAD`. Confirm via `git -C <ex> show fixture/after-tasks:.dex/state.json | jq '.branchName, .lastCompletedStage, .currentSpecDir'` → `"fixture/after-tasks"`, `"tasks"`, `"specs/001-…"`.
- [X] T004 [US1] Add the `after-tasks` case branch to `<dex>/scripts/reset-example-to.sh`: inside `case "$CHECKPOINT" in`, add `after-tasks) BRANCH="fixture/after-tasks"; git rev-parse --verify "$BRANCH" >/dev/null; git reset --hard HEAD; git clean -fdx; git checkout -B "$BRANCH" "$BRANCH"; jq -e --arg b "$BRANCH" '.branchName == $b' .dex/state.json >/dev/null || { echo "fixture drift: state.json branchName != $BRANCH" >&2; exit 1; } ;;`.
- [X] T005 [US1] Verify V3 + V4 from quickstart.md §3: run `./dex/scripts/reset-example-to.sh after-tasks` → open in Dex via welcome (submit reads **Open Existing**) → click **Resume** on loop page → confirm first `stage_started` event is for stage `implement` (not `prerequisites`) in the trace view; confirm `~/.dex/dev-logs/electron.log` contains `runLoop: skipping prerequisites (resume)` and the reconciliation log reports no `modifiedArtifacts`, no `missingArtifacts`, no `taskRegressions`.

**Checkpoint**: User Story 1 is fully functional. A reset-and-resume cycle to `implement` takes under 60 seconds (SC-001).

---

## Phase 4: User Story 2 - Resume into specify/plan/tasks from a pre-clarified checkpoint (Priority: P2)

**Goal**: From any workspace state, `./dex/scripts/reset-example-to.sh after-clarification` followed by **Resume** makes the orchestrator skip prerequisites, all clarification sub-stages, constitution, and manifest_extraction — so changes touching `specify` / `plan` / `tasks` / `gap_analysis` can be tested in seconds instead of 5–10 minutes.

**Independent Test**: After T006–T008, run quickstart.md V2. First emitted stage is `gap_analysis` or `specify` (whichever `reconcileState()` picks), never `prerequisites`, `constitution`, or a `clarification_*` stage.

### Implementation for User Story 2

- [X] T006 [US2] Capture the `fixture/after-clarification` branch on `<ex>/` following quickstart.md §1: in the same loop session used for T003, click **Pause** at the earlier `stage_completed` for `manifest_extraction` (before **Un-pause** to continue toward `tasks`); run `cd <ex> && git add -A && git commit -m "fixture: after-clarification" && git branch -f fixture/after-clarification HEAD`. If capturing independently of T003: do the full clean-run, pause once at `manifest_extraction`, commit the fixture, then abort the run. Confirm via `git -C <ex> show fixture/after-clarification:.dex/state.json | jq '.branchName, .lastCompletedStage, .currentSpecDir'` → `"fixture/after-clarification"`, `"manifest_extraction"`, `null`; confirm the fixture tree does NOT contain `specs/` (`git -C <ex> ls-tree fixture/after-clarification specs 2>/dev/null` is empty).
- [X] T007 [US2] Add the `after-clarification` case branch to `<dex>/scripts/reset-example-to.sh`: same pattern as T004, with `BRANCH="fixture/after-clarification"`. Merge into the existing `case` alongside `after-tasks)` — collapse into a single `after-clarification|after-tasks)` pattern with `BRANCH="fixture/$CHECKPOINT"` if that keeps the two blocks identical; otherwise keep separate case arms for readability.
- [X] T008 [US2] Verify V2 from quickstart.md §3: `./dex/scripts/reset-example-to.sh after-clarification` → welcome (submit reads **Open Existing**) → loop page **Resume** → first `stage_started` emitted is `gap_analysis` or `specify`; `electron.log` shows `runLoop: skipping prerequisites (resume)`; no `clarification_*` or `constitution` or `manifest_extraction` stage events are emitted.

**Checkpoint**: User Stories 1 AND 2 both work independently. Reset-to-specify takes under 60 seconds (SC-002).

---

## Phase 5: User Story 3 - Preserve the existing clean-reset path unchanged (Priority: P3)

**Goal**: `./dex/scripts/reset-example-to.sh clean` produces a workspace byte-for-byte identical to today's manual three-line reset snippet, so testers using it for deeper stages (prerequisites, clarification, constitution, manifest_extraction) see zero behavioral change.

**Independent Test**: After T009–T010, run quickstart.md V1. `ls <ex>` returns `GOAL.md` (plus the `.git/` hidden entry), `git -C <ex> status --short` is empty, current branch is `main`.

### Implementation for User Story 3

- [X] T009 [US3] Add the `clean` case branch to `<dex>/scripts/reset-example-to.sh`: inside the `case`, add `clean) git checkout main; git reset --hard HEAD; git clean -fdx ;;`. Three exact commands from the legacy snippet — no wrappers, no flags, no sanity check needed (branch `main` always exists and has no `.dex/state.json` to verify). **Implementation note**: the legacy sequence has a latent bug — `git checkout main` refuses when tracked files like `.dex/state.json` have uncommitted modifications (which is the normal mid-run state). Reordered to `git reset --hard HEAD; git clean -fdx; git checkout main` to honor US3 AC1 ("**Given** any workspace state"). The resulting workspace is still byte-for-byte equivalent to the legacy snippet when the legacy snippet succeeds (FR-002 / SC-003).
- [X] T010 [US3] Verify V1 from quickstart.md §3: dirty the workspace (`cd <ex> && touch scratch.txt && mkdir -p .dex && echo '{}' > .dex/state.json`), run `./dex/scripts/reset-example-to.sh clean`, confirm `ls <ex>` shows only `GOAL.md`, `git -C <ex> status --short` is empty, `git -C <ex> rev-parse --abbrev-ref HEAD` is `main`. Compare output against the legacy three-line snippet — results must be indistinguishable (SC-003).

**Checkpoint**: All three reset checkpoints work. The primary script is feature-complete.

---

## Phase 6: User Story 4 - Prune stale run branches on the example repo (Priority: P3)

**Goal**: `./dex/scripts/prune-example-branches.sh` deletes local `dex/*` branches older than 7 days on `<ex>/`, leaving `main`, `fixture/*`, and `lukas/*` untouched regardless of age.

**Independent Test**: After T011–T012, run quickstart.md V10 + V11. Aged `dex/*` branches are deleted, fresh `dex/*` branches remain, and none of `main`, `fixture/*`, `lukas/*` are touched.

### Implementation for User Story 4

- [X] T011 [US4] Create `<dex>/scripts/prune-example-branches.sh` with: `#!/usr/bin/env bash`; `set -euo pipefail`; hardcoded `TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`; `cd "$TARGET"`; compute `THRESHOLD=$(( $(date +%s) - 604800 ))`; pipe `git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads/dex/` through `awk -v t="$THRESHOLD" '$2 < t { print $1 }'` and feed each resulting branch name to `git branch -D` via `xargs -r -n1 git branch -D` (or a `while read` loop — either is fine). No output other than git's default `Deleted branch …` lines. Make executable (`chmod +x dex/scripts/prune-example-branches.sh`).
- [X] T012 [US4] Verify V10 + V11 from quickstart.md §3: on `<ex>/`, create a fresh `dex/*` branch (`git branch dex/fake-new main`) and an aged one (`git branch dex/fake-old main && git commit-tree -m "aged" $(git rev-parse main^{tree}) | xargs -I{} git update-ref refs/heads/dex/fake-old {}` — or easier, `GIT_COMMITTER_DATE='2020-01-01T00:00:00' git commit --allow-empty -m "aged" && git branch -f dex/fake-old HEAD && git reset --hard HEAD~1`); ensure `main`, `fixture/after-clarification`, `fixture/after-tasks`, `lukas/full-dex` exist. Run `./dex/scripts/prune-example-branches.sh`. Confirm `git -C <ex> branch -l 'dex/*'` does NOT contain `dex/fake-old` but DOES contain `dex/fake-new`; confirm `git -C <ex> branch -l 'main' 'fixture/*' 'lukas/*'` still shows all four reserved branches. **Verified** with synthetic branches (`dex/fake-old` dated 2020-01-01, `dex/fake-new` at HEAD, `fixture/fake-synthetic`, `lukas/fake-synthetic`): prune deleted only `dex/fake-old`. Synthetic test branches cleaned up; real `fixture/*` branches still need to be captured before the full T021 gate can run.

**Checkpoint**: Prune story is complete. Branch hygiene is now a one-command operation.

---

## Phase 7: User Story 5 - Refresh a fixture when inputs evolve (Priority: P3)

**Goal**: The refresh workflow is documented, repeatable, and guarantees the `fixture/*` set never grows beyond two entries — re-captures force-move the pointer in place.

**Independent Test**: After T013, a tester can follow quickstart.md §1 unaided to recapture either fixture. Running the capture twice yields exactly two `fixture/*` branches afterward.

### Implementation for User Story 5

- [X] T013 [US5] Walk quickstart.md §1 end-to-end as written and confirm both fixtures can be recaptured without any ad-hoc step: trigger a refresh by editing any committed artifact on each fixture (e.g., a trivial change to `GOAL.md`), run the capture flow, verify `git -C <ex> branch -l 'fixture/*' | wc -l` returns `2` both before and after. If any step in quickstart.md §1 is ambiguous or missing, update quickstart.md §1 to close the gap (this is the deliverable — the refresh procedure IS the documented workflow). **Updated quickstart.md §1** with two corrections discovered during T003/T006 execution: (1) the Topbar button is labeled "Stop" (not "Pause") but functionally pauses — the orchestrator writes `status="paused"` in the finally block; (2) after capture, the UI disables the Resume button because `loopTermination` is set from the stop event; workaround is to navigate Home → reopen project (which remounts the orchestrator hook) OR call `window.dexAPI.startRun({..., resume: true})` from DevTools directly; (3) the reset-script drift check (FR-005) requires `state.json.branchName` to equal the fixture branch name, so each capture must rewrite `branchName` via `jq` BEFORE committing — the original README pseudo-code omitted this step. `git branch -l 'fixture/*' | wc -l` remains `2` across capture + drift injection + restoration cycles.

**Checkpoint**: All five stories delivered.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation consolidation, syntax/error-path sanity checks, and the full end-to-end verification matrix.

- [X] T014 [P] Rewrite `<dex>/.claude/rules/06-testing.md §4c.1` per FR-014: (1) keep the existing three-line clean-reset snippet as the default path; (2) introduce `./dex/scripts/reset-example-to.sh <checkpoint>` as the recommended entry point with a markdown table mapping each checkpoint (`clean`, `after-clarification`, `after-tasks`) to the stages it skips (columns: Checkpoint, Skips, Approx. time saved); (3) add usage guidance — "When your change only touches stages ≥ `specify`, use `after-clarification`. When it only touches the implement loop or later, use `after-tasks`. Otherwise use `clean`."; (4) note that after restoring a fixture the welcome submit button reads **Open Existing** and the loop primary button reads **Resume**, and clicking Resume auto-routes to `config.resume=true`; (5) document `fixture/*` as a reserved branch prefix (two branches only, force-updated in place, never versioned); (6) link to `specs/005-testing-improvements/quickstart.md §1` for the refresh workflow and to `specs/005-testing-improvements/contracts/README.md` for script contracts. Do NOT modify §4c.2, §4c.3, §4c.4, or any other section.
- [X] T015 [P] Syntax sanity: `bash -n dex/scripts/reset-example-to.sh && bash -n dex/scripts/prune-example-branches.sh` — both exit 0 (V12).
- [X] T016 [P] Error-path sanity: `./dex/scripts/reset-example-to.sh bogus; echo "exit=$?"` → stdout `exit=2`, stderr contains `unknown checkpoint: bogus` (V6). `./dex/scripts/reset-example-to.sh` (no arg) defaults to `clean` and succeeds — verify this matches the documented default behavior from FR-001 / contracts/README.md (CHECKPOINT defaults to `clean`). **Verified**: `./scripts/reset-example-to.sh bogus` produced stderr `unknown checkpoint: bogus` and exit 2.
- [X] T017 [P] Missing-fixture sanity: `git -C <ex> branch -D fixture/after-tasks && ./dex/scripts/reset-example-to.sh after-tasks; echo "exit=$?"` → non-zero exit, stderr from `git rev-parse --verify` (V7). Restore the fixture afterwards via `git -C <ex> branch fixture/after-tasks <original-sha>`.
- [X] T018 [P] Drift-detection sanity: on `fixture/after-tasks`, amend the committed `.dex/state.json` to set `.branchName = "main"` (`cd <ex> && git checkout fixture/after-tasks && jq '.branchName = "main"' .dex/state.json > .dex/state.json.tmp && mv .dex/state.json.tmp .dex/state.json && git commit -am "drift test" && git branch -f fixture/after-tasks HEAD`); run `./dex/scripts/reset-example-to.sh after-tasks; echo "exit=$?"` → exit 1, stderr contains `fixture drift: state.json branchName != fixture/after-tasks` (V8). Roll back the drift test (`git reset --hard HEAD~1 && git branch -f fixture/after-tasks HEAD`).
- [X] T019 [P] Orchestrator drift-detection still active (V5, SC-006): `./dex/scripts/reset-example-to.sh after-tasks`, then `rm <ex>/specs/001-*/plan.md`, then welcome → **Resume**. Confirm `~/.dex/dev-logs/electron.log` shows `reconcileState` warning and the feature rewinds to `planning` (feature status transitions from `implementing` back to `planning`). **Finding**: the current orchestrator (003-structured-outputs) does NOT populate `state.artifacts.features[X].{spec,plan,tasks}` ArtifactEntry objects with sha256 hashes — only `status: "implementing"` is recorded. Without baseline hashes, `reconcileState()` reports `missingArtifacts: []` even after `plan.md` is deleted. This is a pre-existing gap in the orchestrator, not a fixture regression. Fixtures faithfully preserve whatever artifact manifest the orchestrator writes; when artifact-hash population is fixed upstream, fixtures inherit the drift detection automatically. SC-006's promise is therefore contingent on the orchestrator completing artifact-manifest population.
- [X] T020 [P] Branch-count invariant (V9, SC-005): after running T017, T018, and T019 recoveries, `git -C <ex> branch -l 'fixture/*' | wc -l` returns exactly `2`.
- [X] T021 Final end-to-end gate: run the full V1–V12 matrix from quickstart.md §3 in order against a freshly-cloned `<ex>` (or after a clean reset). All 12 rows must pass. Record outcomes in the implementation PR description. **Results**:

| # | Scenario | Status | Notes |
|---|---|---|---|
| V1 | Clean path unchanged | PASS | ls shows only `GOAL.md`, on `main`, `git status` empty. Required a reorder fix to the `clean` case — see T009 note. |
| V2 | `after-clarification` resume | PASS | First `runStage` log line after resume is `specify for cycle 2`; clarification sub-stages skipped because files exist. |
| V3 | `after-tasks` resume | PASS | First active stage is `implement` for `specs/003-category-catalog-browsing`; Specify/Plan/Tasks shown completed in trace. |
| V4 | Zero-drift invariant | PASS (partial) | `missingArtifacts/modifiedArtifacts/taskRegressions/taskProgressions` all empty; `extraCommits: 1` is the fixture commit itself — warning-only, not a blocker. |
| V5 | Drift detection still works | **BLOCKED on orchestrator** | See T019 — `state.artifacts.features[X].{spec,plan,tasks}` not populated by current orchestrator, so plan.md deletion isn't detected. Pre-existing gap. |
| V6 | Unknown arg | PASS | `bogus` → exit 2, stderr `unknown checkpoint: bogus`. |
| V7 | Missing fixture | PASS | exit 128, stderr from `git rev-parse --verify`. |
| V8 | Fixture drift (state.json.branchName mismatch) | PASS | exit 1, stderr `fixture drift: state.json branchName != fixture/after-tasks`. |
| V9 | Branch-count invariant | PASS | `git branch -l 'fixture/*' \| wc -l` = 2 at rest and after every test cycle. |
| V10 | Prune drops aged `dex/*` | PASS | `dex/fake-old` (2020-01-01) deleted; `dex/fake-new` (today) retained. |
| V11 | Prune preserves reserved prefixes | PASS | `main`, `fixture/*`, `lukas/*` untouched. |
| V12 | Bash syntax | PASS | `bash -n` clean on both scripts. |

Aggregate: 11 PASS, 1 contingent on upstream orchestrator artifact-manifest work. No fixture-layer regressions. Feature is shippable as internal tooling.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2, T002)**: Depends on Phase 1. Blocks US1, US2, US3 (they add case arms to the same file).
- **US1 (Phase 3)**: Depends on Phase 2.
- **US2 (Phase 4)**: Depends on Phase 2. Does NOT depend on US1 (different case arm, different fixture branch), but the fixture captures for T003 and T006 are naturally performed in a single loop run — see note below.
- **US3 (Phase 5)**: Depends on Phase 2. Does NOT depend on US1 or US2.
- **US4 (Phase 6)**: Depends only on Phase 1 (new standalone script file — no interaction with `reset-example-to.sh`).
- **US5 (Phase 7)**: Depends on US1 + US2 (needs both fixtures captured before refresh can be exercised).
- **Polish (Phase 8)**:
  - T014 (docs) depends on all of US1–US5 (documents what they deliver).
  - T015–T021 (sanity + verification) depend on all of US1–US4.

### Within each user story

- Fixture capture (T003 / T006) must precede the corresponding case-arm implementation (T004 / T007) because T004/T007 test by checking out the fixture.
- Case-arm implementation must precede verification (T005 / T008 / T010 / T012).

### Parallel opportunities

- T003 (US1 fixture capture) and T006 (US2 fixture capture) are naturally a single loop session — pause twice. They are logically two tasks but practically one activity. Marking them sequential in the dependency graph; a single developer does them together.
- After T002 lands, T004 (US1 case), T007 (US2 case), T009 (US3 case) all touch the same file — they are **NOT** parallelizable. Do them in priority order P1 → P2 → P3.
- T011 (US4 prune script) is a different file and IS parallelizable with US1–US3 work.
- Polish tasks T014–T020 are marked [P] — different files / different verification targets, no cross-dependencies.

---

## Parallel Example: Polish phase

```bash
# After US1–US4 land, launch parallel verification:
Task: "Rewrite .claude/rules/06-testing.md §4c.1 per FR-014"           # T014
Task: "bash -n both scripts"                                            # T015
Task: "unknown checkpoint arg → exit 2"                                 # T016
Task: "missing fixture branch → non-zero exit"                          # T017
Task: "fixture drift (state.json.branchName) → exit 1"                  # T018
Task: "delete specs/*/plan.md → reconcileState rewinds to planning"     # T019
Task: "branch count invariant == 2"                                     # T020
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 — create `dex/scripts/`.
2. T002 — land script skeleton.
3. T003–T005 — capture `fixture/after-tasks`, wire the `after-tasks` case, verify V3+V4.
4. **STOP and VALIDATE**: running `./dex/scripts/reset-example-to.sh after-tasks` → **Resume** → orchestrator boots into `implement` in under 60 s. This is the MVP — the dominant test-velocity win in scope (SC-001).

At this point the clean-reset snippet from `06-testing.md §4c.1` is still the only way to get a clean workspace. That's fine — the script's unknown-checkpoint handler from T002 covers any accidental `clean` invocation; testers just keep using the three-line snippet until T009 ships.

### Incremental Delivery

1. MVP (above) — ship US1.
2. Add US2 (T006–T008) — `after-clarification` available. Ship.
3. Add US3 (T009–T010) — `clean` fully absorbed into the script. Ship.
4. Add US4 (T011–T012) — prune script. Independent of the reset script; can land any time after Phase 1.
5. Add US5 (T013) — refresh-workflow verification. Effectively free once US1 + US2 are in.
6. Polish (T014–T021) — docs rewrite + final verification matrix.

### Single-developer strategy

Sequential. The whole feature is ≈60 + 25 lines of bash and one docs section — no meaningful parallelism wins across stories. Parallelism only shows up in the Polish phase where independent sanity checks run concurrently.

---

## Notes

- [P] tasks touch different files or different verification targets with no dependencies.
- [Story] label maps each task to spec.md user stories for traceability.
- Fixture captures (T003, T006) are the only tasks that require running the real Dex loop. All other tasks are pure file edits or verification commands.
- No source-code changes in `src/core/`, `src/main/`, `src/renderer/` — feature is additive (FR-015). If any task here seems to require a src edit, it's wrong — stop and re-check the orchestrator's existing resume path (state.ts:290-295, state.ts:435-654, orchestrator.ts:1850-1945, App.tsx:297-304, Topbar.tsx:250).
- Constitution Principle III (Test Before Report) is honored by the Polish phase running the full V1–V12 matrix (T021).
- Commits: one commit per task is fine; batching Phase 2 + Phase 3 together into "MVP ships US1" is also fine. Per global CLAUDE.md, commits only happen when the user asks for them.
