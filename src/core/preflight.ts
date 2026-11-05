/**
 * What: The policy's preflight (research R12). `runPreflight` runs each `policy.preflight` command with `bash -c` in the project folder (60 s timeout, the tail of its output logged); `checkRepos` expands each `policy.repos` glob and needs every matching folder to be a clean git checkout. Each returns the first failure as one line naming the command or the checkout, or null.
 * Not: Does not pause the run — the loop turns a failure into a `preflight_failed` pause. Never changes a checkout.
 * Deps: branching.dirtyFiles, policy.Policy, node:child_process.execFile, node:fs.globSync (Node 22+).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { dirtyFiles } from "./branching.js";
import type { Policy } from "./policy.js";

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;
const TAIL_CHARS = 2_000;

export type PreflightLog = (level: "INFO" | "WARN", msg: string, data?: unknown) => void;

const tail = (s: string | undefined) => (s ?? "").slice(-TAIL_CHARS);

interface ExecError {
  code?: number | string;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

/** The first preflight command that fails, as one line; null when all pass. */
export async function runPreflight(
  policy: Policy,
  projectDir: string,
  log: PreflightLog,
): Promise<string | null> {
  for (const command of policy.preflight) {
    try {
      const { stdout, stderr } = await run("bash", ["-c", command], {
        cwd: projectDir,
        timeout: TIMEOUT_MS,
      });
      log("INFO", `preflight: ok — ${command}`, { stdout: tail(stdout), stderr: tail(stderr) });
    } catch (err) {
      const e = err as ExecError;
      const exit = e.killed
        ? `timed out after ${TIMEOUT_MS / 1000} s`
        : `exit code ${e.code ?? e.signal ?? "unknown"}`;
      log("WARN", `preflight: failed — ${command} (${exit})`, {
        stdout: tail(e.stdout),
        stderr: tail(e.stderr),
      });
      return `preflight command \`${command}\` failed (${exit})`;
    }
  }
  return null;
}

function isGitCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** The first `policy.repos` match that is not a clean git checkout, as one line; null when all are. */
export function checkRepos(policy: Policy, projectDir: string): string | null {
  for (const glob of policy.repos) {
    const matches = fs
      .globSync(glob, { cwd: projectDir })
      .map((rel) => path.resolve(projectDir, rel))
      .filter((abs) => fs.statSync(abs).isDirectory())
      .sort();
    for (const repo of matches) {
      const rel = path.relative(projectDir, repo);
      if (!isGitCheckout(repo)) return `${rel} (repos: "${glob}") is not a git checkout`;
      const dirty = dirtyFiles(repo);
      if (dirty.length > 0)
        return `${rel} (repos: "${glob}") has uncommitted changes: ${dirty.join(", ")}`;
    }
  }
  return null;
}
