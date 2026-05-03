# Tasks: Branch Namespace + Record-mode Cleanup

**Input**: Design documents from `/specs/013-cleanup-2/`
**Prerequisites**: plan.md (loaded), spec.md (loaded), research.md, data-model.md, contracts/, companion `docs/my-specs/013-cleanup-2/README.md`

**Tests**: Required for this feature — the spec mandates updates to existing tests AND adds three new behavioural assertions in `jumpTo.test.ts` (US1: autosave-on-current-branch, detached-HEAD refusal, save-on-`selected-*`). These are listed as implementation tasks within US1, not as separate TDD scaffolding.

**Organization**: Tasks are grouped by user story to enable independent verification of each story. The README's numbered implementation order is preserved within phases — type-check + test + lint must pass between phases (NFR-001).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story label (US1, US2, US3, US4)
- File paths are repository-absolute relative to `/home/lukas/Projects/Github/lukaskellerstein/dex/`

## Path Conventions

- Source: `src/core/`, `src/main/`, `src/renderer/`
- Tests: `src/**/__tests__/`
- Scripts: `scripts/`
- Docs: `CLAUDE.md`, `.claude/rules/`, `docs/my-specs/`

---

## Phase 1: Setup

**Purpose**: Re-validate the spec's grep audits before touching any code. If anything beyond what the README documents appears, stop and update the spec.

- [X] T001 Run pre-flight grep audit per `specs/013-cleanup-2/quickstart.md` §1 — eight grep patterns; cross-reference against expected hits in `docs/my-specs/013-cleanup-2/README.md` §11 ("Pre-flight grep") and §"Why this is safe". If a non-listed hit appears, halt and update the spec.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Relocate `syncStateFromHead` so the rest of the cleanup can delete `recordMode.ts` cleanly. This is a strict prerequisite — every other phase depends on this completing without behaviour change. Also enables US3 (regression check) to be validated independently.

**⚠️ CRITICAL**: No user-story phase work can begin until this phase is complete and gated green.

- [X] T002 Create `src/core/checkpoints/syncState.ts` — move `syncStateFromHead` (currently at `src/core/checkpoints/recordMode.ts:75-160`) and its module-private helper `snapshotResumeFields` (`recordMode.ts:162-184`) verbatim; same signatures, same bodies, same dependencies. Rewrite the file-header `What/Not/Deps` JSDoc to narrate "post-jumpTo state.json reconciliation from HEAD's step-commit subject". Drop the `tags.ts` import — function does its own subject regex.
- [X] T003 Update `src/core/checkpoints/index.ts` flat re-export — replace `export { syncStateFromHead } from "./recordMode.js";` with `export { syncStateFromHead } from "./syncState.js";`. **Leave the namespace object's `recordMode.js` block in place for now** — it is removed in T018 inside US2 once the rest of the file's symbols are deleted; TypeScript still sees a valid module path until then.
- [X] T004 Verify import sites resolve unchanged — `src/main/ipc/checkpoints.ts:10`, `src/main/preload-modules/checkpoints-api.ts:12`, `src/renderer/services/checkpointService.ts:88`, `src/renderer/electron.d.ts:33`, `src/renderer/App.tsx:289`. All five consume via the barrel; no per-file edit needed.
- [X] T005 Gate — `npx tsc --noEmit && npm test && npm run lint`. Must be green before any user-story phase begins. *(tsc green, 119 tests pass; pre-existing `check:size` failure on `timelineLayout.ts` carried over from branch baseline — not introduced by relocation)*

**Checkpoint**: `syncStateFromHead` is at its new home. The relocation is invisible to consumers. US3 is now testable (verification deferred to Phase 5).

---

## Phase 3: User Story 1 - Save dirty changes when navigating the timeline (Priority: P1) 🎯 MVP

**Goal**: When the user picks **Save** in the Go-Back confirm dialog with a dirty working tree, the system stages changes and creates one commit (`dex: pre-jump autosave`) on the current branch — no side branch, no leaky branch name in dialog copy. Detached HEAD is refused with a friendly message.

**Independent Test**: Open the example project, modify a tracked file, click a different timeline node, pick **Save**. Verify (a) no new branch was created, (b) current branch has exactly one new commit (subject `dex: pre-jump autosave`) containing the dirty change, (c) HEAD then moved to the click target, (d) dialog copy uses new wording and references no branch name.

### Implementation for User Story 1

- [X] T006 [US1] Rewrite the `force: "save"` body in `src/core/checkpoints/jumpTo.ts:129-141` — replace `attempt-<ts>-saved` branch creation + commit with two `gitExec` calls on the current branch: `git add -A` then `git commit -q -m "dex: pre-jump autosave"`. Add detached-HEAD refusal: inline `git symbolic-ref -q HEAD` check; on non-zero exit return `{ ok: false, error: "git_error", message: "Cannot save changes while in detached-HEAD state. Switch to a branch first." }` and skip both staging and commit. Do NOT extract a helper — only one call site (verified). Remove the `attemptBranchName` import on line 9; update the file-header `Deps:` line to drop `attemptBranchName` from the `tags.ts` import (leaving only `selectedBranchName`). Update the `JumpToResult` decision-tree JSDoc (lines 71-79) and the `maybePruneEmptySelected` rationale comment (lines 194-201) to drop `attempt-*` references; document that on `selected-*`, the new commit lands on `selected-*` itself (not on `dex/*`) and is preserved by `maybePruneEmptySelected` because the branch is no longer empty relative to the jump target.
- [X] T007 [US1] Update `src/renderer/components/checkpoints/GoBackConfirm.tsx` — three sites: (a) replace the explanatory paragraph at lines 55-58 ("Save commits these files to a new `attempt-…-saved` branch…") with **"Save commits these changes to the current version so you can keep working with them later."**; (b) change the **button label** at line 28 from `Save on a new branch` to **`Save`**; (c) update the JSDoc at line 12 from "Save (stash uncommitted changes on a new branch)" to "Save (commit dirty changes onto the current branch before jumping)". No occurrence of "branch", "attempt-", or "new branch" should remain in user-visible text.
- [X] T008 [P] [US1] Replace the existing autosave tests in `src/core/__tests__/jumpTo.test.ts` — DELETE the test at line 218 ("008 attempt-<ts> branch is NEVER auto-pruned"), the test at line 239 ("attempt-<ts>-saved is NEVER auto-pruned"), and the block at line 280 referencing `attempt-*-saved`. ADD a new test asserting the post-013 contract: dirty-tree + `force: "save"` produces exactly one new commit on the current branch (subject `dex: pre-jump autosave`), zero new branches (`git branch --list` count unchanged), HEAD then moves to the click target.
- [X] T009 [P] [US1] Add a new test in `src/core/__tests__/jumpTo.test.ts` for **detached-HEAD save refusal** — `git checkout <sha>` (detach), modify a tracked file, call `jumpTo(target, { force: "save" })`; assert `{ ok: false, error: "git_error", message: <friendly> }`, zero new commits across all refs, and no jump occurred.
- [X] T010 [P] [US1] Add a new test in `src/core/__tests__/jumpTo.test.ts` for **save while on `selected-*`** — start on a `selected-*` branch, modify a tracked file, `jumpTo(target, { force: "save" })`; assert (a) the autosave commit lands on the `selected-*` branch (not `main`, not `dex/*`), (b) HEAD jumps to target, (c) post-jump `maybePruneEmptySelected` does NOT delete the original `selected-*` (it has the new commit relative to the target).
- [X] T011 [US1] Gate — `npx tsc --noEmit && npm test && npm run lint`.

**Checkpoint**: User Story 1 is complete and independently testable. The Go-Back confirm dialog is branch-free and the autosave commits on the current branch.

---

## Phase 4: User Story 2 - Run an autonomous loop and inspect the resulting git state (Priority: P2)

**Goal**: After one autonomous loop end-to-end on a freshly-reset example project, the git namespace contains exactly: `main`, one `dex/<date>-<id>`, and `[checkpoint:<step>:<cycle>]` step commits — no `capture/*`, no `checkpoint/done-*`, no `attempt-*`, no auto-promoted `checkpoint/*` tags.

**Independent Test**: `./scripts/reset-example-to.sh clean`; run one autonomous loop to completion; run a small set of git queries against the example project repo to confirm the absence of all four families.

### Implementation for User Story 2

**Producer-side deletion (kills `capture/*`, `checkpoint/done-*`, auto-promote, first `checkpoint_promoted` producer)**

- [X] T012 [US2] Delete the entire Record-mode termination block in `src/core/orchestrator.ts:280-299` — outer `if (runtimeState.activeProjectDir && terminationReason !== "user_abort")` guard plus inner `if (recordMode)` arm, including the `promoteToCheckpoint` call, the `checkpoint_promoted` event emit, and the `git branch -f ${captureBranchName(runId)} HEAD` exec. Delete now-unused imports: `checkpointDoneTag`, `captureBranchName`, `promoteToCheckpoint`, `readRecordMode` (lines 20-23) AND `getHeadSha` from `./git.js` (line 18 — only call site is the deleted block; `getCurrentBranch`, `createBranch` survive). Update the file-header `Deps:` line (line 4) — drop `checkpoints (record-mode termination)` and `git.getHeadSha`.
- [X] T013 [US2] Delete `await autoPromoteIfRecordMode(...)` call at `src/core/stages/finalize.ts:99` and the comment at line 98. Delete the `autoPromoteIfRecordMode` import at line 11. Update the file-header `What:` summary to drop the `autoPromoteIfRecordMode` reference.

**Consumer-side deletion (timeline reading + namespace data)**

- [X] T014 [US2] In `src/core/checkpoints/timeline.ts` (Part A — Record mode): delete the `checkpoint/done-*` reading branch at lines 135-150 of `listTimeline`; delete the `git branch --list 'capture/*'` query block at lines 221-225 (exec on 221, push loop on 222-225); delete `captureBranches: string[]` from the `TimelineSnapshot` type; update the `visibleBranches` filter comment that mentions `capture/*` is excluded.
- [X] T015 [US2] In `src/core/checkpoints/timeline.ts` (Part B — `attempt-*`): delete the `AttemptInfo` type (lines 25-33); delete `attempts`/`currentAttempt` fields on `TimelineSnapshot` (lines 101-102); delete the `git branch --list 'attempt-*'` query block (lines 185-219); delete the `attempt-*` entry in `canonicalPriority` (line 94); delete the `attempt-*` line in the `visibleBranches` filter (line 303); delete the variant-letter regex (line 190); delete `attempts` initialisation + sort calls (lines 118, 217-218, 443) and `currentAttempt` declaration + assignment (lines 121, 218). Collapse the `canonicalPriority` JSDoc (lines 84-90) and the `TimelineCommit.branch` JSDoc (lines 56-60) from "main → dex/* → attempt-* → selected-*" to "main → dex/* → selected-*". Update the file-header `What:` doc (line 2) — drop "attempts" and "capture branches" from the `listTimeline` description.

**Factory + interface deletions**

- [X] T016 [P] [US2] In `src/core/checkpoints/tags.ts`: delete `checkpointDoneTag()` and `captureBranchName()` factories (Part A) AND `attemptBranchName()` factory (Part B). All three become dead after T012-T015 land.
- [X] T017 [P] [US2] Delete the `recordMode?: boolean` field on the `DexUiPrefs` interface in `src/core/state.ts:25`. No migration tooling — pre-existing values are silently ignored (FR-011).

**Module deletion (kills second `checkpoint_promoted` producer)**

- [X] T018 [US2] Delete the entire file `src/core/checkpoints/recordMode.ts`. After T002 (relocation) and T013 (autoPromoteIfRecordMode call gone) and T012 (promote call + readRecordMode usage gone), all remaining symbols (`readRecordMode`, `autoPromoteIfRecordMode`, `promoteToCheckpoint`) are dead.
- [X] T019 [US2] Update `src/core/checkpoints/index.ts` namespace object surface (lines 52-110): delete the `recordMode.js` import block (lines 61-66) and replace with `import { syncStateFromHead } from "./syncState.js";`. Delete namespace fields `doneTag`, `captureBranchName`, `promote`, `readRecordMode`, `autoPromoteIfRecordMode` and the "Promotion + record mode" section comment on line 98. Delete `attemptBranchName` from the `tags.js` import (line 56) and from the namespace object (line 93). Delete `AttemptInfo` from the `timeline.js` re-export (lines 35-43). Also drop `checkpointDoneTag`, `captureBranchName` from the flat `tags.js` re-export and `attemptBranchName` from the same.

**Consumer cascade (parallel — different files)**

- [X] T020 [P] [US2] Update `src/main/ipc/checkpoints.ts` `listTimeline` error-fallback object (lines 79-83) — delete `attempts: []` (line 79), `currentAttempt: null` (line 80), `captureBranches: []` (line 83). These would otherwise fail type-check after T014-T015.
- [X] T021 [P] [US2] Update `src/renderer/components/checkpoints/hooks/useTimeline.ts` `EMPTY` constant (lines 10-14) — delete `attempts: []`, `currentAttempt: null`, `captureBranches: []`.
- [X] T022 [P] [US2] Update `src/renderer/electron.d.ts` — delete `captureBranches`, `attempts`, `currentAttempt` from the `TimelineSnapshot` type definition; delete `recordMode` from any `UiState`-shaped type (the `syncStateFromHead` declaration on line 33 stays).
- [X] T023 [P] [US2] Update `src/renderer/services/checkpointService.ts` file-header `What:` JSDoc — drop any "Record mode" mention. Exposed methods are unchanged.
- [X] T024 [P] [US2] Update `scripts/prune-example-branches.sh` — delete the `attempt-*` glob; preserve the `dex/*` glob.

**Test cascade (parallel — different test files)**

- [X] T025 [P] [US2] Update `src/core/__tests__/finalize.test.ts:77,99` — delete the `autoPromoteIfRecordMode`-related assertions/setup. The rest of the file (non-record-mode finalize coverage) stays.
- [X] T026 [P] [US2] Delete `src/core/__tests__/recordMode.test.ts` (or any `recordMode_*.test.ts`) if it exists.
- [X] T027 [P] [US2] Update `src/renderer/services/__tests__/checkpointService.test.ts:52` `EMPTY` fixture — delete `captureBranches: []`, `attempts: []`, `currentAttempt: null`. The `syncStateFromHead` test at lines 69-77 stays (only the import path changed, transparently via the barrel).
- [X] T028 [P] [US2] Update `src/core/__tests__/timelineLayout.test.ts:38` `EMPTY` fixture — delete `attempts: []`, `currentAttempt: null`, `captureBranches: []`.
- [X] T029 [P] [US2] Update `src/core/__tests__/checkpoints.test.ts` — delete `attemptBranchName` factory tests at lines 98-99; delete `captureBranchName` factory test at line 104; retarget the fixture branch name at line 311 from `attempt-test-a` to `dex/test-a` (or `selected-test-a` if the surrounding assertion exercises the `selected-*` path) so the surrounding behaviour assertion keeps running.

**Gate + E2E verification**

- [X] T030 [US2] Gate — `npx tsc --noEmit && npm test && npm run lint`. Both `checkpoint_promoted` producers are now gone; the discriminant deletion (T036) is unblocked.
- [X] T031 [US2] E2E DoD: `./scripts/reset-example-to.sh clean`; run one autonomous loop to completion via the UI (welcome screen → fill `dex-ecommerce` path → Open Existing → Loop page → Automatic Clarification on → Start Autonomous Loop → wait); then in `dex-ecommerce` repo verify all of: `git branch --list 'capture/*'` empty, `git tag --list 'checkpoint/done-*'` empty, `git tag --list 'checkpoint/*'` empty, `git log --grep='^\[checkpoint:'` finds per-step commits, `git branch --list 'attempt-*'` empty.
- [X] T032 [US2] E2E DoD (promote-script regression): `./scripts/promote-checkpoint.sh /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce manual-013-test`; verify `git -C dex-ecommerce tag --list 'checkpoint/manual-013-test'` returns one match; `./scripts/reset-example-to.sh manual-013-test` restores; clean up with `git -C dex-ecommerce tag -d checkpoint/manual-013-test`.

**Checkpoint**: User Story 2 is complete. Branch and tag namespaces are empty of vestigial families. Both `checkpoint_promoted` producers are gone — Phase 6 (US4) can now safely delete the discriminant.

---

## Phase 5: User Story 3 - Resume a partially completed run (Priority: P2)

**Goal**: Verify the relocated `syncStateFromHead` performs identical state reconciliation to the pre-cleanup version. Pure regression check.

**Independent Test**: Reset to any `checkpoint/cycle-N-after-tasks` checkpoint; open in Dex; click **Resume**; verify orchestrator skips `prerequisites`, reuses the existing `runId`, and resumes from the next stage after `state.lastCompletedStage`.

This phase has no implementation tasks — Phase 2 already performed the relocation. Tasks here are verification only.

- [X] T033 [US3] E2E DoD: `./scripts/reset-example-to.sh list | head -20`; pick a `checkpoint/cycle-N-after-tasks`; run `./scripts/reset-example-to.sh <name>`; in the app open the example project; confirm welcome submit reads **Open Existing**; on Loop page confirm primary button reads **Resume**; click **Resume**; verify orchestrator skips `prerequisites`, reuses existing `runId`, resumes at next stage after `state.lastCompletedStage`.
- [X] T034 [US3] Verify `~/.dex/logs/dex-ecommerce/<runId>/run.log` records the resumed `runId` matching the pre-existing one (not a freshly-minted UUID).

**Checkpoint**: Resume regression is verified — the relocation introduced no behaviour change.

---

## Phase 6: User Story 4 - Inspect the topbar and timeline UI (Priority: P3)

**Goal**: The topbar contains no REC badge under any of the three trigger conditions (default, `DEX_RECORD_MODE=1` env, hand-edited `state.json.ui.recordMode=true`). The timeline never renders an `attempt-*` or `capture/*` lane regardless of repo state.

**Independent Test**: Open the example project under each trigger condition; MCP `take_snapshot` of the topbar finds no element with `RecBadge` testid and no "REC" text. Inspect timeline; no `attempt-*` or `capture/*` lane is rendered even if such refs exist in the repo.

**⚠️ Cross-phase dependency**: T037 (events.ts discriminant deletion) requires both `checkpoint_promoted` producers gone, i.e. T012 + T018 from US2 must be complete. Do not start Phase 6 until Phase 4 has gated green.

### Implementation for User Story 4

- [X] T035 [P] [US4] Delete `src/renderer/components/checkpoints/RecBadge.tsx` entire file.
- [X] T036 [US4] Update `src/renderer/components/layout/Topbar.tsx` — delete the `recordMode` `useState` + `useEffect` polling block (lines 44-58); delete the `<RecBadge recordMode={recordMode} />` render line (line 194); delete the `RecBadge` import.
- [X] T037 [US4] Delete the `checkpoint_promoted` discriminant from the orchestrator-event union in `src/core/events.ts:100`. **Sequencing constraint (FR-013)**: this MUST happen after T012 + T018 from US2; doing it earlier breaks `recordMode.ts` type-check during the intermediate state.
- [X] T038 [P] [US4] Delete the `case "checkpoint_promoted":` refresh-trigger from `src/renderer/components/checkpoints/hooks/useTimeline.ts:70`.
- [X] T039 [P] [US4] Delete the `checkpoint_promoted` event-handler block at `src/renderer/App.tsx:365-369`. Add a one-line comment at `App.tsx:36`: `// TODO(post-013): rename to currentRunBranch — value is the current run branch (dex/* or selected-*), never attempt-*. Deferred per 013-cleanup-2.`
- [X] T040 [US4] Gate — `npx tsc --noEmit && npm test && npm run lint`.
- [X] T041 [US4] MCP verification of REC badge absence under all three trigger conditions: (a) default (no env var, no state-file flag), (b) `DEX_RECORD_MODE=1 ./dev-setup.sh`, (c) hand-edit `state.json` with `jq '.ui.recordMode = true'` then `./dev-setup.sh`. In each case use `mcp__electron-chrome__take_snapshot` against the topbar and assert zero elements with `RecBadge` testid and zero "REC" text rendered.
- [X] T042 [US4] MCP visual sweep — `mcp__electron-chrome__take_screenshot` of topbar (badge slot gone or collapsed cleanly) and timeline (no `attempt-*` or `capture/*` lanes anywhere). If the example project repo has pre-existing `capture/*` or `attempt-*` refs from older runs, confirm the timeline does not surface them.

**Checkpoint**: User Story 4 is complete. The UI is free of vestigial Record-mode and `attempt-*` artefacts.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation alignment (NFR-002) and the final pre-merge sweep (FR-016, SC-008). Nothing in this phase changes runtime behaviour.

- [X] T043 [P] Update `CLAUDE.md` — `## On-Disk Layout` block (around lines 79-80) and any `attempt-*` / `capture/*` / `recordMode` mentions throughout the file. Drop references to deleted families; preserve the carve-out note about `reset-example-to.sh` minting fixture-only `attempt-*`.
- [X] T044 [P] Update `.claude/rules/06-testing.md:48` — clarify that the `attempt-<ts>` branch minting in `reset-example-to.sh` is fixture-only.
- [X] T045 [P] Update `.claude/rules/06-testing.md:75` branch hygiene paragraph — rewrite to say only the fixture script produces `attempt-*`; the 30-day rule applies only to the fixture project.
- [X] T046 [P] Update `docs/my-specs/01X-state-reconciliation/README.md:110` History layer table — annotate or remove the `attempt-*` entry as pre-013.
- [X] T047 [P] Add a one-line "Superseded in 013-cleanup-2" banner at the top of `docs/my-specs/008-interactive-checkpoint/README.md`. **Do NOT rewrite** — historical specs are immutable.
- [X] T048 [P] Add a one-line "Superseded in 013-cleanup-2" banner at the top of `docs/my-specs/010-interactive-timeline/README.md`. **Do NOT rewrite**.
- [X] T049 Final pre-merge grep sweep per `specs/013-cleanup-2/quickstart.md` §4 — `grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge\|capture/\|captureBranch\|checkpointDoneTag\|autoPromoteIfRecordMode\|promoteToCheckpoint\|readRecordMode\|checkpoint/done-\|attemptBranchName\|AttemptInfo\|attempt-" src/ | grep -v test` — expected zero hits in non-test code. Sweep `scripts/`: only `reset-example-to.sh:14` (file-header comment) and `:53` (the `attempt-${STAMP}` mint) should match.
- [X] T050 Final type/test/lint gate — `npx tsc --noEmit && npm test && npm run lint` all green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — runs first.
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user stories. Must be gated green before US1, US2, US4 begin.
- **Phase 3 (US1)**: Depends on Phase 2. Independent of US2 / US4 in implementation. (Touches `jumpTo.ts`, `GoBackConfirm.tsx`, `jumpTo.test.ts`.)
- **Phase 4 (US2)**: Depends on Phase 2. Independent of US1 in implementation but shares `tags.ts` (T016 deletes `attemptBranchName` along with `checkpointDoneTag` / `captureBranchName`). If running in parallel with US1, T016 is the only coordination point.
- **Phase 5 (US3)**: Depends on Phase 2 only (verification of the relocation).
- **Phase 6 (US4)**: Depends on Phase 4 (T012 + T018 must be complete before T037 — see FR-013 sequencing constraint). Other US4 tasks (T035, T036, T038, T039) can run after Phase 4.
- **Phase 7 (Polish)**: Depends on all user-story phases complete.

### Critical sequencing constraint (FR-013, README step 7b)

`T037` (delete `checkpoint_promoted` discriminant in `events.ts`) MUST run **after** both producers are gone:

- T012 (delete orchestrator Record-mode block — first producer)
- T018 (delete `recordMode.ts` — second producer)

Doing T037 earlier causes `recordMode.ts` to fail type-check during the intermediate state. Doing it later leaves a dead type that the consumer cases (T038, T039) would otherwise still match.

### Within each user story

- US1: T006 (jumpTo body) and T007 (GoBackConfirm) can be parallel; T008-T010 (tests) are parallel with each other and with T006-T007 if the test runs are isolated.
- US2: implementation order matters — producer deletes (T012, T013) before module delete (T018) before namespace cleanup (T019). Test cascade (T025-T029) is parallel after T015-T017. Consumer cascade (T020-T024) is parallel after T015. T031-T032 (E2E) requires the gate (T030).
- US4: T035-T036 (UI deletes) parallel with each other; T037 has the cross-phase guard; T038-T039 parallel after T037; verification (T041-T042) requires the gate (T040).

### Parallel opportunities

- All tasks marked `[P]` within a phase can run in parallel, subject to the phase's gating.
- US1 (Phase 3) and US2 (Phase 4) can be started in parallel after Phase 2 gates green, but only one author should hold `tags.ts` at a time (T016 is the only file-level overlap — `attemptBranchName` is referenced from `jumpTo.ts` lines 9 import and 130 call site, both removed in T006 within US1).
- US3 (Phase 5) verification can run any time after Phase 2.
- Phase 7 documentation tasks (T043-T048) are all parallel.

---

## Parallel Example: User Story 2 consumer cascade

```bash
# After T015-T017 land, these can run together (different files, no
# dependencies on each other):
Task: "Update src/main/ipc/checkpoints.ts error-fallback (T020)"
Task: "Update useTimeline.ts EMPTY constant (T021)"
Task: "Update electron.d.ts TimelineSnapshot type (T022)"
Task: "Update checkpointService.ts file-header (T023)"
Task: "Update prune-example-branches.sh (T024)"

# Same wave, test fixtures:
Task: "Update finalize.test.ts (T025)"
Task: "Delete recordMode.test.ts if exists (T026)"
Task: "Update checkpointService.test.ts EMPTY (T027)"
Task: "Update timelineLayout.test.ts EMPTY (T028)"
Task: "Update checkpoints.test.ts factory tests (T029)"
```

---

## Implementation Strategy

### Sequenced delivery (recommended for this cleanup)

This is a deletion-heavy spec — running phases sequentially is safer than parallelising them. Suggested order:

1. **Phase 1 (Setup)** — pre-flight greps; halt if anything unexpected appears.
2. **Phase 2 (Foundational)** — relocate `syncStateFromHead`. Gate green.
3. **Phase 3 (US1)** — `jumpTo` rewrite + GoBackConfirm + tests. Gate green. **MVP slice**: at this point the user-visible UX change (Save dialog) ships.
4. **Phase 4 (US2)** — Record-mode + `attempt-*` deletion cascade. Gate green. E2E DoD against the example project.
5. **Phase 5 (US3)** — verify resume regression (no implementation; pure check).
6. **Phase 6 (US4)** — UI / discriminant cleanup. Gate green. MCP verification under all three trigger conditions.
7. **Phase 7 (Polish)** — docs + final sweep + final gate.

### MVP scope

**Phases 1 + 2 + 3** deliver the only user-visible behavioural change (the Go-Back confirm dialog Save flow). Phases 4-7 are pure simplification — no behaviour change for end-users, but they unblock `014-branch-management` from inheriting a clean two-family namespace.

### Parallel team strategy

If two engineers split the work after Phase 2:
- Engineer A: Phase 3 (US1) — owns `jumpTo.ts`, `GoBackConfirm.tsx`, `jumpTo.test.ts`.
- Engineer B: Phase 4 (US2) — owns the Record-mode + `attempt-*` deletion cascade. Coordinates with A on `tags.ts` (T016 — `attemptBranchName` factory deletion; A has already removed the only consumer).

After both gate green, either engineer takes Phase 6 (US4) and Phase 7. Phase 5 verification can be done by anyone.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks.
- `[Story]` = US1, US2, US3, US4 — maps to the four user stories in spec.md.
- Each numbered task maps to a specific edit in the README's file map; line numbers cited are pre-cleanup numbers.
- This is a **no-op behavioural change for end-users in normal flows**. The only user-visible difference is the Go-Back confirm dialog wording (US1).
- Gate rules (NFR-001): every phase MUST end with `npx tsc --noEmit && npm test && npm run lint` green before the next phase begins.
- Verify type/test/lint at every phase boundary — do NOT skip the gate, even if the changes look obviously safe.
- Commit cadence: per CLAUDE.md, the user is the only commit-authoriser. Do not commit during implementation unless explicitly asked.
- Avoid: removing `commitCheckpoint` or the `[checkpoint:<step>:<cycle>]` subject convention (still the timeline's only stage-boundary mechanism); renaming `step_candidate.attemptBranch` (deferred, marked with `TODO(post-013)`); migrating user state files (FR-011 — silently ignored).
