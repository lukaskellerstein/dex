import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RunLogger, fallbackLog as log } from "./log.js";
import { submitUserAnswer, waitForUserInput } from "./userInput.js";
import { createAgentRunner } from "./agent/index.js";
import { loadDexConfig } from "./dexConfig.js";
import type { AgentRunner } from "./agent/AgentRunner.js";
import {
  createContext,
  type OrchestrationContext,
  type RunState,
} from "./context.js";
import { runPrerequisites as runPrerequisitesPhase } from "./stages/prerequisites.js";
import { runClarificationPhase } from "./stages/clarification.js";
import { runMainLoop } from "./stages/main-loop.js";

// Keep submitUserAnswer accessible to IPC callers that import it from this
// module (backwards compatibility — it used to be defined here).
export { submitUserAnswer };
import type {
  EmitFn,
  TaskPhase,
  RunConfig,
  Task,
} from "./types.js";
import { parseTasksFile, deriveTaskPhaseStatus, extractTaskIds, discoverNewSpecDir } from "./parser.js";
import * as runs from "./runs.js";
import {
  getCurrentBranch,
  createBranch,
  createPullRequest,
  createLoopPullRequest,
  getHeadSha,
} from "./git.js";
import {
  checkpointTagFor,
  checkpointDoneTag,
  captureBranchName,
  promoteToCheckpoint,
  autoPromoteIfRecordMode,
  readRecordMode,
  commitCheckpoint,
  readPauseAfterStage,
} from "./checkpoints.js";
import {
  createInitialState,
  saveState,
  loadState,
  clearState,
  updateState,
  hashFile,
  detectStaleState,
  acquireStateLock,
  resolveWorkingTreeConflict,
  reconcileState,
  STEP_ORDER,
} from "./state.js";
import type { DexState } from "./state.js";
import {
  buildProductClarificationPrompt,
  buildTechnicalClarificationPrompt,
  buildClarificationSynthesisPrompt,
  buildManifestExtractionPrompt,
  buildFeatureEvaluationPrompt,
  buildConstitutionPrompt,
  buildSpecifyPrompt,
  buildLoopPlanPrompt,
  buildLoopTasksPrompt,
  buildImplementPrompt,
  buildVerifyPrompt,
  buildVerifyFixPrompt,
  buildLearningsPrompt,
  MANIFEST_SCHEMA,
  GAP_ANALYSIS_SCHEMA,
  VERIFY_SCHEMA,
  LEARNINGS_SCHEMA,
  SYNTHESIS_SCHEMA,
} from "./prompts.js";
import {
  loadManifest,
  saveManifest,
  getNextFeature,
  getActiveFeature,
  updateFeatureStatus,
  updateFeatureSpecDir,
  checkSourceDrift,
  hashFile as hashManifestFile,
  appendLearnings,
} from "./manifest.js";
import type { FeatureManifest } from "./manifest.js";
import type {
  StepType,
  GapAnalysisDecision,
  FailureRecord,
  LoopTermination,
  TerminationReason,
  PrerequisiteCheck,
  PrerequisiteCheckName,
} from "./types.js";

// ── Logging ──
// RunLogger and fallback log moved to ./log.ts so agent runners can share them
// without importing from this orchestrator module (avoids an import cycle).

let abortController: AbortController | null = null;
let activeProjectDir: string | null = null;
let releaseLock: (() => void) | null = null;

/**
 * The agent backend resolved at run start via dex-config.json (or RunConfig.agent
 * override). All runStage/runPhase calls in this module delegate to it.
 * Set to non-null for the duration of a run; cleared on run completion/abort.
 */
let currentRunner: AgentRunner | null = null;

/** Sentinel error thrown when abort is detected between stages to skip remaining work. */
// 011-A4: exported for stages/main-loop.ts. Same circular-but-call-time-safe pattern as runStage.
export class AbortError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "AbortError";
  }
}

// ── Module-level run state (survives renderer reload) ──

// 011-A1: RunState moved to ./context.js (lives alongside OrchestrationContext).
// The legacy aliases below are transitional — every site reads from them today;
// A2-A8 will replace each site with a direct `ctx` parameter as phase functions
// are extracted. The single source of truth at runtime is `currentContext`.
let currentContext: OrchestrationContext | null = null;
let currentRunState: RunState | null = null;

/**
 * Returns the current run state if the orchestrator is actively running.
 * This is the authoritative source — DB rows can be stale from crashes.
 */
export function getRunState(): RunState | null {
  if (!currentContext) return null;
  return currentContext.state;
}

// ── User Input, pricing, step helpers moved to sibling modules ──
// — submitUserAnswer / waitForUserInput → ./userInput.ts
// — MODEL_PRICING / estimateCost / makeStep / toToolCallStep / toToolResultStep /
//   toSubagentInfo / stringifyResponse → ./agent/steps.ts
// They're re-imported at the top of this file.

// ── Spec Discovery ──

// 011-A4: exported for stages/main-loop.ts.
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

function isSpecComplete(projectDir: string, specDir: string): boolean {
  const phases = parseTasksFile(projectDir, specDir);
  return phases.length > 0 && phases.every((p) => p.status === "complete");
}

// ── In-Memory Task State ──

const STATUS_RANK: Record<string, number> = {
  not_done: 0,
  code_exists: 1,
  in_progress: 2,
  done: 3,
};

// 011-A4: exported for stages/main-loop.ts.
export class RunTaskState {
  private phases: TaskPhase[];
  private taskMap: Map<string, Task>;

  constructor(initialPhases: TaskPhase[]) {
    // Deep-clone so mutations don't affect the caller's data
    this.phases = JSON.parse(JSON.stringify(initialPhases));
    this.taskMap = new Map();
    for (const p of this.phases) {
      for (const t of p.tasks) {
        this.taskMap.set(t.id, t);
      }
    }
  }

  /** Apply TodoWrite statuses. Promotes only (never demotes). Returns current phases. */
  updateFromTodoWrite(
    todos: Array<{ content?: string; status?: string }>
  ): TaskPhase[] {
    const updates = new Map<string, "in_progress" | "done">();

    for (const todo of todos) {
      if (!todo.content) continue;
      const ids = extractTaskIds(todo.content);
      const mapped =
        todo.status === "completed" ? "done" : todo.status === "in_progress" ? "in_progress" : null;
      if (!mapped) continue;
      for (const id of ids) {
        updates.set(id, mapped);
      }
    }

    if (updates.size === 0) return this.phases;

    for (const [id, newStatus] of updates) {
      const task = this.taskMap.get(id);
      if (task && STATUS_RANK[newStatus] > STATUS_RANK[task.status]) {
        task.status = newStatus;
      }
    }

    // Re-derive phase statuses
    for (const p of this.phases) {
      p.status = deriveTaskPhaseStatus(p.tasks);
    }

    return this.phases;
  }

  /**
   * Re-read tasks.md from disk and reconcile with in-memory state.
   * Promote-only: a task that is "done" on disk but "not_done" in memory
   * gets promoted. A task that is "done" in memory stays "done" even if
   * disk says otherwise (agent may have used TodoWrite earlier).
   */
  reconcileFromDisk(freshPhases: TaskPhase[]): TaskPhase[] {
    for (const freshPhase of freshPhases) {
      for (const freshTask of freshPhase.tasks) {
        const memTask = this.taskMap.get(freshTask.id);
        if (memTask && STATUS_RANK[freshTask.status] > STATUS_RANK[memTask.status]) {
          memTask.status = freshTask.status;
        }
      }
    }

    for (const p of this.phases) {
      p.status = deriveTaskPhaseStatus(p.tasks);
    }

    return this.phases;
  }

  getPhases(): TaskPhase[] {
    return this.phases;
  }

  getIncompletePhases(filter: "all" | number[]): TaskPhase[] {
    if (filter === "all") {
      return this.phases.filter((p) => p.status !== "complete");
    }
    return this.phases.filter(
      (p) => filter.includes(p.number) && p.status !== "complete"
    );
  }
}

// ── Prompt Builders ──

function buildPrompt(config: RunConfig, phase: TaskPhase): string {
  // Resolve the spec directory to an absolute path so the agent knows exactly
  // which spec to work on (specDir may be relative like "specs/001-product-catalog").
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";

  // The prompt starts with the slash command — the SDK harness expands it
  // as a user invocation (disable-model-invocation only blocks the model
  // from calling the Skill tool on its own, not user-invoked slash commands).
  const afterSteps = config.mode === "plan"
    ? `After analyzing:
- Update ${specPath}/tasks.md with accurate task statuses
- If you learned operational patterns, update CLAUDE.md
- Commit: git add -A -- ':!.dex/' && git commit -m "plan: TaskPhase ${phase.number} gap analysis"`
    : `IMPORTANT — update tasks.md incrementally:
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md before moving to the next task. This drives a real-time progress UI.

After implementing all tasks:
- Run build/typecheck to verify changes compile
- Run tests if they exist
- Commit: git add -A -- ':!.dex/' && git commit -m "Phase ${phase.number}: ${phase.name}"
- If you learned operational patterns, update CLAUDE.md`;

  return `/${skillName} ${specPath} --phase ${phase.number}

${afterSteps}`;
}

// ── Phase Runner ──

// 011-A4: exported for stages/main-loop.ts.
export async function runPhase(
  config: RunConfig,
  phase: TaskPhase,
  agentRunId: string,
  runId: string,
  emit: EmitFn,
  rlog: RunLogger,
  runTaskState: RunTaskState
): Promise<{ cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  if (!currentRunner) {
    throw new Error("runPhase called before currentRunner was resolved — run() must set it");
  }

  const prompt = buildPrompt(config, phase);

  // Delegate SDK invocation to the resolved agent runner. TodoWrite detection
  // stays in the orchestrator via the onTodoWrite callback — runTaskState is
  // orchestrator-owned, not runner-owned.
  return currentRunner.runTaskPhase({
    config,
    prompt,
    runId,
    taskPhase: phase,
    agentRunId,
    abortController,
    emit,
    rlog,
    onTodoWrite: (todos) => {
      const updatedPhases = runTaskState.updateFromTodoWrite(todos);
      emit({ type: "tasks_updated", taskPhases: updatedPhases });
    },
  });
}

// ── Stage Runner (lightweight query() wrapper for loop stages) ──

// 011-A3: exported so extracted stage modules under src/core/stages/ can drive the agent.
// The circular import is safe: both sides export functions only, resolved at call time.
export async function runStage(
  config: RunConfig,
  prompt: string,
  emit: EmitFn,
  rlog: RunLogger,
  runId: string,
  cycleNumber: number,
  stageType: import("./types.js").StepType,
  specDir?: string,
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }
): Promise<{ result: string; structuredOutput: unknown | null; cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  if (!currentRunner) {
    throw new Error("runStage called before currentRunner was resolved — run() must set it");
  }

  // Create a phase record for this stage so steps are persisted
  const agentRunId = crypto.randomUUID();
  runs.startAgentRun(config.projectDir, runId, {
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

  // Keep currentRunState in sync so the renderer can recover after refresh
  if (currentRunState) {
    currentRunState.currentStep = stageType;
    currentRunState.agentRunId = agentRunId;
  }

  emit({
    type: "step_started",
    runId,
    cycleNumber,
    step: stageType,
    agentRunId,
    specDir,
  });

  const isAborted = () => abortController?.signal.aborted ?? false;

  // Delegate the SDK work to the resolved agent runner. Runner is responsible
  // for emitting agent_step events (user_message, tool_call, etc.), returning
  // the final cost/duration/structured output. Orchestrator owns phase-level
  // lifecycle (startPhase/completePhase, stage_started/stage_completed events)
  // and the post-stage checkpoint machinery below.
  const stageResult = await currentRunner.runStep({
    config,
    prompt,
    runId,
    cycleNumber,
    step: stageType,
    agentRunId,
    specDir: specDir ?? null,
    outputFormat,
    abortController,
    emit,
    rlog,
  });
  const { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } = stageResult;

  const stageStatus = isAborted() ? "stopped" : "completed";
  runs.completeAgentRun(config.projectDir, runId, agentRunId, {
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

  // Checkpoint: update state file and commit after each completed stage
  if (!isAborted() && activeProjectDir) {
    try {
      // Only overwrite currentSpecDir when this stage carries one (plan, tasks,
      // implement, …). Specify and clarification stages don't have an input
      // specDir — they'd clobber the active feature pointer with null, which
      // breaks mid-cycle resume.
      await updateState(activeProjectDir, {
        lastCompletedStep: stageType,
        currentCycleNumber: cycleNumber,
        ...(specDir ? { currentSpecDir: specDir } : {}),
      });
      const sha = commitCheckpoint(activeProjectDir, stageType, cycleNumber, specDir ?? null);
      await updateState(activeProjectDir, {
        lastCommit: { sha, timestamp: new Date().toISOString() },
      });

      // Emit stage_candidate for every completed stage; record the candidate
      // on the phase record so downstream UX (cost estimator, DEBUG badge) can
      // reason about it.
      const checkpointTag = checkpointTagFor(stageType, cycleNumber);
      let attemptBranch = "";
      try {
        attemptBranch = getCurrentBranch(activeProjectDir);
      } catch {
        attemptBranch = "";
      }
      try {
        updatePhaseCheckpointInfo(
          activeProjectDir,
          runId,
          agentRunId,
          checkpointTag,
          sha,
        );
      } catch {
        // non-fatal
      }
      emit({
        type: "step_candidate",
        runId,
        cycleNumber,
        step: stageType,
        checkpointTag,
        candidateSha: sha,
        attemptBranch,
      });

      // Record-mode: auto-promote every candidate to canonical.
      await autoPromoteIfRecordMode(activeProjectDir, checkpointTag, sha, runId, emit, rlog);

      // Step mode: pause after every stage awaiting user Keep/Try again.
      // Resume via config.resume=true picks up at the next stage.
      const stepMode = Boolean(config.stepMode) || (await readPauseAfterStage(activeProjectDir));
      if (stepMode) {
        await updateState(activeProjectDir, {
          status: "paused",
          pauseReason: "step_mode",
          pausedAt: new Date().toISOString(),
        });
        emit({
          type: "paused",
          runId,
          reason: "step_mode",
          step: stageType,
        });
        abortController?.abort();
      }
    } catch {
      // Checkpoint failure shouldn't crash the run
    }
  }

  return { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

// readPauseAfterStage moved to src/core/checkpoints/commit.ts as part of 011-A0.

function updatePhaseCheckpointInfo(
  projectDir: string,
  runId: string,
  agentRunId: string,
  checkpointTag: string,
  candidateSha: string,
): void {
  try {
    runs.updateRun(projectDir, runId, (r) => {
      const ph = r.agentRuns.find((p) => p.agentRunId === agentRunId);
      if (!ph) return;
      ph.checkpointTag = checkpointTag;
      ph.candidateSha = candidateSha;
    });
  } catch {
    // non-fatal
  }
}

// ── Build Mode Runner (extracted from run()) ──

async function runBuild(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<{ taskPhasesCompleted: number; totalCost: number }> {
  let taskPhasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  // Determine which specs to process
  const specDirs = config.runAllSpecs
    ? listSpecDirs(config.projectDir).filter(
        (s) => !isSpecComplete(config.projectDir, s)
      )
    : [config.specDir];

  if (specDirs.length === 0) {
    rlog.run("INFO", "runBuild: no unfinished specs found");
    return { taskPhasesCompleted, totalCost };
  }

  rlog.run("INFO", `runBuild: will process ${specDirs.length} spec(s)`, { specDirs });

  for (const specDir of specDirs) {
    if (abortController?.signal.aborted) break;

    const specConfig = { ...config, specDir };

    emit({ type: "spec_started", specDir });
    if (currentRunState) currentRunState.specDir = specDir;
    rlog.run("INFO", `runBuild: starting spec ${specDir}`);

    const initialPhases = parseTasksFile(config.projectDir, specDir);
    const runTaskState = new RunTaskState(initialPhases);

    let iteration = 0;
    let specFailed = false;

    while (iteration < config.maxIterations) {
      if (abortController?.signal.aborted) break;

      const targetPhases = runTaskState.getIncompletePhases(config.taskPhases);

      const phase = targetPhases[0];
      if (!phase) break;

      const agentRunId = crypto.randomUUID();
      runs.startAgentRun(config.projectDir, runId, {
        agentRunId,
        runId,
        specDir,
        taskPhaseNumber: phase.number,
        taskPhaseName: phase.name,
        step: null,
        cycleNumber: null,
        featureSlug: path.basename(specDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });

      rlog.startAgentRun(phase.number, phase.name, agentRunId);
      if (currentRunState) {
        currentRunState.agentRunId = agentRunId;
        currentRunState.taskPhaseNumber = phase.number;
        currentRunState.taskPhaseName = phase.name;
      }
      emit({ type: "task_phase_started", taskPhase: phase, iteration, agentRunId });
      emit({ type: "tasks_updated", taskPhases: runTaskState.getPhases() });

      try {
        const result = await runPhase(specConfig, phase, agentRunId, runId, emit, rlog, runTaskState);

        runs.completeAgentRun(config.projectDir, runId, agentRunId, {
          status: "completed",
          costUsd: result.cost,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens || null,
          outputTokens: result.outputTokens || null,
        });

        taskPhasesCompleted++;
        totalCost += result.cost;

        const freshPhases = parseTasksFile(config.projectDir, specDir);
        const reconciledPhases = runTaskState.reconcileFromDisk(freshPhases);
        emit({ type: "tasks_updated", taskPhases: reconciledPhases });

        emit({
          type: "task_phase_completed",
          taskPhase: { ...phase, status: "complete" },
          cost: result.cost,
          durationMs: result.durationMs,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        rlog.agentRun("ERROR", `Phase ${phase.number} failed: ${message}`, { stack });
        rlog.run("ERROR", `Phase ${phase.number} failed: ${message}`);
        runs.completeAgentRun(config.projectDir, runId, agentRunId, {
          status: "failed",
          costUsd: 0,
          durationMs: Date.now() - runStart,
        });
        emit({
          type: "error",
          message: `Phase ${phase.number} failed: ${message}`,
          taskPhaseNumber: phase.number,
        });
        specFailed = true;
        break;
      }

      iteration++;
    }

    if (!specFailed && !abortController?.signal.aborted) {
      rlog.run("INFO", `runBuild: spec ${specDir} completed`);
      emit({ type: "spec_completed", specDir, taskPhasesCompleted });
    }

    if (specFailed) break;
  }

  return { taskPhasesCompleted, totalCost };
}

// ── Main Entry Point ──

export async function run(config: RunConfig, emit: EmitFn): Promise<void> {
  // Reconcile any prior runs left in "running" state by a previous crash.
  // Mirrors the legacy SQLite cleanupOrphanedRuns behavior.
  try {
    runs.reconcileCrashedRuns(config.projectDir);
  } catch (e) {
    log("WARN", "reconcileCrashedRuns failed", { error: (e as Error).message });
  }
  abortController = new AbortController();

  // For loop mode, defer branch creation to after prerequisites (which may init git).
  // For resume, stay on the current branch — don't create a new one.
  let baseBranch = "";
  let branchName = "";
  if (config.resume) {
    // Resume: stay on current branch (the user is already on the paused run's branch)
    branchName = getCurrentBranch(config.projectDir);
  } else if (config.mode !== "loop") {
    baseBranch = getCurrentBranch(config.projectDir);
    branchName = createBranch(config.projectDir, config.mode);
  }

  // On resume: keep the previous runId so phase_traces from the paused run
  // continue to be associated with the same run in the DB and UI.
  let runId: string = crypto.randomUUID();
  if (config.resume) {
    const prevState = await loadState(config.projectDir);
    if (prevState?.runId) {
      runId = prevState.runId;
    }
  }

  const projectName = path.basename(config.projectDir);
  const rlog = new RunLogger(projectName, runId);
  rlog.run("INFO", `run: ${config.resume ? "resuming" : "starting"} orchestrator`, { mode: config.mode, model: config.model, specDir: config.specDir, branch: branchName || "(deferred)", baseBranch: baseBranch || "(deferred)", runId });

  // Only create a new run record for fresh starts. On resume, the file already exists.
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

  activeProjectDir = config.projectDir;

  // Resolve which agent backend drives this run. Precedence: RunConfig.agent
  // override > .dex/dex-config.json > built-in default ("claude").
  // createAgentRunner throws UnknownAgentError if the name isn't registered;
  // that error surfaces to the caller via the outer try/catch below.
  {
    const dexCfg = loadDexConfig(config.projectDir);
    const agentName = config.agent ?? dexCfg.agent;
    rlog.run("INFO", `run: resolving agent backend`, { agent: agentName, source: config.agent ? "RunConfig" : "dex-config.json" });
    currentRunner = createAgentRunner(agentName, config, config.projectDir);
  }

  // Acquire state lock to prevent concurrent writes
  try {
    releaseLock = await acquireStateLock(config.projectDir);
  } catch (lockErr) {
    // Before bailing with a lock error, surface any stranded variant groups
    // so the UI can prompt the user. This happens when a prior session died
    // mid-fan-out and the user comes back — the emission is informational.
    try {
      const pending = (await import("./checkpoints.js")).readPendingVariantGroups(config.projectDir);
      for (const g of pending) {
        emit({
          type: "variant_group_resume_needed",
          projectDir: config.projectDir,
          groupId: g.groupId,
          step: g.step,
          pendingCount: g.variants.filter((v) => v.status === "pending").length,
          runningCount: g.variants.filter((v) => v.status === "running").length,
        });
      }
    } catch {
      // non-fatal
    }
    emit({ type: "error", message: lockErr instanceof Error ? lockErr.message : String(lockErr) });
    // 011-A1: ctx is not yet built at this point in the lock-failure path —
    // only the raw aliases need clearing.
    abortController = null;
    activeProjectDir = null;
    currentRunner = null;
    return;
  }

  // Create initial state file (unless resuming — state already exists)
  if (!config.resume) {
    const initialState = createInitialState(config, runId, branchName, baseBranch);
    await saveState(config.projectDir, initialState);
  }

  // 008: surface any pending variant groups so the UI can prompt for Continue/Discard.
  try {
    const pending = (await import("./checkpoints.js")).readPendingVariantGroups(config.projectDir);
    for (const g of pending) {
      emit({
        type: "variant_group_resume_needed",
        projectDir: config.projectDir,
        groupId: g.groupId,
        step: g.step,
        pendingCount: g.variants.filter((v) => v.status === "pending").length,
        runningCount: g.variants.filter((v) => v.status === "running").length,
      });
    }
  } catch {
    // non-fatal
  }

  emit({ type: "run_started", config, runId, branchName });

  currentRunState = {
    runId,
    projectDir: config.projectDir,
    specDir: config.specDir,
    mode: config.mode,
    model: config.model,
    agentRunId: "",
    taskPhaseNumber: 0,
    taskPhaseName: "",
  };

  // 011-A1: build the OrchestrationContext now that all dependencies are
  // available. Future extracted phase functions (A2-A7) accept `ctx` and
  // operate purely over its fields. The IPC layer reads `currentContext`
  // for `stopRun` (see src/main/ipc/orchestrator.ts).
  currentContext = createContext({
    abort: abortController!,
    runner: currentRunner!,
    state: currentRunState,
    projectDir: config.projectDir,
    releaseLock: async () => {
      if (releaseLock) releaseLock();
    },
    emit,
    rlog,
  });

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
      const result = await runBuild(config, emit, runId, rlog);
      taskPhasesCompleted = result.taskPhasesCompleted;
      totalCost = result.totalCost;
    }
  } catch (err) {
    // AbortError is expected when the user stops a run — not a real error
    if (!(err instanceof AbortError)) throw err;
  } finally {
    const wasStopped = abortController?.signal.aborted ?? false;
    // 011-A1: drop the OrchestrationContext alongside the legacy aliases.
    currentContext = null;
    abortController = null;
    currentRunState = null;
    currentRunner = null;

    const totalDuration = Date.now() - runStart;
    const finalStatus = wasStopped ? "stopped" : "completed";
    runs.completeRun(config.projectDir, runId, finalStatus, totalCost, totalDuration, taskPhasesCompleted);

    // Update state file: paused if stopped, clear if completed
    if (activeProjectDir) {
      try {
        if (wasStopped) {
          // Preserve pauseReason if step_mode already set it; else default to user_abort.
          const existing = await loadState(activeProjectDir);
          const reason: "user_abort" | "step_mode" | "budget" | "failure" =
            existing?.pauseReason === "step_mode" ? "step_mode" : "user_abort";
          await updateState(activeProjectDir, {
            status: "paused",
            pauseReason: reason,
            pausedAt: new Date().toISOString(),
            cumulativeCostUsd: totalCost,
          });
          emit({ type: "paused", runId, reason });
        } else {
          await updateState(activeProjectDir, { status: "completed" });
        }
      } catch {
        // State write failure shouldn't crash the cleanup
      }
    }

    // Release state lock
    if (releaseLock) {
      releaseLock();
      releaseLock = null;
    }
    activeProjectDir = null;

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
        totalDuration
      );
      rlog.run("INFO", `run: PR created`, { prUrl });
    }

    emit({
      type: "run_completed",
      totalCost,
      totalDuration,
      taskPhasesCompleted,
      branchName,
      prUrl,
    });
  }
}


// ── Loop Mode Runner ──

async function runLoop(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<{ taskPhasesCompleted: number; totalCost: number; baseBranch: string; branchName: string }> {
  // Validate: loop mode requires a GOAL.md input
  const goalPath = config.descriptionFile ?? path.join(config.projectDir, "GOAL.md");
  if (!fs.existsSync(goalPath)) {
    throw new Error(`Loop mode requires GOAL.md at ${goalPath}`);
  }

  // Detect stale state from a different branch or completed run
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

  const clarifiedPath = path.join(config.projectDir, "GOAL_clarified.md");
  let fullPlanPath = "";
  let cumulativeCost = 0;
  let cyclesCompleted = 0;
  const featuresCompleted: string[] = [];
  const featuresSkipped: string[] = [];
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
    // Also persist to state file
    updateState(config.projectDir, {
      failureCounts: { [specDir]: { implFailures: record.implFailures, replanFailures: record.replanFailures } },
    }).catch(() => { /* state write failure shouldn't crash the run */ });
  };

  // ── Determine resume context from state file ──
  let resumeSpecDir: string | null = null;
  let resumeLastStage: string | null = null;
  if (config.resume) {
    // Resolve working-tree vs committed state (crash recovery)
    let savedState = await resolveWorkingTreeConflict(config.projectDir);
    if (!savedState) {
      savedState = await loadState(config.projectDir);
    }

    if (savedState) {
      // Reconcile artifact integrity
      const reconciliation = await reconcileState(config.projectDir, savedState, emit, runId);

      // Apply state patches from reconciliation
      if (Object.keys(reconciliation.statePatches).length > 0) {
        await updateState(config.projectDir, reconciliation.statePatches);
      }

      // Log warnings
      for (const w of reconciliation.warnings) {
        rlog.run("WARN", `runLoop: reconciliation: ${w}`);
      }

      // Restore position from state file
      resumeSpecDir = savedState.currentSpecDir;
      resumeLastStage = savedState.lastCompletedStep;
      cumulativeCost = savedState.cumulativeCostUsd;
      cyclesCompleted = savedState.cyclesCompleted;
      featuresCompleted.push(...savedState.featuresCompleted);
      featuresSkipped.push(...savedState.featuresSkipped);
      fullPlanPath = savedState.fullPlanPath ?? "";

      // Restore failure counts from state file
      for (const [specDir, counts] of Object.entries(savedState.failureCounts)) {
        failureTracker.set(specDir, {
          specDir,
          implFailures: counts.implFailures,
          replanFailures: counts.replanFailures,
        });
      }

      // Use reconciliation resume point if drift was detected
      if (reconciliation.resumeFrom.specDir) {
        resumeSpecDir = reconciliation.resumeFrom.specDir;
      }

      rlog.run("INFO", "runLoop: resuming from state file", {
        resumeSpecDir,
        resumeLastStage,
        cumulativeCost,
        cyclesCompleted,
        drift: reconciliation.driftSummary,
      });
    }
  }

  const isResume = !!config.resume;

  // ── Phase 0: Prerequisites (skip on resume) ──
  if (!isResume) {
    // 011-A2: extracted to src/core/stages/prerequisites.ts. ctx is the
    // single-source-of-truth carrier — see context.ts.
    if (!currentContext) throw new Error("runLoop: prerequisites needs currentContext but it's null");
    await runPrerequisitesPhase(currentContext, runId);
    if (abortController?.signal.aborted) {
      emit({ type: "loop_terminated", runId, termination: { reason: "user_abort", cyclesCompleted: 0, totalCostUsd: 0, totalDurationMs: 0, featuresCompleted: [], featuresSkipped: [] } });
      return { taskPhasesCompleted: 0, totalCost: 0, baseBranch: "", branchName: "" };
    }
  } else {
    rlog.run("INFO", "runLoop: skipping prerequisites (resume)");
    // Emit synthetic events so the UI can reconstruct the stepper state
    emit({ type: "prerequisites_started", runId });
    const prereqTraceId = crypto.randomUUID();
    emit({ type: "step_started", runId, cycleNumber: 0, step: "prerequisites", agentRunId: prereqTraceId });
    emit({ type: "step_completed", runId, cycleNumber: 0, step: "prerequisites", agentRunId: prereqTraceId, costUsd: 0, durationMs: 0 });
    emit({ type: "prerequisites_completed", runId });
  }

  // ── Create git branch (skip on resume — stay on current branch) ──
  let baseBranch: string;
  let branchName: string;
  if (isResume) {
    branchName = getCurrentBranch(config.projectDir);
    // Infer base branch — typically "main" or "master"
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
    // Persist base branch so reconcileState knows the fork point; current branch
    // is derived from git and no longer stored in DexState.
    if (activeProjectDir) {
      await updateState(activeProjectDir, { baseBranch });
    }
  }

  // ── Phase A: Multi-Domain Clarification ──
  // Skip if specs already exist (resume mode) — use existing GOAL_clarified.md
  // Helper to emit a synthetic completed stage event (for skipped stages)
  const emitSkippedStep = (step: import("./types.js").StepType, cycleNum = 0) => {
    const traceId = crypto.randomUUID();
    runs.startAgentRun(config.projectDir, runId, {
      agentRunId: traceId,
      runId,
      specDir: null,
      taskPhaseNumber: cycleNum,
      taskPhaseName: `loop:${step}`,
      step,
      cycleNumber: cycleNum,
      featureSlug: null,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    emit({ type: "step_started", runId, cycleNumber: cycleNum, step, agentRunId: traceId });
    runs.completeAgentRun(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
    emit({ type: "step_completed", runId, cycleNumber: cycleNum, step, agentRunId: traceId, costUsd: 0, durationMs: 0 });
  };

  // ── Phase A: Multi-Domain Clarification (extracted to stages/clarification.ts in 011-A3) ──
  if (!currentContext) throw new Error("runLoop: clarification needs currentContext but it's null");
  {
    const existingSpecsAtStart = listSpecDirs(config.projectDir);
    const result = await runClarificationPhase(currentContext, {
      config,
      runId,
      goalPath,
      clarifiedPath,
      existingSpecsAtStart,
      seedCumulativeCost: cumulativeCost,
    });
    fullPlanPath = result.fullPlanPath;
    cumulativeCost = result.cumulativeCost;
  }

  // ── Manifest Extraction (one-time after clarification) ──

  let manifest = loadManifest(config.projectDir);
  if (!manifest) {
    type ManifestExtraction = { features: Array<{ id: number; title: string; description: string }> };
    let extracted: ManifestExtraction | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const prompt = buildManifestExtractionPrompt(fullPlanPath);
        const result = await runStage(
          config, prompt, emit, rlog, runId, 0,
          "manifest_extraction", undefined,
          { type: "json_schema", schema: MANIFEST_SCHEMA as unknown as Record<string, unknown> }
        );
        cumulativeCost += result.cost;
        extracted = result.structuredOutput as ManifestExtraction | null;
        if (!extracted) {
          rlog.run("WARN", `Manifest extraction attempt ${attempt}: structured_output was null`);
          if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — structured output was null. Check GOAL_clarified.md format.");
          continue;
        }
        if (!extracted.features?.length) {
          rlog.run("WARN", `Manifest extraction attempt ${attempt}: empty features array`);
          if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — extracted zero features. Check GOAL_clarified.md format.");
          continue;
        }
        break;
      } catch (err) {
        rlog.run("ERROR", `Manifest extraction attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check GOAL_clarified.md format.");
      }
    }
    manifest = {
      version: 1,
      sourceHash: hashManifestFile(fullPlanPath),
      features: extracted!.features.map((f) => ({
        ...f,
        status: "pending" as const,
        specDir: null,
      })),
    };
    saveManifest(config.projectDir, manifest);
    emit({ type: "manifest_created", runId, featureCount: manifest.features.length });
    rlog.run("INFO", `runLoop: manifest created with ${manifest.features.length} features`);
  } else if (checkSourceDrift(config.projectDir, manifest, fullPlanPath)) {
    rlog.run("WARN", "GOAL_clarified.md has changed since manifest was created");
    emit({ type: "manifest_drift_detected", runId });
  }

  // ── Phase B: Autonomous Loop (extracted to stages/main-loop.ts in 011-A4) ──
  if (!currentContext) throw new Error("runLoop: main loop needs currentContext but it's null");
  const mainLoopResult = await runMainLoop(currentContext, {
    config,
    runId,
    fullPlanPath,
    cyclesCompletedSeed: cyclesCompleted,
    cumulativeCostSeed: cumulativeCost,
    featuresCompletedSeed: featuresCompleted,
    featuresSkippedSeed: featuresSkipped,
    resumeSpecDir,
    resumeLastStage,
  });
  cyclesCompleted = mainLoopResult.cyclesCompleted;
  cumulativeCost = mainLoopResult.cumulativeCost;
  featuresCompleted.length = 0;
  featuresCompleted.push(...mainLoopResult.featuresCompleted);
  featuresSkipped.length = 0;
  featuresSkipped.push(...mainLoopResult.featuresSkipped);
  const terminationReason = mainLoopResult.termination.reason;
  // (loop_terminated is emitted inside runMainLoop; record-mode tagging below.)

  // 008 Record-mode termination — tag checkpoint/done-<slice> and push capture/ anchor.
  // Only when termination is a genuine finish (gaps_complete or cycles) and record-mode is on.
  if (activeProjectDir && terminationReason !== "user_abort") {
    const recordMode = process.env.DEX_RECORD_MODE === "1" || (await readRecordMode(activeProjectDir));
    if (recordMode) {
      try {
        const finalSha = getHeadSha(activeProjectDir);
        const doneTag = checkpointDoneTag(runId);
        const promoteResult = promoteToCheckpoint(activeProjectDir, doneTag, finalSha, rlog);
        if (promoteResult.ok) {
          emit({ type: "checkpoint_promoted", runId, checkpointTag: doneTag, sha: finalSha });
        }
        execSync(
          `git branch -f ${captureBranchName(runId)} HEAD`,
          { cwd: activeProjectDir, encoding: "utf-8" },
        );
      } catch (err) {
        rlog.run("WARN", `record-mode termination tagging failed: ${String(err)}`);
      }
    }
  }

  return { taskPhasesCompleted: cyclesCompleted, totalCost: cumulativeCost, baseBranch, branchName };
}

export function stopRun(): void {
  // 011-A1: read the abort handle from currentContext when available, falling
  // back to the legacy alias for the brief window before/after a run lifecycle.
  const abort = currentContext?.abort ?? abortController;
  if (abort) {
    console.log("[stopRun] abort signal sent to orchestrator");
    abort.abort();
  } else {
    console.log("[stopRun] called but no active context");
  }
}
