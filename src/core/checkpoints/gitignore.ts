/**
 * What: Idempotent `.gitignore` bootstrap for Dex runtime-cache files. Ensures
 *       per-machine files (`.dex/state.lock`, `.dex/ui.json`, …) are listed in
 *       the project's `.gitignore`, strips legacy entries that became
 *       branch-tracked (`.dex/state.json`, `.dex/feature-manifest.json`), and
 *       runs the inverse `git add` migration so previously-ignored files start
 *       riding `git checkout`.
 * Not: Does not commit. Does not init the repo. Does not touch files outside
 *      `.gitignore` and the index.
 * Deps: node:fs, node:path, _helpers (gitExec).
 */

import fs from "node:fs";
import path from "node:path";
import { gitExec } from "./_helpers.js";

const RUNTIME_CACHE_ENTRIES = [
  ".dex/state.lock",
  ".dex/ui.json",
  ".dex/variant-groups/",
  ".dex/worktrees/",
] as const;

// Legacy entries that previous versions added to projects' `.gitignore`. They
// are now committed (so `git checkout -B selected-<ts> <sha>` restores them
// correctly on a Timeline jump). Strip them on every run-start to migrate
// projects that pulled the change in.
const LEGACY_IGNORE_ENTRIES = [
  ".dex/state.json",
  ".dex/feature-manifest.json",
] as const;

// Files that flipped from gitignored to tracked. If they exist on disk and
// aren't tracked yet, `git add` them so the next checkpoint commit absorbs
// them. The 014 fork-resume reconciliation depends on these riding checkout.
const TRACK_TARGETS = [
  ".dex/state.json",
  ".dex/feature-manifest.json",
] as const;

/**
 * Append any missing Dex runtime-cache entries to `<projectDir>/.gitignore`,
 * strip legacy entries that flipped from gitignored to tracked, then `git add`
 * any of those files that exist but aren't tracked yet.
 *
 * Safe to call repeatedly — the ignore-rewrite is dedup'd by exact line match,
 * legacy-strip is no-op when already absent, and `git ls-files --error-unmatch`
 * gates `git add` so already-tracked files don't get re-staged. Safe on
 * non-git directories — only the `.gitignore` write runs, the index ops are
 * gated on the presence of `.git`.
 */
export function ensureDexGitignore(projectDir: string): void {
  const gi = path.join(projectDir, ".gitignore");
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
  const existingLines = existing.split("\n");

  // Step A — strip legacy ignore entries (state.json, feature-manifest.json).
  const legacy = new Set<string>(LEGACY_IGNORE_ENTRIES);
  const filtered = existingLines.filter((line) => !legacy.has(line));
  const strippedLegacy = filtered.length !== existingLines.length;

  // Step B — append any missing runtime-cache entries.
  const missing = RUNTIME_CACHE_ENTRIES.filter((e) => !filtered.includes(e));
  let gitignoreChanged = strippedLegacy;
  let nextContent = filtered.join("\n");
  if (missing.length > 0) {
    nextContent =
      (nextContent.endsWith("\n") || nextContent === "" ? nextContent : nextContent + "\n") +
      (nextContent === "" ? "" : "\n") +
      "# Dex runtime cache — local only, never committed\n" +
      missing.join("\n") +
      "\n";
    gitignoreChanged = true;
  } else if (strippedLegacy) {
    // Ensure the file still ends with a newline after stripping.
    if (!nextContent.endsWith("\n") && nextContent.length > 0) nextContent += "\n";
  }
  if (gitignoreChanged) {
    fs.writeFileSync(gi, nextContent, "utf-8");
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

  // Step C — track previously-ignored files. Skip if file doesn't exist
  // (fresh project, no run yet) or already tracked.
  for (const target of TRACK_TARGETS) {
    if (!fs.existsSync(path.join(projectDir, target))) continue;
    try {
      // `--error-unmatch` exits non-zero when path isn't tracked.
      gitExec(`git ls-files --error-unmatch -- ${target}`, projectDir);
      // Already tracked — nothing to do.
    } catch {
      try {
        gitExec(`git add -- ${target}`, projectDir);
      } catch {
        // non-fatal — pathspec issue or transient git error
      }
    }
  }

  // Step D — paranoia: state.lock should always be untracked. If a prior
  // version's bug ever staged it, untrack here. `git rm --cached` is no-op
  // when the file isn't tracked.
  try {
    gitExec(`git rm --cached -- .dex/state.lock`, projectDir);
  } catch {
    // wasn't tracked — fine
  }
}
