# Event Order — 011-refactoring

**Created**: 2026-04-27 (seeded; matrices completed at B0 in Phase 5)
**Consumer**: Wave-A golden-trace gate (every sub-gate diffs against this spec); Wave-B hook-split state→hook + event→hook matrices.
**Reference**: [`contracts/golden-trace.md`](../../../specs/011-refactoring/contracts/golden-trace.md), [`contracts/wave-gate.md`](../../../specs/011-refactoring/contracts/wave-gate.md).

---

## Canonical emit sequence (per stage)

This is the structural spine of a clean autonomous-loop run. Every event listed here MUST appear in the post-Wave-A golden trace; reordering is tolerable only when explicitly listed in §"Tolerable reorders by sub-gate" below.

```text
run_started
  prerequisites_started
    prerequisites_check (×5 — claude_cli, specify_cli, git_init, github_repo, speckit_init)
  prerequisites_completed
  clarification_started
    clarification_question     (interactive — only when skipInteractive=false)
    clarification_completed
  loop_cycle_started
    task_phase_started         (×N — one per stage in cycle: gap_analysis | specify | plan | tasks | implement | learnings)
      step_started
        agent_step             (×many — every SDK stream chunk)
        subagent_started       (×0+ — per spawned subagent)
          agent_step           (×many — inside the subagent)
        subagent_completed
        subagent_result        (×0+ — when subagent emits a result payload)
      step_completed
    task_phase_completed
  loop_cycle_completed         (or loop_terminated on stop / budget exhaust / max-cycles reached)
run_completed                  (or never, if abort)
```

`spec_started` / `spec_completed` fire in **Build mode** (not Loop mode) — they bracket each spec's run-through. The golden-trace baseline is captured in Loop mode, so they should not appear in the baseline.

`state_reconciled` fires when `reconcileState` decides the on-disk state and the in-memory state diverge and re-converges them; observed at run start and on resume. Its presence in the baseline depends on whether the baseline run hits a reconciliation path. Treat as **tolerable absent** if the seed run is fully clean.

`tasks_updated` fires when `tasks.md` is parsed and its phase status materially changes. Spec-kit-only event; expected during the `implement` stage of a cycle that runs through the implement phase. Absent if implement was skipped.

`error` events carry a `phase` discriminator. Run-level errors → `useRunSession`. Phase-scoped errors (`phase === "prerequisites" | "clarification" | "loop_cycle" | ...`) route to the relevant hook per the matrix in §"Event → hook ownership" below. Composer-level fatal-error sink catches unmatched.

---

## Tolerable reorders by sub-gate

The wave-gate diff (`diff golden-trace-pre-A.txt /tmp/golden-post.txt`) is read against this list. Any diff entry not enumerated below is a regression and triggers a rollback.

### G0 — A0 + A0.5 (mechanical checkpoint consolidation + split)

> **Tolerable reorders**: none. A0 is pure import-site re-routing; A0.5 is pure file relocation behind a re-export shim. Public emit shape MUST be identical to the baseline. Any diff is a regression.

### G1 — A1 + A2 (OrchestrationContext + prerequisites)

> **Tolerable reorders**:
> - `prerequisites_started` may now emit *before* the lock-acquisition log line (was after). The lock acquisition moved into `createContext` which runs first; the prerequisites driver no longer emits between lock acquisition and the first check. **Tolerable** — same set of events, different ordering of one log↔event boundary.
>
> No semantic emit-set differences expected. Order of `prerequisites_check` for the 5 individual checks MUST be identical (claude_cli → specify_cli → git_init → github_repo → speckit_init).

### G2 — A3 + A4 (clarification + main loop)

> **Tolerable reorders**:
> - `clarification_completed` may emit before or after the `[INFO] full plan written to <path>` log line. The `runClarificationPhase` extraction moves the plan-write to its trailing edge; previously inlined ordering varied by abort-check placement. **Tolerable**.
> - Inside `main-loop.ts`, the per-cycle `task_phase_started` for `gap_analysis` may emit before or after the `[INFO] cycle <N> starting` log line for the same reason. **Tolerable**.
>
> No semantic emit-set differences. Cycle structure (`loop_cycle_started → task_phase_started* → loop_cycle_completed`) MUST be intact.

### G3 — A5 + A6 + A7 (gap-analysis + finalize + phase-lifecycle)

> **Tolerable reorders**: none expected.
>
> A5 (gap-analysis parser) is pure — same decisions, same emits. A6 (finalize) wraps the existing `updateState → commitCheckpoint → updatePhaseCheckpointInfo → autoPromoteIfRecordMode → readPauseAfterStage` sequence into one call site; the **internal** ordering of those operations is already deterministic and MUST stay so. A7 (phase-lifecycle) wraps `runs.startAgentRun → emit("phase_started") → rlog.agentRun` into `recordPhaseStart`; the order is preserved by the wrapper.
>
> Any diff in `phase_started` / `phase_completed` ordering relative to surrounding `step_started` / `step_completed` is a regression — `phase_started` MUST precede the first `step_started` of its phase, and `phase_completed` MUST follow the last `step_completed`.

### G4 — A8 (trim coordinator)

> **Tolerable reorders**: none. A8 is pure code motion — `run()` becomes a slim dispatcher, the helpers it calls are unchanged.
>
> Re-emit-set MUST equal the post-G3 set. Any new event or missing event is a regression.

---

## State → hook ownership matrix

> ⚠️ Filled at **B0 (start of Phase 5 / Wave B)**. Seeded here as the target structure; the actual matrix is locked when Wave B begins.

| Hook | States |
|---|---|
| `useLoopState` | `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination` |
| `useLiveTrace` | `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId` |
| `useUserQuestion` | `pendingQuestion`, `isClarifying` |
| `useRunSession` | `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical` |
| `usePrerequisites` | `prerequisitesChecks`, `isCheckingPrerequisites` |

**Total**: 21 useState calls. Every state in the existing `useOrchestrator.ts` MUST be assigned to exactly one hook. Verified at the Wave B gate by manual cross-check (or a small audit script if drift becomes a recurring concern).

---

## Event → hook ownership matrix

> ⚠️ Filled at **B0 (start of Phase 5 / Wave B)**. Seeded here from the target in `data-model.md` §"Renderer hook state ownership"; locked when Wave B begins.

| Hook | Events |
|---|---|
| `useLoopState` | `loop_cycle_started`, `loop_cycle_completed`, `loop_terminated`, `task_phase_started`, `task_phase_completed`, `spec_started`, `spec_completed` |
| `useLiveTrace` | `step_started`, `step_completed`, `agent_step`, `subagent_started`, `subagent_completed`, `subagent_result` |
| `useUserQuestion` | `clarification_started`, `clarification_question`, `clarification_completed`, `user_input_request`, `user_input_response` |
| `useRunSession` | `run_started`, `run_completed`, `state_reconciled`, plus run-level `error` only |
| `usePrerequisites` | `prerequisites_started`, `prerequisites_check`, `prerequisites_completed` |

**Total**: 25 distinct `event.type` cases. Every case in the existing `useOrchestrator` switch MUST be assigned to exactly one hook.

The 5 `AgentStep` subtypes (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) are used inside `useLiveTrace`'s `labelForStep` helper; they are not top-level events and don't appear in the matrix. Verified at B0 that no other consumer uses them — if zero, they may be deletable raw SDK passthroughs.

---

## Error event discriminator policy

`error` events carry a `phase` field. Routing:

| `phase` value | Owning hook |
|---|---|
| (run-level, no phase) | `useRunSession` |
| `prerequisites` | `usePrerequisites` |
| `clarification` | `useUserQuestion` |
| `loop_cycle` / `task_phase` / `step` | `useLoopState` (cycle context) and surfaced in `useLiveTrace` (step context) — coordinator decides per `event.scope` |
| (no matching hook with the right discriminator) | composer fatal-error sink (top-level toast) |

The composer (B4) keeps a top-level fatal-error sink so unmatched events are still surfaced — they're just not routed into a domain hook's state.

---

## Operational note

Re-capturing the golden-trace baseline mid-Wave-A is forbidden — the intersection of two pre-A runs is the stable signal; replacing it during the wave defeats the regression check. If a load-bearing event is intentionally added or removed by an explicit spec amendment (rare), document the re-capture in the amending wave's PR description with the new SHA of `golden-trace-pre-A.txt`.
