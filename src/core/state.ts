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

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

type PauseReason = "user_abort" | "step_mode" | "budget" | "failure";

interface DexUiPrefs {
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

interface ConfigSnapshot {
  model: string;
  maxLoopCycles?: number;
  maxBudgetUsd?: number;
  maxTurns: number;
  maxIterations: number;
  autoClarification?: boolean;
}

interface ArtifactManifest {
  goalFile: ArtifactEntry | null;
  clarifiedGoal: ArtifactEntry | null;
  productDomain: ArtifactEntry | null;
  technicalDomain: ArtifactEntry | null;
  constitution: ArtifactEntry | null;
  features: Record<string, FeatureArtifacts>;
}

interface ArtifactEntry {
  path: string;
  sha256: string;
  completedAt: string;
}

interface FeatureArtifacts {
  specDir: string;
  status: "specifying" | "planning" | "implementing" | "verifying" | "completed" | "skipped";
  spec: ArtifactEntry | null;
  plan: ArtifactEntry | null;
  tasks: TasksArtifact | null;
  lastImplementedPhase: number;
}

interface TasksArtifact extends ArtifactEntry {
  taskChecksums: Record<string, boolean>;
}

interface CheckpointRef {
  sha: string;
  timestamp: string;
}

interface PendingQuestion {
  id: string;
  question: string;
  context: string;
  askedAt: string;
}

interface ReconciliationResult {
  canResume: boolean;
  resumeFrom: ResumePoint;
  warnings: string[];
  blockers: string[];
  statePatches: DeepPartial<DexState>;
  driftSummary: DriftSummary;
}

interface ResumePoint {
  phase: Phase;
  cycleNumber: number;
  step: StepType;
  specDir?: string;
}

interface LockFile {
  pid: number;
  timestamp: string;
}

// ── Deep Merge ──

function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
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
  "completion",
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
//
// reconcileState detects drift between persisted state and the actual on-disk
// world (git, artifact files, tasks.md checkboxes, manifest, pending question).
// Each check below is independent and contributes warnings/blockers/patches
// into a single accumulator; they're composed sequentially in reconcileState.

interface DriftAccumulator {
  warnings: string[];
  blockers: string[];
  statePatches: DeepPartial<DexState>;
  driftSummary: DriftSummary;
  featurePatches: Record<string, DeepPartial<FeatureArtifacts>>;
}

function checkGitDrift(
  projectDir: string,
  state: DexState,
  acc: DriftAccumulator,
): void {
  if (!state.lastCommit.sha) return;
  try {
    const currentHead = getHeadSha(projectDir);
    if (currentHead === state.lastCommit.sha) return;
    const extra = countCommitsBetween(projectDir, state.lastCommit.sha, currentHead);
    acc.driftSummary.extraCommits = extra;
    acc.warnings.push(`${extra} commit(s) added since last orchestrator commit`);
    acc.statePatches.lastCommit = { sha: currentHead, timestamp: new Date().toISOString() };
  } catch {
    acc.warnings.push("Could not compare last commit — proceeding with current state");
  }
}

async function checkArtifactDrift(
  projectDir: string,
  state: DexState,
  acc: DriftAccumulator,
): Promise<void> {
  const artifactChecks: Array<{ entry: ArtifactEntry }> = [];

  const topLevel: Array<ArtifactEntry | null> = [
    state.artifacts.goalFile,
    state.artifacts.clarifiedGoal,
    state.artifacts.productDomain,
    state.artifacts.technicalDomain,
    state.artifacts.constitution,
  ];
  for (const entry of topLevel) {
    if (entry) artifactChecks.push({ entry });
  }
  for (const feature of Object.values(state.artifacts.features)) {
    if (feature.spec) artifactChecks.push({ entry: feature.spec });
    if (feature.plan) artifactChecks.push({ entry: feature.plan });
    if (feature.tasks) artifactChecks.push({ entry: feature.tasks });
  }

  // Parallel hash check — preserved as deliberate optimization.
  const hashResults = await Promise.all(
    artifactChecks.map(async ({ entry }) => {
      const fullPath = path.join(projectDir, entry.path);
      if (!fs.existsSync(fullPath)) return { entry, status: "missing" as const };
      const currentHash = await hashFile(fullPath);
      if (currentHash !== entry.sha256) return { entry, status: "modified" as const };
      return { entry, status: "ok" as const };
    }),
  );

  for (const result of hashResults) {
    if (result.status === "missing") acc.driftSummary.missingArtifacts.push(result.entry.path);
    else if (result.status === "modified") acc.driftSummary.modifiedArtifacts.push(result.entry.path);
  }
}

function checkTaskDrift(
  projectDir: string,
  state: DexState,
  acc: DriftAccumulator,
): void {
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

    if (regressions.length > 0) acc.driftSummary.taskRegressions[specDir] = regressions;
    if (progressions.length > 0) acc.driftSummary.taskProgressions[specDir] = progressions;
  }
}

function checkPendingQuestionDrift(state: DexState, acc: DriftAccumulator): void {
  if (!state.pendingQuestion) return;
  acc.driftSummary.pendingQuestionReask = true;
  acc.blockers.push(
    `Pending question from ${state.pendingQuestion.context}: "${state.pendingQuestion.question}"`,
  );
}

interface ResumeCursor {
  phase: Phase;
  cycleNumber: number;
  step: StepType | null;
  specDir: string | undefined;
}

/**
 * Apply per-feature drift decisions to determine resume cursor and feature
 * patches: deleted spec → reset to specifying, deleted plan → reset to
 * planning, regressed tasks → resume implement, etc.
 */
function deriveResumeCursor(state: DexState, acc: DriftAccumulator): ResumeCursor {
  const cursor: ResumeCursor = {
    phase: state.currentPhase,
    cycleNumber: state.currentCycleNumber,
    step: state.lastCompletedStep,
    specDir: state.currentSpecDir ?? undefined,
  };

  if (state.artifacts.clarifiedGoal) {
    const goalPath = state.artifacts.clarifiedGoal.path;
    if (acc.driftSummary.missingArtifacts.includes(goalPath)) {
      cursor.phase = "clarification";
      cursor.step = null;
      acc.warnings.push("GOAL_clarified.md deleted — resetting to clarification phase");
    } else if (acc.driftSummary.modifiedArtifacts.includes(goalPath)) {
      acc.blockers.push(
        "GOAL_clarified.md was modified. Re-run gap analysis? Choose: re-run or accept.",
      );
    }
  }

  if (
    state.artifacts.constitution &&
    acc.driftSummary.missingArtifacts.includes(state.artifacts.constitution.path)
  ) {
    acc.warnings.push("constitution.md deleted — will re-run constitution before next cycle");
  }

  for (const [specDir, feature] of Object.entries(state.artifacts.features)) {
    if (feature.spec && acc.driftSummary.missingArtifacts.includes(feature.spec.path)) {
      acc.featurePatches[specDir] = {
        status: "specifying",
        spec: null,
        plan: null,
        tasks: null,
        lastImplementedPhase: 0,
      };
      if (state.currentSpecDir === specDir) {
        cursor.step = "specify" as StepType;
        acc.warnings.push(`spec.md deleted for ${specDir} — resetting to specifying`);
      }
    } else if (feature.plan && acc.driftSummary.missingArtifacts.includes(feature.plan.path)) {
      acc.featurePatches[specDir] = {
        status: "planning",
        plan: null,
        tasks: null,
        lastImplementedPhase: 0,
      };
      if (state.currentSpecDir === specDir) {
        cursor.step = "plan" as StepType;
        acc.warnings.push(`plan.md deleted for ${specDir} — resetting to planning`);
      }
    }

    if (acc.driftSummary.taskRegressions[specDir]?.length) {
      acc.warnings.push(
        `Tasks unchecked in ${specDir} — will resume implement from earliest unchecked phase`,
      );
      if (state.currentSpecDir === specDir) cursor.step = "implement" as StepType;
    }
    if (acc.driftSummary.taskProgressions[specDir]?.length) {
      acc.warnings.push(`Tasks manually checked in ${specDir} — accepting progression`);
    }
  }

  return cursor;
}

/**
 * Sync FeatureArtifacts entries with feature-manifest.json — manifest is
 * authoritative for active/completed status. Failure is non-fatal.
 */
function reconcileWithManifest(
  projectDir: string,
  state: DexState,
  acc: DriftAccumulator,
): void {
  try {
    const manifestPath = path.join(projectDir, ".dex", "feature-manifest.json");
    if (!fs.existsSync(manifestPath)) return;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!manifest?.features || !Array.isArray(manifest.features)) return;

    for (const entry of manifest.features) {
      if (entry.status === "active" && entry.specDir && !state.artifacts.features[entry.specDir]) {
        acc.featurePatches[entry.specDir] = {
          specDir: entry.specDir,
          status: "specifying",
          spec: null,
          plan: null,
          tasks: null,
          lastImplementedPhase: 0,
        };
        acc.warnings.push(
          `Manifest reconciliation: created FeatureArtifacts for ${entry.specDir} (manifest says active)`,
        );
      } else if (
        entry.status === "completed" &&
        entry.specDir &&
        state.artifacts.features[entry.specDir]
      ) {
        const fa = state.artifacts.features[entry.specDir];
        if (fa.status !== "completed") {
          acc.featurePatches[entry.specDir] = { status: "completed" };
          acc.warnings.push(
            `Manifest reconciliation: updated ${entry.specDir} to completed (manifest says completed)`,
          );
        }
      }
    }
  } catch {
    // Non-fatal.
  }
}

function computeNextStep(resumeStep: StepType | null): StepType {
  if (!resumeStep) return STEP_ORDER[0];
  const idx = STEP_ORDER.indexOf(resumeStep);
  return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : resumeStep;
}

export async function reconcileState(
  projectDir: string,
  state: DexState,
  emit?: EmitFn,
  runId?: string,
): Promise<ReconciliationResult> {
  if (emit && runId) {
    emit({ type: "state_reconciling", runId } as never);
  }

  const acc: DriftAccumulator = {
    warnings: [],
    blockers: [],
    statePatches: {},
    featurePatches: {},
    driftSummary: {
      missingArtifacts: [],
      modifiedArtifacts: [],
      taskRegressions: {},
      taskProgressions: {},
      extraCommits: 0,
      pendingQuestionReask: false,
    },
  };

  // Order matters: artifact drift populates missingArtifacts/modifiedArtifacts
  // which deriveResumeCursor reads to make per-feature decisions.
  checkGitDrift(projectDir, state, acc);
  await checkArtifactDrift(projectDir, state, acc);
  checkTaskDrift(projectDir, state, acc);
  checkPendingQuestionDrift(state, acc);

  const cursor = deriveResumeCursor(state, acc);
  reconcileWithManifest(projectDir, state, acc);

  if (Object.keys(acc.featurePatches).length > 0) {
    acc.statePatches.artifacts = { features: acc.featurePatches as never };
  }

  const result: ReconciliationResult = {
    canResume: acc.blockers.length === 0 || acc.driftSummary.pendingQuestionReask,
    resumeFrom: {
      phase: cursor.phase,
      cycleNumber: cursor.cycleNumber,
      step: computeNextStep(cursor.step),
      specDir: cursor.specDir,
    },
    warnings: acc.warnings,
    blockers: acc.blockers,
    statePatches: acc.statePatches,
    driftSummary: acc.driftSummary,
  };

  if (emit && runId) {
    emit({ type: "state_reconciled", runId, driftSummary: acc.driftSummary } as never);
  }

  return result;
}

