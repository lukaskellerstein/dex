/**
 * What: Core operations on Dex-owned timeline branches — `deleteBranch` (014/US1)
 *       and `mergeToMain` (014/US2; conflict path lands in US3). Subsumes the
 *       legacy `unselect` verb.
 * Not: Does not touch the renderer, IPC layer, or state lock — those live in
 *      `src/main/ipc/checkpoints.ts`.
 * Deps: _helpers (gitExec, safeExec, log), tags.ts (parseCheckpointTag, labelFor),
 *       node:fs / node:path for state.json mid-run probe.
 */

import fs from "node:fs";
import path from "node:path";
import { gitExec, safeExec, log, type RunLoggerLike } from "./_helpers.js";
import { parseCheckpointTag, labelFor } from "./tags.js";
import {
  classifyUnmergedPaths,
  gatherCommitSubjects,
  readGoalText,
  finalizeMergeSuccess,
} from "./_mergeHelpers.js";
import { resolveConflicts, type ResolverFailReason } from "../conflict-resolver.js";
import type { AgentRunner } from "../agent/AgentRunner.js";
import type { ConflictResolverConfig } from "../dexConfig.js";
import type { EmitFn, RunConfig } from "../types.js";
import type { RunLogger } from "../log.js";

// ── Types ────────────────────────────────────────────────

export interface LostStep {
  /** Plain-English label (e.g. "cycle 2 · plan written") or the truncated commit subject. */
  label: string;
  /** First 7 chars of the commit SHA. */
  shortSha: string;
}

export interface DeleteBranchOpts {
  /** Caller has shown the lost-work modal and the user confirmed. Skips the lost-work check. */
  confirmedLoss?: boolean;
}

export type DeleteBranchResult =
  | { ok: true; deleted: string; switchedTo: string | null }
  | { ok: false; error: "not_dex_owned"; branch: string }
  | { ok: false; error: "is_protected"; branch: string }
  | { ok: false; error: "no_primary_to_switch_to" }
  | { ok: false; error: "would_lose_work"; lostSteps: LostStep[] }
  | { ok: false; error: "branch_in_active_run"; branch: string }
  | { ok: false; error: "git_error"; message: string };

// ── Helpers ──────────────────────────────────────────────

/**
 * The deletable set: branches Dex owns and is allowed to remove. Exactly the
 * two namespaces the timeline shows as "saved versions".
 */
function isDexOwned(branchName: string): boolean {
  return branchName.startsWith("dex/") || branchName.startsWith("selected-");
}

function isProtected(branchName: string): boolean {
  return branchName === "main" || branchName === "master";
}

/**
 * Mid-run safety probe. Read `<projectDir>/.dex/state.json`. If it exists and
 * `state.status === "running"` AND HEAD is on `branchName`, the orchestrator
 * is currently building this version — refuse the destructive op.
 *
 * Returns `true` if the orchestrator is actively building the target branch.
 */
function isBranchInActiveRun(projectDir: string, branchName: string): boolean {
  try {
    const stateFile = path.join(projectDir, ".dex", "state.json");
    if (!fs.existsSync(stateFile)) return false;
    const raw = fs.readFileSync(stateFile, "utf-8");
    const state = JSON.parse(raw) as { status?: string };
    if (state.status !== "running") return false;
    const head = safeExec(`git rev-parse --abbrev-ref HEAD`, projectDir);
    return head === branchName;
  } catch {
    // If state.json is unparseable or HEAD is unreadable, fail-open (allow
    // the operation to proceed). The IPC's withLock guard is the second
    // line of defence against concurrent state mutation.
    return false;
  }
}

function branchExists(projectDir: string, branchName: string): boolean {
  return Boolean(safeExec(`git rev-parse --verify refs/heads/${branchName}`, projectDir));
}

/**
 * Map a step-commit SHA to a `LostStep`. Parses the
 * `[checkpoint:<step>:<cycle>]` trailer added by `commitCheckpoint`; falls
 * back to a truncated commit subject when the trailer is absent.
 */
function lostStepForSha(projectDir: string, sha: string): LostStep {
  const shortSha = sha.slice(0, 7);
  const subject = safeExec(`git log -1 --format=%s ${sha}`, projectDir);
  const body = safeExec(`git log -1 --format=%B ${sha}`, projectDir);
  // Trailer format: "[checkpoint:<stage>:<cycle>]" or "checkpoint/<…>" name
  // shapes via `parseCheckpointTag`. Body trailers from commitCheckpoint look
  // like "[checkpoint:plan:2]". Match permissively.
  const trailerMatch = body.match(/\[checkpoint:([\w-]+):(\d+)\]/);
  if (trailerMatch) {
    const tag = `checkpoint/cycle-${trailerMatch[2]}-after-${trailerMatch[1]}`;
    const parsed = parseCheckpointTag(tag);
    if (parsed) {
      return { label: labelFor(parsed.step, parsed.cycleNumber, null), shortSha };
    }
  }
  // Subject form: "dex: <step> completed [cycle:N] [feature:slug]"
  const subjectMatch = subject.match(/^dex: (\w+) completed \[cycle:(\d+)\]/);
  if (subjectMatch) {
    const tag = `checkpoint/cycle-${subjectMatch[2]}-after-${subjectMatch[1]}`;
    const parsed = parseCheckpointTag(tag);
    if (parsed) {
      return { label: labelFor(parsed.step, parsed.cycleNumber, null), shortSha };
    }
  }
  // Fallback: trimmed subject.
  const truncated = subject.length > 60 ? `${subject.slice(0, 57)}…` : subject;
  return { label: truncated || `(${shortSha})`, shortSha };
}

/**
 * Find commits on `branchName` not reachable from any other tracked branch
 * (main/master/dex/*\/selected-*). Returns the SHAs in newest-first order.
 */
function uniqueCommits(projectDir: string, branchName: string): string[] {
  // Build the "every other tracked branch" exclusion list at runtime — this
  // is more robust than a fixed glob list, and naturally handles repos
  // without main/master.
  const excludeArgs: string[] = [];
  for (const ref of safeExec(`git for-each-ref --format='%(refname:short)' refs/heads/`, projectDir)
    .split("\n")
    .filter(Boolean)) {
    if (ref === branchName) continue;
    if (ref === "main" || ref === "master") {
      excludeArgs.push(`^${ref}`);
      continue;
    }
    if (ref.startsWith("dex/") || ref.startsWith("selected-")) {
      excludeArgs.push(`^${ref}`);
    }
  }
  const cmd = `git log ${branchName} --format=%H ${excludeArgs.join(" ")}`.trim();
  const raw = safeExec(cmd, projectDir);
  return raw.split("\n").filter(Boolean);
}

function findPrimaryFallback(projectDir: string): "main" | "master" | null {
  if (branchExists(projectDir, "main")) return "main";
  if (branchExists(projectDir, "master")) return "master";
  return null;
}

// ── deleteBranch (014/US1) ───────────────────────────────

/**
 * Remove a Dex-owned saved version. Subsumes the legacy `unselect` verb with
 * stricter semantics: HEAD-on-target always switches to `main` (fallback
 * `master`), never to a "natural parent". Refuses on protected, user, and
 * actively-building branches.
 */
export function deleteBranch(
  projectDir: string,
  branchName: string,
  opts?: DeleteBranchOpts,
  rlog?: RunLoggerLike,
): DeleteBranchResult {
  if (isProtected(branchName)) {
    return { ok: false, error: "is_protected", branch: branchName };
  }
  if (!isDexOwned(branchName)) {
    return { ok: false, error: "not_dex_owned", branch: branchName };
  }
  if (isBranchInActiveRun(projectDir, branchName)) {
    return { ok: false, error: "branch_in_active_run", branch: branchName };
  }

  // Lost-work check (skipped when caller has already confirmed).
  if (!opts?.confirmedLoss) {
    const unique = uniqueCommits(projectDir, branchName);
    if (unique.length > 0) {
      const lostSteps = unique
        .map((sha) => lostStepForSha(projectDir, sha))
        .filter((step) => Boolean(step.label));
      // Surface the modal even when every commit is a non-step-commit; the
      // user still deserves the warning. lostSteps is never empty here.
      return { ok: false, error: "would_lose_work", lostSteps };
    }
  }

  let switchedTo: string | null = null;
  try {
    const current = gitExec(`git rev-parse --abbrev-ref HEAD`, projectDir);
    if (current === branchName) {
      const fallback = findPrimaryFallback(projectDir);
      if (!fallback) {
        return { ok: false, error: "no_primary_to_switch_to" };
      }
      gitExec(`git checkout -q ${fallback}`, projectDir);
      switchedTo = fallback;
    }
    // -D (force-delete) is required because `confirmedLoss` may have skipped
    // the unique-commit check — the user has explicitly elected to lose them.
    gitExec(`git branch -D ${branchName}`, projectDir);
    log(
      rlog,
      "INFO",
      `deleteBranch: deleted ${branchName}${switchedTo ? ` (switched to ${switchedTo})` : ""}`,
    );
    return { ok: true, deleted: branchName, switchedTo };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
}

// ── mergeToMain (014/US2 — clean-merge path; conflict path lands in US3) ──

export interface PromoteSummary {
  fileCount: number;
  added: number;
  removed: number;
  /** First five paths in alphabetical order (the order `git diff --name-only` returns). */
  topPaths: string[];
  /** Full path list — caller decides whether to surface it (lazy "View all changes" expander). */
  fullPaths: string[];
}

export interface MergeToMainOpts {
  /** save | discard for the existing dirty-tree-handling flow. Same shape as JumpToOpts.force. */
  force?: "save" | "discard";
}

export type NonContentConflictKind =
  | "rename_delete"
  | "binary"
  | "submodule"
  | "both_added"
  | "both_deleted";

export type MergeToMainResult =
  | { ok: true; mode: "clean"; mergeSha: string; deletedSource: string }
  | {
      ok: true;
      mode: "resolved";
      mergeSha: string;
      deletedSource: string;
      resolverCostUsd: number;
      resolvedFiles: string[];
    }
  | { ok: false; error: "dirty_working_tree"; files: string[] }
  | { ok: false; error: "not_dex_owned"; branch: string }
  | { ok: false; error: "branch_in_active_run"; branch: string }
  | { ok: false; error: "main_in_active_run" }
  | { ok: false; error: "no_primary_branch" }
  | { ok: false; error: "non_content_conflict"; kinds: NonContentConflictKind[] }
  | {
      ok: false;
      error: "resolver_failed";
      reason: ResolverFailReason;
      partialMergeSha: string | null;
    }
  | { ok: false; error: "git_error"; message: string };

/**
 * Optional resolver dependencies passed to `mergeToMain` from the IPC layer.
 * When undefined, the resolver path is unavailable — the function still
 * handles clean merges; if it detects conflicts, it aborts and returns
 * `git_error` (this preserves the US2 surface for callers that don't yet
 * pass resolver deps).
 */
export interface MergeToMainResolverDeps {
  runner: AgentRunner;
  config: ConflictResolverConfig;
  runConfig: RunConfig;
  emit: EmitFn;
  abortController: AbortController | null;
  rlog: RunLogger;
}

/**
 * Compute the diff summary the promote-confirm modal renders. Uses
 * three-dot semantics so the summary is "what does the source add relative
 * to the merge-base", not "what is different between the two tips" — that
 * way a moving primary doesn't change the summary.
 */
export function computePromoteSummary(
  projectDir: string,
  sourceBranch: string,
): PromoteSummary {
  const primary = findPrimaryFallback(projectDir);
  if (!primary) {
    return { fileCount: 0, added: 0, removed: 0, topPaths: [], fullPaths: [] };
  }
  const stat = safeExec(
    `git diff --shortstat ${primary}...${sourceBranch}`,
    projectDir,
  );
  // shortstat shape: " 4 files changed, 120 insertions(+), 38 deletions(-)"
  const fileCount = Number((stat.match(/(\d+) files? changed/) ?? [, "0"])[1]);
  const added = Number((stat.match(/(\d+) insertions?\(\+\)/) ?? [, "0"])[1]);
  const removed = Number((stat.match(/(\d+) deletions?\(-\)/) ?? [, "0"])[1]);
  const fullPathsRaw = safeExec(
    `git diff --name-only ${primary}...${sourceBranch}`,
    projectDir,
  );
  const fullPaths = fullPathsRaw.split("\n").filter(Boolean);
  return {
    fileCount,
    added,
    removed,
    topPaths: fullPaths.slice(0, 5),
    fullPaths,
  };
}

/**
 * Promote a saved version to become the new primary (`main`, fallback
 * `master`). v1 implements the clean-merge path only — when the merge has
 * no content conflicts, commit + delete source + ensure HEAD on primary.
 *
 * The conflict path is wired in 014/US3 (conflict-resolver harness).
 */
export async function mergeToMain(
  projectDir: string,
  sourceBranch: string,
  opts?: MergeToMainOpts,
  rlog?: RunLoggerLike,
  resolver?: MergeToMainResolverDeps,
): Promise<MergeToMainResult> {
  if (!isDexOwned(sourceBranch)) {
    return { ok: false, error: "not_dex_owned", branch: sourceBranch };
  }
  if (isBranchInActiveRun(projectDir, sourceBranch)) {
    return { ok: false, error: "branch_in_active_run", branch: sourceBranch };
  }
  const primary = findPrimaryFallback(projectDir);
  if (!primary) {
    return { ok: false, error: "no_primary_branch" };
  }
  if (isBranchInActiveRun(projectDir, primary)) {
    return { ok: false, error: "main_in_active_run" };
  }

  // Dirty-tree handling. We reuse the same "save / discard" semantics
  // jumpTo uses, so the renderer's existing GoBackConfirm modal can drive
  // the retry path. When `force` is undefined, return the unsaved tracked
  // files for the renderer to display.
  let dirtyTracked: { dirty: boolean; files: string[] };
  try {
    const out = safeExec(`git status --porcelain --untracked-files=no`, projectDir);
    const lines = out.split("\n").filter(Boolean);
    dirtyTracked = { dirty: lines.length > 0, files: lines.map((l) => l.slice(3)) };
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  if (dirtyTracked.dirty) {
    if (!opts?.force) {
      return { ok: false, error: "dirty_working_tree", files: dirtyTracked.files };
    }
    if (opts.force === "save") {
      try {
        gitExec(`git add -A`, projectDir);
        gitExec(`git commit -q -m "dex: pre-promote autosave"`, projectDir);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    } else if (opts.force === "discard") {
      try {
        gitExec(`git reset --hard HEAD`, projectDir);
        gitExec(`git clean -fd -e .dex/state.lock`, projectDir);
      } catch (err) {
        return { ok: false, error: "git_error", message: String(err) };
      }
    }
  }

  // Switch to primary and run the merge.
  try {
    gitExec(`git checkout -q ${primary}`, projectDir);
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }

  const subject = `dex: promoted ${sourceBranch} to ${primary}`;

  // Two-phase merge so we can intervene on conflicts:
  //   1. `git merge --no-ff --no-commit` — create the merge state without
  //      committing. On clean: nothing in `git status` is unmerged → commit.
  //      On conflict: unmerged paths exist → hand off to resolver.
  //   2. `git commit -m <subject>` — finalize on clean OR after resolver.
  let mergeStarted = false;
  try {
    gitExec(
      `git merge --no-ff --no-commit -m "${subject}" ${sourceBranch}`,
      projectDir,
    );
    mergeStarted = true;
  } catch {
    // Non-zero exit usually means conflicts; the index is left in the
    // unmerged state for `git status` to inspect. We don't abort yet —
    // we'll classify and either resolve or roll back.
    mergeStarted = true;
  }

  // Inspect `git status --porcelain` for unmerged paths.
  const unmergedClassified = classifyUnmergedPaths(projectDir);

  if (unmergedClassified.contentConflicts.length === 0 && unmergedClassified.nonContentKinds.length === 0) {
    // Clean merge — finalize.
    try {
      gitExec(`git commit -q --no-edit`, projectDir);
    } catch (err) {
      // If even the commit fails (rare — usually means there's nothing to
      // commit because main was already up-to-date), abort and surface.
      if (mergeStarted) safeExec(`git merge --abort`, projectDir);
      return { ok: false, error: "git_error", message: String(err) };
    }
    return finalizeMergeSuccess(projectDir, sourceBranch, primary, "clean", null, [], rlog);
  }

  // Non-content conflicts (rename/delete, binary, submodule) → abort and surface.
  if (unmergedClassified.nonContentKinds.length > 0) {
    safeExec(`git merge --abort`, projectDir);
    return {
      ok: false,
      error: "non_content_conflict",
      kinds: unmergedClassified.nonContentKinds,
    };
  }

  // Content conflicts. Hand off to the AI resolver — when deps are missing,
  // abort cleanly and surface as git_error so the caller doesn't get a
  // half-merged tree.
  if (!resolver) {
    safeExec(`git merge --abort`, projectDir);
    return {
      ok: false,
      error: "git_error",
      message:
        "merge produced content conflicts but no resolver was supplied; merge aborted",
    };
  }

  const resolverResult = await resolveConflicts({
    projectDir,
    sourceBranch,
    conflictedPaths: unmergedClassified.contentConflicts,
    runner: resolver.runner,
    config: resolver.config,
    primaryCommitSubjects: gatherCommitSubjects(projectDir, primary),
    sourceCommitSubjects: gatherCommitSubjects(projectDir, sourceBranch),
    goalText: readGoalText(projectDir),
    runConfig: resolver.runConfig,
    emit: resolver.emit,
    abortController: resolver.abortController,
    rlog: resolver.rlog,
  });

  if (!resolverResult.ok) {
    // Leave the merge state in-progress so the failure modal can offer
    // accept/rollback. Caller is responsible for the next step.
    let partialSha: string | null = null;
    try {
      // The merge state is in the index/work tree but not committed; we
      // don't have a real merge SHA yet. partialMergeSha can stay null —
      // the failure modal's "Accept what AI did" path commits at that point.
      partialSha = null;
    } catch {
      partialSha = null;
    }
    return {
      ok: false,
      error: "resolver_failed",
      reason: resolverResult.reason,
      partialMergeSha: partialSha,
    };
  }

  // Resolver succeeded — stage all + commit.
  try {
    gitExec(`git add -A`, projectDir);
    gitExec(`git commit -q --no-edit`, projectDir);
  } catch (err) {
    safeExec(`git merge --abort`, projectDir);
    return { ok: false, error: "git_error", message: String(err) };
  }

  return finalizeMergeSuccess(
    projectDir,
    sourceBranch,
    primary,
    "resolved",
    resolverResult.costUsd,
    resolverResult.resolvedFiles,
    rlog,
  );
}

