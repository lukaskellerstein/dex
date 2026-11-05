import type { RunLogger } from "../log.js";
import type { Policy } from "../policy.js";
import type { EmitFn, RunConfig, StepType, TaskPhase } from "../types.js";

/** Context passed to runStep. Everything a runner needs to execute one step. */
export interface StepContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  cycleNumber: number;
  step: StepType;
  /** AgentRun id — assigned by the orchestrator before calling the runner. */
  agentRunId: string;
  /** Spec dir for this step, if any (plan/tasks/implement/…); null for non-spec steps. */
  specDir: string | null;
  /** Set when the step expects JSON-schema-constrained output. */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Abort controller — aborts the agent's execution mid-stream. */
  abortController: AbortController | null;
  /** Event emitter supplied by the orchestrator. */
  emit: EmitFn;
  /** Structured logger supplied by the orchestrator. */
  rlog: RunLogger;
  /** Extra environment for the agent (SPECIFY_FEATURE_DIRECTORY, …), merged over process.env. */
  env?: Record<string, string>;
  /** The queue entry this step works on; absent for project-level steps. */
  entryId?: string;
  /** The project's policy; the Claude runner enforces it, the mock ignores it. */
  policy: Policy;
}

export interface StepResult {
  /** USD — may be 0 for non-SDK runners. */
  cost: number;
  durationMs: number;
  /** Present iff outputFormat was supplied. */
  structuredOutput: unknown | null;
  /** Last assistant text; used by a few steps for debug/logging. */
  result: string;
  inputTokens: number;
  outputTokens: number;
  /** SDK session id when available; null for non-SDK runners. */
  sessionId: string | null;
  /** The stage stopped at its turn or budget limit (research R9); null or absent otherwise. */
  limitHit?: LimitHit | null;
}

/** Which stage limit stopped an agent. */
export type LimitHit = "turns" | "budget";

/** The SDK result subtypes that mean a stage limit stopped the agent. */
export function limitHitOf(subtype: string | null | undefined): LimitHit | null {
  if (subtype === "error_max_turns") return "turns";
  if (subtype === "error_max_budget_usd") return "budget";
  return null;
}

/** Context for runTaskPhase (one tasks.md phase per agent). */
export interface TaskPhaseContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  taskPhase: TaskPhase;
  agentRunId: string;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** Extra environment for the agent, merged over process.env. */
  env?: Record<string, string>;
  /** The queue entry this phase belongs to; absent in build mode. */
  entryId?: string;
  /** The project's policy; the Claude runner enforces it, the mock ignores it. */
  policy: Policy;
}

export interface TaskPhaseResult {
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  limitHit?: LimitHit | null;
}

export interface AgentRunner {
  runStep(ctx: StepContext): Promise<StepResult>;
  runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult>;
}

export type AgentRunnerFactory = (runConfig: RunConfig, projectDir: string) => AgentRunner;
