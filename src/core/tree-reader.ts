/**
 * What: Read-only file access over a *tree* — the working tree, or one git ref's committed tree — so the picker can judge an entry on its own branch without a checkout (research R3).
 * Not: Never switches branches or writes. Content is returned byte-exact (no trimming): the tasks.md hash in a verify record is checked against it.
 * Deps: node:child_process (execFileSync, no shell), node:fs, node:path.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface TreeReader {
  /** True when `rel` is a regular file in this tree. */
  exists(rel: string): boolean;
  /** The file's content, or null when it is absent. */
  read(rel: string): string | null;
}

/** The files on disk under `dir`, uncommitted changes included. */
export function workingTree(dir: string): TreeReader {
  const abs = (rel: string) => path.join(dir, rel);
  return {
    exists: (rel) => fs.statSync(abs(rel), { throwIfNoEntry: false })?.isFile() ?? false,
    read: (rel) => {
      try {
        return fs.readFileSync(abs(rel), "utf-8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * The committed tree of `ref`. Paths are relative to `dir` (`<ref>:./<rel>`),
 * so a project in a sub-folder of its repo reads the same paths.
 */
export function gitRef(dir: string, ref: string): TreeReader {
  const spec = (rel: string) => `${ref}:./${rel}`;
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    exists: (rel) => {
      try {
        return git(["cat-file", "-t", spec(rel)]).trim() === "blob";
      } catch {
        return false;
      }
    },
    read: (rel) => {
      try {
        return git(["cat-file", "blob", spec(rel)]);
      } catch {
        return null;
      }
    },
  };
}
