# Contract — `AgentRunner` interface

**File**: `src/core/agent/AgentRunner.ts`
**Stability**: Load-bearing for all future providers. Breaking changes require a corresponding change in `orchestrator.ts`.

---

## Interface

```typescript
export interface AgentRunner {
  runStage(ctx: StageContext): Promise<StageResult>;
  runPhase(ctx: PhaseContext): Promise<PhaseResult>;
}

export type AgentRunnerFactory = (
  runConfig: RunConfig,
  projectDir: string,
) => AgentRunner;
```

Two methods, one factory type. Nothing else. See `data-model.md` §3 for the exact shape of `StageContext`, `StageResult`, `PhaseContext`, `PhaseResult`.

---

## Method: `runStage(ctx: StageContext): Promise<StageResult>`

**Called for**: every per-stage agent invocation in the loop — `gap_analysis`, `specify`, `plan`, `tasks`, `implement`, `implement_fix`, `verify`, `learnings`, `clarification_product`, `clarification_technical`, `clarification_synthesis`, `constitution`, `manifest_extraction`.

**Preconditions**:
- `ctx.prompt` is already assembled by the orchestrator — runner MUST NOT re-assemble it.
- `ctx.phaseTraceId` has been registered in the runs ledger before the runner is called — runner MUST NOT call `runs.startPhase`/`completePhase`.
- `ctx.emit` and `ctx.rlog` are valid for the duration of the call.

**Postconditions**:
- `stage_started` emitted before any side effect.
- Exactly one `stage_completed` emitted before resolving (with `costUsd` and `durationMs` — 0 and measured respectively for the mock).
- Returned `StageResult.structuredOutput` is non-null iff `ctx.outputFormat` was supplied.
- Returned `StageResult.cost` is a non-negative finite number.
- If the call throws, a `stage_completed` event MAY have been emitted — the orchestrator must handle both paths. (Matches today's real-runner behavior.)

**Abort handling**:
- If `ctx.abortController?.signal.aborted` becomes `true` during the call, the runner SHOULD emit `stage_completed` with an error cause OR throw — either is acceptable. Orchestrator handles both.

**No silent defaults** (mock-specific reinforcement):
- `MockAgentRunner.runStage` throws `MockConfigMissingEntryError` when no script entry exists for `(phase, stage, [cycle, feature])`.
- Throws `MockFixtureMissingError` when any `writes[].from` resolves to a nonexistent path.
- Throws `MockConfigInvalidPathError` when any `writes[].path` or `appends[].path` contains an unknown substitution token.

---

## Method: `runPhase(ctx: PhaseContext): Promise<PhaseResult>`

**Called for**: spec-kit skill invocations that run as a single phase (not a per-stage loop) — historically the `prerequisites` handshake and some ad-hoc skill calls at `src/core/orchestrator.ts:506`.

**Preconditions / Postconditions**: same shape as `runStage`, minus the structured-output channel.

**Mock behavior**:
- `MockAgentRunner.runPhase` is a specialization of `runStage` for the one-off phase case. It looks up the phase descriptor at `config[phase]` (no cycle index) and executes the same `delay → writes → appends` pipeline.

---

## Invariants (both methods)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Runner MUST NOT import from `electron`, `src/main/`, or `src/renderer/`. | ESLint `no-restricted-imports` on `src/core/**` + Vitest test `core.electron-free.test.ts` (existing). |
| I2 | Runner MUST NOT mutate `.dex/state.json` directly. | Code review — orchestrator owns state writes. |
| I3 | Runner MUST NOT write to the runs ledger (`runs.startPhase`, `runs.completePhase`). | Code review; orchestrator is the sole caller in `src/core/runs.ts`. |
| I4 | Runner MUST emit `stage_started` / `stage_completed` pairs (or `phase_started` / `phase_completed`) for every invocation. | Unit tests assert the event sequence. |
| I5 | Runner's returned cost + duration MUST be accurate-as-observable. For mock: cost is always `0`, duration is wall-clock from method entry to return. | Unit tests. |

---

## Testing contract

Every runner implementation ships with these Vitest tests:

- `<Runner>.emits-stage-started-and-completed.test.ts` — for one representative stage.
- `<Runner>.returns-structured-output-when-requested.test.ts` — for a structured-output stage.
- `<Runner>.does-not-write-to-runs-ledger.test.ts` — mock `runs.*` and assert zero calls.
- Mock-specific: `MockAgentRunner.throws-on-missing-entry.test.ts`, `…on-missing-fixture.test.ts`, `…on-unknown-token.test.ts`, `…honors-delay.test.ts`, `…returns-structured-output-verbatim.test.ts`.

These tests are part of Phase 2 (tasks.md) — the contract lists them so the shape is fixed before implementation.
