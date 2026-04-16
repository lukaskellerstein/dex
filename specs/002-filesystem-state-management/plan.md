# Implementation Plan: Filesystem-First State Management

**Branch**: `lukas/full-dex` | **Date**: 2026-04-16 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-filesystem-state-management/spec.md`

## Summary

Replace the hybrid in-memory + SQLite resume mechanism with a single `.dex/state.json` file committed to the git branch after each stage. This gives the orchestrator a single source of truth for pause/resume, crash recovery, and artifact integrity — eliminating the state divergence between DB, memory, and filesystem that causes duplicate work and lost progress.

The database is demoted to append-only audit log (all existing writes preserved). Resume reads exclusively from the state file. Git checkpoint commits (state-file-only) provide crash recovery anchors. A reconciliation pass on resume detects manual artifact edits and computes the minimum rollback point.

## Technical Context

**Language/Version**: TypeScript (strict mode), Node.js (Electron 30+)
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18
**Storage**: `better-sqlite3` (audit trail, unchanged), `.dex/state.json` (new — primary state), filesystem artifacts with SHA-256 integrity hashing
**Testing**: `npx tsc --noEmit` (type check), MCP electron-chrome (UI verification), manual smoke tests
**Target Platform**: Desktop (Electron on macOS/Linux/Windows)
**Project Type**: Desktop app (Electron)
**Performance Goals**: Reconciliation completes in <2s for 100 artifacts; state write + checkpoint commit <1s
**Constraints**: Atomic file writes (tmp+rename); no `git add -A` in agent prompts (must exclude `.dex/`); state-only checkpoint commits
**Scale/Scope**: Typical project has 5-20 features × 3-4 artifacts each = 15-80 tracked files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Clean-Context Orchestration | PASS | State file is read at orchestrator startup, not carried between agent instances. Each `query()` call still starts with clean context. State persists on disk, not in agent memory. |
| II. Platform-Agnostic Core | PASS | New `src/core/state.ts` is pure Node.js (fs, crypto, child_process). No Electron imports. All IPC additions are in `src/main/`. |
| III. Test Before Report | PASS | Plan includes 21-item verification checklist (from ALIGNMENT_PLAN.md). All changes testable via tsc + MCP. |
| IV. Simplicity First | PASS | Purpose-built 30-line `deepMerge` instead of lodash. State file is a single JSON file, not a custom binary format. Advisory lock is ~20 lines. No speculative abstractions. |
| V. Mandatory Workflow | PASS | This plan follows Understand → Plan → Implement → Test → Report. |

**Gate result: PASS** — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/002-filesystem-state-management/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (IPC contracts)
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── state.ts          # NEW — DexState types, read/write/clear, deepMerge, hash, lock, reconcile, migrate, crash recovery
│   ├── orchestrator.ts   # MODIFIED — wire state file writes at stage transitions, replace resume-from-DB with resume-from-state
│   ├── git.ts            # MODIFIED — add commitCheckpoint(), getHeadSha(), getCommittedFileContent()
│   ├── types.ts          # MODIFIED — update RunConfig (resume: boolean replaces resumeRunId), add new event types
│   ├── prompts.ts        # MODIFIED — git add -A exclusion for .dex/
│   └── database.ts       # UNCHANGED (all writes stay, deprecate getActiveRunState for resume)
├── main/
│   ├── ipc/
│   │   └── orchestrator.ts  # MODIFIED — add orchestrator:getProjectState handler
│   └── preload.ts           # MODIFIED — expose getProjectState()
└── renderer/
    ├── App.tsx              # MODIFIED — resume: boolean instead of resumeRunId
    ├── hooks/
    │   └── useOrchestrator.ts  # MODIFIED — use getProjectState() for paused detection, handle state_reconciled event
    └── electron.d.ts        # MODIFIED — add getProjectState type

# Root-level additions
.gitattributes               # NEW — .dex/state.json merge=ours
.gitignore                   # MODIFIED — add .dex/state.lock
```

**Structure Decision**: Single-project Electron app, no monorepo. New code goes in `src/core/state.ts` (one new file). All other changes are modifications to existing files. Follows the established `core/` = platform-agnostic, `main/` = Electron IPC, `renderer/` = React UI separation.

## Implementation Phases

### Phase 1: State File Foundation (`src/core/state.ts`)

Create the new state module with all types and core I/O functions.

**Files**: `src/core/state.ts` (new)

**Scope**:
- `DexState` interface with all fields from the alignment plan (position cursor, accumulators, failure counts, config snapshot, artifact manifest, checkpoint, pending question)
- `ArtifactEntry`, `FeatureArtifacts`, `TasksArtifact` interfaces
- `DeepPartial<T>` utility type
- `ReconciliationResult` interface
- `saveState()` — atomic write (tmp + rename)
- `loadState()` — read + parse + version check, null on missing/corrupt
- `clearState()` — delete state file
- `updateState()` — deep-merge update using purpose-built `deepMerge()` (see data-model.md for merge contract)
- `hashFile()` — SHA-256 of file contents
- `detectStaleState()` — compare `branchName` in state vs current git branch
- `createInitialState()` — build from RunConfig + runId + branch info
- `acquireStateLock()` / lock staleness detection — advisory lock with PID + timestamp, 10-minute staleness threshold
- `resolveWorkingTreeConflict()` — crash recovery: compare committed vs working-tree state, pick more-advanced

**Dependencies**: Node.js `fs`, `crypto`, `child_process` (for git commands). No Electron imports.

### Phase 2: Git Checkpoint Protocol (`src/core/git.ts`)

Add git helper functions for state-only checkpoint commits and crash recovery reads.

**Files**: `src/core/git.ts` (modified)

**Scope**:
- `commitCheckpoint(projectDir, stage, cycleNumber, featureName, cost)` — `git add .dex/state.json && git commit -m "dex: <stage> completed [cycle:<N>] [feature:<name>] [cost:$<X.XX>]"`, returns new HEAD SHA
- `getHeadSha(projectDir)` — `git rev-parse HEAD`
- `countCommitsBetween(projectDir, fromSha, toSha)` — for drift detection
- `getCommittedFileContent(projectDir, ref, filePath)` — `git show <ref>:<path>` for crash recovery
- Runtime guard in `commitCheckpoint()`: warn if agent's last commit contains `.dex/state.json`

### Phase 3: Agent Prompt Isolation

Update all `git add -A` usages to exclude `.dex/` directory.

**Files**: `src/core/orchestrator.ts` (lines 441, 448, 1630), `src/core/prompts.ts` (line 320)

**Scope**:
- Replace `git add -A` with `git add -A -- ':!.dex/'` at all 4 locations
- Add build-time grep guard (can be a test or verification script) that scans prompt files for unguarded `git add -A`

### Phase 4: State Writes at Stage Transitions

Wire `saveState()` + `commitCheckpoint()` into the orchestrator at every stage boundary.

**Files**: `src/core/orchestrator.ts` (modified)

**Scope**:
- In `run()`: after `createRun()`, call `saveState()` with initial state. In `finally` block: write `status="paused"` if stopped, `clearState()` if completed.
- After each stage completion: call `updateState()` with new `lastCompletedStage`, updated artifact hashes, updated accumulators → then `commitCheckpoint()` → then update `checkpoint.sha` in state
- Before `user_input_request` emission: persist `pendingQuestion` to state
- After `user_input_response`: clear `pendingQuestion` from state
- Store `projectDir` in module-level var so `finally` block can write paused state

### Phase 5: Reconciliation Engine

Implement `reconcileState()` — the integrity checking pass that runs on resume.

**Files**: `src/core/state.ts` (extend)

**Scope**:
- Git checkpoint comparison: `HEAD` vs `state.checkpoint.sha`, count extra commits
- Artifact existence + hash check: parallel `Promise.all(artifacts.map(hashFile))`, compare against manifest
- Tasks.md checkbox state comparison: detect regressions and progressions
- Pending question re-ask: if `pendingQuestion` is non-null, re-emit `user_input_request`
- Decision matrix: compute resume point per the alignment plan's table (missing spec → reset to specifying, unchecked tasks → resume implement from earliest, etc.)
- Emit `state_reconciling` at start, `state_reconciled` with drift summary on completion

### Phase 6: DB Migration (One-Time)

Support migration from DB-based resume for existing paused runs.

**Files**: `src/core/state.ts` (extend)

**Scope**:
- `migrateFromDbResume(projectDir, db)`: detect no state file + DB has stopped/crashed run → reconstruct `DexState` from DB fields → present to user for confirmation → write state file on confirm
- Best-effort: no prior checkpoint SHAs, artifact hashes from current disk state
- After migration, the old `resumeRunId` code path is no longer needed

### Phase 7: Replace Resume-from-DB with Resume-from-State

Rewrite the resume flow in `runLoop()` to use the state file instead of DB queries.

**Files**: `src/core/orchestrator.ts` (modified), `src/core/types.ts` (modified)

**Scope**:
- `RunConfig`: remove `resumeRunId?: string`, add `resume?: boolean`
- `runLoop()` resume block (lines 1738-1758): replace with `loadState()` → `resolveWorkingTreeConflict()` → `reconcileState()` → restore position, failure counts, accumulators from state
- Remove `loadFailureRecords()` function (lines 1711-1718) — failure counts now come from state file
- Update all `config.resumeRunId` references to `config.resume`

### Phase 8: IPC + Preload + Type Definitions

Expose project state to the renderer via IPC.

**Files**: `src/main/ipc/orchestrator.ts`, `src/main/preload.ts`, `src/renderer/electron.d.ts`

**Scope**:
- Add `orchestrator:getProjectState` IPC handler that reads state file for a given projectDir
- Expose `getProjectState(dir: string)` in preload
- Add TypeScript type definition for the new API
- Update `orchestrator:getRunState` to fall back to state file when not running

### Phase 9: Renderer Updates

Update React hooks and App.tsx for the new resume flow.

**Files**: `src/renderer/App.tsx`, `src/renderer/hooks/useOrchestrator.ts`

**Scope**:
- `handleStartLoop()`: accept `resume?: boolean` instead of `resumeRunId`
- `handleStart()`: pass `resume: true` instead of `resumeRunId`
- Mount effect: use `getProjectState()` for paused state detection instead of DB queries
- Handle `state_reconciled` event to show drift summary in UI
- Add new event types to `OrchestratorEvent` union: `state_reconciling`, `state_reconciled`

### Phase 10: Git Configuration

Set up gitignore, gitattributes, and verify the integration.

**Files**: `.gitignore`, `.gitattributes` (new)

**Scope**:
- Add `.dex/state.lock` to `.gitignore`
- Do NOT gitignore `.dex/state.json` — it must be committed
- Create `.gitattributes` with `.dex/state.json merge=ours`

## Verification Checklist

From the alignment plan — all 21 items must pass:

1. `npx tsc --noEmit` passes
2. Start loop → verify `.dex/state.json` created and updates at each stage
3. Verify checkpoint commits contain ONLY `.dex/state.json`
4. Verify agent commits do NOT contain `.dex/state.json`
5. Pause mid-run → verify state file has `status: "paused"` with correct position + artifact hashes
6. Resume → verify picks up from correct stage, no duplicate execution
7. Kill Electron process → restart → verify crash recovery picks correct state
8. Kill while user-input question pending → restart → verify question is re-asked
9. Manually delete a spec folder → resume → verify reconciliation detects it and re-runs from specify
10. Manually uncheck tasks in `tasks.md` → resume → verify re-runs implement from the right phase
11. Let loop complete → verify state file set to "completed" and cleaned up on next start
12. Check `.dex/state.json` appears in git commits on the branch
13. Verify UI shows `state_reconciled` drift summary on resume
14. Test DB migration: stop a run using old code, upgrade, verify migration generates valid state
15. Open two Electron windows on same project → verify state lock prevents corruption
16. Kill Electron while holding lock → restart → verify stale lock detected and stolen
17. Merge feature branch into main → verify `.gitattributes merge=ours` prevents conflict
18. Start loop on main after merge → verify `detectStaleState` returns "stale" and cleans up
19. Run grep guard → verify no unguarded `git add -A` patterns exist
20. Verify `updateState({ pendingQuestion: null })` clears the field
21. Verify `updateState({ featuresCompleted: ["a"] })` replaces the array (not appends)

## Complexity Tracking

No constitution violations — no complexity justifications needed.
