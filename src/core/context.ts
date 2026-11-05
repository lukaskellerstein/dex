/**
 * What: OrchestrationContext interface + createContext factory — the single per-run value every stage function accepts as `ctx`: abort, runner, live run state, the project, the queue kind and the project's policy.
 * Not: Does not own run lifecycle (acquire/release locks, build runner, instantiate logger, load the policy) — the caller assembles dependencies and passes them in. Held human requests live in humanInput.ts, not here.
 * Deps: ./agent/AgentRunner.js (AgentRunner type), ./events.js (EmitFn), ./log.js (RunLogger), ./policy.js (Policy, QueueKind), ./types.js (StepType).
 */

import type { AgentRunner } from "./agent/AgentRunner.js";
import type { EmitFn } from "./events.js";
import type { RunLogger } from "./log.js";
import type { Policy, QueueKind } from "./policy.js";
import type { StepType } from "./types.js";

/**
 * Live in-memory mirror of the orchestrator's current step. Returned by the
 * IPC `getRunState` so the renderer can recover after a tab refresh. Distinct
 * from `DexState` (the persistent on-disk state owned by `state.ts`) — this is
 * a transient cache the orchestrator updates as it advances.
 */
export interface RunState {
  runId: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
  agentRunId: string;
  taskPhaseNumber: number;
  taskPhaseName: string;
  currentCycle?: number;
  currentStep?: StepType;
  isClarifying?: boolean;
  cyclesCompleted?: number;
}

export type { EmitFn };

/**
 * Per-run session value. Replaces the historic module-level globals
 * (`abortController`, `activeProjectDir`, `releaseLock`, `currentRunner`,
 * `currentRunState`) with one passed-down value. Future extracted phase
 * functions (A2-A7) accept `ctx: OrchestrationContext` and operate purely
 * over its fields instead of reaching into orchestrator.ts globals.
 */
export interface OrchestrationContext {
  readonly abort: AbortController;
  readonly runner: AgentRunner;
  state: RunState;
  readonly projectDir: string;
  readonly releaseLock: () => Promise<void>;
  readonly emit: EmitFn;
  readonly rlog: RunLogger;
  /** `new` (Dex plans and owns the run branch) or `existing` (the project's own rules). */
  readonly kind: QueueKind;
  /** `.dex/policy.json`, validated at start, or the defaults. */
  readonly policy: Policy;
}

/**
 * Builder — assembles an `OrchestrationContext` from already-constructed
 * dependencies. Pure function (no IO). The caller (`runLoop` / `runBuild`)
 * is responsible for acquiring the project lock, instantiating the runner,
 * loading initial state, etc., and passes those values in.
 *
 * Intentionally not async so it stays trivially mockable in tests:
 *   const ctx = createContext({ abort, runner, state, ... });
 */
export function createContext(deps: {
  abort: AbortController;
  runner: AgentRunner;
  state: RunState;
  projectDir: string;
  releaseLock: () => Promise<void>;
  emit: EmitFn;
  rlog: RunLogger;
  kind: QueueKind;
  policy: Policy;
}): OrchestrationContext {
  return {
    abort: deps.abort,
    runner: deps.runner,
    state: deps.state,
    projectDir: deps.projectDir,
    releaseLock: deps.releaseLock,
    emit: deps.emit,
    rlog: deps.rlog,
    kind: deps.kind,
    policy: deps.policy,
  };
}
