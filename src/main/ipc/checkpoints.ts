import { ipcMain, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  listTimeline,
  jumpTo,
  deleteBranch,
  mergeToMain,
  computePromoteSummary,
  syncStateFromHead,
  type JumpToResult,
  type DeleteBranchResult,
  type DeleteBranchOpts,
  type MergeToMainResult,
  type MergeToMainOpts,
  type MergeToMainResolverDeps,
  type PromoteSummary,
} from "../../core/checkpoints.js";
import { withLock } from "./lock-utils.js";
import { createIpcLogger } from "./logger.js";
import "../../core/agent/index.js"; // side-effect: register claude+mock
import { createAgentRunner } from "../../core/agent/registry.js";
import { loadDexConfig } from "../../core/dexConfig.js";
import type { RunConfig, OrchestratorEvent } from "../../core/types.js";
import type { RunLogger } from "../../core/log.js";

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

/**
 * Build the resolver dependency bundle for a single `mergeToMain` invocation.
 * Loads DexConfig, picks the right agent runner, constructs a minimal
 * `RunConfig`, and routes resolver progress events to the calling renderer
 * via `webContents.send("orchestrator:event", ...)`.
 *
 * The resolver isn't part of an orchestrator run, so the logger duck-types
 * `RunLogger` over the existing IpcLogger — only `run`/`agentRun` are
 * actually called by the resolver harness and ClaudeAgentRunner.runOneShot.
 */
function buildResolverDeps(
  projectDir: string,
  senderWebContentsId: number,
): MergeToMainResolverDeps {
  const dexConfig = loadDexConfig(projectDir);
  const resolverModel = dexConfig.conflictResolver.model ?? "claude-opus-4-7";
  const runConfig = {
    projectDir,
    specDir: "",
    mode: "loop",
    model: resolverModel,
    maxIterations: dexConfig.conflictResolver.maxIterations,
    maxTurns: dexConfig.conflictResolver.maxTurnsPerIteration,
    taskPhases: "all",
    autoClarification: false,
  } as unknown as RunConfig;

  const runner = createAgentRunner(dexConfig.agent, runConfig, projectDir);

  const emit = (event: OrchestratorEvent): void => {
    const wc = BrowserWindow.getAllWindows()
      .map((w) => w.webContents)
      .find((c) => c.id === senderWebContentsId);
    if (wc && !wc.isDestroyed()) {
      wc.send("orchestrator:event", event);
    }
  };

  // Duck-typed RunLogger over the IPC logger — `run` and `agentRun` are the
  // only methods the resolver path actually invokes. `subagentEvent` is a
  // no-op since runOneShot doesn't spawn subagents.
  const rlog = {
    run: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, data?: unknown) =>
      ipcLogger.run(level, msg, data),
    agentRun: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, data?: unknown) =>
      ipcLogger.run(level, `[resolver] ${msg}`, data),
    subagentEvent: () => {},
  } as unknown as RunLogger;

  return {
    runner,
    config: dexConfig.conflictResolver,
    runConfig,
    emit,
    abortController: null,
    rlog,
  };
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
    "checkpoints:deleteBranch",
    async (
      _e,
      projectDir: string,
      branchName: string,
      opts?: DeleteBranchOpts,
    ): Promise<DeleteBranchResult | { ok: false; error: "locked_by_other_instance" }> =>
      withLock(projectDir, () => deleteBranch(projectDir, branchName, opts, ipcLogger)),
  );

  // Read-only: pre-fetch the promote diff summary for the confirm modal.
  // No lock — pure read.
  ipcMain.handle(
    "checkpoints:promoteSummary",
    async (_e, projectDir: string, sourceBranch: string): Promise<PromoteSummary> => {
      try {
        return computePromoteSummary(projectDir, sourceBranch);
      } catch (err) {
        ipcLogger.run("ERROR", "promoteSummary threw", {
          message: err instanceof Error ? err.message : String(err),
          cwd: projectDir,
        });
        return { fileCount: 0, added: 0, removed: 0, topPaths: [], fullPaths: [] };
      }
    },
  );

  ipcMain.handle(
    "checkpoints:mergeToMain",
    async (
      e,
      projectDir: string,
      sourceBranch: string,
      opts?: MergeToMainOpts,
    ): Promise<MergeToMainResult | { ok: false; error: "locked_by_other_instance" }> =>
      withLock(projectDir, async () => {
        const resolverDeps = buildResolverDeps(projectDir, e.sender.id);
        return mergeToMain(projectDir, sourceBranch, opts, ipcLogger, resolverDeps);
      }),
  );

  // 014/US4 — three follow-up IPCs invoked by the resolver-failure modal.

  ipcMain.handle(
    "checkpoints:acceptResolverResult",
    async (_e, projectDir: string): Promise<{ ok: true; mergeSha: string } | { ok: false; error: string }> =>
      withLock(projectDir, () => {
        try {
          gitExec(`git add -A`, projectDir);
          // --no-edit accepts the canonical merge subject `mergeToMain` set
          // via `git merge --no-ff --no-commit -m "..."`.
          gitExec(`git commit -q --no-edit`, projectDir);
          const mergeSha = gitExec(`git rev-parse HEAD`, projectDir);
          // Try to read MERGE_MSG to discover the source branch (best-effort —
          // the post-merge cleanup needs to delete the source branch).
          let sourceBranch: string | null = null;
          try {
            const mergeMsgPath = path.join(projectDir, ".git", "MERGE_MSG");
            if (fs.existsSync(mergeMsgPath)) {
              const msg = fs.readFileSync(mergeMsgPath, "utf-8");
              const m = msg.match(/^dex: promoted (\S+) to (?:main|master)/m);
              if (m) sourceBranch = m[1];
            }
          } catch {
            sourceBranch = null;
          }
          // MERGE_MSG is consumed by `git commit` so by now it's gone — we
          // already captured the source branch before the commit. The above
          // attempt is a no-op safety net.
          if (!sourceBranch) {
            // Fall back: parse the just-created merge commit's subject.
            const subject = gitExec(`git log -1 --format=%s ${mergeSha}`, projectDir);
            const m = subject.match(/^dex: promoted (\S+) to (?:main|master)/);
            if (m) sourceBranch = m[1];
          }
          if (sourceBranch) {
            try {
              gitExec(`git branch -D ${sourceBranch}`, projectDir);
            } catch {
              // Best-effort cleanup — leftover branch is cosmetic.
            }
          }
          return { ok: true as const, mergeSha };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
        }
      }),
  );

  ipcMain.handle(
    "checkpoints:abortResolverMerge",
    async (_e, projectDir: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      withLock(projectDir, () => {
        try {
          gitExec(`git merge --abort`, projectDir);
          return { ok: true as const };
        } catch (err) {
          // If there's no merge in progress, treat as a no-op success — the
          // user may have hit Cancel after the merge was already cleaned up.
          const msg = err instanceof Error ? err.message : String(err);
          if (/no merge to abort/i.test(msg)) return { ok: true as const };
          return { ok: false as const, error: msg };
        }
      }),
  );

  ipcMain.handle(
    "checkpoints:openInEditor",
    async (
      _e,
      projectDir: string,
      files: string[],
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const editor = process.env.EDITOR;
        const platform = process.platform;
        const fallback = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : "notepad";
        const cmd = editor || fallback;
        const args = [...files];
        const cp = await import("node:child_process");
        cp.spawn(cmd, args, {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
        }).unref();
        return { ok: true as const };
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
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
