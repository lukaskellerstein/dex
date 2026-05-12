/**
 * What: commitCheckpoint — produces a structured-message --allow-empty commit for one stage; readPauseAfterStage — reads the per-developer step-mode flag from .dex/ui.json.
 * Not: Does not tag the commit. Does not auto-promote. Does not decide whether to commit; that's the orchestrator's call.
 * Deps: node:child_process (raw execSync — both for stdin pipe on commit and for stderr-silenced `git add`), ../git.js (getHeadSha), ../uiPrefs.js (loadUiPrefs).
 */

import { execSync } from "node:child_process";
import { getHeadSha } from "../git.js";
import { loadUiPrefs } from "../uiPrefs.js";

/**
 * Stage one pathspec, tolerating "did not match any files" without leaking
 * stderr to the parent process. We deliberately enumerate committable
 * pathspecs here rather than `git add .dex/` — behaviour stays identical
 * regardless of how the consumer project configures `.gitignore`, and we
 * never accidentally commit runtime caches like `state.json`,
 * `feature-manifest.json`, or `state.lock` even on projects without proper
 * ignore rules.
 */
function tryStage(projectDir: string, pathspec: string): void {
  try {
    execSync(`git add ${pathspec}`, {
      cwd: projectDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Pathspec may not match yet (e.g., before learnings.md is appended).
    // Non-fatal.
  }
}

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

  // Explicit allow-list of committable Dex artifacts. Anything else under
  // `.dex/` (state.lock, ui.json, dex-config.json, mock-config.json) is
  // per-developer / runtime and stays out of git via `.gitignore` (managed by
  // `ensureDexGitignore`). state.json + feature-manifest.json travel with
  // the branch so `git checkout` restores them on Timeline-driven jumps.
  // Add to this list when introducing a new committable artifact.
  tryStage(projectDir, ".dex/state.json");
  tryStage(projectDir, ".dex/feature-manifest.json");
  tryStage(projectDir, ".dex/learnings.md");
  tryStage(projectDir, ".dex/runs/");

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
 * Read the per-developer step-mode flag (`.dex/ui.json` `pauseAfterStage`).
 * Returns false on any IO error. The orchestrator pauses after each stage when
 * either this flag or `RunConfig.stepMode` is true. Lives in ui.json (gitignored)
 * rather than state.json (now committed) so the toggle stays per-machine.
 */
export async function readPauseAfterStage(projectDir: string): Promise<boolean> {
  try {
    const prefs = await loadUiPrefs(projectDir);
    return Boolean(prefs.pauseAfterStage);
  } catch {
    return false;
  }
}
