import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RunLogger, fallbackLog as log } from "./log.js";
import { submitUserAnswer, waitForUserInput } from "./userInput.js";
import { createAgentRunner } from "./agent/index.js";
import { loadDexConfig } from "./dexConfig.js";
import type { AgentRunner } from "./agent/AgentRunner.js";

// Keep submitUserAnswer accessible to IPC callers that import it from this
// module (backwards compatibility — it used to be defined here).
export { submitUserAnswer };
import type {
  EmitFn,
  Phase,
  RunConfig,
  Task,
} from "./types.js";
import { parseTasksFile, derivePhaseStatus, extractTaskIds, discoverNewSpecDir } from "./parser.js";
import * as runs from "./runs.js";
import {
  getCurrentBranch,
  createBranch,
  createPullRequest,
  createLoopPullRequest,
  commitCheckpoint,
  getHeadSha,
} from "./git.js";
import {
  checkpointTagFor,
  checkpointDoneTag,
  captureBranchName,
  promoteToCheckpoint,
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
  STAGE_ORDER,
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
  LoopStageType,
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
class AbortError extends Error {
  constructor() {
    super("Run stopped by user");
    this.name = "AbortError";
  }
}

// ── Module-level run state (survives renderer reload) ──

interface RunState {
  runId: string;
  projectDir: string;
  specDir: string;
  mode: string;
  model: string;
  phaseTraceId: string;
  phaseNumber: number;
  phaseName: string;
  // Loop-mode fields
  currentCycle?: number;
  currentStage?: LoopStageType;
  isClarifying?: boolean;
  loopsCompleted?: number;
}

let currentRunState: RunState | null = null;

/**
 * Returns the current run state if the orchestrator is actively running.
 * This is the authoritative source — DB rows can be stale from crashes.
 */
export function getRunState(): RunState | null {
  if (!abortController) return null;
  return currentRunState;
}

// ── User Input, pricing, step helpers moved to sibling modules ──
// — submitUserAnswer / waitForUserInput → ./userInput.ts
// — MODEL_PRICING / estimateCost / makeStep / toToolCallStep / toToolResultStep /
//   toSubagentInfo / stringifyResponse → ./agent/steps.ts
// They're re-imported at the top of this file.

// ── Spec Discovery ──

function listSpecDirs(projectDir: string): string[] {
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

class RunTaskState {
  private phases: Phase[];
  private taskMap: Map<string, Task>;

  constructor(initialPhases: Phase[]) {
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
  ): Phase[] {
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
      p.status = derivePhaseStatus(p.tasks);
    }

    return this.phases;
  }

  /**
   * Re-read tasks.md from disk and reconcile with in-memory state.
   * Promote-only: a task that is "done" on disk but "not_done" in memory
   * gets promoted. A task that is "done" in memory stays "done" even if
   * disk says otherwise (agent may have used TodoWrite earlier).
   */
  reconcileFromDisk(freshPhases: Phase[]): Phase[] {
    for (const freshPhase of freshPhases) {
      for (const freshTask of freshPhase.tasks) {
        const memTask = this.taskMap.get(freshTask.id);
        if (memTask && STATUS_RANK[freshTask.status] > STATUS_RANK[memTask.status]) {
          memTask.status = freshTask.status;
        }
      }
    }

    for (const p of this.phases) {
      p.status = derivePhaseStatus(p.tasks);
    }

    return this.phases;
  }

  getPhases(): Phase[] {
    return this.phases;
  }

  getIncompletePhases(filter: "all" | number[]): Phase[] {
    if (filter === "all") {
      return this.phases.filter((p) => p.status !== "complete");
    }
    return this.phases.filter(
      (p) => filter.includes(p.number) && p.status !== "complete"
    );
  }
}

// ── Prompt Builders ──

function buildPrompt(config: RunConfig, phase: Phase): string {
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
- Commit: git add -A -- ':!.dex/' && git commit -m "plan: Phase ${phase.number} gap analysis"`
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

async function runPhase(
  config: RunConfig,
  phase: Phase,
  phaseTraceId: string,
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
  return currentRunner.runPhase({
    config,
    prompt,
    runId,
    phase,
    phaseTraceId,
    abortController,
    emit,
    rlog,
    onTodoWrite: (todos) => {
      const updatedPhases = runTaskState.updateFromTodoWrite(todos);
      emit({ type: "tasks_updated", phases: updatedPhases });
    },
  });
}

// ── Stage Runner (lightweight query() wrapper for loop stages) ──

async function runStage(
  config: RunConfig,
  prompt: string,
  emit: EmitFn,
  rlog: RunLogger,
  runId: string,
  cycleNumber: number,
  stageType: import("./types.js").LoopStageType,
  specDir?: string,
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }
): Promise<{ result: string; structuredOutput: unknown | null; cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  if (!currentRunner) {
    throw new Error("runStage called before currentRunner was resolved — run() must set it");
  }

  // Create a phase record for this stage so steps are persisted
  const phaseTraceId = crypto.randomUUID();
  runs.startPhase(config.projectDir, runId, {
    phaseTraceId,
    runId,
    specDir: specDir ?? null,
    phaseNumber: cycleNumber,
    phaseName: `loop:${stageType}`,
    stage: stageType,
    cycleNumber,
    featureSlug: specDir ? path.basename(specDir) : null,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  rlog.startPhase(cycleNumber, stageType, phaseTraceId);
  rlog.phase("INFO", `runStage: ${stageType} for cycle ${cycleNumber}`);

  // Keep currentRunState in sync so the renderer can recover after refresh
  if (currentRunState) {
    currentRunState.currentStage = stageType;
    currentRunState.phaseTraceId = phaseTraceId;
  }

  emit({
    type: "stage_started",
    runId,
    cycleNumber,
    stage: stageType,
    phaseTraceId,
    specDir,
  });

  const isAborted = () => abortController?.signal.aborted ?? false;

  // Delegate the SDK work to the resolved agent runner. Runner is responsible
  // for emitting agent_step events (user_message, tool_call, etc.), returning
  // the final cost/duration/structured output. Orchestrator owns phase-level
  // lifecycle (startPhase/completePhase, stage_started/stage_completed events)
  // and the post-stage checkpoint machinery below.
  const stageResult = await currentRunner.runStage({
    config,
    prompt,
    runId,
    cycleNumber,
    stage: stageType,
    phaseTraceId,
    specDir: specDir ?? null,
    outputFormat,
    abortController,
    emit,
    rlog,
  });
  const { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens } = stageResult;

  const stageStatus = isAborted() ? "stopped" : "completed";
  runs.completePhase(config.projectDir, runId, phaseTraceId, {
    status: stageStatus,
    costUsd: totalCost,
    durationMs,
    inputTokens: totalInputTokens || null,
    outputTokens: totalOutputTokens || null,
  });

  emit({
    type: "stage_completed",
    runId,
    cycleNumber,
    stage: stageType,
    phaseTraceId,
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
        lastCompletedStage: stageType,
        currentCycleNumber: cycleNumber,
        ...(specDir ? { currentSpecDir: specDir } : {}),
      });
      const sha = commitCheckpoint(activeProjectDir, stageType, cycleNumber, specDir ?? null, totalCost);
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
          phaseTraceId,
          checkpointTag,
          sha,
        );
      } catch {
        // non-fatal
      }
      emit({
        type: "stage_candidate",
        runId,
        cycleNumber,
        stage: stageType,
        checkpointTag,
        candidateSha: sha,
        attemptBranch,
      });

      // Record-mode: auto-promote every candidate to canonical.
      const recordMode = process.env.DEX_RECORD_MODE === "1" || (await readRecordMode(activeProjectDir));
      if (recordMode) {
        const result = promoteToCheckpoint(activeProjectDir, checkpointTag, sha, rlog);
        if (result.ok) {
          emit({ type: "checkpoint_promoted", runId, checkpointTag, sha });
        }
      }

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
          stage: stageType,
        });
        abortController?.abort();
      }
    } catch {
      // Checkpoint failure shouldn't crash the run
    }
  }

  return { result: resultText, structuredOutput, cost: totalCost, durationMs, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

async function readPauseAfterStage(projectDir: string): Promise<boolean> {
  try {
    const s = await loadState(projectDir);
    return Boolean(s?.ui?.pauseAfterStage);
  } catch {
    return false;
  }
}

async function readRecordMode(projectDir: string): Promise<boolean> {
  try {
    const s = await loadState(projectDir);
    return Boolean(s?.ui?.recordMode);
  } catch {
    return false;
  }
}

function updatePhaseCheckpointInfo(
  projectDir: string,
  runId: string,
  phaseTraceId: string,
  checkpointTag: string,
  candidateSha: string,
): void {
  try {
    runs.updateRun(projectDir, runId, (r) => {
      const ph = r.phases.find((p) => p.phaseTraceId === phaseTraceId);
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
): Promise<{ phasesCompleted: number; totalCost: number }> {
  let phasesCompleted = 0;
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
    return { phasesCompleted, totalCost };
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

      const targetPhases = runTaskState.getIncompletePhases(config.phases);

      const phase = targetPhases[0];
      if (!phase) break;

      const phaseTraceId = crypto.randomUUID();
      runs.startPhase(config.projectDir, runId, {
        phaseTraceId,
        runId,
        specDir,
        phaseNumber: phase.number,
        phaseName: phase.name,
        stage: null,
        cycleNumber: null,
        featureSlug: path.basename(specDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });

      rlog.startPhase(phase.number, phase.name, phaseTraceId);
      if (currentRunState) {
        currentRunState.phaseTraceId = phaseTraceId;
        currentRunState.phaseNumber = phase.number;
        currentRunState.phaseName = phase.name;
      }
      emit({ type: "phase_started", phase, iteration, phaseTraceId });
      emit({ type: "tasks_updated", phases: runTaskState.getPhases() });

      try {
        const result = await runPhase(specConfig, phase, phaseTraceId, runId, emit, rlog, runTaskState);

        runs.completePhase(config.projectDir, runId, phaseTraceId, {
          status: "completed",
          costUsd: result.cost,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens || null,
          outputTokens: result.outputTokens || null,
        });

        phasesCompleted++;
        totalCost += result.cost;

        const freshPhases = parseTasksFile(config.projectDir, specDir);
        const reconciledPhases = runTaskState.reconcileFromDisk(freshPhases);
        emit({ type: "tasks_updated", phases: reconciledPhases });

        emit({
          type: "phase_completed",
          phase: { ...phase, status: "complete" },
          cost: result.cost,
          durationMs: result.durationMs,
        });
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        rlog.phase("ERROR", `Phase ${phase.number} failed: ${message}`, { stack });
        rlog.run("ERROR", `Phase ${phase.number} failed: ${message}`);
        runs.completePhase(config.projectDir, runId, phaseTraceId, {
          status: "failed",
          costUsd: 0,
          durationMs: Date.now() - runStart,
        });
        emit({
          type: "error",
          message: `Phase ${phase.number} failed: ${message}`,
          phaseNumber: phase.number,
        });
        specFailed = true;
        break;
      }

      iteration++;
    }

    if (!specFailed && !abortController?.signal.aborted) {
      rlog.run("INFO", `runBuild: spec ${specDir} completed`);
      emit({ type: "spec_completed", specDir, phasesCompleted });
    }

    if (specFailed) break;
  }

  return { phasesCompleted, totalCost };
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
          stage: g.stage,
          pendingCount: g.variants.filter((v) => v.status === "pending").length,
          runningCount: g.variants.filter((v) => v.status === "running").length,
        });
      }
    } catch {
      // non-fatal
    }
    emit({ type: "error", message: lockErr instanceof Error ? lockErr.message : String(lockErr) });
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
        stage: g.stage,
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
    phaseTraceId: "",
    phaseNumber: 0,
    phaseName: "",
  };

  let phasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  try {
    if (config.mode === "loop") {
      const result = await runLoop(config, emit, runId, rlog);
      phasesCompleted = result.phasesCompleted;
      totalCost = result.totalCost;
      // Branch was created inside runLoop after prerequisites
      baseBranch = result.baseBranch;
      branchName = result.branchName;
    } else {
      const result = await runBuild(config, emit, runId, rlog);
      phasesCompleted = result.phasesCompleted;
      totalCost = result.totalCost;
    }
  } catch (err) {
    // AbortError is expected when the user stops a run — not a real error
    if (!(err instanceof AbortError)) throw err;
  } finally {
    const wasStopped = abortController?.signal.aborted ?? false;
    abortController = null;
    currentRunState = null;
    currentRunner = null;

    const totalDuration = Date.now() - runStart;
    const finalStatus = wasStopped ? "stopped" : "completed";
    runs.completeRun(config.projectDir, runId, finalStatus, totalCost, totalDuration, phasesCompleted);

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
    if (!wasStopped && phasesCompleted > 0 && branchName) {
      rlog.run("INFO", `run: creating PR for branch ${branchName}`);
      prUrl = createPullRequest(
        config.projectDir,
        branchName,
        baseBranch,
        config.mode,
        phasesCompleted,
        totalCost,
        totalDuration
      );
      rlog.run("INFO", `run: PR created`, { prUrl });
    }

    emit({
      type: "run_completed",
      totalCost,
      totalDuration,
      phasesCompleted,
      branchName,
      prUrl,
    });
  }
}

// ── Prerequisites Check ──

function isCommandOnPath(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execSync(`${whichCmd} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getScriptType(): "sh" | "ps" {
  return process.platform === "win32" ? "ps" : "sh";
}

async function runPrerequisites(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<void> {
  rlog.run("INFO", "runPrerequisites: starting prerequisites checks");
  emit({ type: "prerequisites_started", runId });

  // Create a phase record so the stage appears in preCycleStages
  const phaseTraceId = crypto.randomUUID();
  runs.startPhase(config.projectDir, runId, {
    phaseTraceId,
    runId,
    specDir: null,
    phaseNumber: 0,
    phaseName: "loop:prerequisites",
    stage: "prerequisites",
    cycleNumber: 0,
    featureSlug: null,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  emit({
    type: "stage_started",
    runId,
    cycleNumber: 0,
    stage: "prerequisites",
    phaseTraceId,
  });

  const startTime = Date.now();

  const emitCheck = (check: PrerequisiteCheck) => {
    emit({ type: "prerequisites_check", runId, check });
  };

  // Track final status of each check
  const checkResults = new Map<PrerequisiteCheckName, "pass" | "fail" | "fixed">();

  // ── Check 1: Claude CLI ──
  emitCheck({ name: "claude_cli", status: "running" });
  let claudeOk = isCommandOnPath("claude");
  if (claudeOk) {
    rlog.run("INFO", "runPrerequisites: claude CLI found");
    emitCheck({ name: "claude_cli", status: "pass" });
    checkResults.set("claude_cli", "pass");
  } else {
    rlog.run("WARN", "runPrerequisites: claude CLI not found");
    emitCheck({ name: "claude_cli", status: "fail", message: "Claude Code CLI not found on PATH" });

    let resolved = false;
    while (!resolved) {
      if (abortController?.signal.aborted) return;
      const answers = await waitForUserInput(config.projectDir, emit, runId, [{
        question: "Claude Code CLI is not installed or not on your PATH. Please install it and try again.",
        header: "Missing: Claude CLI",
        options: [
          { label: "I've installed it — check again", description: "Re-run the check after you've installed Claude Code" },
          { label: "Skip this check", description: "Proceed without verifying (not recommended)" },
        ],
        multiSelect: false,
      }]);
      const answer = Object.values(answers)[0];
      if (answer === "Skip this check") {
        emitCheck({ name: "claude_cli", status: "fixed", message: "Skipped by user" });
        checkResults.set("claude_cli", "fixed");
        resolved = true;
      } else {
        claudeOk = isCommandOnPath("claude");
        if (claudeOk) {
          emitCheck({ name: "claude_cli", status: "pass" });
          checkResults.set("claude_cli", "pass");
          resolved = true;
        } else {
          emitCheck({ name: "claude_cli", status: "fail", message: "Still not found — please check your PATH" });
        }
      }
    }
  }

  // ── Check 2: Specify CLI ──
  emitCheck({ name: "specify_cli", status: "running" });
  let specifyOk = isCommandOnPath("specify");
  if (specifyOk) {
    rlog.run("INFO", "runPrerequisites: specify CLI found");
    emitCheck({ name: "specify_cli", status: "pass" });
    checkResults.set("specify_cli", "pass");
  } else {
    rlog.run("WARN", "runPrerequisites: specify CLI not found");
    emitCheck({ name: "specify_cli", status: "fail", message: "Spec-Kit CLI not found on PATH" });

    let resolved = false;
    while (!resolved) {
      if (abortController?.signal.aborted) return;
      const answers = await waitForUserInput(config.projectDir, emit, runId, [{
        question: "Spec-Kit CLI (specify) is not installed. Install it with:\n\nuv tool install specify-cli --from git+https://github.com/github/spec-kit.git\n\nThen try again.",
        header: "Missing: Spec-Kit CLI",
        options: [
          { label: "I've installed it — check again", description: "Re-run the check after you've installed spec-kit" },
          { label: "Skip this check", description: "Proceed without spec-kit (the loop will likely fail)" },
        ],
        multiSelect: false,
      }]);
      const answer = Object.values(answers)[0];
      if (answer === "Skip this check") {
        emitCheck({ name: "specify_cli", status: "fixed", message: "Skipped by user" });
        checkResults.set("specify_cli", "fixed");
        resolved = true;
      } else {
        specifyOk = isCommandOnPath("specify");
        if (specifyOk) {
          emitCheck({ name: "specify_cli", status: "pass" });
          checkResults.set("specify_cli", "pass");
          resolved = true;
        } else {
          emitCheck({ name: "specify_cli", status: "fail", message: "Still not found — please check your PATH" });
        }
      }
    }
  }

  // ── Check 3: Git repository ──
  emitCheck({ name: "git_init", status: "running" });
  const gitDir = path.join(config.projectDir, ".git");
  if (fs.existsSync(gitDir)) {
    rlog.run("INFO", "runPrerequisites: git repo already exists");
    emitCheck({ name: "git_init", status: "pass" });
    checkResults.set("git_init", "pass");
  } else {
    rlog.run("INFO", "runPrerequisites: initializing git repo");
    try {
      execSync("git init", {
        cwd: config.projectDir,
        stdio: "pipe",
        timeout: 15_000,
      });
      if (fs.existsSync(gitDir)) {
        rlog.run("INFO", "runPrerequisites: git init succeeded");
        emitCheck({ name: "git_init", status: "pass" });
        checkResults.set("git_init", "pass");
      } else {
        rlog.run("WARN", "runPrerequisites: git init ran but .git/ not found");
        emitCheck({ name: "git_init", status: "fail", message: "git init ran but .git/ directory was not created" });
        checkResults.set("git_init", "fail");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rlog.run("ERROR", "runPrerequisites: git init failed", { error: msg });
      emitCheck({ name: "git_init", status: "fail", message: `git init failed: ${msg}` });
      checkResults.set("git_init", "fail");
    }
  }

  // ── Check 4: Spec-Kit initialized in project ──
  emitCheck({ name: "speckit_init", status: "running" });
  const integrationJson = path.join(config.projectDir, ".specify", "integration.json");
  if (fs.existsSync(integrationJson)) {
    rlog.run("INFO", "runPrerequisites: spec-kit already initialized");
    emitCheck({ name: "speckit_init", status: "pass" });
    checkResults.set("speckit_init", "pass");
  } else if (specifyOk) {
    // Auto-run specify init
    rlog.run("INFO", "runPrerequisites: running specify init");
    try {
      const scriptType = getScriptType();
      execSync(`specify init . --force --ai claude --script ${scriptType}`, {
        cwd: config.projectDir,
        stdio: "pipe",
        timeout: 60_000,
      });
      if (fs.existsSync(integrationJson)) {
        rlog.run("INFO", "runPrerequisites: specify init succeeded");
        emitCheck({ name: "speckit_init", status: "pass" });
        checkResults.set("speckit_init", "pass");
      } else {
        rlog.run("WARN", "runPrerequisites: specify init ran but integration.json not found");
        emitCheck({ name: "speckit_init", status: "fail", message: "specify init ran but .specify/integration.json was not created" });
        checkResults.set("speckit_init", "fail");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rlog.run("ERROR", "runPrerequisites: specify init failed", { error: msg });
      emitCheck({ name: "speckit_init", status: "fail", message: `specify init failed: ${msg}` });
      checkResults.set("speckit_init", "fail");
    }
  } else {
    rlog.run("WARN", "runPrerequisites: cannot init spec-kit — specify CLI not available");
    emitCheck({ name: "speckit_init", status: "fail", message: "Cannot initialize — specify CLI not available" });
    checkResults.set("speckit_init", "fail");
  }

  // ── Check 5: GitHub repository (optional) ──
  // Runs after spec-kit init so the initial commit includes all generated files
  emitCheck({ name: "github_repo", status: "running" });
  let hasRemote = false;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: config.projectDir,
      stdio: "pipe",
      timeout: 5_000,
    }).toString().trim();
    hasRemote = remote.length > 0;
  } catch {
    // No remote configured
  }

  if (hasRemote) {
    rlog.run("INFO", "runPrerequisites: GitHub remote already configured");
    emitCheck({ name: "github_repo", status: "pass" });
    checkResults.set("github_repo", "pass");
  } else {
    const ghOk = isCommandOnPath("gh");
    if (!ghOk) {
      rlog.run("INFO", "runPrerequisites: gh CLI not found, skipping GitHub repo setup");
      emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI (gh) not installed — skipped" });
      checkResults.set("github_repo", "fixed");
    } else {
      let ghAuthed = false;
      try {
        execSync("gh auth status", { cwd: config.projectDir, stdio: "pipe", timeout: 10_000 });
        ghAuthed = true;
      } catch {
        // Not authenticated
      }

      if (!ghAuthed) {
        rlog.run("INFO", "runPrerequisites: gh not authenticated, skipping GitHub repo setup");
        emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI not authenticated — run 'gh auth login' to enable" });
        checkResults.set("github_repo", "fixed");
      } else {
        if (abortController?.signal.aborted) return;
        const answers = await waitForUserInput(config.projectDir, emit, runId, [{
          question: "Would you like to create a GitHub repository for this project?",
          header: "GitHub Repository (optional)",
          options: [
            { label: "Yes — create a new repo", description: "Create a GitHub repository and push this project" },
            { label: "No — skip", description: "Continue without a GitHub remote" },
          ],
          multiSelect: false,
        }]);
        const answer = Object.values(answers)[0];

        if (answer === "No — skip") {
          emitCheck({ name: "github_repo", status: "fixed", message: "Skipped by user" });
          checkResults.set("github_repo", "fixed");
        } else {
          if (abortController?.signal.aborted) return;
          const repoAnswers = await waitForUserInput(config.projectDir, emit, runId, [{
            question: "Enter the name for your new GitHub repository:",
            header: "Repository Name",
            options: [
              { label: path.basename(config.projectDir), description: "Use project folder name" },
            ],
            multiSelect: false,
          }]);
          const repoName = Object.values(repoAnswers)[0];

          rlog.run("INFO", `runPrerequisites: creating GitHub repo '${repoName}'`);
          try {
            // Commit all files created during prerequisites (GOAL.md, .specify/, .claude/, etc.)
            execSync("git add -A -- ':!.dex/' && git commit -m \"Initial project setup (prerequisites)\"", {
              cwd: config.projectDir,
              stdio: "pipe",
              timeout: 10_000,
            });
            execSync(`gh repo create "${repoName}" --private --source . --push`, {
              cwd: config.projectDir,
              stdio: "pipe",
              timeout: 30_000,
            });
            rlog.run("INFO", "runPrerequisites: GitHub repo created successfully");
            emitCheck({ name: "github_repo", status: "pass" });
            checkResults.set("github_repo", "pass");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            rlog.run("ERROR", "runPrerequisites: gh repo create failed", { error: msg });
            emitCheck({ name: "github_repo", status: "fail", message: `Failed to create repo: ${msg}` });
            checkResults.set("github_repo", "fail");
          }
        }
      }
    }
  }

  // ── If any check failed, block until user acknowledges ──
  const failedChecks = [...checkResults.entries()].filter(([, s]) => s === "fail");
  if (failedChecks.length > 0) {
    const failedNames = failedChecks.map(([name]) => name).join(", ");
    rlog.run("WARN", `runPrerequisites: ${failedChecks.length} check(s) failed: ${failedNames}`);

    await waitForUserInput(config.projectDir, emit, runId, [{
      question: `${failedChecks.length} prerequisite check(s) failed: ${failedNames}. You can continue, but the loop may not work correctly.`,
      header: "Prerequisites incomplete",
      options: [
        { label: "Continue anyway", description: "Proceed to clarification despite failed checks" },
      ],
      multiSelect: false,
    }]);
  }

  const allPassed = failedChecks.length === 0;
  const durationMs = Date.now() - startTime;
  runs.completePhase(config.projectDir, runId, phaseTraceId, {
    status: "completed",
    costUsd: 0,
    durationMs,
    inputTokens: 0,
    outputTokens: 0,
  });

  emit({
    type: "stage_completed",
    runId,
    cycleNumber: 0,
    stage: "prerequisites",
    phaseTraceId,
    costUsd: 0,
    durationMs,
  });

  emit({ type: "prerequisites_completed", runId });
  rlog.run("INFO", "runPrerequisites: completed", { durationMs, allPassed });
}

// ── Loop Mode Runner ──

async function runLoop(
  config: RunConfig,
  emit: EmitFn,
  runId: string,
  rlog: RunLogger
): Promise<{ phasesCompleted: number; totalCost: number; baseBranch: string; branchName: string }> {
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
      resumeLastStage = savedState.lastCompletedStage;
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
    await runPrerequisites(config, emit, runId, rlog);
    if (abortController?.signal.aborted) {
      emit({ type: "loop_terminated", runId, termination: { reason: "user_abort", cyclesCompleted: 0, totalCostUsd: 0, totalDurationMs: 0, featuresCompleted: [], featuresSkipped: [] } });
      return { phasesCompleted: 0, totalCost: 0, baseBranch: "", branchName: "" };
    }
  } else {
    rlog.run("INFO", "runLoop: skipping prerequisites (resume)");
    // Emit synthetic events so the UI can reconstruct the stepper state
    emit({ type: "prerequisites_started", runId });
    const prereqTraceId = crypto.randomUUID();
    emit({ type: "stage_started", runId, cycleNumber: 0, stage: "prerequisites", phaseTraceId: prereqTraceId });
    emit({ type: "stage_completed", runId, cycleNumber: 0, stage: "prerequisites", phaseTraceId: prereqTraceId, costUsd: 0, durationMs: 0 });
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
  const emitSkippedStage = (stage: import("./types.js").LoopStageType, cycleNum = 0) => {
    const traceId = crypto.randomUUID();
    runs.startPhase(config.projectDir, runId, {
      phaseTraceId: traceId,
      runId,
      specDir: null,
      phaseNumber: cycleNum,
      phaseName: `loop:${stage}`,
      stage,
      cycleNumber: cycleNum,
      featureSlug: null,
      startedAt: new Date().toISOString(),
      status: "running",
    });
    emit({ type: "stage_started", runId, cycleNumber: cycleNum, stage, phaseTraceId: traceId });
    runs.completePhase(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
    emit({ type: "stage_completed", runId, cycleNumber: cycleNum, stage, phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
  };

  const existingSpecsAtStart = listSpecDirs(config.projectDir);
  if (existingSpecsAtStart.length > 0 && fs.existsSync(clarifiedPath)) {
    fullPlanPath = clarifiedPath;
    rlog.run("INFO", `runLoop: specs exist (${existingSpecsAtStart.length}), skipping clarification, using ${clarifiedPath}`);
    // Emit synthetic clarification events so the UI stepper advances past clarification
    emit({ type: "clarification_started", runId });
    emitSkippedStage("clarification_product");
    emitSkippedStage("clarification_technical");
    emitSkippedStage("clarification_synthesis");
    emitSkippedStage("constitution");
    emit({ type: "clarification_completed", runId, fullPlanPath: clarifiedPath });
  } else {
    emit({ type: "clarification_started", runId });
    rlog.run("INFO", "runLoop: starting multi-domain clarification (Phase A)");

    if (currentRunState) {
      currentRunState.isClarifying = true;
    }

    // Step 1: Product domain clarification
    const productDomainPath = path.join(config.projectDir, "GOAL_product_domain.md");
    if (!fs.existsSync(productDomainPath)) {
      rlog.run("INFO", "runLoop: starting product domain clarification");
      const prompt = buildProductClarificationPrompt(goalPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_product");
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();
      if (!fs.existsSync(productDomainPath)) {
        throw new Error("Product clarification completed but GOAL_product_domain.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_product_domain.md exists, skipping product clarification");
      emitSkippedStage("clarification_product");
    }

    // Step 2: Technical domain clarification
    if (abortController?.signal.aborted) throw new AbortError();
    const technicalDomainPath = path.join(config.projectDir, "GOAL_technical_domain.md");
    if (!fs.existsSync(technicalDomainPath)) {
      rlog.run("INFO", "runLoop: starting technical domain clarification");
      const prompt = buildTechnicalClarificationPrompt(goalPath, productDomainPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_technical");
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();
      if (!fs.existsSync(technicalDomainPath)) {
        throw new Error("Technical clarification completed but GOAL_technical_domain.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_technical_domain.md exists, skipping technical clarification");
      emitSkippedStage("clarification_technical");
    }

    // Step 3: Synthesis → GOAL_clarified.md + CLAUDE.md (with structured confirmation)
    if (abortController?.signal.aborted) throw new AbortError();
    if (!fs.existsSync(clarifiedPath)) {
      rlog.run("INFO", "runLoop: starting clarification synthesis");
      const prompt = buildClarificationSynthesisPrompt(goalPath, productDomainPath, technicalDomainPath);
      const result = await runStage(
        config, prompt, emit, rlog, runId, 0, "clarification_synthesis", undefined,
        { type: "json_schema", schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown> }
      );
      cumulativeCost += result.cost;
      if (abortController?.signal.aborted) throw new AbortError();

      // Try structured output first, fall back to filesystem probing
      const synthesisOutput = result.structuredOutput as { filesProduced?: string[]; goalClarifiedPath?: string } | null;
      if (synthesisOutput?.goalClarifiedPath) {
        const resolvedPath = path.isAbsolute(synthesisOutput.goalClarifiedPath)
          ? synthesisOutput.goalClarifiedPath
          : path.join(config.projectDir, synthesisOutput.goalClarifiedPath);
        if (!fs.existsSync(resolvedPath)) {
          rlog.run("WARN", `Synthesis structured output claimed ${synthesisOutput.goalClarifiedPath} but file not found — falling back to filesystem check`);
        }
      }

      if (!fs.existsSync(clarifiedPath)) {
        throw new Error("Synthesis completed but GOAL_clarified.md not found");
      }
    } else {
      rlog.run("INFO", "runLoop: GOAL_clarified.md exists, skipping synthesis");
      emitSkippedStage("clarification_synthesis");
    }

    fullPlanPath = clarifiedPath;

    // Step 4: Constitution (final step of clarification)
    // The file may exist as an unfilled template (with [PLACEHOLDER] tokens) from `specify init`.
    // Only skip if it exists AND has been filled (no placeholder tokens remain).
    if (abortController?.signal.aborted) throw new AbortError();
    const constitutionPath = path.join(config.projectDir, ".specify", "memory", "constitution.md");
    const constitutionNeedsGeneration = !fs.existsSync(constitutionPath)
      || fs.readFileSync(constitutionPath, "utf-8").includes("[PROJECT_NAME]");
    if (constitutionNeedsGeneration) {
      rlog.run("INFO", "runLoop: generating constitution");
      const prompt = buildConstitutionPrompt(config, fullPlanPath);
      const result = await runStage(config, prompt, emit, rlog, runId, 0, "constitution");
      cumulativeCost += result.cost;
    } else {
      rlog.run("INFO", "runLoop: constitution already filled, skipping");
      emitSkippedStage("constitution");
    }

    emit({ type: "clarification_completed", runId, fullPlanPath });
    rlog.run("INFO", `runLoop: clarification completed, fullPlanPath=${fullPlanPath}`);

    if (currentRunState) {
      currentRunState.isClarifying = false;
    }
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

  // ── Phase B: Autonomous Loop ──

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

    emit({ type: "loop_cycle_started", runId, cycleNumber });
    rlog.run("INFO", `runLoop: starting cycle ${cycleNumber}`);

    if (currentRunState) {
      currentRunState.currentCycle = cycleNumber;
    }

    // ── Gap Analysis — Deterministic Manifest Walk ──
    let decision: GapAnalysisDecision;
    if (resumeSpecDir && cycleNumber === cyclesCompleted + 1) {
      // Mid-cycle resume: pick RESUME_AT_STAGE when a pre-implement stage
      // (specify or plan) completed before the abort. A completed "tasks"
      // stage means the pre-implement triad is done → classic RESUME_FEATURE
      // (jump straight to implement). Any later stage or null also maps to
      // RESUME_FEATURE since implement/verify/learnings have their own
      // resume paths.
      if (resumeLastStage === "specify" || resumeLastStage === "plan") {
        decision = { type: "RESUME_AT_STAGE", specDir: resumeSpecDir, resumeAtStage: resumeLastStage };
        rlog.run("INFO", `runLoop: resume — using RESUME_AT_STAGE(${resumeLastStage}) for ${resumeSpecDir}`);
      } else {
        decision = { type: "RESUME_FEATURE", specDir: resumeSpecDir };
        rlog.run("INFO", `runLoop: resume — skipping gap analysis, using RESUME_FEATURE for ${resumeSpecDir}`);
      }
      const traceId = crypto.randomUUID();
      runs.startPhase(config.projectDir, runId, {
        phaseTraceId: traceId,
        runId,
        specDir: resumeSpecDir,
        phaseNumber: cycleNumber,
        phaseName: "loop:gap_analysis",
        stage: "gap_analysis",
        cycleNumber,
        featureSlug: path.basename(resumeSpecDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });
      emit({ type: "stage_started", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId });
      runs.completePhase(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
      emit({ type: "stage_completed", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
      resumeSpecDir = null;
    } else {
      try {
        const manifest = loadManifest(config.projectDir);
        if (!manifest) {
          throw new Error("Feature manifest not found — manifest extraction should have run before the loop");
        }

        if (currentRunState) {
          currentRunState.currentStage = "gap_analysis";
        }

        const active = getActiveFeature(manifest);
        const nextPending = getNextFeature(manifest);

        // Emit a synthetic (deterministic, cost=0) gap_analysis stage so the UI shows it completed
        const emitSyntheticGapAnalysis = (specDir: string) => {
          const traceId = crypto.randomUUID();
          runs.startPhase(config.projectDir, runId, {
            phaseTraceId: traceId,
            runId,
            specDir: specDir || null,
            phaseNumber: cycleNumber,
            phaseName: "loop:gap_analysis",
            stage: "gap_analysis",
            cycleNumber,
            featureSlug: specDir ? path.basename(specDir) : null,
            startedAt: new Date().toISOString(),
            status: "running",
          });
          emit({ type: "stage_started", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, specDir });
          runs.completePhase(config.projectDir, runId, traceId, { status: "completed", costUsd: 0, durationMs: 0 });
          emit({ type: "stage_completed", runId, cycleNumber, stage: "gap_analysis", phaseTraceId: traceId, costUsd: 0, durationMs: 0 });
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
            const evaluation = evalResult.structuredOutput as { decision: string; reason: string } | null;
            if (!evaluation) {
              throw new Error(`Gap analysis for ${active.specDir} returned null structured output — cannot determine RESUME vs REPLAN`);
            }
            if (evaluation.decision === "REPLAN_FEATURE") {
              decision = { type: "REPLAN_FEATURE", specDir: active.specDir };
            } else {
              decision = { type: "RESUME_FEATURE", specDir: active.specDir };
            }
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
      || decision.type === "RESUME_AT_STAGE"
      ? decision.specDir
      : null;
    let cycleFailed = false;

    // Cycle metadata (cycleNumber, featureName, decisionType, specDir) is
    // captured per-phase via PhaseRecord.cycleNumber + featureSlug + stage.
    // No separate cycle row needed — derived via runs.cycleSummary at read time.
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
        runs.updateRunLoopsCompleted(config.projectDir, runId, cyclesCompleted);
        continue;
      }
      if (record.implFailures >= 3) {
        // Force replan
        decision = { type: "REPLAN_FEATURE", specDir };
        rlog.run("WARN", `runLoop: forcing replan for ${specDir} — 3 impl failures`);
      }
    }

    let cycleCost = 0;

    // Closed over the finalized `decision` (after force-replan promotion).
    // Centralizes the decision→stages mapping; only callers for plan/tasks
    // use it today. The switch has no `default` — TypeScript enforces
    // exhaustiveness if a new decision variant is added.
    // GAPS_COMPLETE is already handled by the early `break` above, so the
    // narrowed type at this point excludes it — the switch below is
    // exhaustive over the remaining four variants.
    const shouldRun = (stage: LoopStageType): boolean => {
      switch (decision.type) {
        case "NEXT_FEATURE":
          return stage !== "gap_analysis";
        case "REPLAN_FEATURE":
          return stage === "plan" || stage === "tasks" || stage === "implement"
            || stage === "verify" || stage === "learnings";
        case "RESUME_FEATURE":
          return stage === "implement" || stage === "verify" || stage === "learnings";
        case "RESUME_AT_STAGE":
          return STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(decision.resumeAtStage);
      }
    };

    try {
      // Emit synthetic completed events for stages that won't actually run,
      // so the UI stepper shows them ✓ instead of missing/stuck.
      if (decision.type === "RESUME_FEATURE") {
        emitSkippedStage("specify", cycleNumber);
        emitSkippedStage("plan", cycleNumber);
        emitSkippedStage("tasks", cycleNumber);
      } else if (decision.type === "RESUME_AT_STAGE") {
        const resumeOrdinal = STAGE_ORDER.indexOf(decision.resumeAtStage);
        for (const s of ["specify", "plan", "tasks"] as const) {
          if (STAGE_ORDER.indexOf(s) <= resumeOrdinal) {
            emitSkippedStage(s, cycleNumber);
          }
        }
      }

      // ── NEXT_FEATURE: specify → plan → tasks → implement → verify → learnings ──
      if (decision.type === "NEXT_FEATURE") {
        // Specify (T030)
        if (currentRunState) {
          currentRunState.currentStage = "specify";
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
        // currentSpecDir on the next resume to pick RESUME_AT_STAGE.
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

      // Plan (T031) — runs for NEXT_FEATURE, REPLAN_FEATURE, and RESUME_AT_STAGE(specify)
      if (shouldRun("plan")) {
        if (abortController?.signal.aborted) throw new AbortError();

        const targetSpecDir = specDir!;
        const specPath = targetSpecDir.startsWith("/")
          ? targetSpecDir
          : path.join(config.projectDir, targetSpecDir);

        if (currentRunState) {
          currentRunState.currentStage = "plan";
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

      // Tasks (T031) — runs for NEXT_FEATURE, REPLAN_FEATURE, and RESUME_AT_STAGE(specify|plan)
      if (shouldRun("tasks")) {
        if (abortController?.signal.aborted) throw new AbortError();

        const targetSpecDir = specDir!;
        const specPath = targetSpecDir.startsWith("/")
          ? targetSpecDir
          : path.join(config.projectDir, targetSpecDir);

        if (currentRunState) {
          currentRunState.currentStage = "tasks";
        }
        const tasksPrompt = buildLoopTasksPrompt(config, specPath);
        const tasksResult = await runStage(config, tasksPrompt, emit, rlog, runId, cycleNumber, "tasks", targetSpecDir);
        cycleCost += tasksResult.cost;
      }

      if (abortController?.signal.aborted) throw new AbortError();

      // Implement (T032)
      const implSpecDir = specDir!;
      const implSpecPath = implSpecDir.startsWith("/")
        ? implSpecDir
        : path.join(config.projectDir, implSpecDir);

      if (currentRunState) {
        currentRunState.currentStage = "implement";
        currentRunState.specDir = implSpecDir;
      }
      // Update FeatureArtifacts.status to "implementing"
      if (activeProjectDir && implSpecDir) {
        updateState(activeProjectDir, {
          artifacts: { features: { [implSpecDir]: { status: "implementing" } } },
        } as never).catch(() => {});
      }

      // Create a stage-level phase record so the UI shows implement in the stage list
      const implStageTraceId = crypto.randomUUID();
      runs.startPhase(config.projectDir, runId, {
        phaseTraceId: implStageTraceId,
        runId,
        specDir: implSpecDir,
        phaseNumber: cycleNumber,
        phaseName: "loop:implement",
        stage: "implement",
        cycleNumber,
        featureSlug: path.basename(implSpecDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });

      emit({
        type: "stage_started",
        runId,
        cycleNumber,
        stage: "implement",
        phaseTraceId: implStageTraceId,
        specDir: implSpecDir,
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
      const phases = parseTasksFile(config.projectDir, implSpecDir);
      const implConfig = { ...config, specDir: implSpecDir };
      const runTaskState = new RunTaskState(phases);

      // Emit initial task state so the UI can show the spec card immediately
      emit({ type: "tasks_updated", phases: runTaskState.getPhases() });

      try {
        for (const phase of phases) {
          if (abortController?.signal.aborted) break;
          if (phase.status === "complete") continue;

          const phaseTraceId = crypto.randomUUID();
          activePhaseTraceId = phaseTraceId;
          runs.startPhase(config.projectDir, runId, {
            phaseTraceId,
            runId,
            specDir: implSpecDir,
            phaseNumber: phase.number,
            phaseName: phase.name,
            stage: null,
            cycleNumber,
            featureSlug: path.basename(implSpecDir),
            startedAt: new Date().toISOString(),
            status: "running",
          });

          if (currentRunState) {
            currentRunState.phaseTraceId = phaseTraceId;
            currentRunState.phaseNumber = phase.number;
            currentRunState.phaseName = phase.name;
          }

          emit({ type: "phase_started", phase, iteration: 0, phaseTraceId });

          const phaseResult = await runPhase(implConfig, phase, phaseTraceId, runId, emit, rlog, runTaskState);
          runs.completePhase(config.projectDir, runId, phaseTraceId, {
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
          const freshPhases = parseTasksFile(config.projectDir, implSpecDir);
          runTaskState.reconcileFromDisk(freshPhases);
          emit({ type: "tasks_updated", phases: runTaskState.getPhases() });
          emit({
            type: "phase_completed",
            phase: { ...phase, status: "complete" },
            cost: phaseResult.cost,
            durationMs: phaseResult.durationMs,
          });
        }
      } catch (implErr) {
        implStageFailed = true;
        // Mark any in-flight phase trace as failed so it doesn't dangle as "running"
        if (activePhaseTraceId) {
          try {
            runs.completePhase(config.projectDir, runId, activePhaseTraceId, {
              status: "failed",
              costUsd: 0,
              durationMs: Date.now() - implStageStart,
            });
          } catch { /* best-effort */ }
        }
        throw implErr;
      } finally {
        // Always close the loop:implement stage trace, even on exception, so the
        // UI never sees an orphaned "running" implement stage.
        const implStageDurationMs = Date.now() - implStageStart;
        const implAborted = abortController?.signal.aborted ?? false;
        const implFinalStatus = implAborted ? "stopped" : implStageFailed ? "failed" : "completed";
        runs.completePhase(config.projectDir, runId, implStageTraceId, {
          status: implFinalStatus,
          costUsd: implStageCost,
          durationMs: implStageDurationMs,
          inputTokens: implStageInputTokens || null,
          outputTokens: implStageOutputTokens || null,
        });
        emit({
          type: "stage_completed",
          runId,
          cycleNumber,
          stage: "implement",
          phaseTraceId: implStageTraceId,
          costUsd: implStageCost,
          durationMs: implStageDurationMs,
          ...(implAborted ? { stopped: true } : {}),
        });
      }

      // The implement stage trace and stage_completed event were already emitted
      // in the finally block above. Now decide whether to continue to verify/learnings.
      const implAborted = abortController?.signal.aborted ?? false;

      if (implAborted) throw new AbortError();

      // Verify — structured output with fix-reverify loop
      if (currentRunState) {
        currentRunState.currentStage = "verify";
      }
      // Update FeatureArtifacts.status to "verifying"
      if (activeProjectDir && implSpecDir) {
        updateState(activeProjectDir, {
          artifacts: { features: { [implSpecDir]: { status: "verifying" } } },
        } as never).catch(() => {});
      }
      const verifyPrompt = buildVerifyPrompt(config, implSpecPath, fullPlanPath);
      const verifyResult = await runStage(
        config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", implSpecDir,
        { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> }
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

            if (abortController?.signal.aborted) throw new AbortError();

            const fixPrompt = buildVerifyFixPrompt(config, implSpecPath, currentBlocking);
            const fixResult = await runStage(config, fixPrompt, emit, rlog, runId, cycleNumber, "implement_fix", implSpecDir);
            cycleCost += fixResult.cost;

            if (abortController?.signal.aborted) throw new AbortError();

            const reVerifyResult = await runStage(
              config, verifyPrompt, emit, rlog, runId, cycleNumber, "verify", implSpecDir,
              { type: "json_schema", schema: VERIFY_SCHEMA as unknown as Record<string, unknown> }
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

      if (abortController?.signal.aborted) throw new AbortError();

      // Learnings — structured output with dedup
      if (currentRunState) {
        currentRunState.currentStage = "learnings";
      }
      const learningsPrompt = buildLearningsPrompt(config, implSpecPath);
      const learningsResult = await runStage(
        config, learningsPrompt, emit, rlog, runId, cycleNumber, "learnings", implSpecDir,
        { type: "json_schema", schema: LEARNINGS_SCHEMA as unknown as Record<string, unknown> }
      );
      cycleCost += learningsResult.cost;

      const learnings = learningsResult.structuredOutput as {
        insights: Array<{ category: string; insight: string; context: string }>;
      } | null;

      if (learnings?.insights?.length) {
        appendLearnings(config.projectDir, learnings.insights, config.maxLearningsPerCategory);
      } else if (!learnings) {
        rlog.run("WARN", "runLoop: learnings structured output was null — skipping append");
      }

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
          const currentStage = currentRunState?.currentStage;
          if (currentStage === "plan" || currentStage === "tasks") {
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
    runs.updateRunLoopsCompleted(config.projectDir, runId, cyclesCompleted);

    // Update state file with cycle completion
    if (activeProjectDir) {
      updateState(activeProjectDir, {
        cumulativeCostUsd: cumulativeCost,
        cyclesCompleted,
        currentCycleNumber: cycleNumber,
      }).catch(() => {});
    }

    if (currentRunState) {
      currentRunState.loopsCompleted = cyclesCompleted;
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

  return { phasesCompleted: cyclesCompleted, totalCost: cumulativeCost, baseBranch, branchName };
}

export function stopRun(): void {
  if (abortController) {
    console.log("[stopRun] abort signal sent to orchestrator");
    abortController.abort();
  } else {
    console.log("[stopRun] called but no active abortController");
  }
}

export function isRunning(): boolean {
  return abortController !== null;
}
