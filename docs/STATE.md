# State Management: Orchestrator <-> Renderer

This document describes how running state flows between the orchestrator engine (main process) and the React renderer, the bugs we encountered, and the fixes applied. Written to inform future optimization discussions.

## Architecture Overview

```
Orchestrator (src/core/orchestrator.ts)     Main Process IPC           Renderer (useOrchestrator hook)
───────────────────────────────────────     ──────────────────         ─────────────────────────────────
Module-level:                               preload.ts exposes:        React state:
  abortController (running flag)              startRun()                 isRunning
  currentRunState (RunState)                  stopRun()                  currentPhase
                                              isRunning()                activeSpecDir
run() emits OrchestratorEvent ──────────>     getRunState()              currentRunId
  via emit callback                           onOrchestratorEvent()      currentPhaseTraceId
                                                                         liveSteps, subagents, etc.
SQLite (database.ts):
  runs (status: running|completed|crashed)
  phase_traces (status: running|completed|failed|crashed)
  trace_steps, subagent_metadata
```

## Event Flow (Happy Path)

```
run_started        → renderer sets isRunning=true, runId, specDir
  spec_started     → renderer sets activeSpecDir
    phase_started  → renderer sets currentPhase, phaseTraceId, clears steps
      agent_step   → renderer appends to liveSteps (streaming)
      tasks_updated → renderer updates phase/task statuses (from TodoWrite OR disk reconcile)
    phase_completed → renderer accumulates cost/duration
  spec_completed   → renderer clears activeSpecDir (spec card stops showing RUNNING)
run_completed      → renderer resets everything
```

## Bug 1: UI Shows Wrong State After HMR/Reload

### Symptom

After Vite HMR or manual page reload, the running phase showed a "paused" icon instead of the spinning "running" indicator. Completed specs still showed "RUNNING" on the overview card.

### Root Cause

On mount, `useOrchestrator` reset all state to defaults. Only `isRunning` was recovered via `window.ralphAPI.isRunning()`. The critical state needed to identify *which* phase is running (`currentPhase`, `activeSpecDir`, `currentRunId`, `currentPhaseTraceId`) remained `null`.

In `App.tsx`, the `isRunning` prop on `PhaseView` requires:
```ts
orchestrator.isRunning
  && orchestrator.currentPhase?.number === phase.number  // null after reload!
  && orchestrator.activeSpecDir === project.selectedSpec  // null after reload!
```

So `isRunning` was `true` but no phase matched -> all phases showed their static status (Pause icon for "partial").

### Fix: In-Memory RunState + Mount Hydration

**Orchestrator side** (`src/core/orchestrator.ts`):
- Added module-level `currentRunState: RunState | null` — updated at run start, spec start, phase start; cleared in `finally`.
- Exported `getRunState()` — returns `currentRunState` only when `abortController !== null` (authoritative).
- This is the single source of truth. The DB can have stale rows from crashes (see Bug 3).

**IPC side** (`src/main/ipc/orchestrator.ts`, `src/main/preload.ts`):
- Added `orchestrator:getRunState` handler and `window.ralphAPI.getRunState()`.

**Renderer side** (`src/renderer/hooks/useOrchestrator.ts`):
- On mount, calls `getRunState()` instead of just `isRunning()`.
- If running: hydrates `isRunning`, `currentRunId`, `activeSpecDir`, `currentPhase`, `currentPhaseTraceId`.
- Also reloads accumulated `steps` and `subagents` from DB for the running phase trace, so the trace view also survives reload.

### Why In-Memory, Not DB?

Initially we tried querying the DB for `runs.status = 'running'` + `phase_traces.status = 'running'`. This failed because:
- The DB can have orphaned "running" rows from crashed/killed processes (the `finally` block never ran).
- The DB doesn't know if the orchestrator process is actually alive.
- The orchestrator's `abortController` is the only authority on "is something running right now?"

## Bug 2: Orchestrator Re-Runs Completed Phases (Infinite Loop)

### Symptom

After a phase completed successfully, the orchestrator picked it up again in the next iteration. Specs never finished — they looped until `maxIterations`.

### Root Cause

`RunTaskState` only updated task statuses via **TodoWrite detection** in the `PostToolUse` hook. But the agent prompt says:

> "After completing EACH task, immediately mark it [x] in tasks.md"

The agent does this by using the **Edit tool** to modify `tasks.md` directly. The `PostToolUse` hook only checks for `TodoWrite`, not `Edit`. So the in-memory state never saw task completions -> `getIncompletePhases()` kept returning the same phase.

### Fix: Reconcile From Disk After Each Phase

Added `RunTaskState.reconcileFromDisk(freshPhases)`:
- After each successful phase, re-parses `tasks.md` from disk.
- Merges disk state into memory using promote-only semantics (status can only go up: `not_done -> code_exists -> in_progress -> done`).
- Re-derives phase statuses.
- Emits `tasks_updated` with reconciled state so the UI reflects disk truth.

Two update paths now exist:
1. **TodoWrite** (PostToolUse hook) — real-time during a phase, drives progress UI as tasks complete.
2. **Disk reconciliation** (after each phase) — catches Edit tool changes that TodoWrite missed. Ensures `getIncompletePhases()` sees completions.

### Trade-off: Why Not Drop TodoWrite?

TodoWrite provides real-time progress during a phase (task goes to `in_progress` -> `done` as the agent works). Disk reconciliation only runs between phases. Both are needed for correct behavior:
- TodoWrite alone: misses Edit tool changes -> infinite loop.
- Disk alone: no real-time progress during phase execution.
- Both: correct loop termination + real-time UI updates.

## Bug 3: Orphaned DB Rows From Crashes

### Symptom

After a crash or `kill -9`, the DB retained `runs.status = 'running'` and `phase_traces.status = 'running'` rows. On next launch, the DB-based approach would incorrectly report an active run.

### Fix: Cleanup on Startup

Added `cleanupOrphanedRuns()` called during `initDatabase()`:
- Marks all `running` runs as `crashed`.
- Marks all `running` phase_traces as `crashed`.
- Runs once per process lifetime (before any new run starts).
- Safe because `initDatabase()` is called at the start of `run()`, and `getRunState()` uses in-memory state (not DB).

## Bug 4: No `spec_completed` Event

### Symptom

After a spec finished all its phases, the overview card stayed "RUNNING" until the entire run completed.

### Root Cause

No event existed between `phase_completed` (last phase) and `run_completed` (entire run). The renderer's `activeSpecDir` was only cleared on `run_completed`.

### Fix

Added `spec_completed` event:
- Emitted after the spec's while loop exits (all phases done, no failure, not aborted).
- Renderer handler clears `activeSpecDir`, `currentPhase`, `currentPhaseTraceId`.
- The next `spec_started` event (if processing multiple specs) sets `activeSpecDir` again.

## State Sources Summary

| State | Authoritative Source | Updated By |
|---|---|---|
| Is orchestrator running? | `abortController !== null` | `run()` start / `finally` |
| Which phase/spec is active? | `currentRunState` (module-level) | `run()`, `spec_started`, `phase_started` |
| Task completion status (during phase) | `RunTaskState` in-memory | TodoWrite hook (real-time) |
| Task completion status (between phases) | `tasks.md` on disk | Agent's Edit tool |
| Task completion status (reconciled) | `RunTaskState` after `reconcileFromDisk()` | After each phase completes |
| Historical traces | SQLite DB | `insertStep()`, `completePhaseTrace()`, etc. |
| Renderer UI state | React state in `useOrchestrator` | Events (streaming) + `getRunState()` (mount) |

## Future Optimization Topics

- **PostToolUse Edit detection**: Could detect when the agent edits `tasks.md` via the Edit tool and immediately reconcile, providing real-time updates even without TodoWrite. Would make the two update paths converge.
- **Debounced disk reconciliation**: Instead of only reconciling after phase completion, could periodically re-read disk during long phases.
- **Event replay on reconnect**: Instead of querying DB for steps on mount, the main process could buffer recent events and replay them. Would be more accurate for in-flight state.
- **Shared state store**: Move from scattered `useState` to a single state object that can be snapshot/restored atomically. Would simplify mount hydration.
