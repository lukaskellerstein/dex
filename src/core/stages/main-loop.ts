/**
 * What: Phase B autonomous-loop cycle iterator + termination — runs until gaps_complete | user_abort | budget_exceeded | max_cycles_reached, dispatching gap-analysis → specify → plan → tasks → implement (with phase loop) → verify (with fix-retry) → learnings each cycle. Owns failure-counter persistence and per-cycle state-file updates.
 * Not: Does not own runStage / runPhase / RunTaskState / AbortError — imported from orchestrator.ts (circular but call-time-safe). Does not own clarification or prerequisites (their own stage modules) or post-loop record-mode tagging (caller's responsibility).
 * Deps: OrchestrationContext + a deps bundle (config, runId, fullPlanPath, seed counters, resume hints). Imports orchestrator.ts (runStage/runPhase/AbortError/RunTaskState/listSpecDirs), prompts.ts (per-stage builders), manifest.ts (feature lifecycle), runs.* (audit trail), parser.ts (tasks.md), state.ts (updateState + STEP_ORDER), checkpoints (none directly — runStage handles it).
 *
 * KNOWN DEBT (A4.5 follow-up before Wave A merges):
 *   `runMainLoop` exceeds the 120-LOC-per-function rule (FR-002). The spec
 *   prescribes per-stage helpers (`runGapAnalysisStep`, `runSpecifyPlanTasks`,
 *   `runImplementWithVerifyRetry`, `runLearningsStep`) — that pre-decomposition
 *   was deferred from this commit to keep the extraction behaviour-preserving in
 *   one shot. The body below is otherwise an exact port of the pre-extraction
 *   cycle (orchestrator.ts:1146-1858 pre-A4); golden-trace verifies parity.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import type {
  RunConfig,
  StepType,
  GapAnalysisDecision,
  TerminationReason,
  LoopTermination,
  FailureRecord,
} from "../types.js";
import { discoverNewSpecDir } from "../parser.js";
import * as runs from "../runs.js";
import { updateState, STEP_ORDER } from "../state.js";
import {
  loadManifest,
  getNextFeature,
  getActiveFeature,
  updateFeatureStatus,
  updateFeatureSpecDir,
} from "../manifest.js";
import {
  buildSpecifyPrompt,
  buildLoopPlanPrompt,
  buildLoopTasksPrompt,
  buildFeatureEvaluationPrompt,
  GAP_ANALYSIS_SCHEMA,
} from "../prompts.js";
// Circular: orchestrator.ts and this module call each other's exports at call
// time; both sides export functions/classes only, so ESM module init is safe.
import {
  runStage,
  AbortError,
  listSpecDirs,
} from "../orchestrator.js";
import { emitSkippedStep as phaseEmitSkippedStep } from "../phase-lifecycle.js";
import {
  parseGapAnalysisDecision,
  shouldRunStage as shouldRunStageFromDecision,
} from "../gap-analysis.js";
import { runImplementVerifyLearnings } from "./cycle-stages.js";

export interface MainLoopResult {
  cyclesCompleted: number;
  cumulativeCost: number;
  featuresCompleted: string[];
  featuresSkipped: string[];
  termination: LoopTermination;
}

export async function runMainLoop(
  ctx: OrchestrationContext,
  deps: {
    config: RunConfig;
    runId: string;
    fullPlanPath: string;
    cyclesCompletedSeed: number;
    cumulativeCostSeed: number;
    featuresCompletedSeed: string[];
    featuresSkippedSeed: string[];
    resumeSpecDir: string | null;
    resumeLastStage: string | null;
  },
): Promise<MainLoopResult> {
  // Bind locals so the verbatim body below uses ctx-fields without per-site rewrites.
  const abortController = ctx.abort;
  const activeProjectDir = ctx.projectDir;
  const currentRunState = ctx.state;
  const { emit, rlog } = ctx;
  const { config, runId, fullPlanPath } = deps;

  let cyclesCompleted = deps.cyclesCompletedSeed;
  let cumulativeCost = deps.cumulativeCostSeed;
  const featuresCompleted: string[] = [...deps.featuresCompletedSeed];
  const featuresSkipped: string[] = [...deps.featuresSkippedSeed];
  let resumeSpecDir = deps.resumeSpecDir;
  const resumeLastStage = deps.resumeLastStage;

  const failureTracker = new Map<string, FailureRecord>();

  const getOrCreateFailureRecord = (specDir: string): FailureRecord => {
    let record = failureTracker.get(specDir);
    if (!record) {
      record = { specDir, implFailures: 0, replanFailures: 0 };
      failureTracker.set(specDir, record);
    }
    return record;
  };

  const persistFailure = (specDir: string) => {
    const record = getOrCreateFailureRecord(specDir);
    runs.upsertFailureCount(config.projectDir, runId, specDir, record.implFailures, record.replanFailures);
    updateState(config.projectDir, {
      failureCounts: { [specDir]: { implFailures: record.implFailures, replanFailures: record.replanFailures } },
    }).catch(() => { /* state write failure shouldn't crash the run */ });
  };

  // Delegates to the consolidated helper in phase-lifecycle.ts (A6/T043 wire-in).
  const emitSkippedStep = (step: StepType, cycleNum = 0) => {
    phaseEmitSkippedStep({ ctx, runId, agentRunId: crypto.randomUUID(), step, cycleNumber: cycleNum });
  };

  // ── Phase B: Autonomous Loop ────────────────────────────

  while (true) {
    // Check abort
    if (abortController?.signal.aborted) {
      rlog.run("INFO", "runLoop: abort detected");
      break;
    }

    // Check max cycles
    if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) {
      rlog.run("INFO", `runLoop: max cycles reached (${config.maxLoopCycles})`);
      break;
    }

    // Check budget
    if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) {
      rlog.run("INFO", `runLoop: budget exceeded ($${cumulativeCost.toFixed(2)} >= $${config.maxBudgetUsd})`);
      break;
    }

    const cycleNumber = cyclesCompleted + 1;
    const cycleId = crypto.randomUUID();
    const cycleStart = Date.now();
    void cycleStart;

    emit({ type: "loop_cycle_started", runId, cycleNumber });
    rlog.run("INFO", `runLoop: starting cycle ${cycleNumber}`);

    if (currentRunState) {
      currentRunState.currentCycle = cycleNumber;
    }

    // ── Gap Analysis — Deterministic Manifest Walk ──
    let decision: GapAnalysisDecision;
    if (resumeSpecDir && cycleNumber === cyclesCompleted + 1) {
      // Mid-cycle resume: pick RESUME_AT_STEP when a pre-implement stage
      // (specify or plan) completed before the abort. A completed "tasks"
      // stage means the pre-implement triad is done → classic RESUME_FEATURE
      // (jump straight to implement). Any later stage or null also maps to
      // RESUME_FEATURE since implement/verify/learnings have their own
      // resume paths.
      if (resumeLastStage === "specify" || resumeLastStage === "plan") {
        decision = { type: "RESUME_AT_STEP", specDir: resumeSpecDir, resumeAtStep: resumeLastStage };
        rlog.run("INFO", `runLoop: resume — using RESUME_AT_STEP(${resumeLastStage}) for ${resumeSpecDir}`);
      } else {
        decision = { type: "RESUME_FEATURE", specDir: resumeSpecDir };
        rlog.run("INFO", `runLoop: resume — skipping gap analysis, using RESUME_FEATURE for ${resumeSpecDir}`);
      }
      const traceId = crypto.randomUUID();
      runs.startAgentRun(config.projectDir, runId, {
        agentRunId: traceId,
        runId,
        specDir: resumeSpecDir,
        taskPhaseNumber: cycleNumber,
        taskPhaseName: "loop:gap_analysis",
        step: "gap_analysis",
        cycleNumber,
        featureSlug: path.basename(resumeSpecDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });
      emit({ type: "step_started", runId, cycleNumber, step: "gap_analysis", agentRunId: traceId });
      runs.completeAgentRun(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
      emit({ type: "step_completed", runId, cycleNumber, step: "gap_analysis", agentRunId: traceId, costUsd: 0, durationMs: 0 });
      resumeSpecDir = null;
    } else {
      try {
        const manifest = loadManifest(config.projectDir);
        if (!manifest) {
          throw new Error("Feature manifest not found — manifest extraction should have run before the loop");
        }

        if (currentRunState) {
          currentRunState.currentStep = "gap_analysis";
        }

        const active = getActiveFeature(manifest);
        const nextPending = getNextFeature(manifest);

        // Emit a synthetic (deterministic, cost=0) gap_analysis stage so the UI shows it completed
        const emitSyntheticGapAnalysis = (specDir: string) => {
          const traceId = crypto.randomUUID();
          runs.startAgentRun(config.projectDir, runId, {
            agentRunId: traceId,
            runId,
            specDir: specDir || null,
            taskPhaseNumber: cycleNumber,
            taskPhaseName: "loop:gap_analysis",
            step: "gap_analysis",
            cycleNumber,
            featureSlug: specDir ? path.basename(specDir) : null,
            startedAt: new Date().toISOString(),
            status: "running",
          });
          emit({ type: "step_started", runId, cycleNumber, step: "gap_analysis", agentRunId: traceId, specDir });
          runs.completeAgentRun(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
          emit({ type: "step_completed", runId, cycleNumber, step: "gap_analysis", agentRunId: traceId, costUsd: 0, durationMs: 0 });
        };

        if (active) {
          if (active.specDir) {
            // Active feature with specDir — evaluate RESUME vs REPLAN (LLM call)
            const evaluationPrompt = buildFeatureEvaluationPrompt(config, active.specDir);
            const evalResult = await runStage(
              config, evaluationPrompt, emit, rlog, runId, cycleNumber,
              "gap_analysis", active.specDir,
              { type: "json_schema", schema: GAP_ANALYSIS_SCHEMA as unknown as Record<string, unknown> }
            );
            cumulativeCost += evalResult.cost;
            // Delegate to gap-analysis.parseGapAnalysisDecision (A5 wire-in).
            // The parser throws on null/malformed; the surrounding try/catch
            // surfaces it as `gap analysis failed` and breaks the cycle —
            // matches the previous behaviour exactly.
            decision = parseGapAnalysisDecision(evalResult.structuredOutput, active.specDir);
          } else {
            // Active but no specDir — re-run specify for this feature (deterministic)
            emitSyntheticGapAnalysis("");
            decision = {
              type: "NEXT_FEATURE",
              name: active.title,
              description: active.description,
              featureId: active.id,
            };
          }
        } else if (nextPending) {
          // Deterministic — no LLM call needed
          updateFeatureStatus(config.projectDir, nextPending.id, "active");
          emitSyntheticGapAnalysis("");
          decision = {
            type: "NEXT_FEATURE",
            name: nextPending.title,
            description: nextPending.description,
            featureId: nextPending.id,
          };
        } else {
          decision = { type: "GAPS_COMPLETE" };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rlog.run("ERROR", `runLoop: gap analysis failed: ${msg}`);
        emit({ type: "error", message: `Gap analysis failed: ${msg}` });
        break;
      }
    }

    // Record the cycle
    const decisionType = decision.type;
    const featureName = decision.type === "NEXT_FEATURE" ? decision.name : null;
    let specDir = decision.type === "RESUME_FEATURE"
      || decision.type === "REPLAN_FEATURE"
      || decision.type === "RESUME_AT_STEP"
      ? decision.specDir
      : null;
    let cycleFailed = false;

    void cycleId;

    // ── GAPS_COMPLETE → terminate ──
    if (decision.type === "GAPS_COMPLETE") {
      rlog.run("INFO", "runLoop: all gaps complete");
      emit({
        type: "loop_cycle_completed",
        runId,
        cycleNumber,
        decision: decisionType,
        featureName: null,
        specDir: null,
        costUsd: 0,
      });
      break;
    }

    // ── Failure threshold checks (T038) ──
    if (specDir) {
      const record = getOrCreateFailureRecord(specDir);
      if (record.replanFailures >= 3) {
        rlog.run("WARN", `runLoop: skipping feature at ${specDir} — 3 replan failures`);
        // Mark feature as skipped in manifest
        const skipManifest = loadManifest(config.projectDir);
        if (skipManifest) {
          const skipEntry = skipManifest.features.find((f) => f.specDir === specDir);
          if (skipEntry) updateFeatureStatus(config.projectDir, skipEntry.id, "skipped");
        }
        featuresSkipped.push(specDir);
        // (loop cycle row removed in 007-sqlite-removal — derived from phases)
        emit({
          type: "loop_cycle_completed",
          runId,
          cycleNumber,
          decision: "skipped",
          featureName,
          specDir,
          costUsd: 0,
        });
        // Update FeatureArtifacts.status to "skipped"
        if (activeProjectDir && specDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [specDir]: { status: "skipped" } } },
            featuresSkipped: [...featuresSkipped],
          } as never).catch(() => {});
        }
        cyclesCompleted++;
        runs.updateRunCyclesCompleted(config.projectDir, runId, cyclesCompleted);
        continue;
      }
      if (record.implFailures >= 3) {
        // Force replan
        decision = { type: "REPLAN_FEATURE", specDir };
        rlog.run("WARN", `runLoop: forcing replan for ${specDir} — 3 impl failures`);
      }
    }

    let cycleCost = 0;

    // Decision→stages mapping delegated to gap-analysis.shouldRunStage (A5
    // wire-in). The exhaustiveness check (TypeScript `never` on missing
    // variants) lives in gap-analysis.ts — adding a new GapAnalysisDecision
    // variant produces a compile error there, the single source of truth.
    const shouldRun = (step: StepType): boolean => shouldRunStageFromDecision(decision, step);

    try {
      // Emit synthetic completed events for stages that won't actually run,
      // so the UI stepper shows them ✓ instead of missing/stuck.
      if (decision.type === "RESUME_FEATURE") {
        emitSkippedStep("specify", cycleNumber);
        emitSkippedStep("plan", cycleNumber);
        emitSkippedStep("tasks", cycleNumber);
      } else if (decision.type === "RESUME_AT_STEP") {
        const resumeOrdinal = STEP_ORDER.indexOf(decision.resumeAtStep);
        for (const s of ["specify", "plan", "tasks"] as const) {
          if (STEP_ORDER.indexOf(s) <= resumeOrdinal) {
            emitSkippedStep(s, cycleNumber);
          }
        }
      }

      // ── NEXT_FEATURE: specify → plan → tasks → implement → verify → learnings ──
      if (decision.type === "NEXT_FEATURE") {
        // Specify (T030)
        if (currentRunState) {
          currentRunState.currentStep = "specify";
        }
        const knownSpecs = listSpecDirs(config.projectDir);
        const specifyPrompt = buildSpecifyPrompt(decision.name, decision.description);
        const specifyResult = await runStage(config, specifyPrompt, emit, rlog, runId, cycleNumber, "specify");
        cycleCost += specifyResult.cost;

        // IMPORTANT: do NOT abort-check here before persisting the new spec
        // dir. If the user clicked Stop during specify, the dir exists on
        // disk and the next resume needs currentSpecDir set to recover.
        // Discover the newly created spec directory and link to manifest
        specDir = discoverNewSpecDir(config.projectDir, knownSpecs);
        if (!specDir) {
          throw new Error("Specify completed but no new spec directory was created");
        }
        rlog.run("INFO", `runLoop: new spec directory: ${specDir}`);
        updateFeatureSpecDir(config.projectDir, decision.featureId, specDir);

        // Persist the new spec directory to state immediately so a pause
        // between specify and plan is recoverable — the emitter reads
        // currentSpecDir on the next resume to pick RESUME_AT_STEP.
        // Must run BEFORE the abort check below, otherwise a Stop click
        // right after specify completes orphans the new spec dir.
        if (activeProjectDir) {
          await updateState(activeProjectDir, {
            currentSpecDir: specDir,
            artifacts: { features: { [specDir]: { specDir, status: "specifying", spec: null, plan: null, tasks: null, lastImplementedPhase: 0 } } },
          } as never).catch(() => {});
        }

        if (abortController?.signal.aborted) throw new AbortError();
      }

      // Plan (T031) — runs for NEXT_FEATURE, REPLAN_FEATURE, and RESUME_AT_STEP(specify)
      if (shouldRun("plan")) {
        if (abortController?.signal.aborted) throw new AbortError();

        const targetSpecDir = specDir!;
        const specPath = targetSpecDir.startsWith("/")
          ? targetSpecDir
          : path.join(config.projectDir, targetSpecDir);

        if (currentRunState) {
          currentRunState.currentStep = "plan";
        }
        // Update FeatureArtifacts.status to "planning"
        if (activeProjectDir && targetSpecDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [targetSpecDir]: { status: "planning" } } },
          } as never).catch(() => {});
        }
        const planPrompt = buildLoopPlanPrompt(config, specPath);
        const planResult = await runStage(config, planPrompt, emit, rlog, runId, cycleNumber, "plan", targetSpecDir);
        cycleCost += planResult.cost;

        if (abortController?.signal.aborted) throw new AbortError();
      }

      // Tasks (T031) — runs for NEXT_FEATURE, REPLAN_FEATURE, and RESUME_AT_STEP(specify|plan)
      if (shouldRun("tasks")) {
        if (abortController?.signal.aborted) throw new AbortError();

        const targetSpecDir = specDir!;
        const specPath = targetSpecDir.startsWith("/")
          ? targetSpecDir
          : path.join(config.projectDir, targetSpecDir);

        if (currentRunState) {
          currentRunState.currentStep = "tasks";
        }
        const tasksPrompt = buildLoopTasksPrompt(config, specPath);
        const tasksResult = await runStage(config, tasksPrompt, emit, rlog, runId, cycleNumber, "tasks", targetSpecDir);
        cycleCost += tasksResult.cost;
      }

      if (abortController?.signal.aborted) throw new AbortError();

      // ── Implement → Verify → Learnings (extracted to stages/cycle-stages.ts in 011-A4.5) ──
      const implSpecDir = specDir!;
      const ivlResult = await runImplementVerifyLearnings({
        ctx, config, runId, cycleNumber,
        specDir: implSpecDir, fullPlanPath, rlog,
      });
      cycleCost += ivlResult.cycleCost;
      const verification = { passed: ivlResult.verifyPassed };

      // Success — reset failure counters and update manifest
      if (implSpecDir) {
        const record = getOrCreateFailureRecord(implSpecDir);
        record.implFailures = 0;
        record.replanFailures = 0;
        persistFailure(implSpecDir);
      }

      // Mark feature as completed in manifest and FeatureArtifacts if verify passed
      if (verification.passed) {
        if (decision.type === "NEXT_FEATURE") {
          updateFeatureStatus(config.projectDir, decision.featureId, "completed");
        } else if (implSpecDir) {
          const currentManifest = loadManifest(config.projectDir);
          if (currentManifest) {
            const entry = currentManifest.features.find((f) => f.specDir === implSpecDir);
            if (entry) updateFeatureStatus(config.projectDir, entry.id, "completed");
          }
        }
        // Update FeatureArtifacts.status to "completed"
        if (activeProjectDir && implSpecDir) {
          updateState(activeProjectDir, {
            artifacts: { features: { [implSpecDir]: { status: "completed" } } },
          } as never).catch(() => {});
        }
      }

      featuresCompleted.push(featureName ?? implSpecDir);

      // Update state file with feature completion
      if (activeProjectDir) {
        updateState(activeProjectDir, {
          featuresCompleted: [...featuresCompleted],
          cumulativeCostUsd: cumulativeCost + cycleCost,
        }).catch(() => {});
      }

    } catch (err) {
      // AbortError is a clean exit — not a stage failure
      if (err instanceof AbortError) {
        rlog.run("INFO", `runLoop: cycle ${cycleNumber} aborted by user`);
      } else {
        cycleFailed = true;
        // ── Stage failure handling (T040) ──
        const msg = err instanceof Error ? err.message : String(err);
        rlog.run("ERROR", `runLoop: cycle ${cycleNumber} failed: ${msg}`);

        if (specDir) {
          const record = getOrCreateFailureRecord(specDir);
          // Determine which counter to increment based on the current stage
          const currentStep = currentRunState?.currentStep;
          if (currentStep === "plan" || currentStep === "tasks") {
            record.replanFailures++;
          } else {
            record.implFailures++;
          }
          persistFailure(specDir);
        }

        emit({ type: "error", message: `Cycle ${cycleNumber} failed: ${msg}` });
      }
    }

    cumulativeCost += cycleCost;
    const cycleAborted = abortController?.signal.aborted ?? false;
    const cycleStatus = cycleAborted ? "stopped" : cycleFailed ? "failed" : "completed";
    // User aborts preserve the cycle counter so resume re-enters the same
    // cycleNumber. Unrecoverable failures still advance — otherwise a poison
    // cycle would retry forever.
    if (!cycleAborted) {
      cyclesCompleted++;
    }

    // (loop cycle row removed in 007-sqlite-removal — cycleCost/duration derived from phases)
    void cycleStatus;
    runs.updateRunCyclesCompleted(config.projectDir, runId, cyclesCompleted);

    // Update state file with cycle completion
    if (activeProjectDir) {
      updateState(activeProjectDir, {
        cumulativeCostUsd: cumulativeCost,
        cyclesCompleted,
        currentCycleNumber: cycleNumber,
      }).catch(() => {});
    }

    if (currentRunState) {
      currentRunState.cyclesCompleted = cyclesCompleted;
    }

    emit({
      type: "loop_cycle_completed",
      runId,
      cycleNumber,
      decision: cycleAborted ? "stopped" : decisionType,
      featureName,
      specDir,
      costUsd: cycleCost,
    });

    // Check termination conditions after cycle
    if (abortController?.signal.aborted) break;
    if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) break;
    if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) break;
  }

  // ── Termination (T042) ──
  let terminationReason: TerminationReason = "gaps_complete";
  if (abortController?.signal.aborted) {
    terminationReason = "user_abort";
  } else if (config.maxBudgetUsd && cumulativeCost >= config.maxBudgetUsd) {
    terminationReason = "budget_exceeded";
  } else if (config.maxLoopCycles && cyclesCompleted >= config.maxLoopCycles) {
    terminationReason = "max_cycles_reached";
  }

  const termination: LoopTermination = {
    reason: terminationReason,
    cyclesCompleted,
    totalCostUsd: cumulativeCost,
    totalDurationMs: 0, // Will be set by caller
    featuresCompleted,
    featuresSkipped,
  };

  emit({ type: "loop_terminated", runId, termination });
  rlog.run("INFO", `runLoop: terminated — reason=${terminationReason}, cycles=${cyclesCompleted}, features=${featuresCompleted.length}/${featuresSkipped.length}`);

  return { cyclesCompleted, cumulativeCost, featuresCompleted, featuresSkipped, termination };
}
