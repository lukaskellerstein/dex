import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { RunConfig, StepType, Phase, EmitFn, DriftSummary } from "./types.js";
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

export type PauseReason = "user_abort" | "step_mode" | "budget" | "failure";

export interface DexUiPrefs {
  recordMode?: boolean;
  pauseAfterStage?: boolean;
}

export interface DexState {
  version: 1;
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  baseBranch: string;
  mode: "loop" | "build" | "plan";

  // Position cursor
  currentPhase: Phase;
  currentCycleNumber: number;
  lastCompletedStep: StepType | null;
  currentSpecDir: string | null;
  currentTaskPhaseNumber: number | null;

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

  // Last commit observed by the orchestrator — cache of commitCheckpoint()'s return.
  // Not to be confused with the user-facing "checkpoint" domain term (tag-backed save points).
  lastCommit: CheckpointRef;

  // Pending user input (persisted so crash doesn't lose unanswered questions)
  pendingQuestion: PendingQuestion | null;

  // Reason for status === "paused" (typed; present iff paused).
  pauseReason?: PauseReason;

  // Session UI preferences — Record mode, Pause-after-stage toggles.
  ui?: DexUiPrefs;

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
  phase: Phase;
  cycleNumber: number;
  step: StepType;
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
    return stripRemovedFields(raw);
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
  _branchName: string,
  baseBranch: string
): DexState {
  return {
    version: 1,
    runId,
    status: "running",
    baseBranch,
    mode: config.mode,
    currentPhase: "prerequisites",
    currentCycleNumber: 0,
    lastCompletedStep: null,
    currentSpecDir: null,
    currentTaskPhaseNumber: null,
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
    lastCommit: {
      sha: "",
      timestamp: new Date().toISOString(),
    },
    pendingQuestion: null,
    startedAt: new Date().toISOString(),
    pausedAt: null,
  };
}

// ── Strip removed fields from older on-disk state ────────

function stripRemovedFields(raw: Record<string, unknown>): DexState | null {
  if (raw.version !== 1) return null;
  // Pre-008: rename `checkpoint` → `lastCommit` if present.
  if (raw.checkpoint && !raw.lastCommit) {
    raw.lastCommit = raw.checkpoint;
  }
  // Pre-008: drop `branchName` silently.
  delete raw.branchName;
  delete raw.checkpoint;
  // Pre-rename (PR 1 of terminology rename): migrate old field names.
  if (raw.phase !== undefined && raw.currentPhase === undefined) {
    raw.currentPhase = raw.phase;
    delete raw.phase;
  }
  if (raw.lastCompletedStage !== undefined && raw.lastCompletedStep === undefined) {
    raw.lastCompletedStep = raw.lastCompletedStage;
    delete raw.lastCompletedStage;
  }
  if (raw.currentPhaseNumber !== undefined && raw.currentTaskPhaseNumber === undefined) {
    raw.currentTaskPhaseNumber = raw.currentPhaseNumber;
    delete raw.currentPhaseNumber;
  }
  return raw as unknown as DexState;
}

// ── Stale State Detection ──

export async function detectStaleState(
  projectDir: string
): Promise<"fresh" | "stale" | "completed" | "none"> {
  const state = await loadState(projectDir);
  if (!state) return "none";
  if (state.status === "completed") return "completed";

  // Paused state is always resumable — the user explicitly asked to continue.
  // Branch is derived from git, not stored, so mismatch is not a staleness signal.
  if (state.status === "paused") return "fresh";

  try {
    // Confirm we can read the current branch — failure implies a broken repo.
    getCurrentBranch(projectDir);
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

export const STEP_ORDER: StepType[] = [
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

function stepOrdinal(step: StepType | null): number {
  if (!step) return -1;
  return STEP_ORDER.indexOf(step);
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
  const wtOrdinal = stepOrdinal(workingTree.lastCompletedStep);
  const cmOrdinal = stepOrdinal(committed.lastCompletedStep);
  const chosen = wtOrdinal >= cmOrdinal ? workingTree : committed;

  // Validate: lastCommit SHA must exist in git history
  if (chosen.lastCommit.sha) {
    try {
      execSync(`git cat-file -t ${chosen.lastCommit.sha}`, {
        cwd: projectDir,
        stdio: "pipe",
      });
      return chosen;
    } catch {
      const fallback = chosen === workingTree ? committed : workingTree;
      if (fallback.lastCommit.sha) {
        try {
          execSync(`git cat-file -t ${fallback.lastCommit.sha}`, {
            cwd: projectDir,
            stdio: "pipe",
          });
          return fallback;
        } catch {
          return null;
        }
      }
      return fallback;
    }
  }

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

  // 1. Git lastCommit comparison
  if (state.lastCommit.sha) {
    try {
      const currentHead = getHeadSha(projectDir);
      if (currentHead !== state.lastCommit.sha) {
        const extra = countCommitsBetween(projectDir, state.lastCommit.sha, currentHead);
        driftSummary.extraCommits = extra;
        warnings.push(`${extra} commit(s) added since last orchestrator commit`);
        statePatches.lastCommit = { sha: currentHead, timestamp: new Date().toISOString() };
      }
    } catch {
      warnings.push("Could not compare last commit — proceeding with current state");
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
  let resumeStep = state.lastCompletedStep;
  let resumeCycle = state.currentCycleNumber;
  let resumePhase = state.currentPhase;
  let resumeSpecDir = state.currentSpecDir ?? undefined;

  // Check for clarified goal deletion/modification
  if (state.artifacts.clarifiedGoal) {
    const goalPath = state.artifacts.clarifiedGoal.path;
    if (driftSummary.missingArtifacts.includes(goalPath)) {
      resumePhase = "clarification";
      resumeStep = null;
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
        resumeStep = "specify" as StepType;
        warnings.push(`spec.md deleted for ${specDir} — resetting to specifying`);
      }
    } else if (feature.plan && driftSummary.missingArtifacts.includes(feature.plan.path)) {
      featurePatches[specDir] = { status: "planning", plan: null, tasks: null, lastImplementedPhase: 0 };
      if (state.currentSpecDir === specDir) {
        resumeStep = "plan" as StepType;
        warnings.push(`plan.md deleted for ${specDir} — resetting to planning`);
      }
    }

    // Task regressions → resume implement from earliest unchecked
    if (driftSummary.taskRegressions[specDir]?.length) {
      warnings.push(`Tasks unchecked in ${specDir} — will resume implement from earliest unchecked phase`);
      if (state.currentSpecDir === specDir) {
        resumeStep = "implement" as StepType;
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

  // Determine the next step to execute (the one after lastCompletedStep)
  let nextStep: StepType;
  if (!resumeStep) {
    nextStep = STEP_ORDER[0];
  } else {
    const idx = STEP_ORDER.indexOf(resumeStep);
    nextStep = idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : resumeStep;
  }

  const result: ReconciliationResult = {
    canResume: blockers.length === 0 || driftSummary.pendingQuestionReask,
    resumeFrom: {
      phase: resumePhase,
      cycleNumber: resumeCycle,
      step: nextStep,
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

// ── isLockedByAnother probe ──

export function isLockedByAnother(projectDir: string): boolean {
  const lp = lockPath(projectDir);
  try {
    const raw = fs.readFileSync(lp, "utf-8");
    const lock: LockFile = JSON.parse(raw);
    if (isLockStale(lock)) return false;
    return lock.pid !== process.pid;
  } catch {
    return false;
  }
}
