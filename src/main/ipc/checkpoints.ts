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
  readPendingPromote,
  clearPendingPromote,
  ensureDexGitignore,
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
import { createAgentRunner } from "../../core/agent/index.js";
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
 * Post-promote on-disk cleanup. The squash-merge flow drops both
 * `.dex/state.json` and `.dex/feature-manifest.json` from the merge commit
 * itself (`git rm -f --ignore-unmatch` before `git commit`), so on success
 * both files are gone from the working tree post-merge — Steps tab falls
 * back to "no run yet" naturally.
 *
 * This function is the safety net for the edge case where state.json existed
 * in the working tree but wasn't tracked at squash time (fresh project, no
 * checkpoint commit yet) — `git rm --ignore-unmatch` skips untracked paths,
 * so we may need to fs.unlink the leftover working-tree copy.
 *
 * Audit trail in `.dex/runs/<runId>.json` and `.dex/learnings.md` are
 * preserved — those are cumulative across specs.
 *
 * Best-effort: a missing file is fine; any other failure is logged but
 * not surfaced (the merge itself already succeeded).
 */
function finalizePromoteOnDisk(projectDir: string): void {
  const target = path.join(projectDir, ".dex", "state.json");
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err) {
    ipcLogger.run("WARN", "finalizePromoteOnDisk: unlink failed", {
      target,
      message: err instanceof Error ? err.message : String(err),
      cwd: projectDir,
    });
  }
}

/**
 * Push a `loop_reset` event back to the renderer that initiated the
 * merge. `useLoopState` clears its in-memory loop state on this event so
 * the Steps tab stops showing the just-completed run's "All Features
 * Implemented" view.
 */
function emitLoopReset(senderWebContentsId: number): void {
  const wc = BrowserWindow.getAllWindows()
    .map((w) => w.webContents)
    .find((c) => c.id === senderWebContentsId);
  if (wc && !wc.isDestroyed()) {
    const event: OrchestratorEvent = { type: "loop_reset", reason: "promoted" };
    wc.send("orchestrator:event", event);
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
        const result = await mergeToMain(projectDir, sourceBranch, opts, ipcLogger, resolverDeps);
        if (result.ok) {
          finalizePromoteOnDisk(projectDir);
          emitLoopReset(e.sender.id);
        }
        return result;
      }),
  );

  // 014/US4 — three follow-up IPCs invoked by the resolver-failure modal.

  ipcMain.handle(
    "checkpoints:acceptResolverResult",
    async (e, projectDir: string): Promise<{ ok: true; mergeSha: string } | { ok: false; error: string }> =>
      withLock(projectDir, () => {
        try {
          // Recover the in-flight squash-merge target from the sidecar
          // `git merge --squash` doesn't write MERGE_MSG, so we stashed
          // sourceBranch + primary at start; we need sourceBranch to build
          // the canonical commit subject the timeline parser recognizes.
          const pending = readPendingPromote(projectDir);
          if (!pending) {
            return {
              ok: false as const,
              error: "no in-flight promote to accept (sidecar missing)",
            };
          }
          const subject = `dex: promoted ${pending.sourceBranch} to ${pending.primary}`;
          gitExec(`git add -A`, projectDir);
          // Drop per-spec runtime files from the commit — same reason as the
          // clean-merge path in branchOps.mergeToMain: per-spec scratch that
          // doesn't belong on `main`. `--ignore-unmatch` is no-op-safe when
          // a file was never tracked (legacy-branch safety net).
          try {
            gitExec(`git rm -f --ignore-unmatch .dex/feature-manifest.json .dex/state.json`, projectDir);
          } catch {
            // best-effort — fall through to commit
          }
          gitExec(`git commit -q -m "${subject}"`, projectDir);
          const mergeSha = gitExec(`git rev-parse HEAD`, projectDir);
          // Source branch is intentionally kept — Timeline drill-down walks
          // it to recover the version's full agent-step history.
          clearPendingPromote(projectDir);
          finalizePromoteOnDisk(projectDir);
          emitLoopReset(e.sender.id);
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
          // `git merge --squash` doesn't set MERGE_HEAD, so `git merge
          // --abort` is unavailable. `git reset --merge` rolls the index
          // and work-tree back to HEAD whether or not a merge is in
          // progress.
          gitExec(`git reset --merge`, projectDir);
          clearPendingPromote(projectDir);
          return { ok: true as const };
        } catch (err) {
          // Tolerate "no-op" cases where there's nothing to reset — the
          // user may have hit Cancel after the merge was already cleaned up.
          const msg = err instanceof Error ? err.message : String(err);
          clearPendingPromote(projectDir);
          if (/no merge to abort|no merge in progress/i.test(msg)) {
            return { ok: true as const };
          }
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
          ensureDexGitignore(projectDir);
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
