# Contract: OrchestrationContext

**Module**: `src/core/context.ts` (NEW, A1 — Wave A Gate 1)
**Status**: Required for Wave A Gate 1 onward.

## Purpose

Replace the five module-level mutable globals at `src/core/orchestrator.ts:98-135` plus the pending-question handle at `:13` with a single value threaded through every extracted phase function. Makes those phase functions pure-input → pure-output around `ctx`, and trivially fakeable from unit tests.

## Shape

```ts
import type { AgentRunner } from "./agent/AgentRunner";
import type { RunState } from "./state";
import type { RunLogger } from "./log";
import type { OrchestratorEvent } from "./events";

export type EmitFn = (event: OrchestratorEvent) => void;

export interface OrchestrationContext {
  readonly abort: AbortController;
  readonly runner: AgentRunner;
  state: RunState;
  readonly projectDir: string;
  readonly releaseLock: () => Promise<void>;
  readonly emit: EmitFn;
  readonly rlog: RunLogger;
  pendingQuestion: {
    promise: Promise<string> | null;
    resolve: ((answer: string) => void) | null;
    requestId: string | null;
  };
}

export async function createContext(
  config: RunConfig,
  emit: EmitFn,
): Promise<OrchestrationContext>;
```

## Invariants

1. `ctx.projectDir` is set once at creation and never changes for the lifetime of the run.
2. `ctx.abort.signal.aborted === true` is the canonical "stop" signal — every long-running operation either checks it or is wrapped in a helper (`safeExec`, `gitExec`) that does.
3. `ctx.state` is mutated in-place via `updateState(ctx, partial)` (existing helper at `state.ts:219`); the reference does not change.
4. `ctx.pendingQuestion.{resolve, requestId}` are nulled after each clarification round-trip. At most one outstanding question per `ctx`.
5. `ctx.runner` is non-null for the life of the context — there is no "swap runner mid-run" path.

## IPC residual

Two values survive as a singleton holder in `src/main/ipc/orchestrator.ts` because they're addressed by IPC handlers that arrive on different handlers than the one running `runLoop`:

- `currentContext: OrchestrationContext | null` — set when a run starts, cleared when it ends.
- `submitUserAnswer(answer)` resolves `currentContext.pendingQuestion.resolve(answer)`.

This is **not** a Constitution-II violation: it lives in the IPC layer, not in core. It is documented inline at `src/main/ipc/orchestrator.ts` with a comment pointing at this contract.

## Test contract

`createContext` is constructible from unit tests with a fake `runner` (use `MockAgentRunner` from `src/core/agent/MockAgentRunner.ts`). Every stage function under `src/core/stages/` accepts `ctx` and is callable from a test without touching IPC, the filesystem, or git.

Example fixture:

```ts
const ctx = await createContext({
  mode: "loop",
  projectDir: "/tmp/dex-test",
  runner: new MockAgentRunner({ scenario: "fixtures/mock-run/happy-path" }),
  /* ... */
}, /* emit: */ () => {});
```

## Non-goals

- This contract does **not** define `RunState` (that's `src/core/state.ts`, untouched).
- This contract does **not** define the SDK runner interface (that's `src/core/agent/AgentRunner.ts`, untouched).
- This contract does **not** introduce a per-phase sub-context or scoped state. One ctx per run; phases share it.

## References

- Spec FR-016 — context-threading requirement.
- Research R-002 — Path α decision (preserves the public `run()` entry that calls `createContext`).
- Research R-003 — pending-question handle on `ctx` (not at IPC layer).
