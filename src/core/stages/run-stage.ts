/**
 * What: Runs one agent stage — creates the agent-run audit entry, emits step_started, delegates the SDK work to the resolved agent runner (Claude / mock), records the result and emits step_completed.
 * Not: Does not pick the prompt or the stage (the caller does), and writes no run state (post-stage does). Does not run implement's task phases (cycle-stages.ts uses runTaskPhase).
 * Deps: getActiveContext (runner / state / abort / emit / rlog), runs.startAgentRun/completeAgentRun.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { LimitHit } from "../agent/AgentRunner.js";
import { getActiveContext } from "../orchestrator.js";
import * as runs from "../runs.js";
import type { StageScope } from "../scope.js";
import type { RunConfig, StepType } from "../types.js";

export interface StageRequest {
  config: RunConfig;
  prompt: string;
  runId: string;
  /** The entry's 1-based queue position; 0 for project-level stages. */
  cycleNumber: number;
  step: StepType;
  specDir?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  /** Extra agent environment (research R5). */
  env?: Record<string, string>;
  entryId?: string;
  /** The stage's write scope (016 R9). */
  scope?: StageScope | null;
}

export interface StageResult {
  agentRunId: string;
  result: string;
  structuredOutput: unknown | null;
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** The stage stopped at its turn or budget limit; null for a normal end and for the mock. */
  limitHit: LimitHit | null;
}

export async function runStage(req: StageRequest): Promise<StageResult> {
  const ctx = getActiveContext();
  if (!ctx) {
    throw new Error("runStage called before currentContext was resolved — run() must set it");
  }
  const { runner, state, abort, projectDir, emit, rlog } = ctx;
  const { config, runId, cycleNumber, step, specDir } = req;

  const agentRunId = crypto.randomUUID();
  runs.startAgentRun(projectDir, runId, {
    agentRunId,
    runId,
    specDir: specDir ?? null,
    taskPhaseNumber: cycleNumber,
    taskPhaseName: `loop:${step}`,
    step,
    cycleNumber,
    // The queue entry id when there is one: a spec folder can be named otherwise.
    featureSlug: req.entryId ?? (specDir ? path.basename(specDir) : null),
    startedAt: new Date().toISOString(),
    status: "running",
  });
  rlog.startAgentRun(cycleNumber, step, agentRunId);
  rlog.agentRun("INFO", `runStage: ${step} for cycle ${cycleNumber}`, {
    entryId: req.entryId ?? null,
    env: req.env ?? {},
  });

  // Keep the live mirror in sync so the renderer can recover after refresh.
  state.currentStep = step;
  state.agentRunId = agentRunId;
  emit({ type: "step_started", runId, cycleNumber, step, agentRunId, specDir });

  const r = await runner.runStep({
    config,
    prompt: req.prompt,
    runId,
    cycleNumber,
    step,
    agentRunId,
    specDir: specDir ?? null,
    outputFormat: req.outputFormat,
    abortController: abort,
    emit,
    rlog,
    env: req.env,
    entryId: req.entryId,
    policy: ctx.policy,
    scope: req.scope ?? undefined,
  });

  const stopped = abort.signal.aborted;
  runs.completeAgentRun(projectDir, runId, agentRunId, {
    status: stopped ? "stopped" : "completed",
    costUsd: r.cost,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens || null,
    outputTokens: r.outputTokens || null,
  });
  emit({
    type: "step_completed",
    runId,
    cycleNumber,
    step,
    agentRunId,
    costUsd: r.cost,
    durationMs: r.durationMs,
    ...(stopped ? { stopped: true } : {}),
  });

  return {
    agentRunId,
    result: r.result,
    structuredOutput: r.structuredOutput,
    cost: r.cost,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    limitHit: r.limitHit ?? null,
  };
}
