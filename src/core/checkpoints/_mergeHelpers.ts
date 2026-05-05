/**
 * What: Internal helpers for `mergeToMain` — unmerged-path classification
 *       (rename/delete vs binary vs submodule vs content), commit-subject
 *       gathering for the resolver prompt, GOAL.md reading, and
 *       success-finalisation that wraps source-branch deletion + result shape.
 * Not: Not part of the public `checkpoints` namespace.
 * Deps: _helpers (gitExec, safeExec, log), node:fs, node:path.
 */

import fs from "node:fs";
import path from "node:path";
import { gitExec, safeExec, log, type RunLoggerLike } from "./_helpers.js";
import type { MergeToMainResult, NonContentConflictKind } from "./branchOps.js";

export interface UnmergedClassification {
  contentConflicts: string[];
  nonContentKinds: NonContentConflictKind[];
}

/**
 * Inspect `git status --porcelain` for unmerged paths and dispatch each one
 * to its non-content kind (rename/delete, binary, submodule, both-added,
 * both-deleted) or, if none of those apply, mark it as a content conflict
 * the resolver can attempt.
 */
export function classifyUnmergedPaths(projectDir: string): UnmergedClassification {
  const contentConflicts: string[] = [];
  const nonContentKinds: NonContentConflictKind[] = [];
  const raw = safeExec(`git status --porcelain`, projectDir);
  if (!raw) return { contentConflicts, nonContentKinds };
  const lines = raw.split("\n").filter(Boolean);
  for (const line of lines) {
    const xy = line.slice(0, 2);
    const filePath = line.slice(3);
    switch (xy) {
      case "UU": {
        if (isBinary(projectDir, filePath)) {
          if (!nonContentKinds.includes("binary")) nonContentKinds.push("binary");
        } else if (isSubmodule(projectDir, filePath)) {
          if (!nonContentKinds.includes("submodule")) nonContentKinds.push("submodule");
        } else {
          contentConflicts.push(filePath);
        }
        break;
      }
      case "DU":
      case "UD":
        if (!nonContentKinds.includes("rename_delete")) nonContentKinds.push("rename_delete");
        break;
      case "AA":
        if (!nonContentKinds.includes("both_added")) nonContentKinds.push("both_added");
        break;
      case "DD":
        if (!nonContentKinds.includes("both_deleted")) nonContentKinds.push("both_deleted");
        break;
      case "AU":
      case "UA":
        if (!nonContentKinds.includes("rename_delete")) nonContentKinds.push("rename_delete");
        break;
      default:
        // Non-conflict status (e.g. " M" tracked-modified, "??" untracked).
        // These appear when the merge is clean but the working tree has
        // pre-existing junk. Skip — they're not unmerged paths.
        break;
    }
  }
  return { contentConflicts, nonContentKinds };
}

function isBinary(projectDir: string, file: string): boolean {
  const out = safeExec(`git check-attr -a -- "${file}"`, projectDir);
  if (/binary:\s*set/.test(out)) return true;
  if (/text:\s*(unset|false)/.test(out)) return true;
  return false;
}

function isSubmodule(projectDir: string, file: string): boolean {
  const submodulesFile = path.join(projectDir, ".gitmodules");
  if (!fs.existsSync(submodulesFile)) return false;
  const content = fs.readFileSync(submodulesFile, "utf-8");
  const re = new RegExp(
    `path\\s*=\\s*${file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`,
    "m",
  );
  return re.test(content);
}

export function gatherCommitSubjects(projectDir: string, branch: string): string[] {
  const raw = safeExec(`git log ${branch} -5 --format=%s`, projectDir);
  return raw.split("\n").filter(Boolean);
}

export function readGoalText(projectDir: string): string {
  const goalPath = path.join(projectDir, "GOAL.md");
  if (!fs.existsSync(goalPath)) return "";
  try {
    return fs.readFileSync(goalPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Wrap up a successful merge: capture the merge SHA, delete the source
 * branch (best-effort — leftover branch is cosmetic, never blocks success),
 * and return the discriminated result shape the IPC layer surfaces.
 */
export function finalizeMergeSuccess(
  projectDir: string,
  sourceBranch: string,
  primary: string,
  mode: "clean" | "resolved",
  resolverCostUsd: number | null,
  resolvedFiles: string[],
  rlog: RunLoggerLike | undefined,
): MergeToMainResult {
  let mergeSha: string;
  try {
    mergeSha = gitExec(`git rev-parse HEAD`, projectDir);
  } catch (err) {
    return { ok: false, error: "git_error", message: String(err) };
  }
  try {
    gitExec(`git branch -D ${sourceBranch}`, projectDir);
  } catch (err) {
    log(
      rlog,
      "WARN",
      `mergeToMain: branch delete failed for ${sourceBranch}: ${String(err)}`,
    );
  }
  log(
    rlog,
    "INFO",
    `mergeToMain: ${mode} merge of ${sourceBranch} → ${primary} (mergeSha=${mergeSha.slice(0, 7)})`,
  );
  if (mode === "resolved") {
    return {
      ok: true,
      mode: "resolved",
      mergeSha,
      deletedSource: sourceBranch,
      resolverCostUsd: resolverCostUsd ?? 0,
      resolvedFiles,
    };
  }
  return { ok: true, mode: "clean", mergeSha, deletedSource: sourceBranch };
}
