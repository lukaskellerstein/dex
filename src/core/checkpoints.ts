import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { StepType } from "./types.js";

// ── Constants ────────────────────────────────────────────

export const CHECKPOINT_MESSAGE_PREFIX = "[checkpoint:";

export const CHECKPOINT_MESSAGE_REGEX =
  /^dex: (\w+) completed \[cycle:(\d+)\] \[feature:([\w-]+|-)\] \[cost:\$(\d+\.\d{2})\]\n\[checkpoint:(\w+):(\d+)\]/;

const PARALLELIZABLE_STEPS: StepType[] = [
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "learnings",
];

// ── Minimal runlogger shape ──────────────────────────────

export interface RunLoggerLike {
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

// ── Dirty-tree check ─────────────────────────────────────

export function isWorkingTreeDirty(projectDir: string): { dirty: boolean; files: string[] } {
  // Do NOT use the trimming helper — porcelain format starts with a space for
  // common cases (e.g., " M README.md"), and trim would drop that leading space
  // and skew the slice(3).
  const out = execSync(`git status --porcelain`, { cwd: projectDir, encoding: "utf-8" });
  if (!out) return { dirty: false, files: [] };
  const lines = out.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { dirty: false, files: [] };
  return {
    dirty: true,
    files: lines.map((l) => l.slice(3)),
  };
}

// ── Go back ──────────────────────────────────────────────

export function startAttemptFrom(
  projectDir: string,
  checkpointTag: string,
  rlog?: RunLoggerLike,
  variant?: string
): { ok: true; branch: string } | { ok: false; error: string } {
  const branch = attemptBranchName(new Date(), variant);
  try {
    gitExec(`git rev-parse --verify refs/tags/${checkpointTag}`, projectDir);
    gitExec(`git checkout -B ${branch} ${checkpointTag}`, projectDir);
    // IMPORTANT: -fd not -fdx — preserve gitignored files (.env, build output, editor state).
    gitExec(`git clean -fd -e .dex/state.lock`, projectDir);
    log(rlog, "INFO", `startAttemptFrom: ${checkpointTag} → ${branch}`);
    return { ok: true, branch };
  } catch (err) {
    log(rlog, "WARN", `startAttemptFrom failed: ${String(err)}`);
    return { ok: false, error: String(err) };
  }
}

// ── Variants ─────────────────────────────────────────────

export interface VariantSpawnRequest {
  fromCheckpoint: string;
  variantLetters: string[];
  step: StepType;
}

export interface VariantSpawnResult {
  groupId: string;
  branches: string[];
  worktrees: string[] | null;
  parallel: boolean;
}

export function spawnVariants(
  projectDir: string,
  request: VariantSpawnRequest,
  rlog?: RunLoggerLike
): { ok: true; result: VariantSpawnResult } | { ok: false; error: string } {
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

export interface TimelineSnapshot {
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];
  startingPoint: StartingPoint | null;
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
    // Subject format: "dex: <step> completed [cycle:N] [feature:x] [cost:$X.XX]"
    const m = subject?.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
    if (!m) continue;
    const step = m[1] as StepType;
    const cycleNumber = Number(m[2]);
    const tag = checkpointTagFor(step, cycleNumber);
    if (existingTags.has(tag)) continue;
    pending.push({ checkpointTag: tag, candidateSha: sha, step, cycleNumber });
  }

  // Starting point — current branch + HEAD commit, used as the timeline anchor
  // when no checkpoints exist yet. Null if HEAD is unresolvable (empty repo).
  let startingPoint: StartingPoint | null = null;
  const headSha = safeExec(`git rev-parse HEAD`, projectDir);
  if (currentBranch && headSha) {
    startingPoint = {
      branch: currentBranch,
      sha: headSha,
      shortSha: headSha.slice(0, 7),
      subject: safeExec(`git log -1 --format=%s HEAD`, projectDir),
      timestamp: safeExec(`git log -1 --format=%cI HEAD`, projectDir),
    };
  }

  // Sort: checkpoints by timestamp ascending, attempts by timestamp descending
  checkpoints.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  attempts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { checkpoints, attempts, currentAttempt, pending, captureBranches, startingPoint };
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

export function listAllVariantGroupFiles(projectDir: string): VariantGroupFile[] {
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
