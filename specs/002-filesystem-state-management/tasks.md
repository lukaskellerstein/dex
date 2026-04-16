# Tasks: Filesystem-First State Management

**Input**: Design documents from `/specs/002-filesystem-state-management/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Git configuration for state file management

- [x] T001 Add `.dex/state.lock` to `.gitignore` (do NOT add `.dex/state.json` — it must be committed)
- [x] T002 Create `.gitattributes` with `.dex/state.json merge=ours` for merge conflict prevention

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core state types, I/O functions, git helpers, and prompt isolation that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

### State Types & Core I/O

- [x] T003 Create `src/core/state.ts` with `DexState`, `ArtifactEntry`, `FeatureArtifacts`, `TasksArtifact`, `ReconciliationResult`, `DeepPartial<T>`, `LockFile` interfaces per data-model.md
- [x] T004 Implement `deepMerge()` in `src/core/state.ts` — purpose-built 30-line recursive merge with explicit contract: `undefined`=skip, `null`=clear, primitive=replace, object=recurse, array=replace-entirely
- [x] T005 Implement `saveState()` in `src/core/state.ts` — atomic write (write `.dex/state.json.tmp` then `fs.renameSync` to `.dex/state.json`)
- [x] T006 Implement `loadState()` in `src/core/state.ts` — read + JSON parse + version check, return null on missing/corrupt/unknown-version
- [x] T007 Implement `clearState()` in `src/core/state.ts` — delete state file
- [x] T008 Implement `updateState()` in `src/core/state.ts` — load, deep-merge patch, save atomically
- [x] T009 Implement `hashFile()` in `src/core/state.ts` — SHA-256 of file contents using Node.js `crypto`
- [x] T010 Implement `createInitialState()` in `src/core/state.ts` — build DexState from RunConfig + runId + branchName + baseBranch

### Git Checkpoint Protocol

- [x] T011 Implement `getHeadSha()` in `src/core/git.ts` — `git rev-parse HEAD`
- [x] T012 [P] Implement `countCommitsBetween()` in `src/core/git.ts` — `git rev-list --count fromSha..toSha`
- [x] T013 [P] Implement `getCommittedFileContent()` in `src/core/git.ts` — `git show <ref>:<path>`, return null on failure (for crash recovery)
- [x] T014 Implement `commitCheckpoint()` in `src/core/git.ts` — `git add .dex/state.json && git commit -m "dex: <stage> completed [cycle:<N>] [feature:<name>] [cost:$<X.XX>]"`, return new HEAD SHA. Include runtime guard: warn if last commit contains `.dex/state.json` in its diff

### Agent Prompt Isolation

- [x] T015 Replace `git add -A` with `git add -A -- ':!.dex/'` in `src/core/orchestrator.ts` at line 441 (build mode gap analysis commit)
- [x] T016 [P] Replace `git add -A` with `git add -A -- ':!.dex/'` in `src/core/orchestrator.ts` at line 448 (build mode phase commit)
- [x] T017 [P] Replace `git add -A` with `git add -A -- ':!.dex/'` in `src/core/orchestrator.ts` at line 1630 (prerequisites `execSync` commit)
- [x] T018 [P] Replace `git add -A` with `git add -A -- ':!.dex/'` in `src/core/prompts.ts` at line 320 (loop mode implement commit)

### Type Updates

- [x] T019 Update `RunConfig` in `src/core/types.ts`: remove `resumeRunId?: string` (line 173), add `resume?: boolean`
- [x] T020 Add new event types to `OrchestratorEvent` union in `src/core/types.ts`: `state_reconciling` (`{ type: "state_reconciling"; runId: string }`) and `state_reconciled` (`{ type: "state_reconciled"; runId: string; driftSummary: DriftSummary }`)
- [x] T021 Export `DexState`, `ArtifactEntry`, `FeatureArtifacts`, `TasksArtifact`, `ReconciliationResult`, `DriftSummary` from `src/core/types.ts` (or re-export from `src/core/state.ts`)

**Checkpoint**: Foundation ready — state types, I/O, git helpers, and prompt isolation all in place. User story implementation can begin.

---

## Phase 3: User Story 1 — Reliable Pause/Resume Across Restarts (Priority: P1) MVP

**Goal**: Orchestrator state is persisted to `.dex/state.json` after each stage. On pause or crash, the system resumes from the exact stage without re-executing completed work.

**Independent Test**: Start a loop, let 2+ stages complete, pause. Restart and resume. Verify the orchestrator continues from the next uncompleted stage with correct cost accumulator and failure counts.

### Implementation for User Story 1

- [x] T022 [US1] Wire initial state creation in `run()` function of `src/core/orchestrator.ts`: after `createRun()`, call `createInitialState()` + `saveState()`. Store `projectDir` in module-level variable for `finally` block access
- [x] T023 [US1] Wire state updates after each stage completion in `src/core/orchestrator.ts`: call `updateState()` with new `lastCompletedStage`, updated accumulators (cumulativeCostUsd, cyclesCompleted, featuresCompleted, featuresSkipped), updated artifact hashes → then `commitCheckpoint()` → then update `checkpoint.sha` in state
- [x] T024 [US1] Wire `finally` block in `run()` of `src/core/orchestrator.ts`: write `status: "paused"` + `pausedAt` timestamp if stopped/crashed, `clearState()` if completed successfully
- [x] T025 [US1] Wire failure count persistence in `src/core/orchestrator.ts`: update `failureCounts` in state file alongside existing DB writes in `persistFailure()` and on success reset
- [x] T026 [US1] Implement resume-from-state in `runLoop()` of `src/core/orchestrator.ts`: replace the `if (config.resumeRunId)` block (lines 1738-1758) with `loadState()` → restore position (`resumeSpecDir`, `resumeLastStage`), failure counts, accumulators (`cumulativeCost`, `cyclesCompleted`, `featuresCompleted`, `featuresSkipped`) from state file
- [x] T027 [US1] Remove `loadFailureRecords()` function (lines 1711-1718 of `src/core/orchestrator.ts`) — failure counts now come from state file
- [x] T028 [US1] Update all `config.resumeRunId` references to `config.resume` in `src/core/orchestrator.ts` (lines 1738, 1758, 1761 and any others)
- [x] T029 [US1] Add `orchestrator:getProjectState` IPC handler in `src/main/ipc/orchestrator.ts` that reads state file for a given projectDir via `loadState()`
- [ ] T030 [US1] Update `orchestrator:getRunState` handler in `src/main/ipc/orchestrator.ts` to fall back to state file when not running
- [x] T031 [US1] Expose `getProjectState(dir: string): Promise<DexState | null>` in `src/main/preload.ts` via contextBridge
- [x] T032 [US1] Add `getProjectState` type definition in `src/renderer/electron.d.ts`
- [x] T033 [US1] Update `handleStartLoop()` in `src/renderer/App.tsx`: accept `resume?: boolean` instead of `resumeRunId?: string`
- [x] T034 [US1] Update `handleStart()` in `src/renderer/App.tsx` (line 245-249): pass `resume: true` instead of `resumeRunId`
- [ ] T035 [US1] Update mount effect in `src/renderer/hooks/useOrchestrator.ts`: use `getProjectState()` for paused state detection instead of DB-derived `getRunState()`

**Checkpoint**: User Story 1 complete — pause/resume works via state file. This is the MVP.

---

## Phase 4: User Story 2 — Artifact Integrity Detection on Resume (Priority: P2)

**Goal**: On resume, the system detects manually edited, deleted, or added artifacts and adjusts the execution plan, re-running only the minimum necessary stages.

**Independent Test**: Pause a run, delete a spec folder, resume. Verify reconciliation detects the missing artifact and resets that feature to "specifying".

### Implementation for User Story 2

- [x] T036 [US2] Implement artifact hash checking in `reconcileState()` in `src/core/state.ts`: for each artifact in manifest, check file exists and compare SHA-256 hash. Populate `driftSummary.missingArtifacts` and `driftSummary.modifiedArtifacts`. Use `Promise.all()` for parallel hashing
- [x] T037 [US2] Implement tasks.md checkbox comparison in `reconcileState()` in `src/core/state.ts`: compare task checkbox states against `taskChecksums`. Detect regressions (checked→unchecked) and progressions (unchecked→checked). Populate `driftSummary.taskRegressions` and `driftSummary.taskProgressions`
- [x] T038 [US2] Implement git checkpoint comparison in `reconcileState()` in `src/core/state.ts`: compare `HEAD` vs `state.checkpoint.sha`, count extra commits via `countCommitsBetween()`. Populate `driftSummary.extraCommits`
- [x] T039 [US2] Implement reconciliation decision matrix in `reconcileState()` in `src/core/state.ts`: apply the decision table from data-model.md (missing spec → reset to specifying, deleted plan → reset to planning, unchecked tasks → resume from earliest unchecked phase, etc.). Compute `resumeFrom` point and `statePatches`
- [x] T040 [US2] Emit `state_reconciling` event at start of reconciliation and `state_reconciled` event with `driftSummary` on completion in `src/core/state.ts` (accept `EmitFn` parameter)
- [x] T041 [US2] Wire `reconcileState()` into the resume flow in `runLoop()` of `src/core/orchestrator.ts`: after `loadState()`, call `reconcileState()`, apply `statePatches`, handle `blockers` (emit `user_input_request` for user decisions), use `resumeFrom` for position
- [x] T042 [US2] Handle `state_reconciled` event in `src/renderer/hooks/useOrchestrator.ts` to display drift summary in UI (show warnings about missing/modified artifacts, task regressions)

**Checkpoint**: User Stories 1 AND 2 complete — resume detects manual edits and adjusts execution plan.

---

## Phase 5: User Story 3 — Crash Recovery with Pending User Input (Priority: P2)

**Goal**: Pending user questions survive crashes. On restart, the question is re-presented with original context.

**Independent Test**: Trigger a user question, kill the app, restart. Verify the question reappears.

### Implementation for User Story 3

- [x] T043 [US3] Persist `pendingQuestion` to state file before emitting `user_input_request` in `src/core/orchestrator.ts`: update state with question ID, text, context, and timestamp
- [x] T044 [US3] Clear `pendingQuestion` from state file after receiving `user_input_response` in `src/core/orchestrator.ts`
- [x] T045 [US3] Implement pending question re-ask in `reconcileState()` in `src/core/state.ts`: if `state.pendingQuestion` is non-null, set `driftSummary.pendingQuestionReask = true` and include re-emit instruction in `blockers`
- [x] T046 [US3] Implement `resolveWorkingTreeConflict()` in `src/core/state.ts`: read committed version via `getCommittedFileContent(projectDir, "HEAD", ".dex/state.json")` and working-tree version via `loadState()`, compare `lastCompletedStage` ordinal, pick more-advanced, validate `checkpoint.sha` exists via `git cat-file -t`, fall back if validation fails
- [x] T047 [US3] Wire `resolveWorkingTreeConflict()` into resume flow in `runLoop()` of `src/core/orchestrator.ts`: call before `reconcileState()` when both committed and working-tree versions exist

**Checkpoint**: User Stories 1, 2, AND 3 complete — crash recovery handles both state divergence and pending questions.

---

## Phase 6: User Story 4 — Branch-Scoped State with Clean Main (Priority: P3)

**Goal**: State is scoped to git branch. Stale state from merged/switched branches is automatically cleaned up.

**Independent Test**: Complete a loop on a feature branch, merge to main, start new loop on main. Verify stale state is cleaned up.

### Implementation for User Story 4

- [x] T048 [US4] Implement `detectStaleState()` in `src/core/state.ts`: load state, compare `branchName` vs current git branch. Return `"none"` (no state file), `"completed"` (status completed), `"stale"` (different branch), or `"fresh"` (same branch, paused/running)
- [x] T049 [US4] Wire `detectStaleState()` into loop start in `src/core/orchestrator.ts`: on `"none"` or `"completed"` or `"stale"` → delete state file and start fresh. On `"fresh"` → offer resume via existing resume flow

**Checkpoint**: Branch scoping works — switching branches or merging cleans up stale state.

---

## Phase 7: User Story 5 — Migration from DB-Based Resume (Priority: P3)

**Goal**: Existing paused runs under the old DB-based system can be migrated to the new state file system with user confirmation.

**Independent Test**: Pause a run on old code, upgrade, start app. Verify migration prompt appears with correct run details.

### Implementation for User Story 5

- [x] T050 [US5] Implement `migrateFromDbResume()` in `src/core/state.ts`: detect no state file + DB has stopped/crashed run for projectDir → reconstruct `DexState` from DB fields (run config, last phase_trace, loop_cycles, failure_tracker) → hash current artifacts on disk → return reconstructed state for confirmation
- [ ] T051 [US5] Wire migration into loop start in `src/core/orchestrator.ts`: when `detectStaleState()` returns `"none"` and `config.resume` is true, call `migrateFromDbResume()`. If migration returns state, emit `user_input_request` asking user to confirm. On confirmation, write state file and proceed with normal resume

**Checkpoint**: Migration path works — existing paused runs can be resumed after upgrade.

---

## Phase 8: User Story 6 — Concurrent Instance Protection (Priority: P3)

**Goal**: Two Electron windows targeting the same project cannot corrupt the state file by writing simultaneously.

**Independent Test**: Open two windows on same project, attempt to start runs in both. Verify second is blocked.

### Implementation for User Story 6

- [x] T052 [US6] Implement `acquireStateLock()` in `src/core/state.ts`: create `.dex/state.lock` with PID + timestamp (JSON). Return release function. Register `process.on('exit')` auto-release
- [x] T053 [US6] Implement `isLockStale()` in `src/core/state.ts`: check PID alive via `process.kill(pid, 0)`, check 10-minute staleness threshold. If stale → allow steal
- [x] T054 [US6] Wire lock acquisition into `run()` in `src/core/orchestrator.ts`: acquire lock at start, release in `finally` block. If lock held by another live process, emit error event and abort

**Checkpoint**: Concurrent writes prevented — second instance gets clear error.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Guards, verification, and cleanup

- [x] T055 [P] Add build-time grep guard: scan `src/core/orchestrator.ts` and `src/core/prompts.ts` for unguarded `git add -A` (without `:!.dex/` exclusion). Can be a test file or a verification script
- [x] T056 [P] Deprecate `getActiveRunState()` in `src/core/database.ts` — add deprecation comment noting it's no longer used for resume (DB writes stay, only resume reads removed)
- [x] T057 Verify `npx tsc --noEmit` passes with all changes
- [ ] T058 Run full verification checklist from plan.md (21 items)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
  - US1 (Phase 3): Can start immediately after Foundational
  - US2 (Phase 4): Depends on US1 (needs state writes wired to have artifacts to check)
  - US3 (Phase 5): Depends on US1 (needs state file persistence for pending questions)
  - US4 (Phase 6): Depends on US1 (needs `loadState()` wired)
  - US5 (Phase 7): Depends on US1 + US4 (needs both state file and stale detection)
  - US6 (Phase 8): Can start after Foundational (lock is independent of resume logic)
- **Polish (Phase 9)**: Depends on all user stories being complete

### User Story Dependencies

```
Foundational ──┬── US1 (P1 MVP) ──┬── US2 (P2)
               │                   ├── US3 (P2)
               │                   ├── US4 (P3) ── US5 (P3)
               │                   │
               └── US6 (P3) ──────┘── Polish
```

### Within Each User Story

- State module functions before orchestrator wiring
- Orchestrator changes before IPC changes
- IPC changes before renderer changes

### Parallel Opportunities

- T001 and T002 (Setup) can run in parallel
- T011, T012, T013 (git helpers) can run in parallel after T003
- T015, T016, T017, T018 (prompt isolation) can run in parallel
- T019, T020, T021 (type updates) can run in parallel
- US6 (locking) can run in parallel with US2/US3/US4 since it only depends on Foundational
- T055 and T056 (polish) can run in parallel

---

## Parallel Example: Foundational Phase

```
# Wave 1: Types (sequential — later tasks depend on types)
T003: Create state types in src/core/state.ts

# Wave 2: Core I/O (sequential — each builds on previous)
T004: deepMerge → T005: saveState → T006: loadState → T007: clearState → T008: updateState

# Wave 3: Utilities (parallel — independent functions)
T009: hashFile         (parallel)
T010: createInitialState (parallel)

# Wave 4: Git helpers (parallel — independent functions)
T011: getHeadSha
T012: countCommitsBetween  (parallel)
T013: getCommittedFileContent (parallel)
T014: commitCheckpoint (depends on T011)

# Wave 5: Prompt isolation (all parallel — different files/lines)
T015: orchestrator.ts:441
T016: orchestrator.ts:448
T017: orchestrator.ts:1630
T018: prompts.ts:320

# Wave 6: Type updates (all parallel — different sections of types.ts)
T019: RunConfig update
T020: OrchestratorEvent new types
T021: Re-exports
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (git config)
2. Complete Phase 2: Foundational (state types, I/O, git helpers, prompt isolation)
3. Complete Phase 3: User Story 1 (state writes, resume rewrite, IPC, renderer)
4. **STOP and VALIDATE**: Start loop, pause, resume — verify correct stage pickup
5. This delivers the core value: reliable pause/resume

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Pause/resume works (MVP!)
3. Add US2 → Artifact drift detection on resume
4. Add US3 → Crash recovery with pending questions
5. Add US4 → Branch-scoped state cleanup
6. Add US5 → Migration from old DB resume
7. Add US6 → Concurrent instance protection
8. Polish → Guards, deprecation, verification

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- All DB writes are preserved — this feature adds state file alongside existing DB, not replacing it
- Line numbers reference current codebase state — verify before editing if significant time has passed
- The 4 `git add -A` locations (T015-T018) are the most critical correctness concern — missed exclusion = silent data corruption
