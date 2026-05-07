/**
 * What: Idempotent `.gitignore` bootstrap for Dex runtime-cache files. Ensures
 *       `.dex/state.json`, `.dex/feature-manifest.json`, and friends are listed
 *       in the project's `.gitignore`, and untracks any pre-existing tracked
 *       copies via `git rm --cached`.
 * Not: Does not commit. Does not init the repo. Does not touch files outside
 *      `.gitignore` and the index.
 * Deps: node:fs, node:path, _helpers (gitExec).
 */

import fs from "node:fs";
import path from "node:path";
import { gitExec } from "./_helpers.js";

const RUNTIME_CACHE_ENTRIES = [
  ".dex/state.json",
  ".dex/state.lock",
  ".dex/feature-manifest.json",
  ".dex/variant-groups/",
  ".dex/worktrees/",
] as const;

const UNTRACK_TARGETS = [
  ".dex/state.json",
  ".dex/feature-manifest.json",
] as const;

/**
 * Append any missing Dex runtime-cache entries to `<projectDir>/.gitignore`,
 * then `git rm --cached` any files that should be runtime-only but are still
 * tracked (one-time migration for repos that pre-date a given entry).
 *
 * Safe to call repeatedly — append is deduped by exact line match, and
 * `git rm --cached` swallows "wasn't tracked" errors. Safe on non-git
 * directories — only the `.gitignore` write runs, the untrack step is gated
 * on the presence of `.git`.
 */
export function ensureDexGitignore(projectDir: string): void {
  const gi = path.join(projectDir, ".gitignore");
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
  const lines = existing.split("\n");
  const missing = RUNTIME_CACHE_ENTRIES.filter((e) => !lines.includes(e));
  let gitignoreChanged = false;
  if (missing.length > 0) {
    const appended =
      (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
      (existing === "" ? "" : "\n") +
      "# Dex runtime cache — local only, never committed\n" +
      missing.join("\n") +
      "\n";
    fs.writeFileSync(gi, appended, "utf-8");
    gitignoreChanged = true;
  }

  if (!fs.existsSync(path.join(projectDir, ".git"))) return;
  // Stage `.gitignore` ourselves so the next checkpoint commit absorbs the
  // migration cleanly — `commitCheckpoint`'s allow-list doesn't include
  // `.gitignore`, so without this it would sit as `M .gitignore` after run end.
  if (gitignoreChanged) {
    try {
      gitExec(`git add .gitignore`, projectDir);
    } catch {
      // non-fatal
    }
  }
  for (const cached of UNTRACK_TARGETS) {
    try {
      gitExec(`git rm --cached ${cached}`, projectDir);
    } catch {
      // wasn't tracked — fine
    }
  }
}
