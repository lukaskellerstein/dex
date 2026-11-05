/**
 * What: Coordinator surface — `run()` routes to build mode or the loop. The loop body: for a new project, prerequisites → run branch → clarification → queue extraction → the queue loop; for an existing project (hand-written queue), check-only prerequisites → the queue loop, with no goal, clarification or branch of Dex's own. A new project's Resume skips prerequisites and runs the queue loop again — there is no reconcile step. Also the named exports IPC and the stage modules use (getRunState, getActiveContext, listSpecDirs, isSpecComplete, runStage, runPhase, runBuild, RunTaskState, AbortError) and stopRun.
 * Not: Does not own setup / teardown (run-lifecycle.ts) or per-stage execution (stages/). Does not decide what runs next — the picker does, inside stages/loop.ts.
 * Deps: run-lifecycle, stages/{run-stage, run-phase, build, loop, prerequisites, clarification, manifest-extraction}, queue.loadQueue, state, humanInput.cancelAll.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OrchestrationContext, RunState } from "./context.js";
import { createBranch, getCurrentBranch } from "./git.js";
import { deriveGoalPaths } from "./goal-paths.js";
import { cancelAll, type HeldKind, parkAll, WaitingForHuman } from "./humanInput.js";
import type { RunLogger } from "./log.js";
import { parseTasksFile } from "./parser.js";
import { loadQueue, type QueueV3, resolveEntries } from "./queue.js";
import { finalizeRun, initRun, runtimeState } from "./run-lifecycle.js";
import * as runs from "./runs.js";
import { runBuild } from "./stages/build.js";
import { runClarificationPhase } from "./stages/clarification.js";
import { type LoopResult, runQueueLoop } from "./stages/loop.js";
import { ensureManifest } from "./stages/manifest-extraction.js";
import { checkExistingProject, runPrerequisites as runPrerequisitesPhase } from "./stages/prerequisites.js";
import { RunTaskState, runPhase } from "./stages/run-phase.js";
import { runStage } from "./stages/run-stage.js";
import { loadState, updateState } from "./state.js";
import type { EmitFn, RunConfig, TerminationReason } from "./types.js";

// Re-exports for IPC + stage modules: "./orchestrator.js" stays the single
// import point, so extracted modules can move without churning call sites.
export { RunTaskState, runBuild, runPhase, runStage };

/** Sentinel error thrown when abort is detected between stages to skip remaining work. */
export class AbortError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "AbortError";
  }
}

// ── Public read-only accessors over runtimeState ────────────────────────────

/** The live RunState while a run is active, else null (renderer recovery after refresh). */
export function getRunState(): RunState | null {
  return runtimeState.currentContext?.state ?? null;
}

/** The live OrchestrationContext, or null when no run is in flight. */
export function getActiveContext(): OrchestrationContext | null {
  return runtimeState.currentContext;
}

// ── Spec discovery (used by IPC + build mode) ───────────────────────────────

export function listSpecDirs(projectDir: string): string[] {
  const candidates = [path.join(projectDir, "specs"), path.join(projectDir, ".specify", "specs")];
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
  if (!init) return; // lock or queue failure already surfaced via emit

  const { runId, rlog, ctx, resumed } = init;
  let { branchName, baseBranch } = init;
  let taskPhasesCompleted = 0;
  let totalCost = 0;
  let termination: TerminationReason | undefined;
  const runStart = Date.now();

  try {
    if (config.mode === "loop") {
      const result = await runLoop(ctx, { config, runId, rlog, resumed });
      taskPhasesCompleted = result.stagesRun;
      totalCost = result.cost;
      termination = result.termination.reason;
      baseBranch = result.baseBranch;
      branchName = result.branchName;
    } else {
      const result = await runBuild(ctx, { config, runId, rlog });
      taskPhasesCompleted = result.taskPhasesCompleted;
      totalCost = result.totalCost;
    }
  } catch (err) {
    // An error after Stop is the stop unwinding (stages throw their own abort
    // errors), not a failure.
    if (err instanceof AbortError || ctx.abort.signal.aborted) {
      termination = "user_abort";
    } else {
      termination = "failed";
      throw err;
    }
  } finally {
    cancelAll();
    await finalizeRun({
      config,
      emit,
      runId,
      rlog,
      branchName,
      baseBranch,
      taskPhasesCompleted,
      totalCost,
      runStart,
      termination,
      openPullRequest: ctx.policy.openPullRequest,
    });
  }
}

// ── Loop mode ──────────────────────────────────────────────────────────────

/**
 * The new project's goal file. Precedence: config.descriptionFile, the goal
 * the run started with (state.json), `<projectDir>/GOAL.md`, the most recent
 * run record's goal. Throws listing every probed path when none exists.
 */
async function resolveGoalPath(config: RunConfig, rlog: RunLogger): Promise<string> {
  const tried: string[] = [];
  const probe = (p: string | undefined) => {
    if (!p) return null;
    const abs = path.isAbsolute(p) ? p : path.join(config.projectDir, p);
    tried.push(abs);
    return fs.existsSync(abs) ? abs : null;
  };
  const persisted = (await loadState(config.projectDir))?.config.descriptionFile;
  const found =
    probe(config.descriptionFile) ?? probe(persisted) ?? probe(path.join(config.projectDir, "GOAL.md"));
  if (found) return found;
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
      `Set config.descriptionFile or place GOAL.md in ${config.projectDir}.`,
  );
}

interface LoopRun {
  config: RunConfig;
  runId: string;
  rlog: RunLogger;
  resumed: boolean;
}

type LoopOutcome = LoopResult & { baseBranch: string; branchName: string };

function abortedBeforeLoop(ctx: OrchestrationContext, runId: string): LoopOutcome {
  const termination = {
    reason: "user_abort" as const,
    cyclesCompleted: 0,
    totalCostUsd: 0,
    totalDurationMs: 0,
    featuresCompleted: [],
    featuresSkipped: [],
  };
  ctx.emit({ type: "loop_terminated", runId, termination });
  return { termination, cost: 0, stagesRun: 0, baseBranch: "", branchName: "" };
}

/** Synthetic prerequisite events on Resume, so the UI stepper shows them done. */
function emitResumedPrerequisites(ctx: OrchestrationContext, runId: string): void {
  const agentRunId = crypto.randomUUID();
  ctx.emit({ type: "prerequisites_started", runId });
  ctx.emit({ type: "step_started", runId, cycleNumber: 0, step: "prerequisites", agentRunId });
  ctx.emit({
    type: "step_completed",
    runId,
    cycleNumber: 0,
    step: "prerequisites",
    agentRunId,
    costUsd: 0,
    durationMs: 0,
  });
  ctx.emit({ type: "prerequisites_completed", runId });
}

/**
 * Prerequisites and the run branch, once per new project. Dex never switches
 * a new project's branch, so on Resume the run branch is the checkout — after
 * a checkpoint reset that is the `attempt-*` branch, not the original one.
 */
async function prepareNewProject(
  ctx: OrchestrationContext,
  run: LoopRun,
): Promise<{ baseBranch: string; branchName: string } | null> {
  const { config, runId, rlog } = run;
  if (run.resumed) {
    emitResumedPrerequisites(ctx, runId);
    const branchName = getCurrentBranch(config.projectDir);
    const previous = (await loadState(config.projectDir))?.runBranch;
    if (previous !== branchName) await updateState(config.projectDir, { runBranch: branchName });
    rlog.run("INFO", `runLoop: resuming on ${branchName}`, { previousRunBranch: previous ?? null });
    return { baseBranch: "", branchName };
  }
  await runPrerequisitesPhase(ctx, runId);
  if (ctx.abort.signal.aborted) return null;
  const baseBranch = getCurrentBranch(config.projectDir);
  const branchName = createBranch(config.projectDir);
  await updateState(config.projectDir, { runBranch: branchName });
  rlog.run("INFO", `runLoop: created branch ${branchName} from ${baseBranch}`);
  return { baseBranch, branchName };
}

async function runNewProject(
  ctx: OrchestrationContext,
  run: LoopRun,
  existing: QueueV3 | null,
): Promise<LoopOutcome> {
  const { config, runId, rlog } = run;
  const goalPath = await resolveGoalPath(config, rlog);
  const goalPaths = deriveGoalPaths(goalPath);
  const branches = await prepareNewProject(ctx, run);
  if (!branches) return abortedBeforeLoop(ctx, runId);

  const clarified = await runClarificationPhase(ctx, {
    config,
    runId,
    goalPath,
    clarifiedPath: goalPaths.clarified,
    productDomainPath: goalPaths.productDomain,
    technicalDomainPath: goalPaths.technicalDomain,
    queueExists: existing !== null,
    seedCumulativeCost: 0,
  });
  if (ctx.abort.signal.aborted) return { ...abortedBeforeLoop(ctx, runId), ...branches };
  const { queue, cost } = await ensureManifest(ctx, {
    config,
    runId,
    fullPlanPath: clarified.fullPlanPath,
  });
  await updateState(config.projectDir, {
    cumulativeCostUsd: ((await loadState(config.projectDir))?.cumulativeCostUsd ?? 0) + clarified.cumulativeCost + cost,
  });
  const goalForAgents = fs.existsSync(clarified.fullPlanPath) ? clarified.fullPlanPath : goalPath;
  const result = await runQueueLoop(ctx, {
    config,
    runId,
    kind: "new",
    goalPath: goalForAgents,
    queue,
    runBranch: branches.branchName,
  });
  return { ...result, cost: result.cost + clarified.cumulativeCost + cost, ...branches };
}

async function runLoop(ctx: OrchestrationContext, run: LoopRun): Promise<LoopOutcome> {
  const queue = loadQueue(run.config.projectDir);
  if (queue?.kind !== "existing") return runNewProject(ctx, run, queue);
  return runExistingProject(ctx, run, queue);
}

/**
 * The branch the run ended on and its queue base — what an opt-in pull
 * request would compare. No base when the branch is no entry's own.
 */
function endBranches(projectDir: string, queue: QueueV3): { baseBranch: string; branchName: string } {
  const branchName = getCurrentBranch(projectDir);
  const entry = resolveEntries(queue, branchName, null).find((e) => e.branch === branchName);
  const baseBranch = entry && entry.baseBranch !== branchName ? entry.baseBranch : "";
  return { baseBranch, branchName };
}

/**
 * An existing project (FR-007): check-only prerequisites, then the queue. Dex
 * creates no branch, runs no clarification and makes no commit; the agents
 * commit and spec-kit makes the feature branches.
 */
async function runExistingProject(ctx: OrchestrationContext, run: LoopRun, queue: QueueV3): Promise<LoopOutcome> {
  const { config, runId, rlog } = run;
  rlog.run("INFO", `runLoop: existing project, ${queue.entries.length} queue entries`);
  const failures = await checkExistingProject(ctx, runId);
  const startGuard =
    failures.length > 0 ? { reason: "preflight_failed" as const, detail: `prerequisites failed: ${failures.join("; ")}` } : null;
  const result = await runQueueLoop(ctx, {
    config,
    runId,
    kind: "existing",
    goalPath: null,
    queue,
    runBranch: null,
    startGuard,
  });
  return { ...result, ...endBranches(config.projectDir, queue) };
}

// ── Stop ───────────────────────────────────────────────────────────────────

/**
 * No human can answer the request that just arrived (`dex run` without a
 * TTY): park every held request, end the stage, and let the run pause with
 * what it waits for (contracts/cli.md § Human input on the terminal).
 */
export function pauseForHuman(waitFor: HeldKind): void {
  const abort = runtimeState.currentContext?.abort ?? runtimeState.abortController;
  parkAll();
  abort?.abort(new WaitingForHuman(waitFor));
}

export function stopRun(): void {
  const abort = runtimeState.currentContext?.abort ?? runtimeState.abortController;
  cancelAll();
  if (abort) {
    console.log("[stopRun] abort signal sent to orchestrator");
    abort.abort();
  } else {
    console.log("[stopRun] no active orchestrator");
  }
}
