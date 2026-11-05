/**
 * Project-tree fixtures for core tests: write a file tree into a temp folder.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Creates a temp folder holding `files` (path relative to the folder → content). */
export function mkTmpProject(files: Record<string, string>, prefix = "dex-project-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  writeFiles(dir, files);
  return dir;
}

/** Writes `files` into `dir`, creating folders as needed. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
