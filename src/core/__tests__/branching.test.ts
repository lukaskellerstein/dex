import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { dirtyFiles, isTreeClean, prepareBranch } from "../branching.ts";
import { type QueueV3, type ResolvedEntry, resolveEntries } from "../queue.ts";
import { commitFile, currentBranch, mkTmpRepo, rmTmp } from "./helpers/git.ts";

let dir: string;

beforeEach(() => {
  dir = mkTmpRepo("dex-branching-");
});

afterEach(() => {
  rmTmp(dir);
});

function write(rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Entry A on its own branch `900-a`; entry B starts from A (base `900-a`, branch `901-b`). */
function entries(): { a: ResolvedEntry; b: ResolvedEntry } {
  const queue: QueueV3 = {
    version: 3,
    kind: "existing",
    entries: [
      { id: "900-a", title: "A" },
      { id: "901-b", title: "B" },
    ],
  };
  const [a, b] = resolveEntries(queue, currentBranch(dir), null);
  return { a, b };
}

test("isTreeClean: Dex runtime files do not count, even when .dex/ itself is untracked", () => {
  write(".dex/state.json", "{}");
  write(".dex/state.lock", "1");
  write(".dex/runs/r-1.json", "{}");
  write(".dex/questions.md", "# q");
  write(".dex/ui.json", "{}");
  assert.equal(isTreeClean(dir), true);
  assert.deepEqual(dirtyFiles(dir), []);
});

test("isTreeClean: an untracked file and a modified tracked file are dirty", () => {
  write(".dex/state.json", "{}");
  write("notes/leftover.txt", "agent scratch");
  write("README.md", "# changed\n");
  assert.equal(isTreeClean(dir), false);
  assert.deepEqual(dirtyFiles(dir), ["README.md", "notes/leftover.txt"]);
});

test("isTreeClean: other files under .dex/ count (the queue is the human's file)", () => {
  write(".dex/queue.json", "{}");
  assert.deepEqual(dirtyFiles(dir), [".dex/queue.json"]);
});

test("prepareBranch: already on the target, nothing happens even on a dirty tree", () => {
  execSync("git switch -q -c 900-a", { cwd: dir });
  write("wip.txt", "x");
  const { a } = entries();
  assert.deepEqual(prepareBranch(dir, a, "existing"), {
    kind: "ready",
    branch: "900-a",
    switched: false,
  });
});

test("prepareBranch: a later stage switches to the entry branch on a clean tree", () => {
  execSync("git branch 900-a", { cwd: dir });
  const { a } = entries();
  assert.deepEqual(prepareBranch(dir, a, "existing"), {
    kind: "ready",
    branch: "900-a",
    switched: true,
  });
  assert.equal(currentBranch(dir), "900-a");
});

test("prepareBranch: an entry whose branch does not exist yet starts from its base (brief, specify)", () => {
  execSync("git branch 900-a", { cwd: dir });
  const { b } = entries();
  assert.equal(b.baseBranch, "900-a");
  assert.deepEqual(prepareBranch(dir, b, "existing"), {
    kind: "ready",
    branch: "900-a",
    switched: true,
  });
  assert.equal(currentBranch(dir), "900-a");
});

test("prepareBranch: once the entry branch exists, every stage runs on it", () => {
  execSync("git branch 900-a", { cwd: dir });
  execSync("git branch 901-b", { cwd: dir });
  const { b } = entries();
  assert.deepEqual(prepareBranch(dir, b, "existing"), {
    kind: "ready",
    branch: "901-b",
    switched: true,
  });
});

test("prepareBranch: a dirty tree does not switch and names the dirty files", () => {
  execSync("git branch 900-a", { cwd: dir });
  write("wip.txt", "x");
  write(".dex/state.json", "{}");
  const { a } = entries();
  assert.deepEqual(prepareBranch(dir, a, "existing"), {
    kind: "dirty",
    target: "900-a",
    files: ["wip.txt"],
  });
  assert.equal(currentBranch(dir), "main");
});

test("prepareBranch: a new project never switches, whatever the entry says", () => {
  commitFile(dir, "x.txt", "x", "x");
  execSync("git branch 900-a", { cwd: dir });
  write("wip.txt", "x");
  const { a } = entries();
  assert.deepEqual(prepareBranch(dir, a, "new"), {
    kind: "ready",
    branch: "main",
    switched: false,
  });
  assert.equal(currentBranch(dir), "main");
});
