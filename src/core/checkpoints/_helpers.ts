/**
 * What: Internal git/log primitives shared across all checkpoints/* sub-files.
 * Not: Not part of the public `checkpoints` namespace; do not import from outside `src/core/checkpoints/`.
 * Deps: node:child_process.
 */

import { execSync } from "node:child_process";

export interface RunLoggerLike {
  run?: (level: "INFO" | "WARN" | "ERROR" | "DEBUG", msg: string, data?: unknown) => void;
}

export function log(
  rlog: RunLoggerLike | undefined,
  level: "INFO" | "WARN" | "ERROR" | "DEBUG",
  msg: string,
  extra?: unknown,
): void {
  if (rlog?.run) {
    if (extra === undefined) rlog.run(level, msg);
    else rlog.run(level, msg, extra);
  }
}

/**
 * Error thrown by `gitExec` when a git command fails. Carries the failed
 * command, cwd, exit status, and captured stderr so callers (and `safeExec`'s
 * logger) can record exactly which call blew up. Without this wrapper the
 * underlying child-process error has no `cmd`/`cwd` and stderr would have
 * leaked to the parent process's terminal instead of being captured here.
 */
export class GitExecError extends Error {
  readonly cmd: string;
  readonly cwd: string;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(cmd: string, cwd: string, status: number | null, stderr: string, stdout: string) {
    super(`git command failed (status=${status ?? "n/a"}): ${cmd}\n${stderr || stdout || "(no output)"}`);
    this.name = "GitExecError";
    this.cmd = cmd;
    this.cwd = cwd;
    this.status = status;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

interface ChildProcessExecError {
  status?: number | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

function toGitExecError(cmd: string, cwd: string, err: unknown): GitExecError {
  const e = err as ChildProcessExecError;
  const stderr = e?.stderr ? String(e.stderr).trim() : "";
  const stdout = e?.stdout ? String(e.stdout).trim() : "";
  const status = e?.status ?? null;
  return new GitExecError(cmd, cwd, status, stderr, stdout);
}

/**
 * Runs a git command and returns its trimmed stdout. Throws `GitExecError`
 * on non-zero exit. **stderr is captured, not inherited** — without explicit
 * `stdio: ["ignore", "pipe", "pipe"]` Node's default would pipe stdout but
 * leak stderr to the parent process's terminal, producing bare `fatal: ...`
 * lines in `electron.log` with no Dex log entry attached.
 */
export function gitExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    throw toGitExecError(cmd, cwd, err);
  }
}

/**
 * Runs a git command, swallowing failures (returns `""`). Pass an `rlog` to
 * log the swallowed command + stderr — strongly recommended so silent
 * failures don't disappear without a trace. The previous implementation
 * silently dropped errors; a missing `rlog` preserves that behaviour for
 * legacy call sites that explicitly do not care.
 */
export function safeExec(cmd: string, cwd: string, rlog?: RunLoggerLike): string {
  try {
    return gitExec(cmd, cwd);
  } catch (err) {
    if (rlog?.run && err instanceof GitExecError) {
      rlog.run("WARN", "safeExec swallowed git failure", {
        cmd: err.cmd,
        cwd: err.cwd,
        status: err.status,
        stderr: err.stderr,
        stdout: err.stdout,
      });
    }
    return "";
  }
}
