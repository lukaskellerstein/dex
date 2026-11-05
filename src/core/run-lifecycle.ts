/**
 * What: Run-level setup and teardown helpers — `initRun` does the bootstrap (crash-recovery, branch resolution, runId/rlog, runs-table init, agent-runner resolution, state-lock acquisition, initial state file, ctx construction); `finalizeRun` does the teardown (status persistence, lock release, PR creation, run_completed emit). The mutable `runtimeState` bag holds the bridge globals (currentContext, abortController, releaseLock, …) so orchestrator.ts and other modules can read them without circular setters.
 * Not: Does not own the per-mode dispatch (run() in orchestrator.ts decides loop vs build). Does not run the actual phases (those are stages/*).
 * Deps: createContext (context.ts), runs.* (audit init/finalize), git.{getCurrentBranch, createBranch, createPullRequest}, state.{loadState, saveState, updateState, createInitialState, acquireStateLock}, agent.createAgentRunner (named-runner dispatch), dexConfig.loadDexConfig, log.{RunLogger, fallbackLog}.
 */

import crypto from "node:crypto";
import path from "node:path";
import { assertEntrySensors } from "./acceptance.js";
import type { AgentRunner } from "./agent/AgentRunner.js";
import { createAgentRunner } from "./agent/index.js";
import { createContext, type OrchestrationContext, type RunState } from "./context.js";
import { loadDexConfig } from "./dexConfig.js";
import { createBranch, createPullRequest, getCurrentBranch } from "./git.js";
import { clearStaleRequests, waitingFor } from "./humanInput.js";
import { fallbackLog as log, RunLogger } from "./log.js";
import { loadPolicy, type Policy, type QueueKind } from "./policy.js";
import { loadQueue, type QueueV3, queuePath } from "./queue.js";
import * as runs from "./runs.js";
import {
  acquireStateLock,
  createInitialState,
  ensureRuntimeIgnore,
  loadState,
  mutateState,
  saveState,
} from "./state.js";
import type { EmitFn, RunConfig, TerminationReason } from "./types.js";

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
  /** True when a v2 run state was found and this run continues it. */
  resumed: boolean;
}

interface ProjectRules {
  queue: QueueV3 | null;
  kind: QueueKind;
  policy: Policy;
}

/**
 * The queue, its kind and the project's policy. An invalid queue or policy, or
 * a refused one, emits `error` with the file and the reason and returns null:
 * Dex refuses to start (FR-014).
 */
function readProjectRules(config: RunConfig, emit: EmitFn): ProjectRules | null {
  try {
    const queue = loadQueue(config.projectDir);
    const kind = queue?.kind ?? (config.mode === "loop" ? "new" : "existing");
    const policy = loadPolicy(config.projectDir, kind);
    if (queue) assertEntrySensors(queue, policy, queuePath(config.projectDir));
    return { queue, kind, policy };
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ── initRun ────────────────────────────────────────────────────────────────

export async function initRun(config: RunConfig, emit: EmitFn): Promise<InitResult | null> {
  const rules = readProjectRules(config, emit);
  if (!rules) return null;
  // Reconcile any prior runs left "running" by a previous crash.
  try {
    runs.reconcileCrashedRuns(config.projectDir);
  } catch (e) {
    log("WARN", "reconcileCrashedRuns failed", { error: (e as Error).message });
  }
  // An existing project gets .dex/.gitignore from `dex queue init`; Dex writes
  // nothing there during a run, and a new file would make the tree dirty.
  if (rules.kind === "new") {
    try {
      ensureRuntimeIgnore(config.projectDir);
    } catch (e) {
      log("WARN", "ensureRuntimeIgnore failed", { error: (e as Error).message });
    }
  }
  runtimeState.abortController = new AbortController();

  // Branch resolution. Loop mode defers branch creation until after
  // prerequisites (which may init git); resume keeps the current branch, and
  // build mode makes a branch only for a project Dex created (FR-007).
  let baseBranch = "";
  let branchName = "";
  if (config.resume || (config.mode !== "loop" && rules.kind === "existing")) {
    branchName = getCurrentBranch(config.projectDir);
  } else if (config.mode !== "loop") {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir);
  }

  // Resume preserves the previous runId so phase traces stay associated. A
  // state file of another version reads as absent: the run starts fresh.
  const prev = config.resume ? await loadState(config.projectDir) : null;
  const resumed = prev !== null;
  const runId: string = prev?.runId ?? crypto.randomUUID();

  const rlog = new RunLogger(path.basename(config.projectDir), runId);
  rlog.run("INFO", `run: ${resumed ? "resuming" : "starting"} orchestrator`, {
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
  const runRecordExists = resumed ? runs.readRun(config.projectDir, runId) !== null : false;
  if (!resumed || !runRecordExists) {
    if (resumed) {
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
      maxBudgetUsd: rules.policy.limits.maxBudgetUsdPerRun ?? null,
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

  if (resumed) {
    // Resume is the answer to every pause, and no agent waits yet: drop every
    // pending request and run the picker again.
    mutateState(config.projectDir, (s) => ({
      ...s,
      status: "running",
      pauseReason: undefined,
      pauseDetail: undefined,
      pausedAt: null,
    }));
    clearStaleRequests(config.projectDir);
  } else {
    await saveState(
      config.projectDir,
      createInitialState(config, runId, { kind: rules.kind, runBranch: null }),
    );
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
    kind: rules.kind,
    policy: rules.policy,
  });
  runtimeState.currentContext = ctx;

  return { runId, rlog, ctx, branchName, baseBranch, resumed };
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
  /** How the loop ended; absent in build mode. */
  termination?: TerminationReason;
  /** `policy.openPullRequest`: push and open a PR for a finished run (FR-011, off by default). */
  openPullRequest: boolean;
}

/** The run state a finished run leaves behind. A loop pause already wrote its own reason. */
function stateStatusAtEnd(
  termination: TerminationReason | undefined,
  wasStopped: boolean,
): "completed" | "failed" | "paused" | "keep" {
  if (termination === "paused") return "keep";
  if (termination === "failed") return "failed";
  if (wasStopped || termination === "user_abort" || termination === "budget_exceeded")
    return "paused";
  return "completed";
}

export async function finalizeRun(args: FinalizeArgs): Promise<void> {
  const {
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
    openPullRequest,
  } = args;
  // A run that pauses because no human can answer (`dex run` without a TTY)
  // is not a Stop: its record says paused, and the state names what it waits for.
  const signal = runtimeState.abortController?.signal;
  const waitFor = waitingFor(signal);
  const wasStopped = (signal?.aborted ?? false) && waitFor === null;

  // Drop ctx + bridge aliases.
  runtimeState.currentContext = null;
  runtimeState.abortController = null;
  runtimeState.currentRunState = null;
  runtimeState.currentRunner = null;

  const totalDuration = Date.now() - runStart;
  const status = stateStatusAtEnd(termination, wasStopped);
  // The run record tells a finished run from a resumable one (the renderer's history view reads it).
  const recordStatus = wasStopped
    ? "stopped"
    : status === "keep" || status === "paused"
      ? "paused"
      : status;
  runs.completeRun(
    config.projectDir,
    runId,
    recordStatus,
    totalCost,
    totalDuration,
    taskPhasesCompleted,
  );

  const projectDir = runtimeState.activeProjectDir;
  if (projectDir && status !== "keep") {
    try {
      const pausedAt = new Date().toISOString();
      const reason =
        waitFor ?? (termination === "budget_exceeded" ? "limit_reached" : "user_abort");
      mutateState(projectDir, (s) =>
        status === "paused" ? { ...s, status, pauseReason: reason, pausedAt } : { ...s, status },
      );
      if (status === "paused") emit({ type: "paused", runId, reason });
    } catch {
      // non-fatal — state write failure shouldn't crash cleanup
    }
  }

  if (runtimeState.releaseLock) {
    runtimeState.releaseLock();
    runtimeState.releaseLock = null;
  }
  runtimeState.activeProjectDir = null;

  // A PR only when the policy asks for one, for a finished run with a base to
  // compare against: a paused or failed loop resumes on the same branch.
  const finished = termination === undefined || termination === "queue_complete";
  let prUrl: string | null = null;
  if (
    openPullRequest &&
    !wasStopped &&
    finished &&
    taskPhasesCompleted > 0 &&
    branchName &&
    baseBranch
  ) {
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
