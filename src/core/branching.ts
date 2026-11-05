/**
 * What: Branch handling for an existing project (research R4, D-015-2). `prepareBranch` puts the checkout on the tree the picker read for this stage — the entry's branch when it exists, else its base (only `brief` and `specify` get that far) — and switches only on a clean tree. `dirtyFiles` / `isTreeClean` define clean: nothing in `git status` once Dex's runtime files are dropped; untracked files count.
 * Not: Never creates, commits, pushes or stashes. Never switches a new project (its run branch is made once, by the orchestrator). Does not pause the run itself — the loop turns a dirty result into a `dirty_tree` pause.
 * Deps: git.{branchExists, getCurrentBranch, switchBranch}, state.RUNTIME_IGNORE_ENTRIES, queue.ResolvedEntry, node:child_process.
 */

import { execFileSync } from "node:child_process";
import { branchExists, getCurrentBranch, switchBranch } from "./git.js";
import type { QueueKind } from "./policy.js";
import type { ResolvedEntry } from "./queue.js";
import { RUNTIME_IGNORE_ENTRIES } from "./state.js";

/** Dex's own runtime files (the `.dex/.gitignore` list): never a reason to call a tree dirty. */
export const RUNTIME_PATHS: readonly string[] = RUNTIME_IGNORE_ENTRIES.map((e) => `.dex/${e}`);

function isRuntimePath(file: string): boolean {
  return RUNTIME_PATHS.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p));
}

/**
 * Changed and untracked files, sorted, without Dex's runtime files.
 * `--untracked-files=all` lists files one by one, so an untracked `.dex/`
 * holding only runtime files does not show up as one dirty folder.
 */
export function dirtyFiles(projectDir: string): string[] {
  // --no-optional-locks: no index refresh, so a read never writes .git/index.
  const out = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: projectDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const records = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    // A rename or copy carries its source path as the next record.
    if (record[0] === "R" || record[0] === "C") i++;
    files.push(record.slice(3));
  }
  return files.filter((f) => !isRuntimePath(f)).sort();
}

export function isTreeClean(projectDir: string): boolean {
  return dirtyFiles(projectDir).length === 0;
}

export type BranchPrep =
  | { kind: "ready"; branch: string; switched: boolean }
  | { kind: "dirty"; target: string; files: string[] };

/**
 * The branch a stage runs on: the entry's own branch once it exists, else its
 * base. The picker reads the same tree, so the agent sees what was decided on.
 * Only `brief` and `specify` ever run on the base: the picker pauses any later
 * stage of an entry whose branch is missing.
 */
export function stageBranch(projectDir: string, entry: ResolvedEntry): string {
  return branchExists(projectDir, entry.branch) ? entry.branch : entry.baseBranch;
}

/** Right before a stage: switch an existing project to the stage's branch if the tree is clean. */
export function prepareBranch(projectDir: string, entry: ResolvedEntry, kind: QueueKind): BranchPrep {
  const current = getCurrentBranch(projectDir);
  if (kind === "new") return { kind: "ready", branch: current, switched: false };
  const target = stageBranch(projectDir, entry);
  if (target === current) return { kind: "ready", branch: current, switched: false };
  const files = dirtyFiles(projectDir);
  if (files.length > 0) return { kind: "dirty", target, files };
  switchBranch(projectDir, target);
  return { kind: "ready", branch: target, switched: true };
}
