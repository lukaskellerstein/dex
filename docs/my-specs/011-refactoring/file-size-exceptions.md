# File-Size Exceptions and Path Decisions — 011-refactoring

**Created**: 2026-04-27
**Locked at**: Pre-Wave (before Gate 0 starts)
**Spec**: [`specs/011-refactoring/spec.md`](../../../specs/011-refactoring/spec.md)

This document is read by `npm run check:size` to derive its allow-list and is the canonical record of the path choices that affect the cross-cutting wave gates.

---

## Path Decisions

These choices are locked **before Gate 0 starts** because they affect cross-cutting code paths whose smoke baselines would be invalidated if the choice changed mid-wave.

### A8-prep — Public entry-point shape

**Choice: Path α — Keep `run()` as a slimmed dispatcher.**

`src/main/ipc/orchestrator.ts:19` continues to import `run` from `src/core/orchestrator.ts`. Under Path α, `run()` survives as a ~30-line dispatcher: `mode resolution → createContext → runLoop | runBuild`. IPC handler signatures are unchanged.

**Rejected: Path β** (delete `run()`, update IPC). Acceptable but rejected because Path β changes a cross-cutting IPC handler and would invalidate Gate 0's smoke baseline if picked up late. Path α has the smaller blast radius and keeps wave-internal rollbacks cleaner.

**Reference**: research.md R-002.

### Pending-question handle — Where it lives

**Choice: On `OrchestrationContext` as `ctx.pendingQuestion`.**

The handle (`{ promise, resolve, requestId }`) is part of the `ctx` value created by `createContext()`. `clarification.ts` consumes `ctx.pendingQuestion` and stays a pure function over `ctx`. The `submitUserAnswer` IPC handler resolves the promise from outside by reading the handle off the singleton `currentContext` holder in `src/main/ipc/orchestrator.ts`.

**Rejected: IPC-layer singleton paired with `submitUserAnswer`.** Rejected because it makes `clarification.ts` impure and leaks IPC concerns into core. Reducing the IPC residual from "trio" to "duo" (`abortController` + `releaseLock` only) makes the inline documentation in `src/main/ipc/orchestrator.ts` shorter and clearer.

**Reference**: research.md R-003. Contract: [`contracts/orchestration-context.md`](../../../specs/011-refactoring/contracts/orchestration-context.md).

---

## File-Size Exceptions

The Wave-A `npm run check:size` audit (Verification §V.7) reports these files at the end of Wave A — and only these. Any other source file >600 LOC after the refactor is a refactor failure.

### `src/core/state.ts`

- **Current size**: 763 LOC
- **Reason**: `01X-state-reconciliation` will land on top of this refactor and rewrite this file. Refactoring it now would create merge conflicts with that planned work — and worse, the refactor would inevitably alter the `reconcileState` semantics that `01X-state-reconciliation` is designed to fix carefully. Behaviour preservation here is load-bearing.
- **Behaviour to preserve verbatim** (do not "while we're here"):
  - The single-mode `reconcileState` (no per-mode dispatch yet — that's `01X`'s job).
  - `detectStaleState` returning `true` after 5 seconds — the heuristic at the matching call site in `StageList.tsx:104` depends on this.
- **Follow-up spec**: `01X-state-reconciliation`.

### `src/core/agent/ClaudeAgentRunner.ts`

- **Current size**: 699 LOC
- **Reason**: SDK adapter — wraps `@anthropic-ai/claude-agent-sdk`'s `query()` async generator with hooks, structured-output retry, and event mapping. Splitting it sensibly requires understanding which hook callbacks should move with which sub-adapter, which is a non-trivial design choice deferred to a dedicated future spec.
- **Behaviour to preserve verbatim**: every event the runner emits today (each maps to a downstream `OrchestratorEvent`), the structured-output retry loop, the abort-signal propagation, the cost-tracking accumulator.
- **Follow-up spec**: TBD — opens after this refactor merges.

### ~~`src/core/stages/main-loop.ts`~~ — A4.5 landed (retired from allow-list)

- **Pre-A4.5 size**: 824 LOC. **Post-A4.5 size**: 573 LOC.
- **A4.5 commit**: extracted the cohesive Implement → Verify → Learnings stage block (~295 LOC) to `src/core/stages/cycle-stages.ts` as `runImplementVerifyLearnings`. Golden-trace **zero-diff** preserved across the move. main-loop.ts retains `runMainLoop` as a slimmer cycle-iterator (gap-analysis decision → specify/plan/tasks → delegate to cycle-stages → cycle finalize → termination).
- **Allow-list status**: retired.

### `src/renderer/hooks/useOrchestrator.ts` — scheduled deferral

- **Current size**: 907 LOC
- **Reason**: Phase 5 / Wave B explicit scope — splits into 5 domain-bounded hooks (`useLoopState`, `useLiveTrace`, `useUserQuestion`, `useRunSession`, `usePrerequisites`) plus a thin composer (~80 LOC). See tasks T078-T087.
- **Wave**: Wave B (Phase 5).

### `src/renderer/App.tsx` — scheduled deferral

- **Current size**: 720 LOC
- **Reason**: Phase 6 / Wave C-rest explicit scope — extracts `AppBreadcrumbs.tsx` (~140 LOC) and `AppRouter.tsx` (~150 LOC); App.tsx target is ~250 LOC. See tasks T088-T090.
- **Wave**: Wave C-rest (Phase 6).

---

## Allow-list (machine-readable)

`npm run check:size` exempts these paths from its `>600 LOC` audit. The first two are perpetual exceptions (deferred to dedicated future specs); the last three are SCHEDULED — each will be removed from the allow-list when its wave lands.

```text
src/core/state.ts                       # perpetual — 01X-state-reconciliation
src/core/agent/ClaudeAgentRunner.ts     # perpetual — TBD SDK-adapter spec
# main-loop.ts retired (824 → 573 LOC) — A4.5 landed.
src/renderer/hooks/useOrchestrator.ts   # scheduled — Wave B (Phase 5)
src/renderer/App.tsx                    # scheduled — Wave C-rest (Phase 6)
```

The 2 remaining scheduled entries are added under the wave plan's existing decomposition schedule. Each is documented with its target wave; when that wave's PR merges, its entry retires from the allow-list.
