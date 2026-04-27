/**
 * What: 010 variant spawning — given a fromCheckpoint + variant letters, create attempt-<ts>-{a,b,c} branches (parallelizable steps get worktrees with optional .claude/ overlay; sequential steps share the working tree).
 * Not: Does not pick a winner. Does not promote. Does not run any agent — just sets up the git substrate the orchestrator dispatches into.
 * Deps: _helpers (gitExec, log), tags.ts (attemptBranchName, isParallelizable), ../agent-overlay.js (applyOverlay), ../agent-profile.js (AgentProfile), ../types.js (StepType), node:crypto, node:path.
 */

import crypto from "node:crypto";
import path from "node:path";
import { gitExec, log, type RunLoggerLike } from "./_helpers.js";
import { attemptBranchName, isParallelizable } from "./tags.js";
import { applyOverlay } from "../agent-overlay.js";
import type { AgentProfile } from "../agent-profile.js";
import type { StepType } from "../types.js";

export interface VariantSpawnRequest {
  fromCheckpoint: string;
  variantLetters: string[];
  step: StepType;
  /**
   * Per-variant agent profile binding (010 — US4). When omitted, every variant
   * runs with `null` (orchestrator defaults, no overlay). Sparse-tolerant:
   * missing letters default to null. Codex/Copilot profiles cause the spawn
   * to early-fail with `"runner not implemented"`.
   */
  profiles?: Array<{
    letter: string;
    profile: AgentProfile | null;
  }>;
}

export interface VariantSpawnResult {
  groupId: string;
  branches: string[];
  worktrees: string[] | null;
  parallel: boolean;
}

/**
 * Resolve a per-variant profile binding from `request.profiles`. Sparse-tolerant
 * — if `profiles` is undefined or the letter is missing, returns null (variant
 * uses orchestrator defaults / no overlay).
 */
function profileFor(request: VariantSpawnRequest, letter: string): AgentProfile | null {
  if (!request.profiles) return null;
  return request.profiles.find((p) => p.letter === letter)?.profile ?? null;
}

export function spawnVariants(
  projectDir: string,
  request: VariantSpawnRequest,
  rlog?: RunLoggerLike
): { ok: true; result: VariantSpawnResult } | { ok: false; error: string } {
  // 010 — Codex/Copilot profiles are stubbed but not wired through any runner
  // yet. Reject early so the spawn doesn't half-succeed and leave dangling
  // worktrees/branches the variant-group state would have to track.
  if (request.profiles) {
    for (const p of request.profiles) {
      if (p.profile && p.profile.agentRunner !== "claude-sdk") {
        log(rlog, "WARN", `spawnVariants: profile '${p.profile.name}' uses ${p.profile.agentRunner} — runner not implemented`);
        return { ok: false, error: "runner not implemented" };
      }
    }
  }

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
        // 010 — overlay the profile's runner-native subdir into the worktree.
        // Skipped for sequential stages (no worktree) and for variants without
        // a profile or without a runner-native subdir.
        const profile = profileFor(request, letter);
        if (profile) {
          try {
            applyOverlay(path.join(projectDir, wtPath), profile);
          } catch (err) {
            log(rlog, "WARN", `spawnVariants: applyOverlay for ${letter} failed: ${String(err)}`);
          }
        }
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
