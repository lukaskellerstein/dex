import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { diffHashSince, treeStamp } from "../tree-stamp.ts";
import { commitFile, headSha, mkTmpRepo, rmTmp } from "./helpers/git.ts";

function withRepo(fn: (dir: string) => void): () => void {
  return () => {
    const dir = mkTmpRepo();
    try {
      fn(dir);
    } finally {
      rmTmp(dir);
    }
  };
}

test(
  "treeStamp: the same tree gives the same stamp",
  withRepo((dir) => {
    assert.match(treeStamp(dir), /^[0-9a-f]{64}$/);
    assert.equal(treeStamp(dir), treeStamp(dir));
  }),
);

test(
  "treeStamp: a tracked edit, a new untracked file, a commit each change it",
  withRepo((dir) => {
    const s0 = treeStamp(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "# changed\n");
    const s1 = treeStamp(dir);
    assert.notEqual(s1, s0, "tracked edit");
    fs.writeFileSync(path.join(dir, "new.txt"), "a\n");
    const s2 = treeStamp(dir);
    assert.notEqual(s2, s1, "untracked file");
    fs.writeFileSync(path.join(dir, "new.txt"), "b\n");
    assert.notEqual(treeStamp(dir), s2, "the untracked file's content counts");
    execSync("git add -A && git commit -q -m c", { cwd: dir });
    assert.notEqual(treeStamp(dir), s2, "commit");
  }),
);

test(
  "treeStamp: an ignored file does not change it",
  withRepo((dir) => {
    commitFile(dir, ".gitignore", "build/\n", "ignore");
    const s0 = treeStamp(dir);
    fs.mkdirSync(path.join(dir, "build"));
    fs.writeFileSync(path.join(dir, "build/out.js"), "x\n");
    fs.mkdirSync(path.join(dir, ".dex/evidence"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dex/evidence/.gitignore"), "*\n");
    fs.writeFileSync(path.join(dir, ".dex/evidence/r.json"), "{}\n");
    assert.equal(treeStamp(dir), s0);
  }),
);

test(
  "diffHashSince: equal when nothing changed, different when a file changed",
  withRepo((dir) => {
    const start = headSha(dir);
    const a = diffHashSince(dir, start);
    assert.equal(diffHashSince(dir, start), a);
    commitFile(dir, "src/a.ts", "export {};\n", "a");
    const b = diffHashSince(dir, start);
    assert.notEqual(b, a, "a committed change");
    fs.writeFileSync(path.join(dir, "src/a.ts"), "export const x = 1;\n");
    assert.notEqual(diffHashSince(dir, start), b, "an uncommitted change");
  }),
);
