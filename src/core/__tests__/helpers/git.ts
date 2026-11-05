/**
 * Git fixtures for core tests: a throwaway repo on `main` with one commit, and
 * small readers for its state. Copied out of the old branchOps test before the
 * checkpoint code was deleted (015-lean-core T013).
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temp git repo on `main` with a committed README.md. */
export function mkTmpRepo(prefix = "dex-git-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email test@dex.local", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  execSync("git config commit.gpgsign false", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  return dir;
}

export function rmTmp(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function headSha(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

export function currentBranch(dir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

export function branches(dir: string): string[] {
  // %(refname:short) must be quoted — execSync runs via /bin/sh, which would
  // otherwise treat the parentheses as a syntax error.
  return execSync("git branch --format='%(refname:short)'", { cwd: dir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

/** Writes `file` (relative to the repo) with `content`, commits it, returns the new HEAD. */
export function commitFile(dir: string, file: string, content: string, msg: string): string {
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execSync(`git add -- "${file}"`, { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return headSha(dir);
}

/** Commit subjects on HEAD, newest first. */
export function logSubjects(dir: string, range = "HEAD"): string[] {
  return execSync(`git log --format=%s ${range}`, { cwd: dir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}
