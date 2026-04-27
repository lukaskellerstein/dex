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

export function gitExec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

export function safeExec(cmd: string, cwd: string): string {
  try {
    return gitExec(cmd, cwd);
  } catch {
    return "";
  }
}
