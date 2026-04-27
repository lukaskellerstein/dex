/**
 * What: The cycle-stage runner — creates the agent-run audit entry, emits step_started, delegates the SDK work to the resolved agent runner (Claude / mock / etc.), emits step_completed, then triggers the post-stage finalize sequence (commit, candidate emit, auto-promote, optional pause).
 * Not: Does not pick which prompt to use (caller-supplied). Does not own gap-analysis or per-decision dispatch — that lives in main-loop.ts. Does not implement the build-mode phase loop — that's stages/build.ts (uses runPhase, not runStage).
 * Deps: getActiveContext (for runner/state/abort/projectDir), runs.startAgentRun/completeAgentRun, finalizeStageCheckpoint (post-stage checkpoint sequence).
 */

import crypto from "node:crypto";
import path from "node:path";
import * as runs from "../runs.js";
import type { RunConfig, EmitFn, StepType } from "../types.js";
import type { RunLogger } from "../log.js";
import { finalizeStageCheckpoint } from "./finalize.js";
import { getActiveContext } from "../orchestrator.js";

export async function runStage(
  config: RunConfig,
  prompt: string,
  emit: EmitFn,
  rlog: RunLogger,
  runId: string,
  cycleNumber: number,
  stageType: StepType,
  specDir?: string,
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> },
): Promise<{ result: string; structuredOutput: unknown | null; cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  const ctx = getActiveContext();
  if (!ctx) {
    throw new Error("runStage called before currentContext was resolved — run() must set it");
  }
  const { runner, state, abort, projectDir } = ctx;

  // Create a phase record for this stage so steps are persisted.
  const agentRunId = crypto.randomUUID();
  runs.startAgentRun(projectDir, runId, {
    agentRunId,
    runId,
    specDir: specDir ?? null,
    taskPhaseNumber: cycleNumber,
    taskPhaseName: `loop:${stageType}`,
    step: stageType,
    cycleNumber,
    featureSlug: specDir ? path.basename(specDir) : null,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  rlog.startAgentRun(cycleNumber, stageType, agentRunId);
  rlog.agentRun("INFO", `runStage: ${stageType} for cycle ${cycleNumber}`);

  // Keep state in sync so the renderer can recover after refresh.
  state.currentStep = stageType;
  state.agentRunId = agentRunId;

  emit({
    type: "step_started",
    runId,
    cycleNumber,
    step: stageType,
    agentRunId,
    specDir,
  });

  const isAborted = () => abort.signal.aborted;

  // Delegate the SDK work to the resolved agent runner. Runner emits
  // agent_step events (user_message, tool_call, etc.) and returns the final
  // cost/duration/structured output. This module owns phase-level lifecycle
  // (start/complete events + audit record) and the post-stage checkpoint
  // hand-off to finalizeStageCheckpoint.
  const stageResult = await runner.runStep({
    config,
    prompt,
    runId,
    cycleNumber,
    step: stageType,
    agentRunId,
    specDir: specDir ?? null,
    outputFormat,
    abortController: abort,
    emit,
    rlog,
  });
  const { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } = stageResult;

  const stageStatus = isAborted() ? "stopped" : "completed";
  runs.completeAgentRun(projectDir, runId, agentRunId, {
    status: stageStatus,
    costUsd: totalCost,
    durationMs,
    inputTokens: totalInputTokens || null,
    outputTokens: totalOutputTokens || null,
  });

  emit({
    type: "step_completed",
    runId,
    cycleNumber,
    step: stageType,
    agentRunId,
    costUsd: totalCost,
    durationMs,
    ...(isAborted() ? { stopped: true } : {}),
  });

  // Post-stage checkpoint: state file update + commit + candidate emit +
  // auto-promote + optional pause. Delegated to stages/finalize.ts (A6).
  if (!isAborted()) {
    await finalizeStageCheckpoint({
      ctx,
      runId,
      agentRunId,
      cycleNumber,
      step: stageType,
      specDir: specDir ?? null,
      rlog,
      stepModeOverride: Boolean(config.stepMode),
      abortController: abort,
    });
  }

  return { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}
