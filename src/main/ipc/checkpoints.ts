import { ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  listTimeline,
  promoteToCheckpoint,
  startAttemptFrom,
  spawnVariants,
  cleanupVariantWorktree,
  isWorkingTreeDirty,
  readPendingVariantGroups,
  writeVariantGroupFile,
  readVariantGroupFile,
  deleteVariantGroupFile,
  attemptBranchName,
  type VariantSpawnRequest,
  type VariantGroupFile,
} from "../../core/checkpoints.js";
import {
  acquireStateLock,
  isLockedByAnother,
  updateState,
} from "../../core/state.js";
import * as runs from "../../core/runs.js";
import type { StepType } from "../../core/types.js";

// Minimal run-logger adapter for IPC-triggered operations.
const ipcLogger = {
  run: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, extra?: unknown) => {
    if (level === "ERROR" || level === "WARN") {
      console.warn(`[checkpoints-ipc] ${level} ${msg}`, extra ?? "");
    } else {
      console.info(`[checkpoints-ipc] ${level} ${msg}`, extra ?? "");
    }
  },
};

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

async function withLock<T>(
  projectDir: string,
  fn: () => Promise<T> | T,
): Promise<T | { ok: false; error: "locked_by_other_instance" }> {
  let release: (() => void) | null = null;
  try {
    release = await acquireStateLock(projectDir);
  } catch {
    return { ok: false, error: "locked_by_other_instance" } as const;
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

const PATH_BY_STEP: Partial<Record<StepType, string[]>> = {
  gap_analysis: [".dex/feature-manifest.json"],
  manifest_extraction: [".dex/feature-manifest.json"],
  specify: ["specs/"],
  plan: ["specs/"],
  tasks: ["specs/"],
  learnings: [".dex/learnings.md"],
  verify: [".dex/verify-output/"],
};

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
      };
    }
  });

  ipcMain.handle("checkpoints:isLockedByAnother", (_e, projectDir: string) => {
    return isLockedByAnother(projectDir);
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
    "checkpoints:goBack",
    async (
      _e,
      projectDir: string,
      tag: string,
      options?: { force?: "save" | "discard" },
    ) =>
      withLock(projectDir, () => {
        const dirty = isWorkingTreeDirty(projectDir);
        if (dirty.dirty && !options?.force) {
          return { ok: false as const, error: "dirty_working_tree", files: dirty.files };
        }
        if (dirty.dirty && options?.force === "save") {
          const saveBranch = attemptBranchName(new Date()) + "-saved";
          try {
            gitExec(`git checkout -B ${saveBranch}`, projectDir);
            gitExec(`git add -A`, projectDir);
            gitExec(`git commit -m "saved: uncommitted changes before go-back"`, projectDir);
          } catch (err) {
            return {
              ok: false as const,
              error: "save_failed",
              detail: String(err),
            };
          }
        }
        return startAttemptFrom(projectDir, tag, ipcLogger);
      }),
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
          variants: spawn.result.branches.map((branch, i) => ({
            letter: request.variantLetters[i],
            branch,
            worktree: spawn.result.worktrees?.[i] ?? null,
            status: "pending",
            runId: null,
            candidateSha: null,
            errorMessage: null,
          })),
          resolved: { kind: null, pickedLetter: null, resolvedAt: null },
        };
        writeVariantGroupFile(projectDir, group);
        return spawn;
      }),
  );

  ipcMain.handle(
    "checkpoints:deleteAttempt",
    async (_e, projectDir: string, branch: string) =>
      withLock(projectDir, () => {
        const current = gitExecSilent(`git rev-parse --abbrev-ref HEAD`, projectDir);
        if (current === branch) {
          return { ok: false as const, error: "cannot_delete_current" };
        }
        try {
          gitExec(`git branch -D ${branch}`, projectDir);
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: String(err) };
        }
      }),
  );

  ipcMain.handle(
    "checkpoints:writeVariantGroup",
    async (_e, projectDir: string, group: VariantGroupFile) =>
      withLock(projectDir, () => {
        try {
          writeVariantGroupFile(projectDir, group);
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, error: String(err) };
        }
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

  ipcMain.handle(
    "checkpoints:setRecordMode",
    async (_e, projectDir: string, on: boolean) =>
      withLock(projectDir, async () => {
        await updateState(projectDir, { ui: { recordMode: on } });
        return { ok: true as const };
      }),
  );

  ipcMain.handle(
    "checkpoints:setPauseAfterStage",
    async (_e, projectDir: string, on: boolean) =>
      withLock(projectDir, async () => {
        await updateState(projectDir, { ui: { pauseAfterStage: on } });
        return { ok: true as const };
      }),
  );

  // ── Stage-aware compare ───────────────────────────────

  ipcMain.handle(
    "checkpoints:compareAttempts",
    (_e, projectDir: string, branchA: string, branchB: string, step: StepType | null) => {
      try {
        const paths = step ? PATH_BY_STEP[step] : undefined;
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
