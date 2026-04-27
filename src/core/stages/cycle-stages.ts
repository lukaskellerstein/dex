/**
 * What: The cohesive Implement → Verify → Learnings stage block of one autonomous-loop cycle. `runImplementVerifyLearnings` runs the implement stage (with phase loop and per-stage trace), then verify (with structured-output + fix-retry loop), then learnings (with insights append). Returns cost + pass/fail signal so the caller can update its accumulators.
 * Not: Does not own gap analysis, specify, plan, or tasks (those run before this helper in the cycle iterator). Does not own failure-counter state mutation, manifest status updates, or featuresCompleted bookkeeping — caller threads results back. Does not own cycle-level abort handling — the surrounding try/catch in main-loop catches AbortError.
 * Deps: runStage / runPhase / RunTaskState (from orchestrator.js, circular-but-call-time-safe), prompts.{buildVerifyPrompt, buildVerifyFixPrompt, buildLearningsPrompt, VERIFY_SCHEMA, LEARNINGS_SCHEMA}, manifest.appendLearnings, runs.{startAgentRun, completeAgentRun}.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import type { RunConfig } from "../types.js";
import type { RunLogger } from "../log.js";
import * as runs from "../runs.js";
import { updateState } from "../state.js";
import { parseTasksFile } from "../parser.js";
import { appendLearnings } from "../manifest.js";
import {
  buildVerifyPrompt,
  buildVerifyFixPrompt,
  buildLearningsPrompt,
  VERIFY_SCHEMA,
  LEARNINGS_SCHEMA,
} from "../prompts.js";
// Circular: orchestrator.ts hosts runStage / runPhase / RunTaskState / AbortError;
// both sides export only functions/classes so ESM init is safe.
import {
  runStage,
  runPhase,
  RunTaskState,
  AbortError,
} from "../orchestrator.js";

export interface ImplementVerifyLearningsInput {
  ctx: OrchestrationContext;
  config: RunConfig;
  runId: string;
  cycleNumber: number;
  specDir: string;
  fullPlanPath: string;
  rlog: RunLogger;
}

export interface ImplementVerifyLearningsOutput {
  /** Cost accumulated across implement + verify (with retries) + learnings. */
  cycleCost: number;
  /** Whether the final verification passed (after any fix-retry loop). */
  verifyPassed: boolean;
}

/**
 * Runs implement → verify (with fix-retry) → learnings for one cycle's
 * targeted spec dir. Throws `AbortError` on user abort; the surrounding
 * try/catch in `runMainLoop` handles it as a clean exit.
 */
export async function runImplementVerifyLearnings(
  input: ImplementVerifyLearningsInput,
): Promise<ImplementVerifyLearningsOutput> {
  const { ctx, config, runId, cycleNumber, specDir, fullPlanPath, rlog } = input;
  const emit = ctx.emit;
  const abort = ctx.abort;
  const state = ctx.state;
  const projectDir = ctx.projectDir;

  let cycleCost = 0;

  // ── Implement stage ─────────────────────────────────────────────────────
  const implSpecPath = specDir.startsWith("/")
    ? specDir
    : path.join(projectDir, specDir);

  state.currentStep = "implement";
  state.specDir = specDir;
  // Update FeatureArtifacts.status to "implementing"
  updateState(projectDir, {
    artifacts: { features: { [specDir]: { status: "implementing" } } },
  } as never).catch(() => {});

  // Stage-level phase record so the UI shows implement in the stage list.
  const implStageTraceId = crypto.randomUUID();
  runs.startAgentRun(projectDir, runId, {
    agentRunId: implStageTraceId,
    runId,
    specDir,
    taskPhaseNumber: cycleNumber,
    taskPhaseName: "loop:implement",
    step: "implement",
    cycleNumber,
    featureSlug: path.basename(specDir),
    startedAt: new Date().toISOString(),
    status: "running",
  });

  emit({
    type: "step_started",
    runId,
    cycleNumber,
    step: "implement",
    agentRunId: implStageTraceId,
    specDir,
  });

  const implStageStart = Date.now();
  let implStageCost = 0;
  let implStageInputTokens = 0;
  let implStageOutputTokens = 0;
  let activePhaseTraceId: string | null = null;
  let implStageFailed = false;

  // Parse tasks.md to get phases, then run each phase.
  // RunTaskState is created ONCE and reused across all phases so that
  // progress from earlier phases is preserved (promote-only semantics).
  const phases = parseTasksFile(projectDir, specDir);
  const implConfig = { ...config, specDir };
  const runTaskState = new RunTaskState(phases);

  // Initial task state so the UI can show the spec card immediately.
  emit({ type: "tasks_updated", taskPhases: runTaskState.getPhases() });

  try {
    for (const phase of phases) {
      if (abort.signal.aborted) break;
      if (phase.status === "complete") continue;

      const agentRunId = crypto.randomUUID();
      activePhaseTraceId = agentRunId;
      runs.startAgentRun(projectDir, runId, {
        agentRunId,
        runId,
        specDir,
        taskPhaseNumber: phase.number,
        taskPhaseName: phase.name,
        step: null,
        cycleNumber,
        featureSlug: path.basename(specDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });

      state.agentRunId = agentRunId;
      state.taskPhaseNumber = phase.number;
      state.taskPhaseName = phase.name;

      emit({ type: "task_phase_started", taskPhase: phase, iteration: 0, agentRunId });

      const phaseResult = await runPhase(implConfig, phase, agentRunId, runId, emit, rlog, runTaskState);
      runs.completeAgentRun(projectDir, runId, agentRunId, {
        status: "completed",
        costUsd: phaseResult.cost,
        durationMs: phaseResult.durationMs,
        inputTokens: phaseResult.inputTokens || null,
        outputTokens: phaseResult.outputTokens || null,
      });
      activePhaseTraceId = null;
      cycleCost += phaseResult.cost;
      implStageCost += phaseResult.cost;
      implStageInputTokens += phaseResult.inputTokens;
      implStageOutputTokens += phaseResult.outputTokens;

      // Reconcile task state from disk
      const freshPhases = parseTasksFile(projectDir, specDir);
      runTaskState.reconcileFromDisk(freshPhases);
      emit({ type: "tasks_updated", taskPhases: runTaskState.getPhases() });
      emit({
        type: "task_phase_completed",
        taskPhase: { ...phase, status: "complete" },
        cost: phaseResult.cost,
        durationMs: phaseResult.durationMs,
      });
    }
  } catch (implErr) {
    implStageFailed = true;
    if (activePhaseTraceId) {
      try {
        runs.completeAgentRun(projectDir, runId, activePhaseTraceId, {
          status: "failed",
          costUsd: 0,
          durationMs: Date.now() - implStageStart,
        });
      } catch { /* best-effort */ }
    }
    throw implErr;
  } finally {
    // Always close the loop:implement stage trace, even on exception.
    const implStageDurationMs = Date.now() - implStageStart;
    const implAborted = abort.signal.aborted;
    const implFinalStatus = implAborted ? "stopped" : implStageFailed ? "failed" : "completed";
    runs.completeAgentRun(projectDir, runId, implStageTraceId, {
      status: implFinalStatus,
      costUsd: implStageCost,
      durationMs: implStageDurationMs,
      inputTokens: implStageInputTokens || null,
      outputTokens: implStageOutputTokens || null,
    });
    emit({
      type: "step_completed",
      runId,
      cycleNumber,
      step: "implement",
      agentRunId: implStageTraceId,
      costUsd: implStageCost,
      durationMs: implStageDurationMs,
      ...(implAborted ? { stopped: true } : {}),
    });
  }

  if (abort.signal.aborted) throw new AbortError();

  // ── Verify with fix-retry ───────────────────────────────────────────────
  state.currentStep = "verify";
  updateState(projectDir, {
    artifacts: { features: { [specDir]: { status: "verifying" } } },
  } as never).catch(() => {});

  const verifyPrompt = buildVerifyPrompt(config, implSpecPath, fullPlanPath);
  const verifyResult = await runStage(
    config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", specDir,
    { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> },
  );
  cycleCost += verifyResult.cost;

  type VerifyOutput = {
    passed: boolean;
    buildSucceeded: boolean;
    testsSucceeded: boolean;
    failures: Array<{ criterion: string; description: string; severity: string }>;
    summary: string;
  };

  let verification: VerifyOutput = (verifyResult.structuredOutput as VerifyOutput | null) ?? {
    passed: false,
    buildSucceeded: false,
    testsSucceeded: false,
    failures: [{ criterion: "structured_output", description: "Verify agent did not return structured output", severity: "blocking" }],
    summary: "Verification could not be evaluated — structured output was null",
  };

  if (!verification.passed) {
    const blockingFailures = verification.failures.filter((f) => f.severity === "blocking");
    if (blockingFailures.length > 0) {
      const maxRetries = config.maxVerifyRetries ?? 1;
      for (let retryNum = 1; retryNum <= maxRetries; retryNum++) {
        const currentBlocking = verification.failures.filter((f) => f.severity === "blocking");
        rlog.run("WARN", `runLoop: verify found ${currentBlocking.length} blocking failure(s) — fix attempt ${retryNum}/${maxRetries}`);
        emit({ type: "verify_failed", runId, cycleNumber, blockingCount: currentBlocking.length, summary: verification.summary });

        if (abort.signal.aborted) throw new AbortError();

        const fixPrompt = buildVerifyFixPrompt(config, implSpecPath, currentBlocking);
        const fixResult = await runStage(config, fixPrompt, emit, rlog, runId, cycleNumber, "implement_fix", specDir);
        cycleCost += fixResult.cost;

        if (abort.signal.aborted) throw new AbortError();

        const reVerifyResult = await runStage(
          config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", specDir,
          { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> },
        );
        cycleCost += reVerifyResult.cost;

        verification = (reVerifyResult.structuredOutput as VerifyOutput | null) ?? {
          passed: false,
          buildSucceeded: false,
          testsSucceeded: false,
          failures: [{ criterion: "structured_output", description: "Re-verify agent did not return structured output", severity: "blocking" }],
          summary: "Re-verification could not be evaluated — structured output was null",
        };

        if (verification.passed) {
          rlog.run("INFO", `runLoop: re-verify passed on attempt ${retryNum}`);
          break;
        }
        if (retryNum === maxRetries) {
          rlog.run("WARN", `runLoop: re-verify still failing after ${maxRetries} fix attempt(s) — proceeding to learnings`);
        }
      }
    }
  }

  if (abort.signal.aborted) throw new AbortError();

  // ── Learnings ───────────────────────────────────────────────────────────
  state.currentStep = "learnings";
  const learningsPrompt = buildLearningsPrompt(config, implSpecPath);
  const learningsResult = await runStage(
    config, learningsPrompt, emit, rlog, runId, cycleNumber, "learnings", specDir,
    { type: "json_schema", schema: LEARNINGS_SCHEMA as unknown as Record<string, unknown> },
  );
  cycleCost += learningsResult.cost;

  const learnings = learningsResult.structuredOutput as {
    insights: Array<{ category: string; insight: string; context: string }>;
  } | null;

  if (learnings?.insights?.length) {
    appendLearnings(projectDir, learnings.insights, config.maxLearningsPerCategory);
  } else if (!learnings) {
    rlog.run("WARN", "runLoop: learnings structured output was null — skipping append");
  }

  return { cycleCost, verifyPassed: verification.passed };
}
