/**
 * What: Run-level setup and teardown helpers — `initRun` does the bootstrap (crash-recovery, branch resolution, runId/rlog, runs-table init, agent-runner resolution, state-lock acquisition, initial state file, ctx construction); `finalizeRun` does the teardown (status persistence, lock release, PR creation, run_completed emit). The mutable `runtimeState` bag holds the bridge globals (currentContext, abortController, releaseLock, …) so orchestrator.ts and other modules can read them without circular setters.
 * Not: Does not own the per-mode dispatch (run() in orchestrator.ts decides loop vs build). Does not run the actual phases (those are stages/*).
 * Deps: createContext (context.ts), runs.* (audit init/finalize), git.{getCurrentBranch, createBranch, createPullRequest}, state.{loadState, saveState, updateState, createInitialState, acquireStateLock}, agent.createAgentRunner (named-runner dispatch), dexConfig.loadDexConfig, log.{RunLogger, fallbackLog}.
 */

import crypto from "node:crypto";
import path from "node:path";
import { RunLogger, fallbackLog as log } from "./log.js";
import {
  createContext,
  type OrchestrationContext,
  type RunState,
} from "./context.js";
import { createAgentRunner } from "./agent/index.js";
import { loadDexConfig } from "./dexConfig.js";
import type { AgentRunner } from "./agent/AgentRunner.js";
import type { EmitFn, RunConfig } from "./types.js";
import * as runs from "./runs.js";
import { getCurrentBranch, createBranch, createPullRequest } from "./git.js";
import {
  createInitialState,
  saveState,
  loadState,
  updateState,
  acquireStateLock,
} from "./state.js";
import { commitCheckpoint, ensureDexGitignore } from "./checkpoints.js";

// ── Mutable bridge state (single source of truth for the live run) ──────────

export const runtimeState: {
  abortController: AbortController | null;
  activeProjectDir: string | null;
  releaseLock: (() => void) | null;
  currentRunner: AgentRunner | null;
  currentContext: OrchestrationContext | null;
  currentRunState: RunState | null;
} = {
  abortController: null,
  activeProjectDir: null,
  releaseLock: null,
  currentRunner: null,
  currentContext: null,
  currentRunState: null,
};

export interface InitResult {
  runId: string;
  rlog: RunLogger;
  ctx: OrchestrationContext;
  branchName: string;
  baseBranch: string;
}

// ── initRun ────────────────────────────────────────────────────────────────

export async function initRun(
  config: RunConfig,
  emit: EmitFn,
): Promise<InitResult | null> {
  // Reconcile any prior runs left "running" by a previous crash.
  try {
    runs.reconcileCrashedRuns(config.projectDir);
  } catch (e) {
    log("WARN", "reconcileCrashedRuns failed", { error: (e as Error).message });
  }
  // Idempotent — re-runs every start to pick up new runtime-cache entries
  // for projects that were initialized before a given entry was added.
  try {
    ensureDexGitignore(config.projectDir);
  } catch (e) {
    log("WARN", "ensureDexGitignore failed", { error: (e as Error).message });
  }
  runtimeState.abortController = new AbortController();

  // Branch resolution. Loop mode defers branch creation until after
  // prerequisites (which may init git); resume keeps the current branch.
  let baseBranch = "";
  let branchName = "";
  if (config.resume) {
    branchName = getCurrentBranch(config.projectDir);
  } else if (config.mode !== "loop") {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir, config.mode);
  }

  // Resume preserves the previous runId so phase traces stay associated.
  let runId: string = crypto.randomUUID();
  if (config.resume) {
    const prev = await loadState(config.projectDir);
    if (prev?.runId) runId = prev.runId;
  }

  const rlog = new RunLogger(path.basename(config.projectDir), runId);
  rlog.run("INFO", `run: ${config.resume ? "resuming" : "starting"} orchestrator`, {
    mode: config.mode,
    model: config.model,
    specDir: config.specDir,
    branch: branchName || "(deferred)",
    baseBranch: baseBranch || "(deferred)",
    runId,
  });

  // Create the run record on fresh start, OR recreate it on resume if the
  // file is missing (e.g. .dex/runs/<runId>.json was manually deleted while
  // state.json kept the runId). Without this, the first call into
  // runs.updateRun on resume throws "run not found" and the orchestrator
  // hangs silently after the clarification skip path — events have already
  // fired in the renderer (so isRunning=true), but no further progress is
  // possible. Recreating with the same runId preserves audit-trail continuity
  // for the renderer.
  const runRecordExists = config.resume ? runs.readRun(config.projectDir, runId) !== null : false;
  if (!config.resume || !runRecordExists) {
    if (config.resume) {
      rlog.run("WARN", `run: resume runId=${runId} has no run record on disk — recreating`);
    }
    runs.startRun(config.projectDir, {
      runId,
      mode: config.mode,
      model: config.model,
      specDir: config.specDir,
      startedAt: new Date().toISOString(),
      status: "running",
      writerPid: process.pid,
      description: null,
      descriptionFile: config.descriptionFile
        ? path.isAbsolute(config.descriptionFile)
          ? config.descriptionFile
          : path.join(config.projectDir, config.descriptionFile)
        : null,
      fullPlanPath: null,
      maxLoopCycles: config.maxLoopCycles ?? null,
      maxBudgetUsd: config.maxBudgetUsd ?? null,
    });
  }

  runtimeState.activeProjectDir = config.projectDir;

  // Resolve agent backend. Precedence: RunConfig.agent > .dex/dex-config.json > "claude".
  const dexCfg = loadDexConfig(config.projectDir);
  const agentName = config.agent ?? dexCfg.agent;
  rlog.run("INFO", `run: resolving agent backend`, {
    agent: agentName,
    source: config.agent !== undefined ? "RunConfig" : "dex-config.json",
  });
  runtimeState.currentRunner = createAgentRunner(agentName, config, config.projectDir);

  // Acquire state lock.
  try {
    runtimeState.releaseLock = await acquireStateLock(config.projectDir);
  } catch (lockErr) {
    emit({ type: "error", message: lockErr instanceof Error ? lockErr.message : String(lockErr) });
    runtimeState.abortController = null;
    runtimeState.activeProjectDir = null;
    runtimeState.currentRunner = null;
    return null;
  }

  if (!config.resume) {
    const initialState = createInitialState(config, runId, branchName, baseBranch);
    await saveState(config.projectDir, initialState);
  }

  emit({ type: "run_started", config, runId, branchName });

  runtimeState.currentRunState = {
    runId,
    projectDir: config.projectDir,
    specDir: config.specDir,
    mode: config.mode,
    model: config.model,
    agentRunId: "",
    taskPhaseNumber: 0,
    taskPhaseName: "",
  };

  const ctx = createContext({
    abort: runtimeState.abortController!,
    runner: runtimeState.currentRunner!,
    state: runtimeState.currentRunState,
    projectDir: config.projectDir,
    releaseLock: async () => {
      if (runtimeState.releaseLock) runtimeState.releaseLock();
    },
    emit,
    rlog,
  });
  runtimeState.currentContext = ctx;

  return { runId, rlog, ctx, branchName, baseBranch };
}

// ── finalizeRun ────────────────────────────────────────────────────────────

export interface FinalizeArgs {
  config: RunConfig;
  emit: EmitFn;
  runId: string;
  rlog: RunLogger;
  branchName: string;
  baseBranch: string;
  taskPhasesCompleted: number;
  totalCost: number;
  runStart: number;
}

export async function finalizeRun(args: FinalizeArgs): Promise<void> {
  const { config, emit, runId, rlog, branchName, baseBranch, taskPhasesCompleted, totalCost, runStart } = args;
  const wasStopped = runtimeState.abortController?.signal.aborted ?? false;

  // Drop ctx + bridge aliases.
  runtimeState.currentContext = null;
  runtimeState.abortController = null;
  runtimeState.currentRunState = null;
  runtimeState.currentRunner = null;

  const totalDuration = Date.now() - runStart;
  const finalStatus = wasStopped ? "stopped" : "completed";
  runs.completeRun(config.projectDir, runId, finalStatus, totalCost, totalDuration, taskPhasesCompleted);

  // Update state file: paused if stopped, completed otherwise.
  if (runtimeState.activeProjectDir) {
    try {
      if (wasStopped) {
        // Preserve pauseReason if step_mode already set it; else user_abort.
        const existing = await loadState(runtimeState.activeProjectDir);
        const reason: "user_abort" | "step_mode" | "budget" | "failure" =
          existing?.pauseReason === "step_mode" ? "step_mode" : "user_abort";
        await updateState(runtimeState.activeProjectDir, {
          status: "paused",
          pauseReason: reason,
          pausedAt: new Date().toISOString(),
          cumulativeCostUsd: totalCost,
        });
        emit({ type: "paused", runId, reason });
      } else {
        await updateState(runtimeState.activeProjectDir, { status: "completed" });
      }
    } catch {
      // non-fatal — state write failure shouldn't crash cleanup
    }
  }

  // Final completion checkpoint. The terminal write to .dex/runs/<runId>.json
  // happens in runs.completeRun() above — without this commit the working tree
  // stays dirty after a successful run, so any subsequent jumpTo() trips the
  // dirty-tree guard and pops the "Uncommitted changes" modal. Only emitted
  // for clean completion; stopped/aborted runs intentionally leave the tree
  // dirty so the user can inspect.
  //
  // Skip when the run made no progress (errored before any phase ran). Without
  // this guard, a fast-fail run (missing goal file, resume on a stale branch,
  // etc.) commits a "[checkpoint:completion:0] [feature:-]" commit on whatever
  // branch HEAD happens to be — including main — leaving an orphan checkpoint
  // in the tree that has to be hand-rolled back. The skeleton runs/<runId>.json
  // stays in the working tree as untracked dirt; the next legitimate phase
  // commit picks it up cleanly.
  if (!wasStopped && runtimeState.activeProjectDir) {
    try {
      const finalState = await loadState(config.projectDir);
      const cycle = finalState?.cyclesCompleted ?? 0;
      const specDir = finalState?.currentSpecDir ?? null;
      const madeProgress =
        taskPhasesCompleted > 0 ||
        cycle > 0 ||
        (finalState?.lastCompletedStep ?? null) !== null;
      if (!madeProgress) {
        rlog.run("INFO", "run: skipping completion checkpoint — no progress to commit");
      } else {
        const sha = commitCheckpoint(config.projectDir, "completion", cycle, specDir);
        // Intentional: do NOT write state.lastCommit here. The commit already
        // captured state.json (with lastCommit = prior stage's sha); writing
        // the completion sha now would re-dirty the working tree that this
        // very commit was added to clean up. checkGitDrift() forwards
        // lastCommit to HEAD on next load — see state.ts:482-498.
        rlog.run("INFO", `run: completion checkpoint committed`, { sha, cycle });
      }
    } catch (e) {
      rlog.run("WARN", "run: completion checkpoint commit failed", {
        error: (e as Error).message,
      });
    }
  }

  if (runtimeState.releaseLock) {
    runtimeState.releaseLock();
    runtimeState.releaseLock = null;
  }
  runtimeState.activeProjectDir = null;

  let prUrl: string | null = null;
  if (!wasStopped && taskPhasesCompleted > 0 && branchName) {
    rlog.run("INFO", `run: creating PR for branch ${branchName}`);
    prUrl = createPullRequest(
      config.projectDir,
      branchName,
      baseBranch,
      config.mode,
      taskPhasesCompleted,
      totalCost,
      totalDuration,
    );
    rlog.run("INFO", `run: PR created`, { prUrl });
  }

  emit({ type: "run_completed", totalCost, totalDuration, taskPhasesCompleted, branchName, prUrl });
}
