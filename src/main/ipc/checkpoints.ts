import { ipcMain } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  listTimeline,
  jumpTo,
  unselect,
  syncStateFromHead,
  type JumpToResult,
} from "../../core/checkpoints.js";
import { withLock } from "./lock-utils.js";
import { createIpcLogger } from "./logger.js";

const ipcLogger = createIpcLogger("checkpoints-ipc");

/**
 * Run a git command and return its trimmed stdout. **stderr is captured**
 * (`stdio: ["ignore", "pipe", "pipe"]`) so failures bubble up as proper
 * Errors instead of leaking `fatal: ...` lines straight to the parent
 * process's terminal — same posture as `gitExec` in `_helpers.ts`.
 */
function gitExec(cmd: string, projectDir: string): string {
  try {
    return execSync(cmd, {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { status?: number | null; stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = e?.stderr ? String(e.stderr).trim() : "";
    const stdout = e?.stdout ? String(e.stdout).trim() : "";
    const wrapped = new Error(
      `gitExec failed (status=${e?.status ?? "n/a"}): ${cmd}\n${stderr || stdout || "(no output)"}`,
    );
    (wrapped as Error & { cmd: string; cwd: string; stderr: string }).cmd = cmd;
    (wrapped as Error & { cmd: string; cwd: string; stderr: string }).cwd = projectDir;
    (wrapped as Error & { cmd: string; cwd: string; stderr: string }).stderr = stderr;
    throw wrapped;
  }
}

/**
 * Same as `gitExec` but swallows failures (returns ""). Logs the failed
 * command + stderr through `ipcLogger` so the swallowed error still
 * appears in `electron.log` with full context.
 */
function gitExecSilent(cmd: string, projectDir: string): string {
  try {
    return gitExec(cmd, projectDir);
  } catch (err) {
    const e = err as { cmd?: string; stderr?: string };
    ipcLogger.run("WARN", "gitExecSilent swallowed failure", {
      cmd: e.cmd ?? cmd,
      cwd: projectDir,
      stderr: e.stderr,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

export function registerCheckpointsHandlers(): void {
  // ── Read-only ─────────────────────────────────────────

  ipcMain.handle("checkpoints:listTimeline", (_e, projectDir: string) => {
    try {
      return listTimeline(projectDir, ipcLogger);
    } catch (err) {
      ipcLogger.run("ERROR", "listTimeline threw", {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cwd: projectDir,
      });
      return {
        checkpoints: [],
        currentBranch: "",
        pending: [],
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

  // ── Mutating (lock required) ──────────────────────────

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
}
