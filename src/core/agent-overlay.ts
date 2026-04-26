import fs from "node:fs";
import path from "node:path";
import type { AgentProfile, ClaudeProfile } from "./agent-profile.js";

/**
 * Map a runner kind to the runner-native config subdirectory name.
 *
 * Claude Code looks for `.claude/`. Codex/Copilot will get their own
 * subdirectory names when those runners land — for now they're stubs that
 * never actually overlay (the runner registry rejects them upstream of
 * `applyOverlay`).
 */
function nativeConfigSubdir(profile: AgentProfile): string | null {
  switch (profile.agentRunner) {
    case "claude-sdk":
      return ".claude";
    case "codex":
      return ".codex";
    case "copilot":
      return ".copilot";
  }
}

/**
 * Copy the profile's runner-native subtree into the variant's worktree.
 *
 * Behavior:
 *   • profile === null  → no-op (variant uses orchestrator defaults)
 *   • profile has no runner-native subdir → no-op (variant inherits worktree's
 *     committed `.claude/`, only Dex-side knobs apply)
 *   • profile has a `.claude/` (or runner equivalent) → top-level entries are
 *     copied with `force: true` into `<worktreePath>/.claude/`. Existing files
 *     are REPLACED, not merged.
 *
 * Throws if `worktreePath` doesn't exist — the caller (spawnVariants) is
 * expected to have run `git worktree add` first.
 *
 * Never touches the project root. The agent folder under `.dex/agents/` is
 * read-only here.
 */
export function applyOverlay(worktreePath: string, profile: AgentProfile | ClaudeProfile | null): void {
  if (!profile) return;
  if (!fs.existsSync(worktreePath)) {
    throw new Error(`worktree path does not exist: ${worktreePath}`);
  }
  const subdir = nativeConfigSubdir(profile);
  if (!subdir) return;
  const sourceDir = path.join(profile.agentDir, subdir);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    // Profile has no runner-native overlay — that's a valid config.
    return;
  }
  const targetDir = path.join(worktreePath, subdir);
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy each top-level entry recursively, replacing on collision.
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    fs.cpSync(src, dst, { recursive: true, force: true });
  }
}
