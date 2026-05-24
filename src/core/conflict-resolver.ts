/**
 * What: Conflict-resolver harness (014/US3). Drives `AgentRunner.runOneShot`
 *       through a per-file iteration loop, tracks cost, runs the project's
 *       verify command, and emits structured progress events.
 * Not: Does not detect conflicts (caller — `branchOps.mergeToMain` — provides
 *      the unmerged-paths list); does not invoke git directly except for the
 *      verify command.
 * Deps: AgentRunner.runOneShot, node:fs, node:child_process (for verify),
 *       core/types (EmitFn).
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { AgentRunner, OneShotContext } from "./agent/AgentRunner.js";
import type { ConflictResolverConfig } from "./dexConfig.js";
import type { EmitFn, RunConfig } from "./types.js";
import type { RunLogger } from "./log.js";

// ── Types ────────────────────────────────────────────────

export type ResolverFailReason =
  | "max_iterations"
  | "cost_cap"
  | "verify_failed"
  | "agent_gave_up"
  | "user_cancelled";

export type ResolverResult =
  | {
      ok: true;
      costUsd: number;
      resolvedFiles: string[];
      durationMs: number;
    }
  | {
      ok: false;
      reason: ResolverFailReason;
      costUsd: number;
      resolvedFiles: string[];
      failedFiles: string[];
      durationMs: number;
    };

export interface ResolverContext {
  projectDir: string;
  sourceBranch: string;
  /** Files git status reports as unmerged. Caller has classified them as content-conflicts. */
  conflictedPaths: string[];
  runner: AgentRunner;
  config: ConflictResolverConfig;
  /** Recent commit subjects on the primary branch — fed into the resolver prompt. */
  primaryCommitSubjects: string[];
  /** Recent commit subjects on the source branch — fed into the resolver prompt. */
  sourceCommitSubjects: string[];
  /** Truncated goal-file contents (≤ 2KB) — fed into the resolver prompt. May be empty. */
  goalText: string;
  /** RunConfig the resolver embeds into each OneShotContext. */
  runConfig: RunConfig;
  emit: EmitFn;
  abortController: AbortController | null;
  rlog: RunLogger;
}

// ── Constants ────────────────────────────────────────────

const SYSTEM_PROMPT_OVERRIDE = [
  "You are resolving a merge conflict in a single file.",
  "You MUST use the Edit tool to modify the file. Do NOT only describe the resolution in text — call the Edit tool with the merged content.",
  "Goal: remove all conflict markers (<<<<<<<, =======, >>>>>>>) so the file parses cleanly, while preserving the intent of both branches when possible.",
  "Do not modify any other file. Do not add commentary outside the Edit tool call.",
].join("\n");

const ALLOWED_TOOLS = ["Read", "Edit"];
const FIRST_ITERATION_COST_ESTIMATE_USD = 0.05;
const GOAL_TRUNCATE_BYTES = 2048;
const COMMIT_SUBJECT_TRUNCATE_CHARS = 80;

// ── Public API ───────────────────────────────────────────

/**
 * Resolve every file in `ctx.conflictedPaths` by running `runOneShot` once
 * per file. Halts early on max-iteration, cost-cap, user-cancel, or
 * `finishedNormally:false`. After all files resolve cleanly, runs the
 * project's verify command (when configured).
 *
 * Emits the `conflict-resolver:*` events per the contract:
 *   file-start → iteration → file-done (per file)
 *   done (terminal)
 */
export async function resolveConflicts(
  ctx: ResolverContext,
): Promise<ResolverResult> {
  const start = Date.now();
  let costSoFar = 0;
  let prevIterationCost = FIRST_ITERATION_COST_ESTIMATE_USD;
  let iterationCounter = 0;
  const resolvedFiles: string[] = [];
  const failedFiles: string[] = [];

  const finalize = (
    ok: boolean,
    reason?: ResolverFailReason,
  ): ResolverResult => {
    const durationMs = Date.now() - start;
    ctx.emit({
      type: "conflict-resolver:done",
      ok,
      costTotal: costSoFar,
      ...(reason ? { reason } : {}),
    });
    if (ok) {
      return { ok: true, costUsd: costSoFar, resolvedFiles, durationMs };
    }
    return {
      ok: false,
      reason: reason ?? "agent_gave_up",
      costUsd: costSoFar,
      resolvedFiles,
      failedFiles,
      durationMs,
    };
  };

  for (let i = 0; i < ctx.conflictedPaths.length; i++) {
    const file = ctx.conflictedPaths[i];

    if (ctx.abortController?.signal.aborted) {
      // Push remaining files (including this one) to failed list for caller's view.
      for (let j = i; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      return finalize(false, "user_cancelled");
    }

    if (iterationCounter >= ctx.config.maxIterations) {
      for (let j = i; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      return finalize(false, "max_iterations");
    }

    if (costSoFar + prevIterationCost > ctx.config.costCapUsd) {
      for (let j = i; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      return finalize(false, "cost_cap");
    }

    ctx.emit({
      type: "conflict-resolver:file-start",
      file,
      index: i + 1,
      total: ctx.conflictedPaths.length,
    });

    iterationCounter++;
    ctx.emit({
      type: "conflict-resolver:iteration",
      n: iterationCounter,
      costSoFar,
      currentFile: file,
    });

    const prompt = buildPromptForFile(file, ctx);
    const oneShotCtx: OneShotContext = {
      config: { ...ctx.runConfig, model: ctx.config.model ?? ctx.runConfig.model },
      prompt,
      systemPromptOverride: SYSTEM_PROMPT_OVERRIDE,
      allowedTools: ALLOWED_TOOLS,
      cwd: ctx.projectDir,
      maxTurns: ctx.config.maxTurnsPerIteration,
      abortController: ctx.abortController,
      emit: ctx.emit,
      rlog: ctx.rlog,
    };

    let result;
    try {
      result = await ctx.runner.runOneShot(oneShotCtx);
    } catch (err) {
      ctx.rlog.run("WARN", "resolveConflicts: runOneShot threw", {
        err: err instanceof Error ? err.message : String(err),
      });
      failedFiles.push(file);
      ctx.emit({
        type: "conflict-resolver:file-done",
        file,
        ok: false,
        iterationsUsed: 1,
      });
      // Treat exception as agent gave up; halt the whole resolver.
      for (let j = i + 1; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      return finalize(false, "agent_gave_up");
    }

    costSoFar += result.cost;
    prevIterationCost = result.cost > 0 ? result.cost : FIRST_ITERATION_COST_ESTIMATE_USD;

    if (!result.finishedNormally) {
      failedFiles.push(file);
      ctx.emit({
        type: "conflict-resolver:file-done",
        file,
        ok: false,
        iterationsUsed: 1,
      });
      for (let j = i + 1; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      // Distinguish abort from generic "agent gave up".
      if (ctx.abortController?.signal.aborted) {
        return finalize(false, "user_cancelled");
      }
      return finalize(false, "agent_gave_up");
    }

    // Re-read the file and check for residual markers.
    const stillHasMarkers = fileHasConflictMarkers(ctx.projectDir, file);
    if (stillHasMarkers) {
      failedFiles.push(file);
      ctx.emit({
        type: "conflict-resolver:file-done",
        file,
        ok: false,
        iterationsUsed: 1,
      });
      // The file failed; halt with max_iterations because v1 gives one chance per file.
      for (let j = i + 1; j < ctx.conflictedPaths.length; j++) {
        failedFiles.push(ctx.conflictedPaths[j]);
      }
      return finalize(false, "max_iterations");
    }

    resolvedFiles.push(file);
    ctx.emit({
      type: "conflict-resolver:file-done",
      file,
      ok: true,
      iterationsUsed: 1,
    });
  }

  // All files resolved. Verify (if configured).
  if (ctx.config.verifyCommand) {
    try {
      execSync(ctx.config.verifyCommand, {
        cwd: ctx.projectDir,
        stdio: "pipe",
      });
    } catch (err) {
      ctx.rlog.run("WARN", "resolveConflicts: verify command failed", {
        cmd: ctx.config.verifyCommand,
        err: err instanceof Error ? err.message : String(err),
      });
      return finalize(false, "verify_failed");
    }
  }

  return finalize(true);
}

// ── Helpers ──────────────────────────────────────────────

function fileHasConflictMarkers(projectDir: string, file: string): boolean {
  const abs = path.isAbsolute(file) ? file : path.resolve(projectDir, file);
  if (!fs.existsSync(abs)) return false;
  const content = fs.readFileSync(abs, "utf-8");
  return (
    content.includes("<<<<<<<") ||
    content.includes("=======\n") ||
    content.includes(">>>>>>>")
  );
}

function buildPromptForFile(file: string, ctx: ResolverContext): string {
  const primary = ctx.primaryCommitSubjects
    .slice(-5)
    .map((s) => `- ${truncate(s, COMMIT_SUBJECT_TRUNCATE_CHARS)}`)
    .join("\n");
  const source = ctx.sourceCommitSubjects
    .slice(-5)
    .map((s) => `- ${truncate(s, COMMIT_SUBJECT_TRUNCATE_CHARS)}`)
    .join("\n");
  const goal = truncate(ctx.goalText, GOAL_TRUNCATE_BYTES);

  return [
    `Use the Edit tool to resolve the merge conflict in ${file}.`,
    "The file currently contains git conflict markers (<<<<<<<, =======, >>>>>>>).",
    "Produce a final version that keeps the intent of both branches.",
    "",
    "Recent commits on main:",
    primary || "(none)",
    "",
    `Recent commits on ${ctx.sourceBranch}:`,
    source || "(none)",
    "",
    "Project goal:",
    goal || "(no goal file)",
    "",
    `STEPS:`,
    `1. Read ${file} to see the conflict markers.`,
    `2. Call Edit on ${file} with old_string set to the entire conflict block (including the <<<<<<<, =======, >>>>>>> markers) and new_string set to the merged content.`,
    `3. Do not write any other file. Do not output a textual explanation in place of the Edit call.`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
