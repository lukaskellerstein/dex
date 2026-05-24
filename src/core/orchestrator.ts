/**
 * What: Coordinator surface — public `run()` dispatcher routing to runBuild / runLoop, the loop-mode body (createContext → prerequisites → clarification → manifest extraction → mainLoop), the named exports the IPC layer + extracted stage modules consume (getRunState, getActiveContext, listSpecDirs, isSpecComplete, runStage, runPhase, runBuild, RunTaskState, buildPrompt, AbortError, submitUserAnswer), and stopRun.
 * Not: Does not own setup / teardown — those live in run-lifecycle.ts (initRun, finalizeRun, runtimeState bag). Does not own per-stage execution — runStage and runPhase are re-exports from stages/. Does not own the autonomous loop itself — runMainLoop in stages/main-loop.ts.
 * Deps: run-lifecycle (initRun, finalizeRun, runtimeState), stages/{run-stage, run-phase, build, main-loop, prerequisites, clarification, manifest-extraction}, state.* (resume reconciliation).
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { submitUserAnswer } from "./userInput.js";
import type { OrchestrationContext, RunState } from "./context.js";
import { runPrerequisites as runPrerequisitesPhase } from "./stages/prerequisites.js";
import { runClarificationPhase } from "./stages/clarification.js";
import { runMainLoop } from "./stages/main-loop.js";
import type { EmitFn, RunConfig } from "./types.js";
import { parseTasksFile } from "./parser.js";
import { getCurrentBranch, createBranch } from "./git.js";
import { runBuild } from "./stages/build.js";
import { runStage } from "./stages/run-stage.js";
import { RunTaskState, runPhase, buildPrompt } from "./stages/run-phase.js";
import { ensureManifest } from "./stages/manifest-extraction.js";
import { deriveGoalPaths } from "./goal-paths.js";
import {
  initRun,
  finalizeRun,
  runtimeState,
} from "./run-lifecycle.js";
import {
  loadState,
  clearState,
  detectStaleState,
  resolveWorkingTreeConflict,
  reconcileState,
  updateState,
} from "./state.js";
import * as runs from "./runs.js";

// Re-exports for IPC + stage modules. Keeps "./orchestrator.js" as the single
// import point for external consumers — extracted modules can move freely
// without churning all call sites.
export { submitUserAnswer, RunTaskState, runPhase, buildPrompt, runBuild, runStage };

/** Sentinel error thrown when abort is detected between stages to skip remaining work. */
export class AbortError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "AbortError";
  }
}

// ── Public read-only accessors over runtimeState ────────────────────────────

/**
 * Returns the live RunState if a run is active, or null otherwise. Used by
 * IPC for `dexAPI.getRunState()` so the renderer can recover after refresh.
 */
export function getRunState(): RunState | null {
  return runtimeState.currentContext?.state ?? null;
}

/**
 * Returns the live OrchestrationContext, or null when no run is in flight.
 * Used by extracted stage modules (run-stage, run-phase, build) that need
 * runner / state / abort / projectDir without threading ctx through every
 * function signature.
 */
export function getActiveContext(): OrchestrationContext | null {
  return runtimeState.currentContext;
}

// ── Spec discovery (used by IPC + build/loop runners) ───────────────────────

export function listSpecDirs(projectDir: string): string[] {
  const candidates = [
    path.join(projectDir, "specs"),
    path.join(projectDir, ".specify", "specs"),
  ];
  for (const specsRoot of candidates) {
    if (fs.existsSync(specsRoot)) {
      const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .filter((e) => fs.existsSync(path.join(specsRoot, e.name, "tasks.md")))
        .map((e) => path.relative(projectDir, path.join(specsRoot, e.name)))
        .sort();
    }
  }
  return [];
}

export function isSpecComplete(projectDir: string, specDir: string): boolean {
  const phases = parseTasksFile(projectDir, specDir);
  return phases.length > 0 && phases.every((p) => p.status === "complete");
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function run(config: RunConfig, emit: EmitFn): Promise<void> {
  const init = await initRun(config, emit);
  if (!init) return; // lock failure already surfaced via emit

  const { runId, rlog, ctx } = init;
  let { branchName, baseBranch } = init;
  let taskPhasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  try {
    if (config.mode === "loop") {
      const result = await runLoop(config, emit, runId, rlog);
      taskPhasesCompleted = result.taskPhasesCompleted;
      totalCost = result.totalCost;
      // Branch was created inside runLoop after prerequisites
      baseBranch = result.baseBranch;
      branchName = result.branchName;
    } else {
      const result = await runBuild(ctx, { config, runId, rlog });
      taskPhasesCompleted = result.taskPhasesCompleted;
      totalCost = result.totalCost;
    }
  } catch (err) {
    // AbortError is expected when the user stops a run — not a real error.
    if (!(err instanceof AbortError)) throw err;
  } finally {
    await finalizeRun({
      config, emit, runId, rlog,
      branchName, baseBranch, taskPhasesCompleted, totalCost, runStart,
    });
  }
}

// ── Loop Mode Runner ───────────────────────────────────────────────────────

/**
 * Resolve the loop's goal file. Precedence:
 *   1. config.descriptionFile (resolved against projectDir if relative)
 *   2. state.json's persisted `config.descriptionFile` — committed alongside
 *      step checkpoints (014 fork-resume reconciliation), so a Timeline jump
 *      restores the goal that was active at the fork point. Critical for
 *      preventing cross-goal contamination when prior runs used different
 *      goals.
 *   3. <projectDir>/GOAL.md
 *   4. The descriptionFile of the most recent prior run record on disk —
 *      last-resort safety net when state.json is absent (fresh project, no
 *      prior run on this branch).
 *
 * Throws a clear error listing all probed paths if nothing resolves.
 */
function resolveGoalPath(config: RunConfig, rlog: import("./log.js").RunLogger): string {
  const tried: string[] = [];

  if (config.descriptionFile) {
    const explicit = path.isAbsolute(config.descriptionFile)
      ? config.descriptionFile
      : path.join(config.projectDir, config.descriptionFile);
    tried.push(explicit);
    if (fs.existsSync(explicit)) return explicit;
  }

  // state.json now travels with the branch (post-014). Prefer its persisted
  // descriptionFile over GOAL.md / prior runs so fork-resume picks up the
  // correct goal even when other goals exist in the repo. Mirrors the raw
  // read pattern in src/renderer/hooks/useLoopStartForm.ts.
  const stateFile = path.join(config.projectDir, ".dex", "state.json");
  if (fs.existsSync(stateFile)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(stateFile, "utf-8"))?.config?.descriptionFile;
      if (typeof persisted === "string" && persisted.length > 0) {
        const abs = path.isAbsolute(persisted) ? persisted : path.join(config.projectDir, persisted);
        tried.push(abs);
        if (fs.existsSync(abs)) {
          rlog.run("INFO", "runLoop: using goal from state.json", { goal: abs });
          return abs;
        }
      }
    } catch {
      // malformed state.json — fall through to remaining fallbacks
    }
  }

  const defaultGoal = path.join(config.projectDir, "GOAL.md");
  tried.push(defaultGoal);
  if (fs.existsSync(defaultGoal)) return defaultGoal;

  const recovered = runs
    .listRuns(config.projectDir)
    .map((r) => r.descriptionFile)
    .find((p): p is string => !!p && fs.existsSync(p));
  if (recovered) {
    rlog.run("INFO", "runLoop: recovered goal file from prior run record", { recovered });
    return recovered;
  }

  throw new Error(
    `Loop mode requires a goal file. Probed: ${tried.join(", ")}. ` +
      `Set config.descriptionFile, place GOAL.md in ${config.projectDir}, ` +
      `or run again on a project with prior run history.`,
  );
}

async function runLoop(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: import("./log.js").RunLogger,
): Promise<{ taskPhasesCompleted: number; totalCost: number; baseBranch: string; branchName: string }> {
  const goalPath = resolveGoalPath(config, rlog);
  const goalPaths = deriveGoalPaths(goalPath);

  // Detect stale state from a different branch or completed run.
  if (config.resume) {
    const staleCheck = await detectStaleState(config.projectDir);
    if (staleCheck === "stale" || staleCheck === "completed") {
      rlog.run("INFO", `runLoop: stale state detected (${staleCheck}) — clearing and starting fresh`);
      await clearState(config.projectDir);
      config = { ...config, resume: false };
    } else if (staleCheck === "none") {
      rlog.run("INFO", "runLoop: no state file found — starting fresh");
      config = { ...config, resume: false };
    }
  }

  const clarifiedPath = goalPaths.clarified;
  let fullPlanPath = "";
  let cumulativeCost = 0;
  let cyclesCompleted = 0;
  const featuresCompleted: string[] = [];
  const featuresSkipped: string[] = [];

  // ── Resume context from state file ──
  let resumeSpecDir: string | null = null;
  let resumeLastStage: string | null = null;
  if (config.resume) {
    let savedState = await resolveWorkingTreeConflict(config.projectDir);
    if (!savedState) savedState = await loadState(config.projectDir);
    if (savedState) {
      const reconciliation = await reconcileState(config.projectDir, savedState, emit, runId);
      if (Object.keys(reconciliation.statePatches).length > 0) {
        await updateState(config.projectDir, reconciliation.statePatches);
      }
      for (const w of reconciliation.warnings) {
        rlog.run("WARN", `runLoop: reconciliation: ${w}`);
      }
      resumeSpecDir = savedState.currentSpecDir;
      resumeLastStage = savedState.lastCompletedStep;
      cumulativeCost = savedState.cumulativeCostUsd;
      cyclesCompleted = savedState.cyclesCompleted;
      featuresCompleted.push(...savedState.featuresCompleted);
      featuresSkipped.push(...savedState.featuresSkipped);
      fullPlanPath = savedState.fullPlanPath ?? "";
      // Failure counts stay on disk in state.failureCounts; main-loop reads
      // them from there when it needs to evaluate the threshold gates.

      if (reconciliation.resumeFrom.specDir) {
        resumeSpecDir = reconciliation.resumeFrom.specDir;
      }
      rlog.run("INFO", "runLoop: resuming from state file", {
        resumeSpecDir, resumeLastStage, cumulativeCost, cyclesCompleted,
        drift: reconciliation.driftSummary,
      });
    }
  }

  const isResume = !!config.resume;

  // ── Phase 0: Prerequisites (skip on resume) ──
  if (!isResume) {
    const ctx = runtimeState.currentContext;
    if (!ctx) throw new Error("runLoop: prerequisites needs currentContext but it's null");
    await runPrerequisitesPhase(ctx, runId);
    if (runtimeState.abortController?.signal.aborted) {
      emit({ type: "loop_terminated", runId, termination: { reason: "user_abort", cyclesCompleted: 0, totalCostUsd: 0, totalDurationMs: 0, featuresCompleted: [], featuresSkipped: [] } });
      return { taskPhasesCompleted: 0, totalCost: 0, baseBranch: "", branchName: "" };
    }
  } else {
    rlog.run("INFO", "runLoop: skipping prerequisites (resume)");
    // Synthetic events so the UI can reconstruct the stepper.
    emit({ type: "prerequisites_started", runId });
    const prereqTraceId = crypto.randomUUID();
    emit({ type: "step_started", runId, cycleNumber: 0, step: "prerequisites", agentRunId: prereqTraceId });
    emit({ type: "step_completed", runId, cycleNumber: 0, step: "prerequisites", agentRunId: prereqTraceId, costUsd: 0, durationMs: 0 });
    emit({ type: "prerequisites_completed", runId });
  }

  // ── Branch creation (skip on resume — stay on current branch) ──
  let baseBranch: string;
  let branchName: string;
  if (isResume) {
    branchName = getCurrentBranch(config.projectDir);
    try {
      execSync("git rev-parse --verify main", { cwd: config.projectDir, stdio: "ignore" });
      baseBranch = "main";
    } catch {
      baseBranch = "master";
    }
    rlog.run("INFO", `runLoop: resuming on branch ${branchName}, baseBranch=${baseBranch}`);
  } else {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir, config.mode);
    rlog.run("INFO", `runLoop: created branch ${branchName} from ${baseBranch}`);
    if (runtimeState.activeProjectDir) {
      await updateState(runtimeState.activeProjectDir, { baseBranch });
    }
  }

  // ── Phase A: Multi-Domain Clarification (stages/clarification.ts) ──
  const ctxForClarify = runtimeState.currentContext;
  if (!ctxForClarify) throw new Error("runLoop: clarification needs currentContext but it's null");
  {
    const existingSpecsAtStart = listSpecDirs(config.projectDir);
    const result = await runClarificationPhase(ctxForClarify, {
      config, runId, goalPath, clarifiedPath,
      productDomainPath: goalPaths.productDomain,
      technicalDomainPath: goalPaths.technicalDomain,
      existingSpecsAtStart,
      seedCumulativeCost: cumulativeCost,
    });
    fullPlanPath = result.fullPlanPath;
    cumulativeCost = result.cumulativeCost;
  }

  // ── Manifest Extraction (stages/manifest-extraction.ts) ──
  {
    const result = await ensureManifest(ctxForClarify, {
      config, runId, fullPlanPath, rlog, seedCumulativeCost: cumulativeCost,
    });
    cumulativeCost = result.cumulativeCost;
  }

  // ── Phase B: Autonomous Loop (stages/main-loop.ts) ──
  const mainLoopResult = await runMainLoop(ctxForClarify, {
    config, runId, fullPlanPath,
    cyclesCompletedSeed: cyclesCompleted,
    cumulativeCostSeed: cumulativeCost,
    featuresCompletedSeed: featuresCompleted,
    featuresSkippedSeed: featuresSkipped,
    resumeSpecDir, resumeLastStage,
  });
  cyclesCompleted = mainLoopResult.cyclesCompleted;
  cumulativeCost = mainLoopResult.cumulativeCost;

  return { taskPhasesCompleted: cyclesCompleted, totalCost: cumulativeCost, baseBranch, branchName };
}

// ── Stop ───────────────────────────────────────────────────────────────────

export function stopRun(): void {
  // Read the abort handle from currentContext when available, falling back to
  // the runtimeState alias for the brief window before/after a run lifecycle.
  const abort = runtimeState.currentContext?.abort ?? runtimeState.abortController;
  if (abort) {
    console.log("[stopRun] abort signal sent to orchestrator");
    abort.abort();
  } else {
    console.log("[stopRun] no active orchestrator");
  }
}
