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

## State → hook ownership matrix (LOCKED at B0 — Phase 5)

State partition is strict — every `useState` in the legacy `useOrchestrator.ts` is owned by exactly one hook.

| Hook | States |
|---|---|
| `useLoopState` | `preCycleStages`, `loopCycles`, `currentCycle`, `currentStage`, `totalCost`, `loopTermination` |
| `useLiveTrace` | `liveSteps`, `subagents`, `currentPhase`, `currentPhaseTraceId` |
| `useUserQuestion` | `pendingQuestion`, `isClarifying` |
| `useRunSession` | `mode`, `isRunning`, `currentRunId`, `totalDuration`, `activeSpecDir`, `activeTask`, `viewingHistorical` |
| `usePrerequisites` | `prerequisitesChecks`, `isCheckingPrerequisites` |

**Total**: 21 useState calls (matches the legacy `useOrchestrator.ts`). Every state is assigned to exactly one hook; verified at Wave B gate by cross-check.

**Refs** (not React state but worth tracking): `viewingHistoricalRef`, `modeRef`, `currentCycleRef`, `currentStageRef`, `livePhaseTraceIdRef`, `livePhaseRef` move with the state slice they shadow (e.g. `viewingHistoricalRef` → `useRunSession`).

---

## Event → hook subscription matrix (LOCKED at B0 — Phase 5)

Audit of the legacy switch shows that 7 of the 25 cases legitimately touch state in **two or more** hooks (e.g. `step_started` updates `useLiveTrace`'s `liveSteps/currentPhase` AND `useLoopState`'s `currentStage/preCycleStages` AND `useRunSession`'s `activeSpecDir`). A strict 1-event-to-1-hook partition would require introducing a coordinator, which contradicts FR-008's behaviour-preservation gate.

**Resolution**: each hook subscribes to `orchestratorService.subscribeEvents` independently and handles only the cases that touch its own state slice. Multiple hooks may subscribe to the same event — each mutates only its own state. The cost is 5 IPC subscriptions instead of 1; the benefit is hook-level testability.

| Hook | Events handled (× = primary owner; ○ = cross-cutting touch on own state) |
|---|---|
| `useLoopState` | × `loop_cycle_started`, × `loop_cycle_completed`, × `loop_terminated`, ○ `task_phase_started` (impl sub-phase tracking; current cycle/stage refs), ○ `task_phase_completed` (impl sub-phase status; `totalCost` accumulation), ○ `step_started` (`currentStage`, `preCycleStages`/`loopCycles` insert), ○ `step_completed` (stage status update; `totalCost` accumulation), ○ `run_started` (clear cycles/stages/cycle/stage/termination), ○ `run_completed` (clear cycle/stage; freeze `totalCost` to event total) |
| `useLiveTrace` | × `agent_step`, × `subagent_started`, × `subagent_completed`, ○ `step_started` (reset `liveSteps`/`subagents`; set `currentPhase`/`currentPhaseTraceId`), ○ `task_phase_started` (set `currentPhase`/`currentPhaseTraceId`; reset `liveSteps`/`subagents`), ○ `spec_completed` (clear `currentPhase`/`currentPhaseTraceId`), ○ `run_completed` (clear `currentPhase`/`currentPhaseTraceId`), ○ `tasks_updated` (sync `currentPhase`'s task list) |
| `useUserQuestion` | × `clarification_started`, × `clarification_completed`, × `user_input_request`, × `user_input_response`, × `clarification_question` (no-op today; reserved), ○ `run_started` (clear `pendingQuestion`/`isClarifying`), ○ `run_completed` (clear `pendingQuestion`/`isClarifying`) |
| `useRunSession` | × `run_started`, × `run_completed`, × `state_reconciled`, × `error` (run-level — phase-discriminator policy below), ○ `spec_started` (`activeSpecDir`), ○ `spec_completed` (clear `activeSpecDir`), ○ `step_started` (`activeSpecDir` if present in event), ○ `task_phase_started` (clear `activeTask` on entry), ○ `task_phase_completed` (`totalDuration` accumulation), ○ `step_completed` (`totalDuration` accumulation), ○ `tasks_updated` (`activeTask` from in-progress task) |
| `usePrerequisites` | × `prerequisites_started`, × `prerequisites_check`, × `prerequisites_completed`, ○ `run_started` (clear checks; set `isCheckingPrerequisites=false`) |

**Total**: 25 distinct event-type cases. Every case is handled by at least one hook; **none** is silently dropped. Cases handled by multiple hooks are documented above with the primary-owner discriminator.

**Audit policy**: at the Wave B gate, manual diff between the legacy `useOrchestrator.ts` switch and the union of the 5 new hooks' switches must show **zero** orphaned cases (a case in the legacy switch with no handler in any new hook). The 1 ignored case (`error` with empty body in the legacy switch) is preserved in `useRunSession` as a no-op pending the composer-level fatal-error sink in B4.

The 5 `AgentStep` subtypes (`subagent_result`, `subagent_spawn`, `text`, `thinking`, `tool_call`) live in `useLiveTrace`'s `labelForStep` helper only.

**AgentStep subtype audit** (T077): grepped renderer for consumers of the 5 subtypes. Findings:
- `subagent_spawn`, `text`, `thinking`, `tool_call`, `subagent_result` are consumed by `labelForStep` (now in `useLiveTrace`) AND by various `agent-trace/` components (`AgentStepList`, `ToolCard`, etc.) that render the live step list.
- The components consume `liveSteps: AgentStep[]` from the composer — they don't read the subtype enum directly, just dispatch on `step.type`.
- Conclusion: the 5 subtypes are **not deletable**; multiple consumers besides `labelForStep` exist. They stay as-is.

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
