import type {
  EmitFn,
  LoopStageType,
  Phase,
  RunConfig,
} from "../types.js";
import type { RunLogger } from "../log.js";

/** Context passed to runStage. Everything a runner needs to execute one stage. */
export interface StageContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  cycleNumber: number;
  stage: LoopStageType;
  /** Stage trace id — assigned by the orchestrator before calling the runner. */
  phaseTraceId: string;
  /** Spec dir for this stage, if any (plan/tasks/implement/…); null for non-spec stages. */
  specDir: string | null;
  /** Set when the stage expects JSON-schema-constrained output. */
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Abort controller — aborts the agent's execution mid-stream. */
  abortController: AbortController | null;
  /** Event emitter supplied by the orchestrator. */
  emit: EmitFn;
  /** Structured logger supplied by the orchestrator. */
  rlog: RunLogger;
}

export interface StageResult {
  /** USD — may be 0 for non-SDK runners. */
  cost: number;
  durationMs: number;
  /** Present iff outputFormat was supplied. */
  structuredOutput: unknown | null;
  /** Last assistant text; used by a few stages for debug/logging. */
  result: string;
  inputTokens: number;
  outputTokens: number;
  /** SDK session id when available; null for non-SDK runners. */
  sessionId: string | null;
}

/** Context for runPhase (build-mode phase invocations). */
export interface PhaseContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  phase: Phase;
  phaseTraceId: string;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** Callback to apply TodoWrite updates — owned by the orchestrator. */
  onTodoWrite: (todos: Array<{ content?: string; status?: string }>) => void;
}

export interface PhaseResult {
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunner {
  runStage(ctx: StageContext): Promise<StageResult>;
  runPhase(ctx: PhaseContext): Promise<PhaseResult>;
}

export type AgentRunnerFactory = (
  runConfig: RunConfig,
  projectDir: string,
) => AgentRunner;
