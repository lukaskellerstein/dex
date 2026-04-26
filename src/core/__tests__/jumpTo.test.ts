import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { jumpTo } from "../checkpoints.ts";

function mkTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-jt-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email test@dex.local", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add README.md", { cwd: dir });
  execSync("git commit -q -m init", { cwd: dir });
  return dir;
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function commit(dir: string, file: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  execSync(`git add ${file}`, { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

function head(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

function currentBranch(dir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

test("jumpTo: target equals HEAD → noop, no branch movement", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    const before = currentBranch(dir);
    const r = jumpTo(dir, sha);
    assert.deepEqual(r, { ok: true, action: "noop" });
    assert.equal(currentBranch(dir), before);
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: dirty working tree refuses without force, returns files", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "extra.md", "second");
    // Move HEAD back to sha1 so jumping to sha2 is a real change request.
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty\n");
    const r = jumpTo(dir, sha2);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "dirty_working_tree");
      if (r.error === "dirty_working_tree") {
        assert.ok(r.files.length > 0);
        assert.ok(r.files.includes("README.md"));
      }
    }
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: target is unique branch tip → checkout that branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync("git checkout -q -b feature", { cwd: dir });
    const sha2 = commit(dir, "feat.md", "feat");
    // Switch back to main; jumping to sha2 should checkout `feature`, not fork.
    execSync("git checkout -q main", { cwd: dir });
    assert.equal(head(dir), sha1);

    const r = jumpTo(dir, sha2);
    assert.equal(r.ok, true);
    if (r.ok && r.action === "checkout") {
      assert.equal(r.branch, "feature");
      assert.equal(currentBranch(dir), "feature");
      assert.equal(head(dir), sha2);
    } else {
      assert.fail(`expected checkout, got ${JSON.stringify(r)}`);
    }
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: target is mid-branch ancestor → fork attempt branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    commit(dir, "two.md", "two");
    const sha3 = commit(dir, "three.md", "three");
    // sha1 is not the tip of any branch (HEAD is at sha3 on main).
    const r = jumpTo(dir, sha1);
    assert.equal(r.ok, true);
    if (r.ok && r.action === "fork") {
      assert.match(r.branch, /^selected-/);
      assert.equal(currentBranch(dir), r.branch);
      assert.equal(head(dir), sha1);
    } else {
      assert.fail(`expected fork, got ${JSON.stringify(r)}`);
    }
    // main's tip is unchanged at sha3 (we didn't move main).
    const mainSha = execSync("git rev-parse main", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(mainSha, sha3);
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: target is tip of multiple branches → fork", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    // Two branches both pointing at sha1.
    execSync("git branch alpha", { cwd: dir });
    execSync("git branch beta", { cwd: dir });
    // HEAD is on main at a different commit so a jump is meaningful.
    const sha2 = commit(dir, "advance.md", "advance");
    assert.notEqual(sha2, sha1);

    const r = jumpTo(dir, sha1);
    assert.equal(r.ok, true);
    if (r.ok && r.action === "fork") {
      assert.match(r.branch, /^selected-/);
      assert.equal(head(dir), sha1);
    } else {
      assert.fail(`expected fork (multiple tips), got ${JSON.stringify(r)}`);
    }
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: unresolvable SHA → error: not_found", () => {
  const dir = mkTmpRepo();
  try {
    const r = jumpTo(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "not_found");
    }
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: dirty + force discard → resets and proceeds with action", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty\n");

    const r = jumpTo(dir, sha2, { force: "discard" });
    assert.equal(r.ok, true);
    // Dirty change is gone (reset --hard).
    const after = fs.readFileSync(path.join(dir, "README.md"), "utf-8");
    assert.equal(after, "# test\n");
    assert.equal(head(dir), sha2);
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: empty selected-<ts> branch is auto-pruned when navigating away", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    commit(dir, "two.md", "two");
    const sha3 = commit(dir, "three.md", "three");
    // First jump: forks selected-T1 at sha1.
    const r1 = jumpTo(dir, sha1);
    assert.equal(r1.ok, true);
    if (r1.ok && r1.action === "fork") {
      const t1 = r1.branch;
      assert.match(t1, /^selected-/);
      // Second jump: should prune empty t1 (zero new commits) and create t2.
      const r2 = jumpTo(dir, sha3);
      assert.equal(r2.ok, true);
      if (r2.ok) {
        // We expect a checkout to main (sha3 is main's tip), pruning t1 along
        // the way. Either checkout or fork depending on tip uniqueness.
        const branches = execSync("git branch --list 'selected-*'", {
          cwd: dir,
          encoding: "utf-8",
        });
        assert.equal(
          branches.includes(t1),
          false,
          `previous selected ${t1} should have been pruned, branch list:\n${branches}`,
        );
      }
    } else {
      assert.fail(`expected fork, got ${JSON.stringify(r1)}`);
    }
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: 008 attempt-<ts> branch is NEVER auto-pruned (only selected-* navigation forks are)", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    // Manually create an attempt-<ts> branch as if 008 "Try Again" did it.
    execSync(`git checkout -q -B attempt-20260101T000000 ${sha1}`, { cwd: dir });
    // Navigate via jumpTo to sha2. The attempt-* branch must survive even
    // though it has no new commits beyond the new branch.
    const r = jumpTo(dir, sha2);
    assert.equal(r.ok, true);
    const branches = execSync("git branch --list 'attempt-*'", {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.match(branches, /attempt-20260101T000000/, "008 attempt-* must survive jumpTo");
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: attempt-<ts>-saved is NEVER auto-pruned (autosave is meaningful)", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty\n");
    // Save dirty change → creates attempt-<ts>-saved holding the autosave.
    const r1 = jumpTo(dir, sha2, { force: "save" });
    assert.equal(r1.ok, true);
    const savedBefore = execSync("git branch --list 'attempt-*-saved'", {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.ok(savedBefore.length > 0);

    // Now navigate again — the -saved branch must survive.
    const r2 = jumpTo(dir, sha1);
    assert.equal(r2.ok, true);
    const savedAfter = execSync("git branch --list 'attempt-*-saved'", {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(savedAfter, savedBefore, "-saved branch must survive subsequent jumps");
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: dirty + force save → preserves dirty change on a saved branch and proceeds", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty-saved\n");

    const r = jumpTo(dir, sha2, { force: "save" });
    assert.equal(r.ok, true);
    assert.equal(head(dir), sha2);
    // A saved-branch should exist carrying the dirty change.
    const branches = execSync("git branch --list 'attempt-*-saved'", { cwd: dir, encoding: "utf-8" });
    assert.ok(branches.length > 0, "expected at least one attempt-*-saved branch");
  } finally {
    rmTmp(dir);
  }
});
