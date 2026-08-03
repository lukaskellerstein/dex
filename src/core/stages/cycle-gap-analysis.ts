/**
 * What: The per-cycle gap-analysis step extracted from `runMainLoop` — decides
 *       what this cycle should do (resume a feature, start the next one, replan,
 *       or terminate) by walking the feature manifest, with one LLM call only
 *       when an active feature already has a specDir.
 * Not:  Does not run any stage past the decision, and does not own the cycle
 *       loop. The caller keeps `break`/`continue`; this module reports what
 *       happened and the caller acts on it.
 * Deps: orchestrator.runStage (circular but call-time-safe, same as main-loop),
 *       manifest.*, gap-analysis.parseGapAnalysisDecision, prompts, runs.
 *
 * Extracted 2026-08-03 as the A4.5 follow-up this file's parent documented as
 * KNOWN DEBT. Pure code movement — the body is the former `runMainLoop` lines
 * 169-332 verbatim, with three implicit effects made explicit in the return
 * value: the `break` on failure, the `cumulativeCost` increment, and clearing
 * `resumeSpecDir` once consumed.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import { parseGapAnalysisDecision } from "../gap-analysis.js";
import {
  getActiveFeature,
  getNextFeature,
  loadManifest,
  updateFeatureStatus,
} from "../manifest.js";
// Circular: orchestrator.ts and this module call each other's exports at call
// time; both sides export functions only, so ESM module init is safe.
import { runStage } from "../orchestrator.js";
import { buildFeatureEvaluationPrompt, GAP_ANALYSIS_SCHEMA } from "../prompts.js";
import * as runs from "../runs.js";
import type { GapAnalysisDecision, RunConfig } from "../types.js";

export interface GapAnalysisInput {
  ctx: OrchestrationContext;
  config: RunConfig;
  runId: string;
  cycleNumber: number;
  /** Non-null only on the first cycle of a mid-cycle resume; consumed when used. */
  resumeSpecDir: string | null;
  resumeLastStage: string | null;
}

export type GapAnalysisOutcome =
  | {
      kind: "decided";
      decision: GapAnalysisDecision;
      /** Added to the caller's running total (non-zero only on the LLM path). */
      costDelta: number;
      /** True when `resumeSpecDir` was used and the caller must clear it. */
      consumedResume: boolean;
    }
  /** Gap analysis threw — the caller breaks out of the cycle loop. */
  | { kind: "failed" };

/**
 * Emit a synthetic (deterministic, cost=0) gap_analysis stage so the UI shows
 * it completed even when no agent ran.
 */
function emitSyntheticGapAnalysis(
  input: GapAnalysisInput,
  record: {
    /** `specDir` written to the audit record. */
    specDir: string | null;
    featureSlug: string | null;
    /**
     * `specDir` on the `step_started` event. Deliberately separate from the
     * audit value and deliberately allowed to be absent: pre-extraction the
     * resume path omitted the key entirely while the deterministic path sent
     * `""`. Both are preserved verbatim rather than unified.
     */
    emitSpecDir?: string;
  },
): void {
  const { ctx, config, runId, cycleNumber } = input;
  const traceId = crypto.randomUUID();
  runs.startAgentRun(config.projectDir, runId, {
    agentRunId: traceId,
    runId,
    specDir: record.specDir,
    taskPhaseNumber: cycleNumber,
    taskPhaseName: "loop:gap_analysis",
    step: "gap_analysis",
    cycleNumber,
    featureSlug: record.featureSlug,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  ctx.emit({
    type: "step_started",
    runId,
    cycleNumber,
    step: "gap_analysis",
    agentRunId: traceId,
    ...(record.emitSpecDir === undefined ? {} : { specDir: record.emitSpecDir }),
  });
  runs.completeAgentRun(config.projectDir, runId, traceId, {
    status: "completed",
    costUsd: 0,
    durationMs: 0,
  });
  ctx.emit({
    type: "step_completed",
    runId,
    cycleNumber,
    step: "gap_analysis",
    agentRunId: traceId,
    costUsd: 0,
    durationMs: 0,
  });
}

/** Mid-cycle resume: reuse the known specDir instead of re-deriving a decision. */
function resumeDecision(input: GapAnalysisInput, resumeSpecDir: string): GapAnalysisDecision {
  const { ctx, resumeLastStage } = input;
  // Pick RESUME_AT_STEP when a pre-implement stage (specify or plan) completed
  // before the abort. A completed "tasks" stage means the pre-implement triad is
  // done → classic RESUME_FEATURE (jump straight to implement). Any later stage
  // or null also maps to RESUME_FEATURE since implement/verify/learnings have
  // their own resume paths.
  if (resumeLastStage === "specify" || resumeLastStage === "plan") {
    ctx.rlog.run(
      "INFO",
      `runLoop: resume — using RESUME_AT_STEP(${resumeLastStage}) for ${resumeSpecDir}`,
    );
    return { type: "RESUME_AT_STEP", specDir: resumeSpecDir, resumeAtStep: resumeLastStage };
  }
  ctx.rlog.run(
    "INFO",
    `runLoop: resume — skipping gap analysis, using RESUME_FEATURE for ${resumeSpecDir}`,
  );
  return { type: "RESUME_FEATURE", specDir: resumeSpecDir };
}

export async function resolveGapAnalysis(input: GapAnalysisInput): Promise<GapAnalysisOutcome> {
  const { ctx, config, runId, cycleNumber, resumeSpecDir } = input;

  if (resumeSpecDir) {
    const decision = resumeDecision(input, resumeSpecDir);
    // Resume path: audit record carries the specDir, but the step_started
    // event omits it — verbatim pre-extraction behaviour.
    emitSyntheticGapAnalysis(input, {
      specDir: resumeSpecDir,
      featureSlug: path.basename(resumeSpecDir),
    });
    return { kind: "decided", decision, costDelta: 0, consumedResume: true };
  }

  try {
    const manifest = loadManifest(config.projectDir);
    if (!manifest) {
      throw new Error(
        "Feature manifest not found — manifest extraction should have run before the loop",
      );
    }

    if (ctx.state) {
      ctx.state.currentStep = "gap_analysis";
    }

    const active = getActiveFeature(manifest);
    const nextPending = getNextFeature(manifest);

    if (active) {
      if (active.specDir) {
        // Active feature with specDir — evaluate RESUME vs REPLAN (LLM call).
        const evaluationPrompt = buildFeatureEvaluationPrompt(config, active.specDir);
        const evalResult = await runStage(
          config,
          evaluationPrompt,
          ctx.emit,
          ctx.rlog,
          runId,
          cycleNumber,
          "gap_analysis",
          active.specDir,
          {
            type: "json_schema",
            schema: GAP_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
          },
        );
        // parseGapAnalysisDecision throws on null/malformed; the surrounding
        // try/catch surfaces it as `gap analysis failed` and ends the cycle.
        return {
          kind: "decided",
          decision: parseGapAnalysisDecision(evalResult.structuredOutput, active.specDir),
          costDelta: evalResult.cost,
          consumedResume: false,
        };
      }
      // Active but no specDir — re-run specify for this feature (deterministic).
      emitSyntheticGapAnalysis(input, { specDir: null, featureSlug: null, emitSpecDir: "" });
      return {
        kind: "decided",
        decision: {
          type: "NEXT_FEATURE",
          name: active.title,
          description: active.description,
          featureId: active.id,
        },
        costDelta: 0,
        consumedResume: false,
      };
    }

    if (nextPending) {
      // Deterministic — no LLM call needed.
      updateFeatureStatus(config.projectDir, nextPending.id, "active");
      emitSyntheticGapAnalysis(input, { specDir: null, featureSlug: null, emitSpecDir: "" });
      return {
        kind: "decided",
        decision: {
          type: "NEXT_FEATURE",
          name: nextPending.title,
          description: nextPending.description,
          featureId: nextPending.id,
        },
        costDelta: 0,
        consumedResume: false,
      };
    }

    return {
      kind: "decided",
      decision: { type: "GAPS_COMPLETE" },
      costDelta: 0,
      consumedResume: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.rlog.run("ERROR", `runLoop: gap analysis failed: ${msg}`);
    ctx.emit({ type: "error", message: `Gap analysis failed: ${msg}` });
    return { kind: "failed" };
  }
}
