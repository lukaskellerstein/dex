/**
 * What: commitCheckpoint — produces a structured-message --allow-empty commit for one stage; readPauseAfterStage — reads the per-project step-mode flag from .dex/state.json.
 * Not: Does not tag the commit. Does not auto-promote. Does not decide whether to commit; that's the orchestrator's call.
 * Deps: _helpers (gitExec), node:child_process (raw execSync for stdin pipe), ../git.js (getHeadSha), ../state.js (loadState).
 */

import { execSync } from "node:child_process";
import { gitExec } from "./_helpers.js";
import { getHeadSha } from "../git.js";
import { loadState } from "../state.js";

export function commitCheckpoint(
  projectDir: string,
  stage: string,
  cycleNumber: number,
  featureName: string | null,
): string {
  // Two-line structured message per 008 contract. Line 2 is machine-parseable.
  const featureSlug = featureName ?? "-";
  const message =
    `dex: ${stage} completed [cycle:${cycleNumber}] [feature:${featureSlug}]\n` +
    `[checkpoint:${stage}:${cycleNumber}]`;

  // Stage tracked Dex files only. state.json is gitignored (008 P3); committing
  // it would resurrect the old tree-rewrite-at-promote problem. feature-manifest.json
  // stays tracked because teams rely on it for feature inventory.
  try {
    gitExec("git add .dex/feature-manifest.json", projectDir);
  } catch {
    // File may not exist yet (pre-manifest-extraction stages). That's fine.
  }
  try {
    gitExec("git add .dex/learnings.md", projectDir);
  } catch {
    // May not exist yet. That's fine.
  }

  // --allow-empty ensures every stage gets its own distinct SHA, even when the
  // stage produced no file changes (e.g., verify). Without this, adjacent
  // stage checkpoints would coincide on the same commit.
  //
  // We pass the message via stdin with -F - to avoid shell-escaping issues
  // with the embedded newline. gitExec doesn't take stdin, so use execSync directly.
  execSync(`git commit --allow-empty -F -`, {
    cwd: projectDir,
    input: message,
    encoding: "utf-8",
  });

  return getHeadSha(projectDir);
}

/**
 * Read the per-project step-mode flag (`.dex/state.json` `ui.pauseAfterStage`).
 * Returns false on any IO error. The orchestrator pauses after each stage when
 * either this flag or `RunConfig.stepMode` is true.
 */
export async function readPauseAfterStage(projectDir: string): Promise<boolean> {
  try {
    const s = await loadState(projectDir);
    return Boolean(s?.ui?.pauseAfterStage);
  } catch {
    return false;
  }
}
