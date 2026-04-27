/**
 * What: Run-level setup and teardown helpers — `initRun` does the bootstrap (crash-recovery, branch resolution, runId/rlog, runs-table init, agent-runner resolution, state-lock acquisition, initial state file, variant-group emission, ctx construction); `finalizeRun` does the teardown (status persistence, lock release, PR creation, run_completed emit). The mutable `runtimeState` bag holds the bridge globals (currentContext, abortController, releaseLock, …) so orchestrator.ts and other modules can read them without circular setters.
 * Not: Does not own the per-mode dispatch (run() in orchestrator.ts decides loop vs build). Does not own lock-failure variant emission semantics — that's a one-shot inside initRun's lock catch path. Does not run the actual phases (those are stages/*).
 * Deps: createContext (context.ts), runs.* (audit init/finalize), git.{getCurrentBranch, createBranch, createPullRequest}, state.{loadState, saveState, updateState, createInitialState, acquireStateLock}, agent.createAgentRunner, dexConfig.loadDexConfig, log.{RunLogger, fallbackLog}.
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

  if (!config.resume) {
    runs.startRun(config.projectDir, {
      runId,
      mode: config.mode,
      model: config.model,
      specDir: config.specDir,
      startedAt: new Date().toISOString(),
      status: "running",
      writerPid: process.pid,
      description: null,
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
    source: config.agent ? "RunConfig" : "dex-config.json",
  });
  runtimeState.currentRunner = createAgentRunner(agentName, config, config.projectDir);

  // Acquire state lock.
  try {
    runtimeState.releaseLock = await acquireStateLock(config.projectDir);
  } catch (lockErr) {
    await emitPendingVariantGroups(config.projectDir, emit);
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

  await emitPendingVariantGroups(config.projectDir, emit);

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

// ── Helper: emit any pending variant groups so the UI can prompt resume ────

async function emitPendingVariantGroups(projectDir: string, emit: EmitFn): Promise<void> {
  try {
    const checkpoints = await import("./checkpoints.js");
    const pending = checkpoints.readPendingVariantGroups(projectDir);
    for (const g of pending) {
      emit({
        type: "variant_group_resume_needed",
        projectDir,
        groupId: g.groupId,
        step: g.step,
        pendingCount: g.variants.filter((v) => v.status === "pending").length,
        runningCount: g.variants.filter((v) => v.status === "running").length,
      });
    }
  } catch {
    // non-fatal
  }
}
