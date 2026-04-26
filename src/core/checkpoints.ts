import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { StepType } from "./types.js";
import { applyOverlay } from "./agent-overlay.js";
import type { AgentProfile } from "./agent-profile.js";
import { updateState, loadState } from "./state.js";
import type { EmitFn } from "./events.js";

// ── Constants ────────────────────────────────────────────

export const CHECKPOINT_MESSAGE_PREFIX = "[checkpoint:";

const PARALLELIZABLE_STEPS: StepType[] = [
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "learnings",
];

// ── Minimal runlogger shape ──────────────────────────────

interface RunLoggerLike {
  run?: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, data?: unknown) => void;
}

function log(
  rlog: RunLoggerLike | undefined,
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  msg: string,
  extra?: unknown,
): void {
  if (rlog?.run) {
    if (extra === undefined) rlog.run(level, msg);
    else rlog.run(level, msg, extra);
  }
}

// ── Git exec helper (local to this module) ───────────────

function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

// ── Naming ───────────────────────────────────────────────

const slug = (s: string): string => s.replaceAll("_", "-");

export function checkpointTagFor(step: StepType, cycleNumber: number): string {
  if (cycleNumber === 0) return `checkpoint/after-${slug(step)}`;
  return `checkpoint/cycle-${cycleNumber}-after-${slug(step)}`;
}

export function checkpointDoneTag(runId: string): string {
  return `checkpoint/done-${runId.slice(0, 6)}`;
}

export function captureBranchName(runId: string, date: Date = new Date()): string {
  return `capture/${date.toISOString().slice(0, 10)}-${runId.slice(0, 6)}`;
}

/**
 * 010 — name for a transient navigation fork created by click-to-jump.
 * Distinct from `attempt-<ts>` (008's "Try Again" / "Go back" intent) and
 * `attempt-<ts>-{a,b,c}` (variant slots). The auto-prune logic specifically
 * targets this prefix so navigation forks don't accumulate, while 008's
 * intentional attempt-* branches stay around until the user removes them.
 */
function selectedBranchName(date: Date = new Date()): string {
  const stamp = date.toISOString().replaceAll(/[:.-]/g, "").slice(0, 15);
  return `selected-${stamp}`;
}

export function attemptBranchName(date: Date = new Date(), variant?: string): string {
  const stamp = date.toISOString().replaceAll(/[:.-]/g, "").slice(0, 15);
  return variant ? `attempt-${stamp}-${variant}` : `attempt-${stamp}`;
}

const PRETTY_LABELS: Record<StepType, string> = {
  prerequisites: "prerequisites done",
  create_branch: "branch created",
  clarification: "clarifications done",
  clarification_product: "product questions answered",
  clarification_technical: "technical questions answered",
  clarification_synthesis: "requirements synthesized",
  constitution: "constitution drafted",
  manifest_extraction: "features identified",
  gap_analysis: "gap analysis done",
  specify: "spec written",
  plan: "plan written",
  tasks: "tasks generated",
  implement: "implementation done",
  implement_fix: "fixes applied",
  verify: "verification done",
  learnings: "learnings captured",
  commit: "checkpoint saved",
};

export function labelFor(
  step: StepType,
  cycleNumber: number,
  featureSlug?: string | null
): string {
  const pretty = PRETTY_LABELS[step] ?? step;
  if (cycleNumber === 0) return pretty;
  const feature = featureSlug ? ` · ${featureSlug}` : "";
  return `cycle ${cycleNumber}${feature} · ${pretty}`;
}

export function isParallelizable(step: StepType): boolean {
  return PARALLELIZABLE_STEPS.includes(step);
}

/**
 * Files that materially change in each step — used for path-filtered diffs
 * when comparing two attempts ("show me what changed at the spec level vs.
 * everywhere"). Steps absent from this map fall through to a `--stat` diff.
 */
export const PATHS_BY_STEP: Partial<Record<StepType, string[]>> = {
  gap_analysis: [".dex/feature-manifest.json"],
  manifest_extraction: [".dex/feature-manifest.json"],
  specify: ["specs/"],
  plan: ["specs/"],
  tasks: ["specs/"],
  learnings: [".dex/learnings.md"],
  verify: [".dex/verify-output/"],
};

// ── Promotion ────────────────────────────────────────────

export function promoteToCheckpoint(
  projectDir: string,
  tag: string,
  candidateSha: string,
  rlog?: RunLoggerLike
): { ok: true } | { ok: false; error: string } {
  try {
    gitExec(`git rev-parse --verify ${candidateSha}`, projectDir);
    gitExec(`git tag -f ${tag} ${candidateSha}`, projectDir);
    log(rlog, "INFO", `promoteToCheckpoint: ${tag} → ${candidateSha.slice(0, 7)}`);
    return { ok: true };
  } catch (err) {
    log(rlog, "WARN", `promoteToCheckpoint failed for ${tag}: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

/**
 * Read the per-project record-mode flag (`.dex/state.json` `ui.recordMode`).
 * Returns false on any IO error.
 */
export async function readRecordMode(projectDir: string): Promise<boolean> {
  try {
    const s = await loadState(projectDir);
    return Boolean(s?.ui?.recordMode);
  } catch {
    return false;
  }
}

/**
 * If record mode is on (env var DEX_RECORD_MODE=1 or `.dex/state.json`
 * `ui.recordMode === true`), promote `candidateSha` to `checkpointTag` and
 * emit a `checkpoint_promoted` event. No-op otherwise. The orchestrator
 * calls this after each step's commit candidate so a "record" session
 * captures every step as a canonical checkpoint without manual promotion.
 */
export async function autoPromoteIfRecordMode(
  projectDir: string,
  checkpointTag: string,
  candidateSha: string,
  runId: string,
  emit: EmitFn,
  rlog?: RunLoggerLike,
): Promise<void> {
  const recordMode =
    process.env.DEX_RECORD_MODE === "1" || (await readRecordMode(projectDir));
  if (!recordMode) return;
  const result = promoteToCheckpoint(projectDir, checkpointTag, candidateSha, rlog);
  if (result.ok) {
    emit({ type: "checkpoint_promoted", runId, checkpointTag, sha: candidateSha });
  }
}

// ── Sync state from HEAD (010 — Timeline-driven Resume) ─────

/**
 * Read HEAD's commit subject; if it's a canonical step-commit, write the
 * derived position cursor into `<projectDir>/.dex/state.json`. After a
 * Timeline-driven jumpTo + this sync, the orchestrator's existing Resume
 * flow picks up from wherever the user navigated rather than where state.json
 * was last frozen. No-op when HEAD isn't on a step-commit (e.g., main's tip).
 */
export async function syncStateFromHead(
  projectDir: string,
  rlog?: RunLoggerLike,
): Promise<{ ok: true; updated: boolean; step?: StepType; cycle?: number } | { ok: false; error: string }> {
  let subject: string;
  try {
    subject = gitExec(`git log -1 --format=%s HEAD`, projectDir);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  // Subject pattern: `dex: <step> completed [cycle:N] [feature:<slug-or-->]`
  const m = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\](?: \[feature:([^\]]+)\])?/);
  if (!m) {
    log(rlog, "INFO", `syncStateFromHead: HEAD is not a step-commit, leaving state.json alone`);
    return { ok: true, updated: false };
  }
  const step = m[1] as StepType;
  const cycleNumber = Number(m[2]);
  const featureSlug = m[3] ?? "-";

  const patch: Parameters<typeof updateState>[1] = {
    lastCompletedStep: step,
    currentCycleNumber: cycleNumber,
    cyclesCompleted: step === "learnings" ? cycleNumber : Math.max(0, cycleNumber - 1),
    // Pause the run so the orchestrator's resume flow takes the resume path.
    status: "paused",
    pausedAt: new Date().toISOString(),
  };
  if (featureSlug && featureSlug !== "-") {
    patch.currentSpecDir = featureSlug;
  }

  try {
    await updateState(projectDir, patch);
    log(rlog, "INFO", `syncStateFromHead: synced step=${step} cycle=${cycleNumber} feature=${featureSlug}`);
    return { ok: true, updated: true, step, cycle: cycleNumber };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Unselect (010 — drop a `selected-*` navigation fork) ──────

/**
 * Drop a `selected-<ts>` navigation fork. If HEAD is currently on it, switch
 * first to the most "natural" parent branch — main / master, then any `dex/*`
 * containing the SHA, then any other non-`selected-*` branch — and only then
 * delete it. Refuses to act on non-`selected-*` branches.
 */
export function unselect(
  projectDir: string,
  branchName: string,
  rlog?: RunLoggerLike,
): { ok: true; switchedTo: string | null; deleted: string } | { ok: false; error: string } {
  if (!branchName.startsWith("selected-")) {
    return { ok: false, error: "only selected-* branches can be unselected" };
  }
  let switchedTo: string | null = null;
  try {
    const current = gitExec(`git rev-parse --abbrev-ref HEAD`, projectDir);
    if (current === branchName) {
      // HEAD is on this branch; switch to a natural parent before deleting.
      const sha = gitExec(`git rev-parse HEAD`, projectDir);
      const containingRaw = safeExec(
        `git for-each-ref --contains ${sha} --format='%(refname:short)' refs/heads/`,
        projectDir,
      );
      const containing = containingRaw
        .split("\n")
        .filter((b) => Boolean(b) && b !== branchName && !b.startsWith("selected-"));
      const preferred =
        containing.find((b) => b === "main" || b === "master") ??
        containing.find((b) => b.startsWith("dex/")) ??
        containing[0];
      if (!preferred) {
        return { ok: false, error: "no parent branch contains this commit" };
      }
      gitExec(`git checkout -q ${preferred}`, projectDir);
      switchedTo = preferred;
    }
    gitExec(`git branch -D ${branchName}`, projectDir);
    log(rlog, "INFO", `unselect: deleted ${branchName}${switchedTo ? ` (switched to ${switchedTo})` : ""}`);
    return { ok: true, switchedTo, deleted: branchName };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Unmark kept (010 right-click verb) ───────────────────

/**
 * Delete every canonical step-commit checkpoint tag (matching the
 * `checkpoint/[cycle-N-]after-<step>` shape) that points at `sha`. System
 * tags like `checkpoint/done-*` are left alone — those mark whole-run
 * lifecycle, not individual stages.
 */
export function unmarkCheckpoint(
  projectDir: string,
  sha: string,
  rlog?: RunLoggerLike,
): { ok: true; deleted: string[] } | { ok: false; error: string } {
  try {
    const tagsRaw = gitExec(`git tag --points-at ${sha}`, projectDir);
    const tags = tagsRaw.split("\n").filter(Boolean);
    const canonical = tags.filter((t) => parseCheckpointTag(t) !== null);
    const deleted: string[] = [];
    for (const tag of canonical) {
      try {
        gitExec(`git tag -d ${tag}`, projectDir);
        deleted.push(tag);
      } catch (err) {
        log(rlog, "WARN", `unmarkCheckpoint: failed to delete ${tag}: ${String(err)}`);
      }
    }
    log(rlog, "INFO", `unmarkCheckpoint: ${sha.slice(0, 7)} deleted=${deleted.length}`);
    return { ok: true, deleted };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ── Jump-to (010) ────────────────────────────────────────

export type JumpToResult =
  | { ok: true; action: "noop" }
  | { ok: true; action: "checkout"; branch: string }
  | { ok: true; action: "fork"; branch: string }
  | { ok: false; error: "dirty_working_tree"; files: string[] }
  | { ok: false; error: "not_found"; message: string }
  | { ok: false; error: "git_error"; message: string };

/**
 * Click-to-jump core for the 010 Timeline canvas.
 *
 * Decision tree (matches contracts/ipc-checkpoints-jumpTo.md):
 *  1. target == HEAD          → noop
 *  2. dirty tree, no force    → dirty_working_tree
 *  3. dirty tree, force=save  → save dirty change on attempt-<ts>-saved branch
 *  4. dirty tree, force=disc  → reset --hard + clean -fd (preserves gitignored)
 *  5. unresolvable target     → not_found
 *  6. unique branch tip       → git checkout <branch>
 *  7. otherwise               → git checkout -B attempt-<ts> <target>
 */
export function jumpTo(
  projectDir: string,
  targetSha: string,
  options?: { force?: "save" | "discard" },
  rlog?: RunLoggerLike,
): JumpToResult {
  // 1. HEAD no-op
  let head: string;
  try {
    head = gitExec(`git rev-parse HEAD`, projectDir);
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  if (targetSha === head) {
    return { ok: true, action: "noop" };
  }

  // 5. Resolve target SHA before doing anything destructive.
  let resolved: string;
  try {
    resolved = gitExec(`git rev-parse --verify ${targetSha}^{commit}`, projectDir);
  } catch (err) {
    return { ok: false, error: "not_found", message: String(err) };
  }
  if (resolved === head) {
    // Resolved to HEAD via abbreviated SHA / ref. Treat as noop.
    return { ok: true, action: "noop" };
  }

  // 2-4. Dirty-tree handling. Per spec FR-011, only **tracked** file
  // modifications block a jump — untracked noise (e.g. Dex's own runtime
  // `.dex/state.lock` PID file) must not be confused for unsaved work.
  // Use raw execSync (not gitExec/trim) — porcelain status leads with a space
  // for unstaged modifications; trimming would corrupt the slice(3) parse below.
  let dirtyTracked: { dirty: boolean; files: string[] };
  try {
    const out = execSync(`git status --porcelain --untracked-files=no`, {
      cwd: projectDir,
      encoding: "utf-8",
    });
    const lines = out.split("\n").filter((l) => l.length > 0);
    dirtyTracked = { dirty: lines.length > 0, files: lines.map((l) => l.slice(3)) };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  if (dirtyTracked.dirty) {
    if (!options?.force) {
      return { ok: false, error: "dirty_working_tree", files: dirtyTracked.files };
    }
    if (options.force === "save") {
      const saveBranch = attemptBranchName(new Date()) + "-saved";
      try {
        gitExec(`git checkout -B ${saveBranch}`, projectDir);
        gitExec(`git add -A`, projectDir);
        gitExec(`git commit -q -m "dex: dirty-tree autosave before jumpTo"`, projectDir);
        // Return to whatever branch we came from before forking. We don't know the
        // original ref, so instead just continue from the saved branch — the next
        // step will move HEAD anyway and the dirty change is preserved on saveBranch.
        log(rlog, "INFO", `jumpTo: saved dirty tree on ${saveBranch}`);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    } else if (options.force === "discard") {
      try {
        gitExec(`git reset --hard HEAD`, projectDir);
        // Same -fd hygiene as startAttemptFrom — preserve gitignored files.
        gitExec(`git clean -fd -e .dex/state.lock`, projectDir);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    }
  }

  // Capture the branch we were on so we can auto-prune it (if empty + transient)
  // after HEAD moves. Click-by-click navigation should NOT leave a trail of
  // empty selected-<ts> branches behind.
  const previousBranch = safeExec(`git rev-parse --abbrev-ref HEAD`, projectDir);

  // 6. Unique branch tip → checkout that branch.
  let tipsRaw: string;
  try {
    tipsRaw = gitExec(
      `git for-each-ref --points-at ${resolved} --format='%(refname:short)' refs/heads/`,
      projectDir,
    );
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  const tips = tipsRaw.split("\n").filter(Boolean);
  if (tips.length === 1) {
    try {
      gitExec(`git checkout -q ${tips[0]}`, projectDir);
      log(rlog, "INFO", `jumpTo: checkout ${tips[0]} @ ${resolved.slice(0, 7)}`);
      maybePruneEmptySelected(projectDir, previousBranch, tips[0], rlog);
      return { ok: true, action: "checkout", branch: tips[0] };
    } catch (err) {
      return { ok: false, error: "git_error", message: String(err) };
    }
  }

  // 7. Mid-branch ancestor or tip-of-multiple → fork a `selected-<ts>` branch
  //    at the target. Distinct from 008's `attempt-<ts>` (Try Again / Go back)
  //    so navigation forks don't get conflated with intentional retries.
  const branch = selectedBranchName(new Date());
  try {
    gitExec(`git checkout -B ${branch} ${resolved}`, projectDir);
    log(rlog, "INFO", `jumpTo: fork ${branch} @ ${resolved.slice(0, 7)}`);
    maybePruneEmptySelected(projectDir, previousBranch, branch, rlog);
    return { ok: true, action: "fork", branch };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
}

/**
 * If the previously-checked-out branch is a transient `selected-<ts>` (010
 * click-to-jump fork) with no commits the new branch doesn't already have,
 * delete it. Click-by-click navigation thus doesn't leave dead branches.
 *
 * 008 `attempt-*` branches (Try Again / Go back / variants) are NOT pruned —
 * those carry intentional user retry intent.
 */
function maybePruneEmptySelected(
  projectDir: string,
  previousBranch: string,
  newBranch: string,
  rlog: RunLoggerLike | undefined,
): void {
  if (!previousBranch) return;
  if (previousBranch === newBranch) return;
  if (!previousBranch.startsWith("selected-")) return;

  const reachable = safeExec(
    `git log ${previousBranch} --format=%H ^${newBranch}`,
    projectDir,
  )
    .split("\n")
    .filter(Boolean);
  if (reachable.length > 0) return; // has commits the new branch doesn't — keep

  try {
    gitExec(`git branch -D ${previousBranch}`, projectDir);
    log(rlog, "INFO", `jumpTo: auto-pruned empty ${previousBranch}`);
  } catch {
    // Best-effort cleanup — never fail the jump for this.
  }
}

// ── Variants ─────────────────────────────────────────────

export interface VariantSpawnRequest {
  fromCheckpoint: string;
  variantLetters: string[];
  step: StepType;
  /**
   * Per-variant agent profile binding (010 — US4). When omitted, every variant
   * runs with `null` (orchestrator defaults, no overlay). Sparse-tolerant:
   * missing letters default to null. Codex/Copilot profiles cause the spawn
   * to early-fail with `"runner not implemented"`.
   */
  profiles?: Array<{
    letter: string;
    profile: AgentProfile | null;
  }>;
}

export interface VariantSpawnResult {
  groupId: string;
  branches: string[];
  worktrees: string[] | null;
  parallel: boolean;
}

/**
 * Resolve a per-variant profile binding from `request.profiles`. Sparse-tolerant
 * — if `profiles` is undefined or the letter is missing, returns null (variant
 * uses orchestrator defaults / no overlay).
 */
function profileFor(request: VariantSpawnRequest, letter: string): AgentProfile | null {
  if (!request.profiles) return null;
  return request.profiles.find((p) => p.letter === letter)?.profile ?? null;
}

export function spawnVariants(
  projectDir: string,
  request: VariantSpawnRequest,
  rlog?: RunLoggerLike
): { ok: true; result: VariantSpawnResult } | { ok: false; error: string } {
  // 010 — Codex/Copilot profiles are stubbed but not wired through any runner
  // yet. Reject early so the spawn doesn't half-succeed and leave dangling
  // worktrees/branches the variant-group state would have to track.
  if (request.profiles) {
    for (const p of request.profiles) {
      if (p.profile && p.profile.agentRunner !== "claude-sdk") {
        log(rlog, "WARN", `spawnVariants: profile '${p.profile.name}' uses ${p.profile.agentRunner} — runner not implemented`);
        return { ok: false, error: "runner not implemented" };
      }
    }
  }

  const ts = new Date();
  const groupId = crypto.randomUUID();
  const branches: string[] = [];
  const worktrees: string[] = [];
  const parallel = isParallelizable(request.step);

  try {
    for (const letter of request.variantLetters) {
      const branch = attemptBranchName(ts, letter);
      if (parallel) {
        const wtPath = `.dex/worktrees/${branch}`;
        gitExec(
          `git worktree add -b ${branch} ${wtPath} ${request.fromCheckpoint}`,
          projectDir
        );
        branches.push(branch);
        worktrees.push(wtPath);
        // 010 — overlay the profile's runner-native subdir into the worktree.
        // Skipped for sequential stages (no worktree) and for variants without
        // a profile or without a runner-native subdir.
        const profile = profileFor(request, letter);
        if (profile) {
          try {
            applyOverlay(path.join(projectDir, wtPath), profile);
          } catch (err) {
            log(rlog, "WARN", `spawnVariants: applyOverlay for ${letter} failed: ${String(err)}`);
          }
        }
      } else {
        gitExec(`git branch ${branch} ${request.fromCheckpoint}`, projectDir);
        branches.push(branch);
      }
    }
    log(rlog, "INFO", `spawnVariants: ${groupId} step=${request.step} parallel=${parallel} branches=${branches.length}`);
    return {
      ok: true,
      result: {
        groupId,
        branches,
        worktrees: parallel ? worktrees : null,
        parallel,
      },
    };
  } catch (err) {
    // Rollback partial success
    for (const wt of worktrees) {
      try {
        gitExec(`git worktree remove --force ${wt}`, projectDir);
      } catch {
        // ignore
      }
    }
    for (const b of branches) {
      try {
        gitExec(`git branch -D ${b}`, projectDir);
      } catch {
        // ignore
      }
    }
    log(rlog, "WARN", `spawnVariants failed + rolled back: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

export function cleanupVariantWorktree(projectDir: string, worktreePath: string): void {
  try {
    gitExec(`git worktree remove --force ${worktreePath}`, projectDir);
  } catch {
    // Already removed or never existed — fine.
  }
}

// ── Listing ──────────────────────────────────────────────

export interface CheckpointInfo {
  tag: string;
  label: string;
  sha: string;
  step: StepType;
  cycleNumber: number;
  featureSlug: string | null;
  commitMessage: string;
  timestamp: string;
  unavailable?: boolean;
}

export interface AttemptInfo {
  branch: string;
  sha: string;
  isCurrent: boolean;
  baseCheckpoint: string | null;
  stepsAhead: number;
  timestamp: string;
  variantGroup: string | null;
}

export interface PendingCandidate {
  checkpointTag: string;
  candidateSha: string;
  step: StepType;
  cycleNumber: number;
}

export interface StartingPoint {
  branch: string;
  sha: string;
  shortSha: string;
  subject: string;
  timestamp: string;
}

/**
 * One step-commit on the canvas — a commit whose subject matches
 * `[checkpoint:<step>:<cycle>]`. Mid-stage WIP commits are filtered out
 * upstream and never appear here.
 */
export interface TimelineCommit {
  sha: string;
  shortSha: string;
  branch: string;
  parentSha: string | null;
  step: StepType;
  cycleNumber: number;
  subject: string;
  timestamp: string;
  hasCheckpointTag: boolean;
}

export interface TimelineSnapshot {
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];
  startingPoint: StartingPoint | null;
  /** Every step-commit reachable from any tracked branch, sorted ascending by timestamp. */
  commits: TimelineCommit[];
  /** Step-commit SHAs from the run's starting-point to current HEAD, oldest-first. */
  selectedPath: string[];
}

const TAG_RE_CYCLE = /^checkpoint\/cycle-(\d+)-after-(.+)$/;
const TAG_RE_BARE = /^checkpoint\/after-(.+)$/;

function parseCheckpointTag(
  tag: string
): { step: StepType; cycleNumber: number } | null {
  const cycleMatch = tag.match(TAG_RE_CYCLE);
  if (cycleMatch) {
    const cycleNumber = Number(cycleMatch[1]);
    const step = cycleMatch[2].replaceAll("-", "_") as StepType;
    return { step, cycleNumber };
  }
  const bareMatch = tag.match(TAG_RE_BARE);
  if (bareMatch) {
    const step = bareMatch[1].replaceAll("-", "_") as StepType;
    return { step, cycleNumber: 0 };
  }
  return null;
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return gitExec(cmd, cwd);
  } catch {
    return "";
  }
}

export function listTimeline(projectDir: string): TimelineSnapshot {
  const checkpoints: CheckpointInfo[] = [];
  const attempts: AttemptInfo[] = [];
  const pending: PendingCandidate[] = [];
  const captureBranches: string[] = [];
  let currentAttempt: AttemptInfo | null = null;

  // Current branch + HEAD SHA
  const currentBranch = safeExec(`git rev-parse --abbrev-ref HEAD`, projectDir);

  // Checkpoints — tags
  const tagsRaw = safeExec(`git tag --list 'checkpoint/*'`, projectDir);
  for (const tag of tagsRaw.split("\n").filter(Boolean)) {
    // Skip checkpoint/done-* tags — they aren't stage checkpoints
    if (tag.startsWith("checkpoint/done-")) {
      // Treat done tags as pseudo-checkpoint entries with sentinel values
      const sha = safeExec(`git rev-list -n 1 ${tag}`, projectDir);
      const message = safeExec(`git log -1 --format=%B ${tag}`, projectDir);
      const when = safeExec(`git log -1 --format=%cI ${tag}`, projectDir);
      checkpoints.push({
        tag,
        label: "run completed",
        sha,
        step: "learnings",
        cycleNumber: -1,
        featureSlug: null,
        commitMessage: message,
        timestamp: when,
      });
      continue;
    }
    const parsed = parseCheckpointTag(tag);
    if (!parsed) continue;
    const sha = safeExec(`git rev-list -n 1 ${tag}`, projectDir);
    if (!sha) {
      checkpoints.push({
        tag,
        label: `${tag} (unavailable)`,
        sha: "",
        step: parsed.step,
        cycleNumber: parsed.cycleNumber,
        featureSlug: null,
        commitMessage: "",
        timestamp: "",
        unavailable: true,
      });
      continue;
    }
    const message = safeExec(`git log -1 --format=%B ${tag}`, projectDir);
    const when = safeExec(`git log -1 --format=%cI ${tag}`, projectDir);
    const featureMatch = message.match(/\[feature:([\w-]+)\]/);
    const featureSlug = featureMatch && featureMatch[1] !== "-" ? featureMatch[1] : null;
    checkpoints.push({
      tag,
      label: labelFor(parsed.step, parsed.cycleNumber, featureSlug),
      sha,
      step: parsed.step,
      cycleNumber: parsed.cycleNumber,
      featureSlug,
      commitMessage: message,
      timestamp: when,
    });
  }

  // Attempts — attempt-* branches
  const branchesRaw = safeExec(`git branch --list 'attempt-*' --format='%(refname:short)'`, projectDir);
  for (const branch of branchesRaw.split("\n").filter(Boolean)) {
    const sha = safeExec(`git rev-parse ${branch}`, projectDir);
    const when = safeExec(`git log -1 --format=%cI ${branch}`, projectDir);
    const variantMatch = branch.match(/-(?<letter>[a-e])$/);
    const variantGroup = variantMatch ? (variantMatch.groups?.letter ?? null) : null;

    // Find nearest ancestor checkpoint
    let baseCheckpoint: string | null = null;
    try {
      const nearest = safeExec(`git describe --tags --match 'checkpoint/*' --abbrev=0 ${sha}`, projectDir);
      baseCheckpoint = nearest || null;
    } catch {
      baseCheckpoint = null;
    }

    let stepsAhead = 0;
    if (baseCheckpoint) {
      try {
        const count = safeExec(`git rev-list --count ${baseCheckpoint}..${branch}`, projectDir);
        stepsAhead = parseInt(count, 10) || 0;
      } catch {
        stepsAhead = 0;
      }
    }

    const info: AttemptInfo = {
      branch,
      sha,
      isCurrent: branch === currentBranch,
      baseCheckpoint,
      stepsAhead,
      timestamp: when,
      variantGroup,
    };
    attempts.push(info);
    if (info.isCurrent) currentAttempt = info;
  }

  // Capture branches
  const captureRaw = safeExec(`git branch --list 'capture/*' --format='%(refname:short)'`, projectDir);
  for (const b of captureRaw.split("\n").filter(Boolean)) {
    captureBranches.push(b);
  }

  // Pending candidates — commits with [checkpoint:<stage>:<cycle>] reachable from
  // HEAD that have no matching tag. Scoped to HEAD (not --all) so orphan commits
  // on stale dex/* or attempt-* branches from previous runs don't leak through.
  const existingTags = new Set(checkpoints.map((c) => c.tag));
  const candidateLog = safeExec(
    `git log HEAD --grep='^\\[checkpoint:' --format='%H%x09%s%x09%cI'`,
    projectDir
  );
  for (const line of candidateLog.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\t");
    // Subject format: "dex: <step> completed [cycle:N] [feature:x]"
    const m = subject?.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
    if (!m) continue;
    const step = m[1] as StepType;
    const cycleNumber = Number(m[2]);
    const tag = checkpointTagFor(step, cycleNumber);
    if (existingTags.has(tag)) continue;
    pending.push({ checkpointTag: tag, candidateSha: sha, step, cycleNumber });
  }

  // Starting point — pin to main / master tip so the trunk is always visible
  // on the canvas regardless of which branch HEAD is currently on. Falls back
  // to currentBranch + HEAD only when no main/master exists.
  let startingPoint: StartingPoint | null = null;
  const headSha = safeExec(`git rev-parse HEAD`, projectDir);
  for (const trunk of ["main", "master"]) {
    const trunkSha = safeExec(`git rev-parse --verify ${trunk}`, projectDir);
    if (trunkSha) {
      startingPoint = {
        branch: trunk,
        sha: trunkSha,
        shortSha: trunkSha.slice(0, 7),
        subject: safeExec(`git log -1 --format=%s ${trunk}`, projectDir),
        timestamp: safeExec(`git log -1 --format=%cI ${trunk}`, projectDir),
      };
      break;
    }
  }
  if (!startingPoint && currentBranch && headSha) {
    startingPoint = {
      branch: currentBranch,
      sha: headSha,
      shortSha: headSha.slice(0, 7),
      subject: safeExec(`git log -1 --format=%s HEAD`, projectDir),
      timestamp: safeExec(`git log -1 --format=%cI HEAD`, projectDir),
    };
  }

  // Build commits[] — every step-commit reachable from any **session-relevant**
  // branch. Per spec FR-001, the canvas surfaces: `main`/`master`, the
  // currentBranch, attempt-* branches, and the latest `dex/*` run branch.
  // Stale dex/* runs from prior sessions, fixture/*, capture/*, and unrelated
  // user branches are filtered out so the canvas stays legible.
  const commits: TimelineCommit[] = [];
  const seenCommitShas = new Set<string>();
  const checkpointShaSet = new Set(checkpoints.map((c) => c.sha).filter((s) => Boolean(s)));

  // for-each-ref's --format does not expand `%x09`. Use a delimiter git refnames
  // cannot legally contain ('|' is forbidden by git's check-ref-format).
  const allBranchesRaw = safeExec(
    `git for-each-ref --format='%(refname:short)|%(committerdate:iso-strict)' refs/heads/`,
    projectDir,
  );
  const allBranches: Array<{ name: string; tipTime: string }> = [];
  for (const line of allBranchesRaw.split("\n").filter(Boolean)) {
    const [name, tipTime] = line.split("|");
    if (name) allBranches.push({ name, tipTime: tipTime ?? "" });
  }

  const visibleBranches = new Set<string>();
  // Always include the project's default trunk(s).
  for (const def of ["main", "master"]) {
    if (allBranches.some((b) => b.name === def)) visibleBranches.add(def);
  }
  // Always include the currently checked-out branch.
  if (currentBranch && allBranches.some((b) => b.name === currentBranch)) {
    visibleBranches.add(currentBranch);
  }
  // Always include all `attempt-*` branches (008 Try Again / Go back, and
  // variant slots `attempt-<ts>-{a,b,c}`) and `selected-*` branches (010
  // click-to-jump forks).
  for (const b of allBranches) {
    if (b.name.startsWith("attempt-") || b.name.startsWith("selected-")) {
      visibleBranches.add(b.name);
    }
  }
  // Include all `dex/*` run branches (each is a distinct autonomous run).
  // Old runs are pruned by `scripts/prune-example-branches.sh`, so this set
  // stays bounded in practice.
  for (const b of allBranches) {
    if (b.name.startsWith("dex/")) visibleBranches.add(b.name);
  }

  // Iterate filtered branches in stable order: trunk first (so anchor + main
  // commits land in the leftmost lane), then by tip time descending.
  const filtered = allBranches
    .filter((b) => visibleBranches.has(b.name))
    .sort((a, b) => {
      const score = (n: string) =>
        n === "main" || n === "master" ? 0 : n === currentBranch ? 1 : 2;
      const sa = score(a.name);
      const sb = score(b.name);
      if (sa !== sb) return sa - sb;
      return b.tipTime.localeCompare(a.tipTime);
    });

  for (const { name: branch } of filtered) {
    const logRaw = safeExec(
      `git log ${branch} --reverse --format='%H%x09%P%x09%s%x09%cI'`,
      projectDir,
    );
    for (const line of logRaw.split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const [sha, parents, subject, timestamp] = parts;
      const m = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
      if (!m) continue;
      if (seenCommitShas.has(sha)) continue;
      seenCommitShas.add(sha);
      const firstParent = parents.split(" ").filter(Boolean)[0] ?? null;
      commits.push({
        sha,
        shortSha: sha.slice(0, 7),
        branch,
        parentSha: firstParent,
        step: m[1] as StepType,
        cycleNumber: Number(m[2]),
        subject,
        timestamp,
        hasCheckpointTag: checkpointShaSet.has(sha),
      });
    }
  }
  commits.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Build selectedPath — step-commits from the run's starting-point to HEAD,
  // oldest-first. Uses --first-parent to collapse merges.
  const selectedPath: string[] = [];
  if (headSha) {
    const pathLogRaw = safeExec(
      `git log --first-parent ${headSha} --format='%H%x09%s'`,
      projectDir,
    );
    const acc: string[] = [];
    for (const line of pathLogRaw.split("\n").filter(Boolean)) {
      const [sha, subject] = line.split("\t");
      if (subject && /^dex: (\w+) completed \[cycle:(\d+)\]/.test(subject)) {
        acc.push(sha);
      }
    }
    // git log returns newest-first; spec wants oldest-first.
    acc.reverse();
    selectedPath.push(...acc);
  }

  // Sort: checkpoints by timestamp ascending, attempts by timestamp descending
  checkpoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  attempts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    checkpoints,
    attempts,
    currentAttempt,
    pending,
    captureBranches,
    startingPoint,
    commits,
    selectedPath,
  };
}

// ── Variant group file helpers ───────────────────────────

export interface VariantGroupFile {
  groupId: string;
  fromCheckpoint: string;
  step: StepType;
  parallel: boolean;
  createdAt: string;
  variants: Array<{
    letter: string;
    branch: string;
    worktree: string | null;
    status: "pending" | "running" | "completed" | "failed";
    runId: string | null;
    candidateSha: string | null;
    errorMessage: string | null;
    /**
     * 010 — record the profile binding so resume-mid-variant can re-apply the
     * overlay if the worktree is reconstructed. `null` = `(none)` was selected,
     * runner uses orchestrator defaults. Optional on read for backwards
     * compatibility with pre-010 variant groups.
     */
    profile?: { name: string; agentDir: string } | null;
  }>;
  resolved: {
    kind: "keep" | "discard" | null;
    pickedLetter: string | null;
    resolvedAt: string | null;
  };
}

function variantGroupsDir(projectDir: string): string {
  return path.join(projectDir, ".dex", "variant-groups");
}

export function writeVariantGroupFile(projectDir: string, group: VariantGroupFile): void {
  const dir = variantGroupsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${group.groupId}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(group, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
}

export function readVariantGroupFile(projectDir: string, groupId: string): VariantGroupFile | null {
  const target = path.join(variantGroupsDir(projectDir), `${groupId}.json`);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf-8")) as VariantGroupFile;
  } catch {
    return null;
  }
}

function listAllVariantGroupFiles(projectDir: string): VariantGroupFile[] {
  const dir = variantGroupsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const out: VariantGroupFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function deleteVariantGroupFile(projectDir: string, groupId: string): void {
  const target = path.join(variantGroupsDir(projectDir), `${groupId}.json`);
  try {
    fs.unlinkSync(target);
  } catch {
    // already gone
  }
}

export function readPendingVariantGroups(projectDir: string): VariantGroupFile[] {
  return listAllVariantGroupFiles(projectDir).filter((g) =>
    g.variants.some((v) => v.status === "pending" || v.status === "running")
  );
}
