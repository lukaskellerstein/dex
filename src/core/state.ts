import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { RunConfig, LoopStageType, EmitFn, DriftSummary } from "./types.js";
import { getCurrentBranch, getHeadSha, countCommitsBetween, getCommittedFileContent } from "./git.js";

// ── Constants ──

const STATE_DIR = ".dex";
const STATE_FILE = "state.json";
const STATE_TMP = "state.json.tmp";
const LOCK_FILE = "state.lock";
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

// ── Types ──

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export interface DexState {
  version: 1;
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  branchName: string;
  baseBranch: string;
  mode: "loop" | "build" | "plan";

  // Position cursor
  phase: "prerequisites" | "clarification" | "loop";
  currentCycleNumber: number;
  lastCompletedStage: LoopStageType | null;
  currentSpecDir: string | null;
  currentPhaseNumber: number | null;

  // Clarification
  clarificationCompleted: boolean;
  fullPlanPath: string | null;

  // Accumulators
  cumulativeCostUsd: number;
  cyclesCompleted: number;
  featuresCompleted: string[];
  featuresSkipped: string[];

  // Failure tracking (replaces in-memory Map + DB failure_tracker)
  failureCounts: Record<string, { implFailures: number; replanFailures: number }>;

  // Config snapshot for resume
  config: ConfigSnapshot;

  // Artifact integrity manifest
  artifacts: ArtifactManifest;

  // Git checkpoint
  checkpoint: CheckpointRef;

  // Pending user input (persisted so crash doesn't lose unanswered questions)
  pendingQuestion: PendingQuestion | null;

  // Timestamps
  startedAt: string;
  pausedAt: string | null;
}

export interface ConfigSnapshot {
  model: string;
  maxLoopCycles?: number;
  maxBudgetUsd?: number;
  maxTurns: number;
  maxIterations: number;
  autoClarification?: boolean;
}

export interface ArtifactManifest {
  goalFile: ArtifactEntry | null;
  clarifiedGoal: ArtifactEntry | null;
  productDomain: ArtifactEntry | null;
  technicalDomain: ArtifactEntry | null;
  constitution: ArtifactEntry | null;
  features: Record<string, FeatureArtifacts>;
}

export interface ArtifactEntry {
  path: string;
  sha256: string;
  completedAt: string;
}

export interface FeatureArtifacts {
  specDir: string;
  status: "specifying" | "planning" | "implementing" | "verifying" | "completed" | "skipped";
  spec: ArtifactEntry | null;
  plan: ArtifactEntry | null;
  tasks: TasksArtifact | null;
  lastImplementedPhase: number;
}

export interface TasksArtifact extends ArtifactEntry {
  taskChecksums: Record<string, boolean>;
}

export interface CheckpointRef {
  sha: string;
  timestamp: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  context: string;
  askedAt: string;
}

export interface ReconciliationResult {
  canResume: boolean;
  resumeFrom: ResumePoint;
  warnings: string[];
  blockers: string[];
  statePatches: DeepPartial<DexState>;
  driftSummary: DriftSummary;
}

export interface ResumePoint {
  phase: string;
  cycleNumber: number;
  stage: LoopStageType;
  specDir?: string;
}

export type { DriftSummary } from "./types.js";

interface LockFile {
  pid: number;
  timestamp: string;
}

// ── Deep Merge ──

export function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const patchVal = (patch as Record<string, unknown>)[key as string];
    if (patchVal === undefined) continue;
    if (patchVal === null || Array.isArray(patchVal) || typeof patchVal !== "object") {
      (result as Record<string, unknown>)[key as string] = patchVal;
    } else {
      (result as Record<string, unknown>)[key as string] = deepMerge(
        (target as Record<string, unknown>)[key as string] ?? {},
        patchVal as DeepPartial<Record<string, unknown>>
      );
    }
  }
  return result;
}

// ── File Paths ──

function statePath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, STATE_FILE);
}

function stateTmpPath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, STATE_TMP);
}

function lockPath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, LOCK_FILE);
}

function ensureStateDir(projectDir: string): void {
  const dir = path.join(projectDir, STATE_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Core I/O ──

export async function saveState(projectDir: string, state: DexState): Promise<void> {
  ensureStateDir(projectDir);
  const tmp = stateTmpPath(projectDir);
  const target = statePath(projectDir);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, target);
}

export async function loadState(projectDir: string): Promise<DexState | null> {
  const filePath = statePath(projectDir);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (raw.version !== 1) return null;
    return raw as DexState;
  } catch {
    return null;
  }
}

export async function clearState(projectDir: string): Promise<void> {
  const filePath = statePath(projectDir);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File doesn't exist — that's fine
  }
}

export async function updateState(projectDir: string, patch: DeepPartial<DexState>): Promise<void> {
  const current = await loadState(projectDir);
  if (!current) return;
  const updated = deepMerge(current, patch);
  await saveState(projectDir, updated);
}

// ── Hashing ──

export async function hashFile(filePath: string): Promise<string> {
  const content = fs.readFileSync(filePath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ── Initial State ──

export function createInitialState(
  config: RunConfig,
  runId: string,
  branchName: string,
  baseBranch: string
): DexState {
  return {
    version: 1,
    runId,
    status: "running",
    branchName,
    baseBranch,
    mode: config.mode,
    phase: "prerequisites",
    currentCycleNumber: 0,
    lastCompletedStage: null,
    currentSpecDir: null,
    currentPhaseNumber: null,
    clarificationCompleted: false,
    fullPlanPath: null,
    cumulativeCostUsd: 0,
    cyclesCompleted: 0,
    featuresCompleted: [],
    featuresSkipped: [],
    failureCounts: {},
    config: {
      model: config.model,
      maxLoopCycles: config.maxLoopCycles,
      maxBudgetUsd: config.maxBudgetUsd,
      maxTurns: config.maxTurns,
      maxIterations: config.maxIterations,
      autoClarification: config.autoClarification,
    },
    artifacts: {
      goalFile: null,
      clarifiedGoal: null,
      productDomain: null,
      technicalDomain: null,
      constitution: null,
      features: {},
    },
    checkpoint: {
      sha: "",
      timestamp: new Date().toISOString(),
    },
    pendingQuestion: null,
    startedAt: new Date().toISOString(),
    pausedAt: null,
  };
}

// ── Stale State Detection ──

export async function detectStaleState(
  projectDir: string
): Promise<"fresh" | "stale" | "completed" | "none"> {
  const state = await loadState(projectDir);
  if (!state) return "none";
  if (state.status === "completed") return "completed";

  // Paused state is always resumable — the user explicitly asked to continue.
  // Branch mismatch (e.g., speckit switched to a feature branch during specify)
  // is expected and shouldn't invalidate the state.
  if (state.status === "paused") return "fresh";

  try {
    const currentBranch = getCurrentBranch(projectDir);
    if (state.branchName && state.branchName !== currentBranch) return "stale";
  } catch {
    return "stale";
  }

  return "fresh";
}

// ── Advisory Locking ──

function isLockStale(lock: LockFile): boolean {
  const ageMs = Date.now() - new Date(lock.timestamp).getTime();
  if (ageMs > LOCK_STALE_MS) return true;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function acquireStateLock(projectDir: string): Promise<() => void> {
  ensureStateDir(projectDir);
  const lp = lockPath(projectDir);

  // Check existing lock
  try {
    const existing: LockFile = JSON.parse(fs.readFileSync(lp, "utf-8"));
    if (!isLockStale(existing)) {
      throw new Error(`State lock held by PID ${existing.pid} (acquired at ${existing.timestamp}). Another Dex instance may be running on this project.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("State lock held")) throw err;
    // Lock file doesn't exist or is corrupt — proceed
  }

  // Write our lock
  const lockData: LockFile = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(lp, JSON.stringify(lockData), "utf-8");

  const release = () => {
    try {
      const current = JSON.parse(fs.readFileSync(lp, "utf-8")) as LockFile;
      if (current.pid === process.pid) {
        fs.unlinkSync(lp);
      }
    } catch {
      // Already released or doesn't exist
    }
  };

  process.on("exit", release);

  return () => {
    process.removeListener("exit", release);
    release();
  };
}

// ── Crash Recovery ──

const STAGE_ORDER: LoopStageType[] = [
  "prerequisites",
  "clarification",
  "clarification_product",
  "clarification_technical",
  "clarification_synthesis",
  "constitution",
  "manifest_extraction",
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "implement",
  "implement_fix",
  "verify",
  "learnings",
];

function stageOrdinal(stage: LoopStageType | null): number {
  if (!stage) return -1;
  return STAGE_ORDER.indexOf(stage);
}

export async function resolveWorkingTreeConflict(projectDir: string): Promise<DexState | null> {
  const workingTree = await loadState(projectDir);

  let committed: DexState | null = null;
  try {
    const raw = getCommittedFileContent(projectDir, "HEAD", `${STATE_DIR}/${STATE_FILE}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version === 1) committed = parsed;
    }
  } catch {
    // No committed version
  }

  if (!workingTree && !committed) return null;
  if (!workingTree) return committed;
  if (!committed) return workingTree;

  // Both exist — pick the more advanced one
  const wtOrdinal = stageOrdinal(workingTree.lastCompletedStage);
  const cmOrdinal = stageOrdinal(committed.lastCompletedStage);
  const chosen = wtOrdinal >= cmOrdinal ? workingTree : committed;

  // Validate: checkpoint SHA must exist in git history
  if (chosen.checkpoint.sha) {
    try {
      execSync(`git cat-file -t ${chosen.checkpoint.sha}`, {
        cwd: projectDir,
        stdio: "pipe",
      });
      return chosen;
    } catch {
      // Chosen state has invalid checkpoint — try the other
      const fallback = chosen === workingTree ? committed : workingTree;
      if (fallback.checkpoint.sha) {
        try {
          execSync(`git cat-file -t ${fallback.checkpoint.sha}`, {
            cwd: projectDir,
            stdio: "pipe",
          });
          return fallback;
        } catch {
          return null;
        }
      }
      // Fallback has no checkpoint SHA — it's the initial state, accept it
      return fallback;
    }
  }

  // No checkpoint SHA — initial state, accept it
  return chosen;
}

// ── Reconciliation ──

export async function reconcileState(
  projectDir: string,
  state: DexState,
  emit?: EmitFn,
  runId?: string
): Promise<ReconciliationResult> {
  if (emit && runId) {
    emit({ type: "state_reconciling", runId } as never);
  }

  const warnings: string[] = [];
  const blockers: string[] = [];
  const statePatches: DeepPartial<DexState> = {};
  const driftSummary: DriftSummary = {
    missingArtifacts: [],
    modifiedArtifacts: [],
    taskRegressions: {},
    taskProgressions: {},
    extraCommits: 0,
    pendingQuestionReask: false,
  };

  // 1. Git checkpoint comparison
  if (state.checkpoint.sha) {
    try {
      const currentHead = getHeadSha(projectDir);
      if (currentHead !== state.checkpoint.sha) {
        const extra = countCommitsBetween(projectDir, state.checkpoint.sha, currentHead);
        driftSummary.extraCommits = extra;
        warnings.push(`${extra} commit(s) added since last checkpoint`);
        // Update checkpoint to current HEAD
        statePatches.checkpoint = { sha: currentHead, timestamp: new Date().toISOString() };
      }
    } catch {
      warnings.push("Could not compare git checkpoint — proceeding with current state");
    }
  }

  // 2. Artifact existence + hash check
  const artifactChecks: Array<{ name: string; entry: ArtifactEntry; category: string }> = [];

  const topLevel: Array<[string, ArtifactEntry | null]> = [
    ["goalFile", state.artifacts.goalFile],
    ["clarifiedGoal", state.artifacts.clarifiedGoal],
    ["productDomain", state.artifacts.productDomain],
    ["technicalDomain", state.artifacts.technicalDomain],
    ["constitution", state.artifacts.constitution],
  ];

  for (const [name, entry] of topLevel) {
    if (entry) artifactChecks.push({ name, entry, category: "top" });
  }

  for (const [specDir, feature] of Object.entries(state.artifacts.features)) {
    if (feature.spec) artifactChecks.push({ name: `${specDir}/spec`, entry: feature.spec, category: specDir });
    if (feature.plan) artifactChecks.push({ name: `${specDir}/plan`, entry: feature.plan, category: specDir });
    if (feature.tasks) artifactChecks.push({ name: `${specDir}/tasks`, entry: feature.tasks, category: specDir });
  }

  // Parallel hash check
  const hashResults = await Promise.all(
    artifactChecks.map(async ({ name, entry, category }) => {
      const fullPath = path.join(projectDir, entry.path);
      if (!fs.existsSync(fullPath)) {
        return { name, entry, category, status: "missing" as const };
      }
      const currentHash = await hashFile(fullPath);
      if (currentHash !== entry.sha256) {
        return { name, entry, category, status: "modified" as const };
      }
      return { name, entry, category, status: "ok" as const };
    })
  );

  for (const result of hashResults) {
    if (result.status === "missing") {
      driftSummary.missingArtifacts.push(result.entry.path);
    } else if (result.status === "modified") {
      driftSummary.modifiedArtifacts.push(result.entry.path);
    }
  }

  // 3. Tasks.md checkbox comparison
  for (const [specDir, feature] of Object.entries(state.artifacts.features)) {
    if (!feature.tasks) continue;
    const tasksPath = path.join(projectDir, feature.tasks.path);
    if (!fs.existsSync(tasksPath)) continue;

    const content = fs.readFileSync(tasksPath, "utf-8");
    const regressions: string[] = [];
    const progressions: string[] = [];

    for (const [taskId, wasChecked] of Object.entries(feature.tasks.taskChecksums)) {
      const checkedNow = new RegExp(`^\\s*- \\[[xX]\\].*${taskId}`, "m").test(content);
      if (wasChecked && !checkedNow) regressions.push(taskId);
      if (!wasChecked && checkedNow) progressions.push(taskId);
    }

    if (regressions.length > 0) driftSummary.taskRegressions[specDir] = regressions;
    if (progressions.length > 0) driftSummary.taskProgressions[specDir] = progressions;
  }

  // 4. Pending question re-ask
  if (state.pendingQuestion) {
    driftSummary.pendingQuestionReask = true;
    blockers.push(`Pending question from ${state.pendingQuestion.context}: "${state.pendingQuestion.question}"`);
  }

  // 5. Reconciliation decision matrix
  let resumeStage = state.lastCompletedStage;
  let resumeCycle = state.currentCycleNumber;
  let resumePhase = state.phase;
  let resumeSpecDir = state.currentSpecDir ?? undefined;

  // Check for clarified goal deletion/modification
  if (state.artifacts.clarifiedGoal) {
    const goalPath = state.artifacts.clarifiedGoal.path;
    if (driftSummary.missingArtifacts.includes(goalPath)) {
      resumePhase = "clarification";
      resumeStage = null;
      warnings.push("GOAL_clarified.md deleted — resetting to clarification phase");
    } else if (driftSummary.modifiedArtifacts.includes(goalPath)) {
      blockers.push("GOAL_clarified.md was modified. Re-run gap analysis? Choose: re-run or accept.");
    }
  }

  // Check for constitution deletion
  if (state.artifacts.constitution && driftSummary.missingArtifacts.includes(state.artifacts.constitution.path)) {
    warnings.push("constitution.md deleted — will re-run constitution before next cycle");
  }

  // Check feature-level drift
  const featurePatches: Record<string, DeepPartial<FeatureArtifacts>> = {};
  for (const [specDir, feature] of Object.entries(state.artifacts.features)) {
    if (feature.spec && driftSummary.missingArtifacts.includes(feature.spec.path)) {
      featurePatches[specDir] = { status: "specifying", spec: null, plan: null, tasks: null, lastImplementedPhase: 0 };
      if (state.currentSpecDir === specDir) {
        resumeStage = "specify" as LoopStageType;
        warnings.push(`spec.md deleted for ${specDir} — resetting to specifying`);
      }
    } else if (feature.plan && driftSummary.missingArtifacts.includes(feature.plan.path)) {
      featurePatches[specDir] = { status: "planning", plan: null, tasks: null, lastImplementedPhase: 0 };
      if (state.currentSpecDir === specDir) {
        resumeStage = "plan" as LoopStageType;
        warnings.push(`plan.md deleted for ${specDir} — resetting to planning`);
      }
    }

    // Task regressions → resume implement from earliest unchecked
    if (driftSummary.taskRegressions[specDir]?.length) {
      warnings.push(`Tasks unchecked in ${specDir} — will resume implement from earliest unchecked phase`);
      if (state.currentSpecDir === specDir) {
        resumeStage = "implement" as LoopStageType;
      }
    }

    // Task progressions → accept and update state
    if (driftSummary.taskProgressions[specDir]?.length) {
      warnings.push(`Tasks manually checked in ${specDir} — accepting progression`);
    }
  }

  // Manifest reconciliation: sync FeatureArtifacts with feature-manifest.json
  try {
    const manifestPath = path.join(projectDir, ".dex", "feature-manifest.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      if (manifest?.features && Array.isArray(manifest.features)) {
        for (const entry of manifest.features) {
          if (entry.status === "active" && entry.specDir && !state.artifacts.features[entry.specDir]) {
            // Manifest says active but no FeatureArtifacts entry — create one
            featurePatches[entry.specDir] = { specDir: entry.specDir, status: "specifying", spec: null, plan: null, tasks: null, lastImplementedPhase: 0 };
            warnings.push(`Manifest reconciliation: created FeatureArtifacts for ${entry.specDir} (manifest says active)`);
          } else if (entry.status === "completed" && entry.specDir && state.artifacts.features[entry.specDir]) {
            const fa = state.artifacts.features[entry.specDir];
            if (fa.status !== "completed") {
              featurePatches[entry.specDir] = { status: "completed" };
              warnings.push(`Manifest reconciliation: updated ${entry.specDir} to completed (manifest says completed)`);
            }
          }
        }
      }
    }
  } catch {
    // Manifest reconciliation failure is non-fatal
  }

  if (Object.keys(featurePatches).length > 0) {
    statePatches.artifacts = { features: featurePatches as never };
  }

  // Determine the next stage to execute (the one after lastCompletedStage)
  let nextStage: LoopStageType;
  if (!resumeStage) {
    nextStage = STAGE_ORDER[0];
  } else {
    const idx = STAGE_ORDER.indexOf(resumeStage);
    nextStage = idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : resumeStage;
  }

  const result: ReconciliationResult = {
    canResume: blockers.length === 0 || driftSummary.pendingQuestionReask,
    resumeFrom: {
      phase: resumePhase,
      cycleNumber: resumeCycle,
      stage: nextStage,
      specDir: resumeSpecDir,
    },
    warnings,
    blockers,
    statePatches,
    driftSummary,
  };

  if (emit && runId) {
    emit({ type: "state_reconciled", runId, driftSummary } as never);
  }

  return result;
}

// ── DB Migration ──

export async function migrateFromDbResume(
  projectDir: string,
  dbHelpers: {
    getRun: (runId: string) => { run: { id: string; project_dir: string; mode: string; model: string; total_cost_usd: number | null; status: string; created_at: string }; phases: Array<{ phase_name: string; phase_number: number; spec_dir: string }> } | null;
    getLoopCycles: (runId: string) => Array<{ cycle_number: number; spec_dir: string | null; feature_name: string | null; status: string }>;
    getLastStoppedRunId: (projectDir: string) => string | null;
  }
): Promise<DexState | null> {
  // Only migrate if no state file exists
  const existing = await loadState(projectDir);
  if (existing) return null;

  const runId = dbHelpers.getLastStoppedRunId(projectDir);
  if (!runId) return null;

  const runData = dbHelpers.getRun(runId);
  if (!runData) return null;

  const cycles = dbHelpers.getLoopCycles(runId);
  const lastCycle = cycles[cycles.length - 1];

  // Reconstruct state from DB fields
  let branchName = "";
  try {
    branchName = getCurrentBranch(projectDir);
  } catch {
    branchName = "unknown";
  }

  const state = createInitialState(
    {
      projectDir,
      specDir: "",
      mode: (runData.run.mode as "loop" | "build" | "plan") ?? "loop",
      model: runData.run.model ?? "claude-opus-4-6",
      maxIterations: 50,
      maxTurns: 75,
      phases: "all",
    },
    runData.run.id,
    branchName,
    "main"
  );

  state.status = "paused";
  state.cumulativeCostUsd = runData.run.total_cost_usd ?? 0;
  state.cyclesCompleted = lastCycle ? lastCycle.cycle_number - 1 : 0;
  state.currentCycleNumber = lastCycle?.cycle_number ?? 0;
  state.currentSpecDir = lastCycle?.spec_dir ?? null;
  state.startedAt = runData.run.created_at;
  state.pausedAt = new Date().toISOString();

  // Determine last completed stage from phase traces
  const loopPhases = runData.phases
    .filter(pt => pt.phase_name.startsWith("loop:"))
    .sort((a, b) => a.phase_name.localeCompare(b.phase_name));
  const lastPhase = loopPhases[loopPhases.length - 1];
  if (lastPhase) {
    state.lastCompletedStage = lastPhase.phase_name.replace("loop:", "") as LoopStageType;
  }

  // Hash current artifacts on disk (best-effort)
  const goalPath = path.join(projectDir, "GOAL_clarified.md");
  if (fs.existsSync(goalPath)) {
    state.artifacts.clarifiedGoal = {
      path: "GOAL_clarified.md",
      sha256: await hashFile(goalPath),
      completedAt: new Date().toISOString(),
    };
    state.clarificationCompleted = true;
  }

  return state;
}
