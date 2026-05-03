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

test("jumpTo: dirty + force save → exactly one new commit on current branch, no new branch, then jumps", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    // Move HEAD back to sha1 on main so jumping to sha2 is meaningful and the
    // autosave will land on main.
    execSync(`git checkout -q main`, { cwd: dir });
    execSync(`git reset --hard ${sha1}`, { cwd: dir });
    // sha2 still exists in the reflog but main no longer points to it. Tag it
    // so it stays reachable for the jump.
    execSync(`git tag t-sha2 ${sha2}`, { cwd: dir });

    const branchesBefore = execSync("git branch --list", { cwd: dir, encoding: "utf-8" }).trim();
    const commitCountBefore = Number(
      execSync("git rev-list --count main", { cwd: dir, encoding: "utf-8" }).trim(),
    );

    fs.writeFileSync(path.join(dir, "README.md"), "# dirty-saved\n");
    const r = jumpTo(dir, sha2, { force: "save" });
    assert.equal(r.ok, true);

    // No new branch was created.
    const branchesAfter = execSync("git branch --list", { cwd: dir, encoding: "utf-8" }).trim();
    assert.equal(branchesAfter, branchesBefore, "no new branch should be created");

    // Exactly one autosave commit exists somewhere — verify by subject.
    const autosaveLog = execSync(
      `git log --all --grep='^dex: pre-jump autosave' --oneline`,
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    const autosaveCount = autosaveLog ? autosaveLog.split("\n").length : 0;
    assert.equal(autosaveCount, 1, "exactly one autosave commit should exist");

    // main now has one extra commit (the autosave) on top of sha1.
    const mainCommits = Number(
      execSync("git rev-list --count main", { cwd: dir, encoding: "utf-8" }).trim(),
    );
    assert.equal(
      mainCommits,
      commitCountBefore + 1,
      "main should have exactly one new commit (the autosave)",
    );

    // HEAD moved to the click target.
    assert.equal(head(dir), sha2);
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: dirty + force save on detached HEAD → friendly refusal, no commit, no jump", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    const sha2 = commit(dir, "two.md", "two");
    // Detach HEAD at sha1 — no branch.
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    // Confirm detached.
    const symref = execSync(`git symbolic-ref -q HEAD || echo DETACHED`, {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    assert.equal(symref, "DETACHED", "expected detached HEAD for this test");

    fs.writeFileSync(path.join(dir, "README.md"), "# dirty-detached\n");
    const r = jumpTo(dir, sha2, { force: "save" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "git_error");
      if (r.error === "git_error") {
        assert.match(r.message, /detached-HEAD/i, "expected friendly detached-HEAD message");
      }
    }
    // No autosave commit was created on any ref.
    const autosaveLog = execSync(
      `git log --all --grep='^dex: pre-jump autosave' --oneline`,
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    assert.equal(autosaveLog, "", "no autosave commit should exist after refusal");
    // HEAD did not move.
    assert.equal(head(dir), sha1);
  } finally {
    rmTmp(dir);
  }
});

test("jumpTo: dirty + force save on selected-* branch → autosave lands on selected-*, branch survives prune", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    commit(dir, "two.md", "two");
    const sha3 = commit(dir, "three.md", "three");
    // First jump: fork a selected-* branch at sha1 from main.
    const r1 = jumpTo(dir, sha1);
    assert.equal(r1.ok, true);
    let selectedBranch: string | null = null;
    if (r1.ok && r1.action === "fork") {
      selectedBranch = r1.branch;
      assert.match(selectedBranch, /^selected-/);
      assert.equal(currentBranch(dir), selectedBranch);
    } else {
      assert.fail(`expected fork to selected-*, got ${JSON.stringify(r1)}`);
    }

    // Now dirty the tree on the selected-* branch.
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty-on-selected\n");
    // Save while jumping to sha3 (main's tip). The autosave must commit onto
    // the selected-* branch and the branch must survive the post-jump prune.
    const r2 = jumpTo(dir, sha3, { force: "save" });
    assert.equal(r2.ok, true);

    // The autosave commit lives on the selected-* branch (not main, not dex/*).
    const autosaveOnSelected = execSync(
      `git log ${selectedBranch} --grep='^dex: pre-jump autosave' --oneline`,
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    assert.ok(
      autosaveOnSelected.length > 0,
      "autosave commit must be reachable from the selected-* branch",
    );

    // The selected-* branch survives the auto-prune (it has the new commit
    // relative to the jump target).
    const stillThere = execSync(`git branch --list '${selectedBranch}'`, {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    assert.ok(
      stillThere.length > 0,
      `selected-* branch ${selectedBranch} must survive auto-prune`,
    );

    // HEAD moved to sha3.
    assert.equal(head(dir), sha3);
  } finally {
    rmTmp(dir);
  }
});
