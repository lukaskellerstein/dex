# Mid-Cycle Resume — Don't Lose Work When the User Pauses

## Context

Dex's Loop runs in cycles. Each cycle walks a spec through `gap_analysis → specify → plan → tasks → implement → verify → learnings`. Pause/resume is a first-class user affordance — the Topbar's **Stop** button is wired to "pause, not kill" (`orchestrator.ts:1461-1465` writes `status: "paused"` in the finally block so state survives).

Today, **that promise is only kept if you pause at the boundary of a completed cycle**. If you pause mid-cycle — e.g., after specify finished and plan is still running — the next resume:

1. Treats the aborted cycle as a completed one (`cyclesCompleted++` fires unconditionally).
2. Starts a *new* cycle from gap_analysis.
3. Orphans the spec dir that was created by specify (it stays in `specs/NNN-…/` on disk and in `state.artifacts.features` but no plan/tasks/implement work ever runs against it).
4. Silently wastes the spend on that aborted cycle's specify.

This was surfaced as bug **B-3** in `docs/testing-session-005.md` Phase B.2. A partial inline fix landed (stop the null-clobber of `currentSpecDir` at `orchestrator.ts:1215`), but the structural fix needs a real design.

### Why the current design can't resume mid-cycle

Two coupled issues:

1. **`cyclesCompleted++` fires on abort** (`orchestrator.ts:2723`). The increment runs in the cycle's post-amble regardless of `cycleAborted`. Since `cycleNumber = cyclesCompleted + 1` (`orchestrator.ts:2181`), the next iteration always gets a fresh cycle number, even if the previous one only got as far as specify.

2. **`RESUME_FEATURE` is binary** (`orchestrator.ts:2357-2361`). It emits synthetic `stage_completed` events for specify + plan + tasks, then jumps straight to implement. There's no "resume at plan" or "resume at tasks" — the decision type carries a `specDir` but no `resumeAtStage`. So even if we fixed (1), a resume would still skip plan and tasks and run implement against a broken spec.

A clean fix needs both: preserve the aborted cycle's `cycleNumber`, and teach the cycle body to honor an intra-cycle resume point.

## Approach

Three coordinated changes — none of them large, but they have to land together.

### 1. Don't advance `cyclesCompleted` on abort

**File**: `src/core/orchestrator.ts`, around line 2720.

```ts
const cycleAborted = abortController?.signal.aborted ?? false;
const cycleStatus = cycleAborted ? "stopped" : cycleFailed ? "failed" : "completed";
if (!cycleAborted) {
  cyclesCompleted++;
}
```

Failed cycles (unrecoverable error, not user abort) do advance — we don't want to infinite-loop on a poison cycle. User aborts don't advance — next resume picks up where they left off.

**Side effect**: the next resume's `cycleNumber = cyclesCompleted + 1` equals the aborted cycle's number. The cycle body is re-entered with the same cycleId lookup. The DB already tolerates this — `phase_traces` rows are keyed by UUID, not by cycleNumber, and `getSpecPhaseStats` already deduplicates "latest per (project, phase_number, specDir)".

### 2. New decision type: `RESUME_AT_STAGE`

**Files**: `src/core/types.ts` (add to `GapAnalysisDecision` union), `src/core/orchestrator.ts` (emit it, handle it).

```ts
// types.ts
export type GapAnalysisDecision =
  | { type: "GAPS_COMPLETE" }
  | { type: "NEXT_FEATURE"; featureId: string; name: string; description: string }
  | { type: "REPLAN_FEATURE"; featureId: string; specDir: string }
  | { type: "RESUME_FEATURE"; specDir: string }                              // existing
  | { type: "RESUME_AT_STAGE"; specDir: string; resumeAtStage: LoopStageType }; // NEW
```

**When to emit it**: in `runLoop` at the gap-analysis short-circuit (`orchestrator.ts:2194`). Today's check is:

```ts
if (resumeSpecDir && cycleNumber === cyclesCompleted + 1) {
  decision = { type: "RESUME_FEATURE", specDir: resumeSpecDir };
  // ...
}
```

New logic:

```ts
if (resumeSpecDir && cycleNumber === cyclesCompleted + 1) {
  // If lastCompletedStage is past tasks (or null), the feature's spec is fully authored —
  // classic RESUME_FEATURE applies (skip specify+plan+tasks, run implement+).
  // If it's earlier (specify or plan completed but not tasks), resume intra-cycle.
  const intraCycleStages: LoopStageType[] = ["specify", "plan", "tasks"];
  if (resumeLastStage && intraCycleStages.includes(resumeLastStage)) {
    decision = { type: "RESUME_AT_STAGE", specDir: resumeSpecDir, resumeAtStage: resumeLastStage };
  } else {
    decision = { type: "RESUME_FEATURE", specDir: resumeSpecDir };
  }
  // synthetic gap_analysis stage_completed event, same as today
}
```

### 3. Honor `RESUME_AT_STAGE` in the cycle body

**File**: `src/core/orchestrator.ts`, around line 2357 (the decision-type branch pile).

Replace the hard-coded `if (decision.type === "NEXT_FEATURE") { /* specify */ }` etc. with a helper that knows which stages to skip based on `resumeAtStage`:

```ts
// Synthesize skip events for stages before resumeAtStage (UI stepper needs them)
if (decision.type === "RESUME_AT_STAGE") {
  const skipBefore: LoopStageType[] = [];
  if (STAGE_ORDER.indexOf("specify") <= STAGE_ORDER.indexOf(decision.resumeAtStage)) {
    skipBefore.push("specify");
  }
  if (STAGE_ORDER.indexOf("plan") <= STAGE_ORDER.indexOf(decision.resumeAtStage)) {
    skipBefore.push("plan");
  }
  if (STAGE_ORDER.indexOf("tasks") <= STAGE_ORDER.indexOf(decision.resumeAtStage)) {
    skipBefore.push("tasks");
  }
  for (const s of skipBefore) emitSkippedStage(s, cycleNumber);
}

// Helper to gate each stage block
const shouldRun = (stage: LoopStageType): boolean => {
  if (decision.type === "NEXT_FEATURE") return stage !== "gap_analysis";
  if (decision.type === "REPLAN_FEATURE") return stage === "plan" || stage === "tasks" || stage === "implement" || stage === "verify" || stage === "learnings";
  if (decision.type === "RESUME_FEATURE") return stage === "implement" || stage === "verify" || stage === "learnings";
  if (decision.type === "RESUME_AT_STAGE") {
    const resumeOrdinal = STAGE_ORDER.indexOf(decision.resumeAtStage);
    const stageOrdinal = STAGE_ORDER.indexOf(stage);
    return stageOrdinal > resumeOrdinal;
  }
  return false;
};

// Each stage block becomes: if (shouldRun("specify")) { ... }
```

The existing five stage blocks (specify, plan, tasks, implement, verify, learnings) just swap their `if (decision.type === ...)` guards for `if (shouldRun(...))`. Net code change is small; the `shouldRun` abstraction documents the decision→stages mapping in one place instead of being scattered across the cycle.

### 4. Keep `currentSpecDir` honest

`orchestrator.ts:1215` already has the null-clobber fix from the testing session. Also need: write `currentSpecDir: specDir` immediately after specify creates the new dir (so a pause between specify and plan has the right state to resume from).

**File**: `src/core/orchestrator.ts:2381-2385`.

```ts
// AFTER specify creates the new dir, write it to state immediately so
// pause-between-specify-and-plan is recoverable.
if (activeProjectDir) {
  updateState(activeProjectDir, {
    currentSpecDir: specDir,  // NEW
    artifacts: { features: { [specDir]: { specDir, status: "specifying", spec: null, plan: null, tasks: null, lastImplementedPhase: 0 } } },
  } as never).catch(() => {});
}
```

This was attempted inline during testing session 005 but reverted because the RESUME_FEATURE path would've skipped plan+tasks incorrectly. With this spec's changes, setting `currentSpecDir` becomes correct again.

## Out of scope

- **Resuming mid-stage** (e.g., paused halfway through a plan agent's tool calls). The grain of resume is stage boundaries, not tool-call boundaries. Mid-stage resumption would require persisting SDK session state — a much bigger lift, not justified by real use cases (pausing mid-specify is rare, and re-running a stage is cheap compared to losing the whole cycle).

- **Resuming across an orchestrator version upgrade** where the cycle body's stage sequence changed. Out of scope; hash-check in `reconcileState` already flags artifact drift, and a stage-sequence change would be a breaking version bump.

- **Intra-cycle resume for the implement stage's sub-phase** (Phase 1, Phase 2, …). The implement stage already handles its own resume via `tasks.md` checkbox state (`reconcileState` diffs the checksum map). Mid-implement resume works today; it's only the pre-implement stages (specify/plan/tasks) that don't.

## Critical files

- `src/core/types.ts` — add `RESUME_AT_STAGE` to `GapAnalysisDecision` union
- `src/core/orchestrator.ts:2194-2202` — emit `RESUME_AT_STAGE` vs `RESUME_FEATURE` based on `lastCompletedStage`
- `src/core/orchestrator.ts:2357-2361` — swap scattered `decision.type === "NEXT_FEATURE"` guards for a `shouldRun(stage)` helper
- `src/core/orchestrator.ts:2381-2392` — write `currentSpecDir` immediately after specify creates new dir
- `src/core/orchestrator.ts:2720-2735` — guard `cyclesCompleted++` with `!cycleAborted`
- `src/core/state.ts:356-372` — `STAGE_ORDER` constant used for ordinal comparisons (no change needed, just referenced)

## Functions we rely on (no changes needed)

- `STAGE_ORDER` at `state.ts:356` — already has specify/plan/tasks in the right order
- `emitSkippedStage` at `orchestrator.ts:1993-1999` — already synthesizes stage_started/completed events for UI stepper
- `reconcileState` at `state.ts:435-654` — artifact hash checks already validate the restored state on resume
- `detectStaleState` at `state.ts:287-298` — `status: "paused"` returns "fresh" regardless of branchName, so intra-cycle resume doesn't trip the stale detector

## Verification

Once the changes land, run this matrix against the `fixture/after-clarification` fixture (one loop-run budget, about $10 of LLM spend if you run each path once):

1. **Baseline — clean resume after-tasks still works.** Reset to `fixture/after-tasks`, click Resume, watch first emitted stage = `implement`. This is the existing RESUME_FEATURE path — unchanged.
2. **Pause between specify and plan.** Reset to `fixture/after-clarification`, click Resume, wait for `stage_completed(specify)`, click Stop. Record `state.json`. Click Resume. Verify:
   - First emitted stage after gap_analysis is `plan` (NOT specify again, NOT implement).
   - `specs/NNN-…/spec.md` is the same file the aborted cycle wrote (no spec dir churn).
   - `cyclesCompleted` in state equals what it was before the abort (didn't silently advance).
3. **Pause between plan and tasks.** Same setup; pause at `stage_completed(plan)`. Verify resume starts at `tasks`.
4. **Pause between tasks and implement.** Same setup; pause at `stage_completed(tasks)`. Verify resume starts at `implement` — this is the existing `fixture/after-tasks` behavior and should keep working.
5. **Normal cycle completion still advances `cyclesCompleted`.** Let a cycle run to completion naturally (no manual abort); verify `cyclesCompleted` incremented by 1, next cycle starts at gap_analysis for the *next* feature.
6. **UI stepper coherence.** After each mid-cycle resume, the Loop Dashboard's cycle timeline shows the skipped stages as ✓ (completed via `emitSkippedStage`) — not as "running" or missing.

Lightweight checks (fast, cheap):

- `npx tsc --noEmit` after each change.
- Unit-test the `shouldRun` helper table: 4 decision types × 7 stages = 28 cases, all deterministic.

## Non-goals / open questions to resolve during planning

- **What about pause during gap_analysis itself?** The gap_analysis stage runs an LLM call. If the user pauses mid-call, `lastCompletedStage` stays at whatever was before gap_analysis (e.g., `tasks` from the previous cycle, or `manifest_extraction` for the first cycle). Resume would re-run gap_analysis from scratch — acceptable, gap_analysis is cheap. No special handling.

- **Should `RESUME_AT_STAGE` also cover `implement_fix`, `verify`, `learnings`?** Probably not — those run after implement completes, and implement's own resume-via-checksum already handles mid-implement pauses. If verify or learnings gets paused, the simplest answer is "re-run it"; they're idempotent reads of the finished work. Verify in planning but default to no.

- **Migration of existing paused state.** Projects with `.dex/state.json` written under current code may have an inconsistent `cyclesCompleted` (inflated by past aborts). After landing this spec, does the orchestrator reconcile? Recommend: no migration — on first resume after upgrade, `reconcileState` already handles drift by falling back to the earliest affected stage. One slightly-suboptimal resume is acceptable.

- **Does this interact with the `RESUME_FEATURE` path for `after-tasks` fixture?** Test case 4 above. After the refactor, `fixture/after-tasks` has `lastCompletedStage: "tasks"`. The new decision emitter maps that to `RESUME_FEATURE` (not `RESUME_AT_STAGE`, because tasks is the last of the intra-cycle triad). Existing behavior preserved.

## Estimated effort

**1–2 days** of focused work:

- 0.5 day: types + emit logic + shouldRun helper + state propagation fix
- 0.5 day: wire into cycle body + typecheck + light unit tests for shouldRun
- 0.5 day: run the verification matrix, fix whatever breaks
- 0.5 day: docs (update `docs/testing-session-005.md` — close B-3, mark the follow-up as landed)

No UI changes. No new dependencies. No schema changes.
