/**
 * What: Dex's runtime run state — `.dex/state.json` v2 (data-model.md § Run state): only what files cannot say (run id, status, cost, attempt counters, pending requests, the config snapshot). Atomic save, load (any other version reads as absent), merge-update, the advisory lock, and the `.dex/.gitignore` that keeps these files out of git.
 * Not: Holds no position cursor the picker could read from files — Resume runs the picker again, so there is nothing to reconcile. Runs no git command.
 * Deps: node:fs, node:path; types only from humanInput.ts, queue.ts, config.ts.
 */

import fs from "node:fs";
import path from "node:path";
import type { RunConfig } from "./config.js";
import type { AnswerBookItem, PendingRequest, ReviewItem } from "./humanInput.js";
import type { StageName } from "./queue.js";

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

export type PauseReason =
  | "user_abort"
  | "gate"
  | "question"
  | "tool_approval"
  | "dirty_tree"
  | "frozen_changed"
  | "preflight_failed"
  | "limit_reached"
  | "no_progress"
  | "invalid_input";

interface ConfigSnapshot {
  model: string;
  maxTurns: number;
  maxIterations: number;
  autoClarification?: boolean;
  /** Absolute path to the goal file, so Resume keeps the goal the run started with. */
  descriptionFile?: string;
}

export interface DexStateV2 {
  version: 2;
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  pauseReason?: PauseReason;
  /** Human-readable: which limit, which file, which command. */
  pauseDetail?: string;
  kind: "new" | "existing";
  /** New projects only: the single dex/<date>-<id> branch. */
  runBranch: string | null;
  /** The stage that ran last. Informational — the picker decides what is next. */
  current: { entryId: string; stage: StageName; taskPhase: number | null } | null;
  cumulativeCostUsd: number;
  /** Keyed by entry id. */
  counters: Record<string, { implementRunsWithoutProgress: number }>;
  pendingRequests: PendingRequest[];
  reviewList: ReviewItem[];
  answerBook: AnswerBookItem[];
  config: ConfigSnapshot;
  startedAt: string;
  pausedAt: string | null;
}

/** The on-disk run state. One name for callers that only care about "the state". */
export type DexState = DexStateV2;

interface LockFile {
  pid: number;
  timestamp: string;
}

// ── Paths ──

function statePath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, STATE_FILE);
}

function ensureStateDir(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, STATE_DIR), { recursive: true });
}

// ── Deep merge (arrays and null replace; objects merge) ──

function deepMerge<T>(target: T, patch: DeepPartial<T>): T {
  const result = { ...target } as Record<string, unknown>;
  for (const [key, patchVal] of Object.entries(patch as Record<string, unknown>)) {
    if (patchVal === undefined) continue;
    if (patchVal === null || Array.isArray(patchVal) || typeof patchVal !== "object") {
      result[key] = patchVal;
    } else {
      const base = (target as Record<string, unknown>)[key];
      result[key] = deepMerge(
        base && typeof base === "object" ? base : {},
        patchVal as DeepPartial<object>,
      );
    }
  }
  return result as T;
}

// ── Core I/O (sync inside, so a read-modify-write never interleaves) ──

/** The run state, read synchronously; null when absent, unreadable or not v2. */
export function readState(projectDir: string): DexStateV2 | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(projectDir), "utf-8"));
    return raw?.version === 2 ? (raw as DexStateV2) : null;
  } catch {
    return null;
  }
}

function writeState(projectDir: string, state: DexStateV2): void {
  ensureStateDir(projectDir);
  const tmp = path.join(projectDir, STATE_DIR, STATE_TMP);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, statePath(projectDir));
}

export async function saveState(projectDir: string, state: DexStateV2): Promise<void> {
  writeState(projectDir, state);
}

/** The v2 state, or null when the file is absent, unreadable or another version. */
export async function loadState(projectDir: string): Promise<DexStateV2 | null> {
  return readState(projectDir);
}

export async function updateState(
  projectDir: string,
  patch: DeepPartial<DexStateV2>,
): Promise<void> {
  mutateState(projectDir, (s) => deepMerge(s, patch));
}

/**
 * Synchronous read-modify-write. `fn` returns the next state. No-op when there
 * is no v2 state. Returns the state written, or null.
 */
export function mutateState(
  projectDir: string,
  fn: (state: DexStateV2) => DexStateV2,
): DexStateV2 | null {
  const current = readState(projectDir);
  if (!current) return null;
  const next = fn(current);
  writeState(projectDir, next);
  return next;
}

// ── Initial state ──

export function createInitialState(
  config: RunConfig,
  runId: string,
  run: { kind: DexStateV2["kind"]; runBranch: string | null },
): DexStateV2 {
  return {
    version: 2,
    runId,
    status: "running",
    kind: run.kind,
    runBranch: run.runBranch,
    current: null,
    cumulativeCostUsd: 0,
    counters: {},
    pendingRequests: [],
    reviewList: [],
    answerBook: [],
    config: {
      model: config.model,
      maxTurns: config.maxTurns,
      maxIterations: config.maxIterations,
      autoClarification: config.autoClarification,
      descriptionFile: config.descriptionFile,
    },
    startedAt: new Date().toISOString(),
    pausedAt: null,
  };
}

// ── Runtime ignore file ──

/** Dex's per-machine files under `.dex/`: never tracked, never a dirty tree. */
export const RUNTIME_IGNORE_ENTRIES = [
  "state.json",
  "state.json.tmp",
  "state.lock",
  "runs/",
  "questions.md",
  "ui.json",
] as const;

/**
 * Writes `.dex/.gitignore` listing Dex's runtime files — only when the file is
 * absent, so a project that edited it keeps its version. Runs no git command:
 * the human reviews and commits it like any other setup file.
 */
export function ensureRuntimeIgnore(projectDir: string): void {
  ensureStateDir(projectDir);
  const file = path.join(projectDir, STATE_DIR, ".gitignore");
  if (fs.existsSync(file)) return;
  const body = [
    "# Dex runtime files — local to this machine, never committed",
    ...RUNTIME_IGNORE_ENTRIES,
  ].join("\n");
  fs.writeFileSync(file, `${body}\n`, "utf-8");
}

// ── Advisory locking ──

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
  const lp = path.join(projectDir, STATE_DIR, LOCK_FILE);

  try {
    const existing: LockFile = JSON.parse(fs.readFileSync(lp, "utf-8"));
    if (!isLockStale(existing)) {
      throw new Error(
        `State lock held by PID ${existing.pid} (acquired at ${existing.timestamp}). Another Dex instance may be running on this project.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("State lock held")) throw err;
    // Lock file doesn't exist or is corrupt — proceed
  }

  const lockData: LockFile = { pid: process.pid, timestamp: new Date().toISOString() };
  fs.writeFileSync(lp, JSON.stringify(lockData), "utf-8");

  const release = () => {
    try {
      const current = JSON.parse(fs.readFileSync(lp, "utf-8")) as LockFile;
      if (current.pid === process.pid) fs.unlinkSync(lp);
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
