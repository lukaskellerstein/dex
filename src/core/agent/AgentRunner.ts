import type {
  EmitFn,
  StepType,
  TaskPhase,
  RunConfig,
} from "../types.js";
import type { RunLogger } from "../log.js";
import type { ClaudeProfile } from "../agent-profile.js";

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
  /**
   * 010 — per-variant agent profile. When set, overrides `config.model`,
   * appends `systemPromptAppend` to the assembled system prompt, and passes
   * `allowedTools` as the SDK's allowed-tools restriction. Default behavior
   * is unchanged when undefined.
   */
  profile?: ClaudeProfile;
  /**
   * 010 — variant-specific working directory. When set, the runner spawns
   * the SDK with this CWD instead of `config.projectDir`, so the runner's
   * native config discovery picks up the overlaid `.claude/` inside the
   * worktree.
   */
  worktreePath?: string;
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
}

/** Context for runTaskPhase (build-mode tasks.md phase invocations). */
export interface TaskPhaseContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  taskPhase: TaskPhase;
  agentRunId: string;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** Callback to apply TodoWrite updates — owned by the orchestrator. */
  onTodoWrite: (todos: Array<{ content?: string; status?: string }>) => void;
  /** 010 — same as StepContext.profile. */
  profile?: ClaudeProfile;
  /** 010 — same as StepContext.worktreePath. */
  worktreePath?: string;
}

export interface TaskPhaseResult {
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunner {
  runStep(ctx: StepContext): Promise<StepResult>;
  runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult>;
}

export type AgentRunnerFactory = (
  runConfig: RunConfig,
  projectDir: string,
) => AgentRunner;
