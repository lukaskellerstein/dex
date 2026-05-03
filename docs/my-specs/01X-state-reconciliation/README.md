# 011 — State reconciliation: make state.json the cache the spec already says it is

> **Status:** References to "Try N ways" / "Keep this" / "Unmark kept" verbs in this spec are superseded by `012-cleanup` — those verbs have been removed. Record Mode auto-promote, Go-Back, and Jump-to-Checkpoint remain authoritative.

## Why this exists

A fresh loop run on `dex-ecommerce` produced a UI that contradicted itself, contradicted git, and contradicted its own state.json — all at the same time, on a single Stop click.

**Observed (run `79134ace-8eeb-44bf-b4c9-7b1cc6a00e50`, paused 2026-04-26):**

| Source | Cycle 1 | Cycle 2 | Cycle 3 | Counter |
|---|---|---|---|---|
| **state.json** (`cyclesCompleted: 2, currentCycleNumber: 3, lastCompletedStep: "gap_analysis", pauseReason: "user_abort"`) | done | done | started, paused at gap_analysis | — |
| **Git timeline** | specify, plan, tasks, verify (no implement, no learnings) | gap_analysis, verify, implement_fix, verify, learnings | gap_analysis | — |
| **Steps view (UI)** | paused at Implement, Verify struck-through, Learnings dim | all 7 stages green | gap_analysis green, paused | `1/3 cycles` |

state.json and git agree. The UI disagrees with both. Three counters, three answers, no reconciliation point that ever fires.

This is not a one-off rendering glitch. It is a structural failure: the spec says state.json is a cache rebuilt from authoritative refs, but the implementation built two parallel state machines (orchestrator-persisted + renderer-event-accumulated) that never reconcile during a live run. The bug surfaces on every abort that lands mid-stage and on every synthetic-skip path.

This feature closes the gaps in `007-sqlite-removal` and `008-interactive-checkpoint` that allowed the divergence, and brings the implementation in line with what `008-interactive-checkpoint/README.md:209-219` already declared the storage model to be.

## What spec 008 already said (and what the implementation didn't do)

Quoting `docs/my-specs/008-interactive-checkpoint/README.md:209-222`:

> "Cache: `<projectDir>/.dex/state.json` (gitignored) … **Local, not shared. Rebuilt from refs + filesystem on Go back / project open / external git change.**"
>
> "Git refs are the shared authoritative layer."
>
> "reconciliation is authoritative — `reconcileState` extends to 'rebuild state.json from refs + filesystem' rather than 'repair drift against committed state.json'."

And `docs/my-specs/008-interactive-checkpoint/plan.md:1063` flagged the gap explicitly:

> "Reconciliation when state.json diverges from refs: `reconcileState` needs an authoritative mode that fully rebuilds state.json from refs + filesystem. **Details TBD in implementation.**"

That TBD never landed. This spec lands it.

## Implementation reality (what the code actually does today)

| Layer | 008 spec intent | Reality | File:line |
|---|---|---|---|
| state.json writes | Atomic at lifecycle points | ✅ correct — written at cycle boundaries + on pause | `src/core/orchestrator.ts:2248-2253`, `:851-858` |
| state.json reads in renderer | Used to rebuild UI on project open and after drift | ❌ read **once** on mount via `getRunState()`, never re-read | `src/renderer/hooks/useOrchestrator.ts:191-268` (initial), then `:316-661` event-only |
| `reconcileState` rebuilds from git refs | Yes (per 008 README:219) | ❌ no — only diffs `lastCommit.sha` against `HEAD`, checks artifacts + tasks.md. Does not derive `cyclesCompleted` / `currentCycleNumber` / `lastCompletedStep` from refs | `src/core/state.ts:469-687` |
| `reconcileState` runs on project open | Yes (per 008 README:222) | ❌ runs **only on resume** (`config.resume === true`) | `src/core/orchestrator.ts:1308` |
| Cycle ordering guard | Implied | ❌ none — `loop_cycle_started` for cycle N+1 fires while cycle N is mid-abort | `src/core/orchestrator.ts:1579-2273` |
| Synthetic step events | Not specified | `emitSkippedStep` reuses `step_completed`; renderer can't tell synthetic from real | `src/core/orchestrator.ts:1820-1833` |
| 5s "skipped" heuristic | Not specified | Pure renderer hack to paper over the missing distinction above | `src/renderer/components/loop/StageList.tsx:104` |

## Mechanism, end-to-end

1. User clicks Stop while Cycle 1 is running Implement.
2. Orchestrator catches `AbortError`, sets `pauseReason: "user_abort"`, does NOT increment `cyclesCompleted`. state.json is correct. ✅
3. **Before** the abort propagates, the orchestrator already emitted `loop_cycle_started` for Cycle 2 (the abort check is at cycle boundaries, not before each event emit), and emitted `emitSkippedStep` synthetic events for Cycle 2's stages on a `RESUME_FEATURE` path.
4. Renderer event accumulator (`useOrchestrator.ts:316-661`) appends Cycle 2 to `loopCycles[]` with `step_completed` for every synthetic-skip event. Synthetic events have ~0 ms duration — the 5s heuristic at `StageList.tsx:104` masks `verify`/`learnings` as "skipped" but the rest render green.
5. `loop_cycle_completed` for Cycle 2 fires with `decision: "stopped"`, hook maps to `status: "running"` (`useOrchestrator.ts:553`); cycle row shows orange pause icon while inner steps render complete.
6. The header counter `1/3 cycles` is computed from a third path, disagreeing with state.json's `cyclesCompleted: 2`.
7. `reconcileState` only runs on Resume — never on Stop, never on project open — so nothing ever heals the drift.

## Spec gaps this feature closes

### Gap 1 — Live renderer ↔ state.json sync contract is undefined

**Where it belonged**: `008-interactive-checkpoint/README.md` § "Storage model — three layers"

**Missing**: 008 defines reconciliation triggers for project-open, Go back, and external git change — but not for live runs. It does not say whether the renderer is event-driven only, polling-driven, or hybrid. It does not say the renderer must re-read state.json on `paused` / `stopped`.

**Resolution here**: §§ "Renderer ↔ Orchestrator sync protocol" and "Trigger matrix" below.

### Gap 2 — Cycle lifecycle atomicity is undefined

**Where it belonged**: `008-interactive-checkpoint/README.md` § "Autonomous Loop" (does not exist as a section; would be a new one or fold into "Storage model")

**Missing**: No spec text saying "cycle N+1 cannot emit events until cycle N is committed (learnings done OR cycle aborted)." The orchestrator's loop body therefore freely emits `loop_cycle_started` for the next cycle while the previous is still in flight or aborting.

**Resolution here**: § "Cycle lifecycle invariant" below.

### Gap 3 — Synthetic / skipped-step rendering semantics are undocumented

**Where it belonged**: 008 — does not mention `emitSkippedStep` exists.

**Missing**: When `RESUME_FEATURE` / skip-on-no-diff paths emit synthetic step events, what status should the UI render? "Completed" (current behavior) is wrong — the step did not run. "Skipped" with a distinct visual is correct, but the spec does not say so. The 5 s duration heuristic at `StageList.tsx:104` is downstream debt from this silence.

**Resolution here**: § "First-class synthetic-step events" below.

### Gap 4 — `reconcileState` rebuild-from-refs algorithm is TBD

**Where it belonged**: `008-interactive-checkpoint/plan.md:1063` — already flagged as TBD.

**Missing**: How `reconcileState` derives `cyclesCompleted` / `currentCycleNumber` / `lastCompletedStep` from git refs. Without this, `reconcileState` can only detect drift, not heal it.

**Resolution here**: § "Authoritative rebuild algorithm" below. Builds on `008-interactive-checkpoint/plan.md` P5 — the structured `[checkpoint:<stage>:<cycle>]` commit marker — which makes this a `git log --grep` parse, not a divinable reconstruction.

### Gap 5 — Single canonical source for the cycle counter

**Where it belonged**: 008 — never specified.

**Missing**: The "X/Y cycles" header counter has no spec'd source. Implementation derives it from a third path that disagrees with state.json's `cyclesCompleted` and with the in-memory event accumulator.

**Resolution here**: § "Counter source-of-truth rule" below.

## Storage model — restated, with live-run rules

(Extends `008-interactive-checkpoint/README.md:209-217` "Storage model — three layers".)

| Layer | Where | Authority | Live-run rule |
|---|---|---|---|
| **Cache** | `<projectDir>/.dex/state.json` | Derived | Rebuilt from History on the events listed in § "Trigger matrix". Renderer reads via `getRunState()` IPC after every reconciliation event. |
| **History** | Git refs — `checkpoint/*` tags (manual via `promote-checkpoint.sh` post-013), `dex/*` run branches, `selected-*` navigation forks, structured commit messages with `[checkpoint:<step>:<cycle>]` subjects | **Authoritative for cycle/stage progression.** | Append-only during a run. Read by `reconcileState` to rebuild Cache. (`attempt-*` and `capture/*` were retired in 013-cleanup-2; pre-existing refs may linger but are not produced by the running app.) |
| **Audit** | `<projectDir>/.dex/runs/<runId>.json` (007) + `~/.dex/logs/<project>/<runId>/` | **Authoritative for cost / duration / per-subagent traces.** | Append-only during a run. Read by `reconcileState` to populate fields not derivable from refs (cost, duration). |

Authority is partitioned: cycle/stage **progression** comes from refs; cost/duration **metrics** come from runs JSON; both are merged into state.json on every reconciliation event. The renderer never derives progression from its own event log — it always reads the reconciled state.json (via `getRunState()`).

## Renderer ↔ Orchestrator sync protocol

(Closes Gap 1.)

The renderer maintains an in-memory event accumulator for fast incremental UI updates **but treats state.json as authoritative on every settling point**:

1. **Initial mount**: `getRunState()` returns the reconciled state. Accumulator is seeded from it.
2. **During a stage**: events drive the accumulator (current behavior). UI may show a stage as "running" / "completed" optimistically.
3. **At every settling point** (see Trigger matrix): renderer calls `getRunState()`, replaces its `loopCycles` / `preCycleStages` with the reconciled view, and discards any accumulator entries that have no corresponding cycle/stage in the reconciled state.
4. **Conflict rule**: persisted state always wins over accumulator state. The accumulator never overrides a reconciled value.

### Trigger matrix

| Event | Main process action | Renderer action |
|---|---|---|
| Project open | `reconcileState(authoritative: true)` → write state.json | `getRunState()` on mount |
| Resume | `reconcileState(authoritative: true)` (existing call site at `orchestrator.ts:1308`) | `getRunState()` after resume IPC returns |
| Stop / abort | `reconcileState(authoritative: true)` after `pauseReason` write | `getRunState()` on `paused` / `stopped` event |
| Cycle commit (`learnings` done) | `reconcileState(authoritative: true)` after `cyclesCompleted++` write | `getRunState()` on `loop_cycle_committed` event |
| External git change (poll, 30 s + on focus per 008) | `reconcileState(authoritative: true)` | `getRunState()` if poll detects change |
| Go back / Try again / Try N ways (008 verbs) | Already specified in 008 § "Default behavior contract" | (unchanged) |

## Cycle lifecycle invariant

(Closes Gap 2.)

A cycle has exactly four states: `pending → started → committed | aborted`. **At most one cycle is in the `started` state at a time.**

- `pending`: not yet entered. No events emitted.
- `started`: orchestrator has emitted `loop_cycle_started`. May emit `step_started` / `step_completed` for stages within this cycle. No events for cycle N+1 are emitted until this cycle leaves `started`.
- `committed`: `learnings` stage completed successfully. Orchestrator emits `loop_cycle_committed` (new event). `cyclesCompleted` is incremented and state.json is written atomically. Cycle N+1 may now move to `started`.
- `aborted`: abort signal fires while in `started`. Orchestrator emits `loop_cycle_aborted` (new event). `cyclesCompleted` is NOT incremented. Cycle N+1 may NOT move to `started` until Resume.

### Event renaming

| Today | After 011 |
|---|---|
| `loop_cycle_completed` with `decision: "stopped"` | `loop_cycle_aborted` |
| `loop_cycle_completed` with `decision: "completed"` / decision type | `loop_cycle_committed` |
| `loop_cycle_completed` with `decision: "skipped"` | `loop_cycle_skipped` (already distinct in current code; just rename for symmetry) |

Renderer maps these distinctly. The current `useOrchestrator.ts:553` line that maps `decision === "stopped"` → `status: "running"` is replaced by an explicit `loop_cycle_aborted` handler that sets `status: "aborted"` (new enum value) — and is then immediately overwritten by the reconciliation triggered by the `paused` / `stopped` event in the trigger matrix.

### Abort propagation

`abortController.signal.aborted` MUST be checked at the **top of every stage call** within a cycle, not only between cycles. On positive check: bail before emitting any further `step_started` or any synthetic skip event. The current cycle transitions to `aborted` immediately; no events are emitted for cycle N+1.

## First-class synthetic-step events

(Closes Gap 3.)

Add a distinct event type:

```ts
export type OrchestratorEvent =
  /* existing */
  | { type: "step_skipped"; runId: string; cycleNumber: number; stage: LoopStageType;
      reason: "resume_feature" | "no_diff" | "n/a"; durationMs: 0 };
```

Replace `emitSkippedStep` in `src/core/orchestrator.ts:1820-1833`: emit `step_skipped` instead of synthetic `step_started` + `step_completed`.

Renderer maps `step_skipped` → `"skipped"` status in `deriveStageStatus()` (`StageList.tsx:79-110`) with a dedicated visual (struck-through but with a "skipped" tooltip, not a paused-cycle artifact).

**Delete the 5 s duration heuristic** at `StageList.tsx:104`. The new explicit signal makes it obsolete and removes the false-positive (fast genuine verify rendering as struck-through) and false-negative (slow synthetic event rendering as completed).

## Authoritative rebuild algorithm

(Closes Gap 4 / `008-plan.md:1063` TBD.)

`reconcileState(projectDir, options: { authoritative: boolean })` gains an `authoritative` mode. When `authoritative: true`:

1. Read `git rev-parse HEAD` → `currentSha`.
2. Read `git log --grep='^\[checkpoint:' --format='%H%n%s%n%b%n%x00'` on the current branch.
3. For each commit, parse the marker `[checkpoint:<stage>:<cycle>]` (constant `CHECKPOINT_MESSAGE_PREFIX` from `008-plan.md` P5; defined in `src/core/checkpoints.ts`).
4. Derive:
   - `lastCommit = { sha: currentSha, timestamp: <commit-date of currentSha> }`
   - `lastCompletedStep = stage` of the most recent checkpoint commit
   - `currentCycleNumber = cycle` of the most recent checkpoint commit (the cycle that just produced the last commit; if `lastCompletedStep === "learnings"`, the orchestrator will increment to `cycle+1` on next start)
   - `cyclesCompleted = count of commits with stage === "learnings"` on the current branch (each `learnings` commit is the cycle-commit point)
5. Read `<projectDir>/.dex/runs/<runId>.json` (active run) for `cumulativeCostUsd` (sum of `phases[].costUsd`) and per-stage `durationMs`.
6. Merge into a fresh `DexState` object, preserving non-derivable fields from the existing state.json (`config`, `featuresCompleted`, `featuresSkipped`, `pauseReason`, `pausedAt`, `startedAt`).
7. Write atomically. Acquire `.dex/state.lock` (existing).

Non-`authoritative` mode keeps current drift-detection behavior for backward compatibility with the resume flow until callers are migrated.

### Tie-break: orphaned events

When the accumulator has cycles/steps that the rebuild does not (e.g., `loop_cycle_started` for cycle N+1 emitted before abort propagated): the rebuild wins. The orphaned cycle disappears from the UI. This is correct: those events represent work that never produced a checkpoint commit.

## Counter source-of-truth rule

(Closes Gap 5.)

The "X/Y cycles" header counter MUST read `runState.cyclesCompleted` from `getRunState()`. Locate the current derivation site (`LoopDashboard.tsx` or `LoopSummary.tsx` — exact path resolved during implementation) and replace it.

After Slices 1–4 land, this is a one-line change.

## Implementation slices

Each slice independently shippable. Order matters — earlier slices unblock later ones.

| Slice | Contents | Visible? |
|---|---|---|
| **S1** | `reconcileState` authoritative rebuild from refs + tests | No (powers later slices) |
| **S2** | Trigger matrix wired: project open, Stop, cycle commit, external poll. Renderer calls `getRunState()` on `paused` / `stopped` / `loop_cycle_committed`. | Eliminates the live drift |
| **S3** | Cycle lifecycle invariant: abort check at top of every stage call; `loop_cycle_committed` / `loop_cycle_aborted` events; rename + handler split in renderer | Eliminates orphaned cycle N+1 |
| **S4** | First-class `step_skipped` event; renderer renders distinctly; delete 5 s heuristic | Eliminates struck-through false positives |
| **S5** | Counter reads `runState.cyclesCompleted`; remove the third derivation path | Header counter agrees with rest of UI |
| **S6** | Spec updates in 008 (cross-references back to 011) and resolution of `008-plan.md:1063` TBD | No |

### S1 — Authoritative `reconcileState`

**Files**:
- `src/core/state.ts:469-687` — extend `reconcileState` with `options: { authoritative: boolean }`. New mode reads refs + runs JSON and writes a fresh state.json.
- `src/core/checkpoints.ts` — export `parseCheckpointMarker(commitMessage): { stage, cycle } | null` (inverse of the P5 marker).
- `src/core/git.ts` — add `getCommitsWithMarker(projectDir, branch): Array<{ sha, timestamp, message }>` thin wrapper around `git log --grep`.

**Tests** (`src/core/__tests__/state.test.ts`):
- Seed a tmpdir with N checkpoint commits → `reconcileState({authoritative: true})` produces expected `cyclesCompleted` / `currentCycleNumber` / `lastCompletedStep`.
- Empty repo (no checkpoint commits) → fresh state.
- Branch with mid-cycle abort (last commit is `verify` not `learnings`) → `cyclesCompleted` does not include that cycle.

### S2 — Trigger matrix wired

**Files**:
- `src/core/orchestrator.ts:1308` — extend the existing `reconcileState` call to use `authoritative: true`. Add additional call sites at: project open (in main IPC bootstrap), on `pauseReason` write (`:851-858`), on `cyclesCompleted` increment (`:2248-2253`), on external git poll.
- `src/main/ipc/orchestrator.ts:43` — `getRunState` IPC unchanged in shape; now returns the reconciled view.
- `src/renderer/hooks/useOrchestrator.ts:316-661` — on `paused` / `stopped` / `loop_cycle_committed` events, call `getRunState()` and replace `loopCycles` / `preCycleStages` with the reconciled view.

### S3 — Cycle lifecycle invariant

**Files**:
- `src/core/types.ts` — add event types `loop_cycle_committed`, `loop_cycle_aborted`. Deprecate `loop_cycle_completed` with `decision: "stopped"` payload.
- `src/core/orchestrator.ts:1579-2273` — wrap each cycle in a `cycleStarted` / `cycleCommitted | cycleAborted` envelope. Add `abortController.signal.aborted` check at the top of every stage call (currently only between cycles). Move `cyclesCompleted++` + state.json write into a single `commitCycle()` helper.
- `src/renderer/hooks/useOrchestrator.ts:546-562` — split the `loop_cycle_completed` handler into separate `loop_cycle_committed` / `loop_cycle_aborted` / `loop_cycle_skipped` handlers. Remove the `decision === "stopped"` → `status: "running"` line at `:553`.

### S4 — First-class `step_skipped`

**Files**:
- `src/core/types.ts` — add `step_skipped` event type with `reason` field.
- `src/core/orchestrator.ts:1820-1833` (`emitSkippedStep`) — emit `step_skipped` instead of synthetic `step_started` + `step_completed`.
- `src/renderer/hooks/useOrchestrator.ts:565-660` — handler for `step_skipped` → status `"skipped"`.
- `src/renderer/components/loop/StageList.tsx:79-110` (`deriveStageStatus`) — render `"skipped"` distinctly. **Delete lines 102-107** (the 5 s heuristic).

### S5 — Counter source of truth

**Files**:
- `src/renderer/components/loop/LoopDashboard.tsx` and / or `LoopSummary.tsx` — replace the current header-counter derivation with `runState.cyclesCompleted` from `getRunState()`. (Exact site resolved during implementation.)

### S6 — Spec updates

**Files**:
- `docs/my-specs/008-interactive-checkpoint/README.md:209-222` — add a forward reference: "Live-run reconciliation triggers and the renderer sync protocol are specified in `011-state-reconciliation`." Append the trigger matrix link.
- `docs/my-specs/008-interactive-checkpoint/plan.md:1063` — change "Details TBD in implementation" to "Resolved by `011-state-reconciliation` § Authoritative rebuild algorithm."
- `docs/my-specs/008-interactive-checkpoint/README.md` § "Default behavior contract" — add the cycle lifecycle invariant.

## Out of scope

- **Polling cadence tuning**. 30 s + focus from 008 is reused unchanged. Re-evaluate in a follow-up if reconciliation becomes a hot path.
- **Per-stage cost reconciliation**. Costs come from `runs/<runId>.json` already; this spec only ensures the cycle/stage progression view is authoritative. If the cost view drifts, it's a separate bug.
- **Cross-run reconciliation** (multiple runs on the same project). 011 is concerned with the active run only. The runs list view (008's `RunsList`) reads JSON files directly and doesn't drift.
- **Backward compatibility** with state.json files written before this spec lands. Dev phase. On first launch with the new code, `reconcileState({authoritative: true})` runs at project open and overwrites whatever was there. No migration step.

## Verification

### Reproduce the original bug, then verify it can't recur

1. Reset `dex-ecommerce` to `main`. Start a fresh loop.
2. Click Stop during Cycle 1 Implement.
3. **Expected**:
   - state.json: `cyclesCompleted: 0, currentCycleNumber: 1, lastCompletedStep: "tasks", pauseReason: "user_abort"` (or whatever the truthful state is — point: it matches git).
   - UI Steps view: Cycle 1 paused at Implement. Cycles 2 and 3 not rendered. Counter `0/3 cycles`.
   - UI Timeline tab: commits agree with Steps view; no orphaned `gap_analysis · cycle 2` rows.
4. Resume. Cycle 1 picks up at Implement. After cycle 1 completes (learnings runs), counter becomes `1/3 cycles` and Cycle 2 begins.

### Slice-specific

- **S1**: tmpdir tests for `reconcileState({authoritative: true})` — see § "S1 Tests" above.
- **S2**: pause mid-stage; verify `getRunState()` is called by the renderer on `paused` event; verify the in-memory `loopCycles` is replaced (snapshot test in `useOrchestrator.test.ts`).
- **S3**: integration test — abort Cycle 1 mid-Implement; verify zero `loop_cycle_started` events for Cycle 2 are emitted (event recorder).
- **S4**: a `RESUME_FEATURE` decision path — verify `step_skipped` events fire (not synthetic `step_completed`); verify `StageList` renders the new visual.
- **S5**: pause mid-stage; verify header counter equals `state.json.cyclesCompleted`.
- **Regression — fast genuine verify**: a verify that legitimately runs in <5 s now renders as ✅ completed (not struck-through). The 5 s heuristic deletion is the test.
- **Regression — divergent state.json**: manually edit state.json to `cyclesCompleted: 99`; reopen project; verify reconciliation overwrites with the truthful value.

### Property tests

- For every (stage × cycle) pair that the orchestrator can produce a checkpoint commit for, `parseCheckpointMarker(commitCheckpoint(stage, cycle).message)` round-trips.
- For every event sequence the orchestrator emits during a normal cycle, the renderer's accumulator + reconciliation converges to the same state.json the orchestrator writes.

## Estimated effort

**3–4 working days** for a single engineer.

- Day 1: S1 (`reconcileState` rebuild + tests).
- Day 2: S2 (trigger matrix + renderer reconciliation calls) + S5 (counter rewire).
- Day 3: S3 (cycle lifecycle invariant + event rename).
- Day 4: S4 (`step_skipped` event + 5 s heuristic deletion) + S6 (spec updates) + verification matrix.

No new dependencies.

## Supersedes / amends

- **Amends** `008-interactive-checkpoint` § "Storage model — three layers" — adds live-run reconciliation triggers and the renderer sync protocol.
- **Resolves** `008-interactive-checkpoint/plan.md:1063` — the TBD on `reconcileState` authoritative rebuild.
- **Does not supersede** `006-mid-cycle-resume` — resume semantics are unchanged; this spec only changes how state.json is rebuilt before resume runs.
