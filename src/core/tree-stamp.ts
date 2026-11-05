/**
 * What: Exact, cheap hashes of a working tree (research R6, R11). `treeStamp` is sha256 over HEAD, `git diff HEAD --binary` and every untracked, not-ignored file (name and content): the same tree gives the same stamp, so a baseline can reuse the last check run instead of running the checks twice. `diffHashSince(sha)` is the same idea against a start commit: the "diff" part of an implement run's stall fingerprint. `diffStatSince(sha)` is the human-readable `--stat` of the same diff (tracked files only), for the verifier's diagnose prompt and the digest; `nameStatusSince` and `diffSince` are the raw diffs plan-diff.ts reads after an implement run.
 * Not: Decides nothing and writes nothing. Ignored files (Dex's own runtime files among them) never change a stamp.
 * Deps: node:child_process.execFileSync (git, no shell), node:crypto, node:fs, node:path.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BUFFER = 512 * 1024 * 1024;

function git(projectDir: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd: projectDir,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function headOrEmpty(projectDir: string): string {
  try {
    return git(projectDir, ["rev-parse", "--verify", "--quiet", "HEAD"]).toString("utf-8").trim();
  } catch {
    return "";
  }
}

/** Untracked, not-ignored files: each name, then its content (a symlink: its target). */
function hashUntracked(projectDir: string, h: crypto.Hash): void {
  const names = git(projectDir, ["ls-files", "-o", "--exclude-standard", "-z"])
    .toString("utf-8")
    .split("\0")
    .filter((n) => n !== "" && !n.endsWith("/"))
    .sort();
  for (const name of names) {
    const abs = path.join(projectDir, name);
    h.update(`${name}\0`);
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) h.update(`link:${fs.readlinkSync(abs)}`);
    else if (st?.isFile()) h.update(fs.readFileSync(abs));
    h.update("\0");
  }
}

/** The tree as it is now: HEAD, the uncommitted diff and the untracked files. */
export function treeStamp(projectDir: string): string {
  const h = crypto.createHash("sha256");
  const head = headOrEmpty(projectDir);
  h.update(`${head}\0`);
  if (head) h.update(git(projectDir, ["diff", "HEAD", "--binary"]));
  h.update("\0");
  hashUntracked(projectDir, h);
  return h.digest("hex");
}

/** What changed since `sha` — committed or not, untracked files included. */
/** `git diff --name-status -M <sha>`: what changed, moved or went since `sha` (tracked files), for plan-diff. */
export function nameStatusSince(projectDir: string, sha: string): string {
  return git(projectDir, ["diff", "--name-status", "-M", sha]).toString("utf-8");
}

/** `git diff <sha>`: the text diff since `sha`, for the added lines plan-diff scans for skip markers. */
export function diffSince(projectDir: string, sha: string): string {
  return git(projectDir, ["diff", "--no-color", sha]).toString("utf-8");
}

/** `git diff --stat <sha>`: tracked changes from `sha` to the working tree, for a prompt or the digest. */
export function diffStatSince(projectDir: string, sha: string): string {
  return git(projectDir, ["diff", "--stat", sha]).toString("utf-8").trimEnd();
}

export function diffHashSince(projectDir: string, sha: string): string {
  const h = crypto.createHash("sha256");
  h.update(git(projectDir, ["diff", sha, "--binary"]));
  h.update("\0");
  hashUntracked(projectDir, h);
  return h.digest("hex");
}
