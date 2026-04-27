/**
 * What: Wraps the per-phase lifecycle boilerplate — runs.startAgentRun + RunLogger trio at phase entry, runs.completeAgentRun + structured failure logging at phase exit, and a `emitSkippedStep` helper for synthetic steps that need a complete start+emit+complete shape (currently duplicated in clarification.ts and main-loop.ts).
 * Not: Does not own emit shape decisions (callers choose `step_started` vs `task_phase_started` based on their context). Does not own runStage execution — that stays in orchestrator.ts. Does not interpret subagent events; subagent.appendAgentStep stays at its emitter site.
 * Deps: runs.startAgentRun/completeAgentRun, OrchestrationContext.emit, log.RunLogger.
 */

import * as runs from "./runs.js";
import type { OrchestrationContext } from "./context.js";
import type { StepType } from "./types.js";
import type { RunLogger } from "./log.js";

// ── Shared input shapes ─────────────────────────────────────────────────────

interface AgentRunMeta {
  agentRunId: string;
  taskPhaseNumber: number;
  taskPhaseName: string;
  step: StepType | null;
  cycleNumber: number | null;
  specDir: string | null;
  featureSlug: string | null;
}

// ── recordPhaseStart ────────────────────────────────────────────────────────

export interface PhaseStartInput {
  ctx: OrchestrationContext;
  runId: string;
  agentRun: AgentRunMeta;
  rlog: RunLogger;
  /**
   * `agent-run` — call rlog.startAgentRun (binds future agentRun/subagent log
   *   writes to this trace; emits "TaskPhase N started: <name>" on the run log).
   *   Use for cycle stages (runStage callers) and build-mode task phases.
   * `run-only` — log only the start message via rlog.run; no agent-run binding.
   *   Use for synthetic stages or driver-level phases (prerequisites,
   *   manifest_extraction, the "completion" phase) where there is no following
   *   subagent stream to bind to.
   * `none` — no rlog write. Use when the caller has already emitted a more
   *   specific log line above the runs.startAgentRun call.
   */
  logStrategy: "agent-run" | "run-only" | "none";
}

/**
 * Persists the runs-record entry for a phase start and writes the matching
 * RunLogger line. Returns nothing — the caller already holds `agentRun.agentRunId`
 * and uses it for downstream emit() / completePhase calls.
 */
export function recordPhaseStart(input: PhaseStartInput): void {
  const { ctx, runId, agentRun, rlog, logStrategy } = input;

  runs.startAgentRun(ctx.projectDir, runId, {
    agentRunId: agentRun.agentRunId,
    runId,
    specDir: agentRun.specDir,
    taskPhaseNumber: agentRun.taskPhaseNumber,
    taskPhaseName: agentRun.taskPhaseName,
    step: agentRun.step,
    cycleNumber: agentRun.cycleNumber,
    featureSlug: agentRun.featureSlug,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  if (logStrategy === "agent-run") {
    rlog.startAgentRun(agentRun.taskPhaseNumber, agentRun.taskPhaseName, agentRun.agentRunId);
  } else if (logStrategy === "run-only") {
    rlog.run("INFO", `TaskPhase ${agentRun.taskPhaseNumber} started: ${agentRun.taskPhaseName}`, {
      agentRunId: agentRun.agentRunId,
    });
  }
}

// ── recordPhaseComplete ─────────────────────────────────────────────────────

export interface PhaseCompleteInput {
  ctx: OrchestrationContext;
  runId: string;
  agentRunId: string;
  status?: "completed" | "stopped";
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/**
 * Mirror of `runs.completeAgentRun` for the success / clean-stop path. Status
 * defaults to "completed". For abort scenarios pass `status: "stopped"`; the
 * orchestrator's existing convention is that "stopped" still carries the
 * recorded cost/duration so the trace is complete.
 */
export function recordPhaseComplete(input: PhaseCompleteInput): void {
  const {
    ctx,
    runId,
    agentRunId,
    status = "completed",
    costUsd = 0,
    durationMs = 0,
    inputTokens = null,
    outputTokens = null,
  } = input;
  runs.completeAgentRun(ctx.projectDir, runId, agentRunId, {
    status,
    costUsd,
    durationMs,
    inputTokens,
    outputTokens,
  });
}

// ── recordPhaseFailure ──────────────────────────────────────────────────────

export interface PhaseFailureInput {
  ctx: OrchestrationContext;
  runId: string;
  agentRunId: string;
  error: unknown;
  durationMs?: number;
  rlog?: RunLogger;
  /** Logged on `rlog.run` at ERROR level for the run.log; agentRun stack on rlog.agentRun if provided. */
  logPrefix?: string;
}

/**
 * Failure-path companion to `recordPhaseComplete`. Persists the failed status
 * with cost=0 (failures don't accrue billable cost in the existing convention)
 * and, when an `rlog` is supplied, writes the standard ERROR line shape so
 * downstream golden-trace diffs stay byte-stable.
 */
export function recordPhaseFailure(input: PhaseFailureInput): void {
  const { ctx, runId, agentRunId, error, durationMs = 0, rlog, logPrefix = "Phase" } = input;
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  runs.completeAgentRun(ctx.projectDir, runId, agentRunId, {
    status: "failed",
    costUsd: 0,
    durationMs,
  });

  if (rlog) {
    rlog.agentRun("ERROR", `${logPrefix} failed: ${message}`, { stack });
    rlog.run("ERROR", `${logPrefix} failed: ${message}`);
  }
}

// ── emitSkippedStep ─────────────────────────────────────────────────────────

export interface SkippedStepInput {
  ctx: OrchestrationContext;
  runId: string;
  agentRunId: string;
  step: StepType;
  cycleNumber: number;
  specDir?: string | null;
  featureSlug?: string | null;
}

/**
 * Synthesises a complete (started + completed) phase trace for a step that
 * the orchestrator chose to skip — RESUME_FEATURE skipping specify/plan/tasks,
 * clarification's "specs exist" early-return, etc. Cost and duration are 0;
 * the trace's only purpose is keeping the renderer's stepper UI advancing past
 * the skipped stage instead of leaving it stuck on "pending".
 *
 * Consolidates the duplicate `emitSkippedStep` closures previously in
 * `clarification.ts` and `stages/main-loop.ts`.
 */
export function emitSkippedStep(input: SkippedStepInput): void {
  const { ctx, runId, agentRunId, step, cycleNumber, specDir = null, featureSlug = null } = input;
  runs.startAgentRun(ctx.projectDir, runId, {
    agentRunId,
    runId,
    specDir,
    taskPhaseNumber: cycleNumber,
    taskPhaseName: `loop:${step}`,
    step,
    cycleNumber,
    featureSlug,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  ctx.emit({ type: "step_started", runId, cycleNumber, step, agentRunId, ...(specDir ? { specDir } : {}) });
  runs.completeAgentRun(ctx.projectDir, runId, agentRunId, {
    status: "completed",
    costUsd: 0,
    durationMs: 0,
  });
  ctx.emit({ type: "step_completed", runId, cycleNumber, step, agentRunId, costUsd: 0, durationMs: 0 });
}
