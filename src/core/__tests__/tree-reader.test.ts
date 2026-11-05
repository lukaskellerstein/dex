import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { branchExists, switchBranch } from "../git.ts";
import { gitRef, workingTree } from "../tree-reader.ts";
import { commitFile, currentBranch, mkTmpRepo, rmTmp } from "./helpers/git.ts";

test("git helpers: branchExists, switchBranch", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git branch feature", { cwd: dir });
    assert.equal(branchExists(dir, "feature"), true);
    assert.equal(branchExists(dir, "nope"), false);

    switchBranch(dir, "feature");
    assert.equal(currentBranch(dir), "feature");
    assert.throws(() => switchBranch(dir, "nope"));
  } finally {
    rmTmp(dir);
  }
});

test("workingTree: sees an uncommitted file, with its exact content", () => {
  const dir = mkTmpRepo();
  try {
    fs.mkdirSync(path.join(dir, "specs/001-a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "specs/001-a/tasks.md"), "- [ ] T001 x\n\n");
    const tree = workingTree(dir);
    assert.equal(tree.exists("specs/001-a/tasks.md"), true);
    assert.equal(tree.read("specs/001-a/tasks.md"), "- [ ] T001 x\n\n");
  } finally {
    rmTmp(dir);
  }
});

test("gitRef: reads another branch's committed content only", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git switch -q -c feature", { cwd: dir });
    commitFile(dir, "specs/001-a/plan.md", "# Plan\n", "plan");
    execSync("git switch -q main", { cwd: dir });
    // Uncommitted work on main is not part of `feature`.
    fs.writeFileSync(path.join(dir, "draft.md"), "draft\n");

    const feature = gitRef(dir, "feature");
    assert.equal(feature.exists("specs/001-a/plan.md"), true);
    assert.equal(feature.read("specs/001-a/plan.md"), "# Plan\n");
    assert.equal(feature.exists("draft.md"), false);

    const main = gitRef(dir, "main");
    assert.equal(main.exists("specs/001-a/plan.md"), false);
    assert.equal(main.exists("README.md"), true);
  } finally {
    rmTmp(dir);
  }
});

test("a missing path is false / null in both readers", () => {
  const dir = mkTmpRepo();
  try {
    for (const tree of [workingTree(dir), gitRef(dir, "main")]) {
      assert.equal(tree.exists("nope/tasks.md"), false);
      assert.equal(tree.read("nope/tasks.md"), null);
    }
    // A folder is not a file.
    fs.mkdirSync(path.join(dir, "specs"));
    assert.equal(workingTree(dir).exists("specs"), false);
  } finally {
    rmTmp(dir);
  }
});

test("gitRef: a path with a space reads correctly", () => {
  const dir = mkTmpRepo();
  try {
    commitFile(dir, "docs/my specs/README.md", "# Brief\n", "brief");
    assert.equal(gitRef(dir, "main").read("docs/my specs/README.md"), "# Brief\n");
  } finally {
    rmTmp(dir);
  }
});
