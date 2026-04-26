import { ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  listTimeline,
  promoteToCheckpoint,
  spawnVariants,
  cleanupVariantWorktree,
  readPendingVariantGroups,
  writeVariantGroupFile,
  readVariantGroupFile,
  deleteVariantGroupFile,
  jumpTo,
  unmarkCheckpoint,
  unselect,
  syncStateFromHead,
  PATHS_BY_STEP,
  type VariantSpawnRequest,
  type VariantGroupFile,
  type JumpToResult,
} from "../../core/checkpoints.js";
import * as runs from "../../core/runs.js";
import type { StepType } from "../../core/types.js";
import { withLock } from "./lock-utils.js";
import { createIpcLogger } from "./logger.js";

const ipcLogger = createIpcLogger("checkpoints-ipc");

function gitExec(cmd: string, projectDir: string): string {
  return execSync(cmd, { cwd: projectDir, encoding: "utf-8" }).trim();
}

function gitExecSilent(cmd: string, projectDir: string): string {
  try {
    return execSync(cmd, { cwd: projectDir, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

export function registerCheckpointsHandlers(): void {
  // ── Read-only ─────────────────────────────────────────

  ipcMain.handle("checkpoints:listTimeline", (_e, projectDir: string) => {
    try {
      return listTimeline(projectDir);
    } catch (err) {
      console.warn("[checkpoints-ipc] listTimeline failed", err);
      return {
        checkpoints: [],
        attempts: [],
        currentAttempt: null,
        pending: [],
        captureBranches: [],
        startingPoint: null,
        commits: [],
        selectedPath: [],
      };
    }
  });

  ipcMain.handle("checkpoints:checkIsRepo", (_e, projectDir: string) => {
    return fs.existsSync(path.join(projectDir, ".git"));
  });

  ipcMain.handle("checkpoints:checkIdentity", (_e, projectDir: string) => {
    const name = gitExecSilent(`git config --get user.name`, projectDir) || null;
    const email = gitExecSilent(`git config --get user.email`, projectDir) || null;
    const hostname = os.hostname();
    const username = os.userInfo().username;
    return {
      name,
      email,
      suggestedName: username,
      suggestedEmail: `${username}@${hostname}`,
    };
  });

  ipcMain.handle(
    "checkpoints:estimateVariantCost",
    (_e, projectDir: string, step: StepType, variantCount: number) => {
      const recent = runs.listRuns(projectDir, 20);
      const costs: number[] = [];
      for (const r of recent) {
        for (const ar of r.agentRuns) {
          if (ar.step === step && ar.status === "completed") {
            costs.push(ar.costUsd);
          }
        }
      }
      const sample = costs.slice(0, 5).sort((a, b) => a - b);
      if (sample.length === 0) {
        return {
          perVariantMedian: null,
          perVariantP75: null,
          totalMedian: null,
          totalP75: null,
          sampleSize: 0,
        };
      }
      const median = sample[Math.floor(sample.length / 2)];
      const p75 = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.75))];
      return {
        perVariantMedian: median,
        perVariantP75: p75,
        totalMedian: median * variantCount,
        totalP75: p75 * variantCount,
        sampleSize: sample.length,
      };
    },
  );

  ipcMain.handle("checkpoints:readPendingVariantGroups", (_e, projectDir: string) => {
    return readPendingVariantGroups(projectDir);
  });

  // ── Mutating (lock required) ──────────────────────────

  ipcMain.handle(
    "checkpoints:promote",
    async (_e, projectDir: string, tag: string, sha: string) =>
      withLock(projectDir, () => promoteToCheckpoint(projectDir, tag, sha, ipcLogger)),
  );

  ipcMain.handle(
    "checkpoints:unmark",
    async (_e, projectDir: string, sha: string) =>
      withLock(projectDir, () => unmarkCheckpoint(projectDir, sha, ipcLogger)),
  );

  ipcMain.handle(
    "checkpoints:unselect",
    async (_e, projectDir: string, branchName: string) =>
      withLock(projectDir, () => unselect(projectDir, branchName, ipcLogger)),
  );

  ipcMain.handle(
    "checkpoints:syncStateFromHead",
    async (_e, projectDir: string) =>
      withLock(projectDir, () => syncStateFromHead(projectDir, ipcLogger)),
  );

  ipcMain.handle(
    "checkpoints:jumpTo",
    async (
      _e,
      projectDir: string,
      targetSha: string,
      options?: { force?: "save" | "discard" },
    ): Promise<JumpToResult | { ok: false; error: "locked_by_other_instance" }> =>
      withLock(projectDir, () => jumpTo(projectDir, targetSha, options, ipcLogger)),
  );

  ipcMain.handle(
    "checkpoints:spawnVariants",
    async (_e, projectDir: string, request: VariantSpawnRequest) =>
      withLock(projectDir, () => {
        const spawn = spawnVariants(projectDir, request, ipcLogger);
        if (!spawn.ok) return spawn;
        const now = new Date().toISOString();
        const group: VariantGroupFile = {
          groupId: spawn.result.groupId,
          fromCheckpoint: request.fromCheckpoint,
          step: request.step,
          parallel: spawn.result.parallel,
          createdAt: now,
          variants: spawn.result.branches.map((branch, i) => {
            const letter = request.variantLetters[i];
            const profileBinding = request.profiles?.find((p) => p.letter === letter)?.profile ?? null;
            return {
              letter,
              branch,
              worktree: spawn.result.worktrees?.[i] ?? null,
              status: "pending" as const,
              runId: null,
              candidateSha: null,
              errorMessage: null,
              // 010 — record profile binding for resume-mid-variant.
              profile: profileBinding
                ? { name: profileBinding.name, agentDir: profileBinding.agentDir }
                : null,
            };
          }),
          resolved: { kind: null, pickedLetter: null, resolvedAt: null },
        };
        writeVariantGroupFile(projectDir, group);
        return spawn;
      }),
  );

  ipcMain.handle(
    "checkpoints:cleanupVariantGroup",
    async (
      _e,
      projectDir: string,
      groupId: string,
      kind: "keep" | "discard",
      pickedLetter?: string,
    ) =>
      withLock(projectDir, () => {
        const group = readVariantGroupFile(projectDir, groupId);
        if (!group) return { ok: false as const, error: "group_not_found" };
        for (const v of group.variants) {
          if (v.worktree) {
            if (kind === "keep" && v.letter === pickedLetter) {
              cleanupVariantWorktree(projectDir, v.worktree);
              continue;
            }
            cleanupVariantWorktree(projectDir, v.worktree);
          }
        }
        group.resolved = {
          kind,
          pickedLetter: kind === "keep" ? (pickedLetter ?? null) : null,
          resolvedAt: new Date().toISOString(),
        };
        // Persist a final snapshot with `resolved` populated, then delete — this
        // gives a forensic-friendly intermediate state in logs if something goes
        // wrong before the delete.
        writeVariantGroupFile(projectDir, group);
        deleteVariantGroupFile(projectDir, groupId);
        return { ok: true as const };
      }),
  );

  ipcMain.handle(
    "checkpoints:initRepo",
    async (_e, projectDir: string) =>
      withLock(projectDir, () => {
        try {
          if (!fs.existsSync(path.join(projectDir, ".git"))) {
            gitExec(`git init`, projectDir);
          }
          const gi = path.join(projectDir, ".gitignore");
          const entries = [
            ".dex/state.json",
            ".dex/state.lock",
            ".dex/variant-groups/",
            ".dex/worktrees/",
          ];
          const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf-8") : "";
          const missing = entries.filter((e) => !existing.split("\n").includes(e));
          if (missing.length > 0) {
            const appended =
              (existing.endsWith("\n") || existing === "" ? existing : existing + "\n") +
              (existing === "" ? "" : "\n") +
              "# Dex runtime cache — local only, never committed\n" +
              missing.join("\n") +
              "\n";
            fs.writeFileSync(gi, appended, "utf-8");
          }
          // If state.json was previously tracked, untrack it silently.
          try {
            gitExec(`git rm --cached .dex/state.json`, projectDir);
          } catch {
            // wasn't tracked — fine
          }
          // Initial commit if repo is empty
          try {
            gitExecSilent(`git rev-parse HEAD`, projectDir);
          } catch {
            gitExec(`git add -A`, projectDir);
            gitExec(`git commit -m "chore: initial dex commit"`, projectDir);
          }
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: String(err) };
        }
      }),
  );

  ipcMain.handle(
    "checkpoints:setIdentity",
    async (_e, projectDir: string, name: string, email: string) =>
      withLock(projectDir, () => {
        try {
          gitExec(`git config user.name "${name.replace(/"/g, '\\"')}"`, projectDir);
          gitExec(`git config user.email "${email.replace(/"/g, '\\"')}"`, projectDir);
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: String(err) };
        }
      }),
  );

  // ── Stage-aware compare ───────────────────────────────

  ipcMain.handle(
    "checkpoints:compareAttempts",
    (_e, projectDir: string, branchA: string, branchB: string, step: StepType | null) => {
      try {
        const paths = step ? PATHS_BY_STEP[step] : undefined;
        if (paths && paths.length > 0) {
          const diff = gitExecSilent(
            `git diff ${branchA}..${branchB} -- ${paths.map((p) => `"${p}"`).join(" ")}`,
            projectDir,
          );
          return { ok: true as const, diff, mode: "path-filtered", paths };
        }
        const diff = gitExecSilent(`git diff --stat ${branchA}..${branchB}`, projectDir);
        return { ok: true as const, diff, mode: "stat" };
      } catch (err) {
        return { ok: false as const, error: String(err) };
      }
    },
  );
}
