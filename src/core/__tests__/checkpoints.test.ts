import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  checkpointTagFor,
  checkpointDoneTag,
  captureBranchName,
  attemptBranchName,
  labelFor,
  isParallelizable,
  promoteToCheckpoint,
  unmarkCheckpoint,
  unselect,
  startAttemptFrom,
  isWorkingTreeDirty,
  spawnVariants,
  listTimeline,
  writeVariantGroupFile,
  readVariantGroupFile,
  deleteVariantGroupFile,
  readPendingVariantGroups,
  CHECKPOINT_MESSAGE_PREFIX,
} from "../checkpoints.ts";
import type { LoopStageType } from "../types.ts";

const STAGES: LoopStageType[] = [
  "prerequisites",
  "clarification",
  "clarification_product",
  "clarification_technical",
  "clarification_synthesis",
  "constitution",
  "manifest_extraction",
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "implement",
  "implement_fix",
  "verify",
  "learnings",
];

function mkTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-cp-"));
  execSync("git init -q", { cwd: dir });
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

test("constants are exported", () => {
  assert.equal(CHECKPOINT_MESSAGE_PREFIX, "[checkpoint:");
});

test("labelFor: cycle 0 stages produce distinct labels", () => {
  const seen = new Set<string>();
  for (const stage of STAGES) {
    const l = labelFor(stage, 0);
    assert.ok(!seen.has(l), `duplicate label for ${stage}: ${l}`);
    seen.add(l);
  }
});

test("labelFor: cycle > 0 stages include cycle + feature", () => {
  assert.equal(labelFor("plan", 1, "cart"), "cycle 1 · cart · plan written");
  assert.equal(labelFor("plan", 7), "cycle 7 · plan written");
});

test("checkpointTagFor: cycle 0 bare, cycle >= 1 prefixed", () => {
  assert.equal(checkpointTagFor("plan", 0), "checkpoint/after-plan");
  assert.equal(checkpointTagFor("plan", 1), "checkpoint/cycle-1-after-plan");
  assert.equal(
    checkpointTagFor("clarification_product", 0),
    "checkpoint/after-clarification-product",
  );
});

test("checkpointTagFor round-trips over (stage × cycles {0,1,7})", () => {
  const seen = new Set<string>();
  for (const s of STAGES) {
    for (const c of [0, 1, 7]) {
      const tag = checkpointTagFor(s, c);
      assert.ok(!seen.has(tag), `duplicate tag: ${tag}`);
      seen.add(tag);
    }
  }
});

test("attemptBranchName with variant", () => {
  const d = new Date("2026-04-17T18:23:01.000Z");
  assert.match(attemptBranchName(d), /^attempt-\d{8}T\d{6}$/);
  assert.match(attemptBranchName(d, "a"), /^attempt-\d{8}T\d{6}-a$/);
});

test("captureBranchName uses date + runId slice", () => {
  const d = new Date("2026-04-17T00:00:00.000Z");
  assert.equal(captureBranchName("abcdef12-3456", d), "capture/2026-04-17-abcdef");
});

test("checkpointDoneTag uses 6-char slice", () => {
  assert.equal(checkpointDoneTag("abcdef12-3456"), "checkpoint/done-abcdef");
});

test("isParallelizable: spec-only stages true, others false", () => {
  assert.equal(isParallelizable("plan"), true);
  assert.equal(isParallelizable("specify"), true);
  assert.equal(isParallelizable("tasks"), true);
  assert.equal(isParallelizable("gap_analysis"), true);
  assert.equal(isParallelizable("learnings"), true);

  assert.equal(isParallelizable("implement"), false);
  assert.equal(isParallelizable("implement_fix"), false);
  assert.equal(isParallelizable("verify"), false);
  assert.equal(isParallelizable("prerequisites"), false);
  assert.equal(isParallelizable("clarification_product"), false);
});

test("promoteToCheckpoint: happy path + idempotent + bad SHA", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    const tag = "checkpoint/cycle-1-after-plan";

    const r1 = promoteToCheckpoint(dir, tag, sha);
    assert.equal(r1.ok, true);
    const tagsAfter = execSync("git tag --list", { cwd: dir, encoding: "utf-8" }).trim();
    assert.ok(tagsAfter.includes(tag));

    // Idempotent
    const r2 = promoteToCheckpoint(dir, tag, sha);
    assert.equal(r2.ok, true);

    // Bad SHA (non-existent but syntactically valid hex)
    const rBad = promoteToCheckpoint(dir, "checkpoint/x", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.equal(rBad.ok, false);
  } finally {
    rmTmp(dir);
  }
});

test("startAttemptFrom: preserves gitignored files, removes stray untracked", () => {
  const dir = mkTmpRepo();
  try {
    fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
    execSync("git add .gitignore", { cwd: dir });
    execSync("git commit -q -m gitignore", { cwd: dir });
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();

    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-plan", sha);

    // Seed .env (gitignored) and a stray untracked file
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=abc\n");
    fs.writeFileSync(path.join(dir, "stray.txt"), "boom\n");

    const r = startAttemptFrom(dir, "checkpoint/cycle-1-after-plan");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.branch, /^attempt-/);
      // .env preserved (gitignored)
      assert.ok(fs.existsSync(path.join(dir, ".env")), ".env should be preserved");
      // stray removed
      assert.equal(fs.existsSync(path.join(dir, "stray.txt")), false);
      // HEAD matches tag
      const head = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
      assert.equal(head, sha);
    }
  } finally {
    rmTmp(dir);
  }
});

test("startAttemptFrom: missing tag returns ok:false", () => {
  const dir = mkTmpRepo();
  try {
    const r = startAttemptFrom(dir, "checkpoint/nope");
    assert.equal(r.ok, false);
  } finally {
    rmTmp(dir);
  }
});

test("isWorkingTreeDirty: detects modified tracked + untracked", () => {
  const dir = mkTmpRepo();
  try {
    assert.deepEqual(isWorkingTreeDirty(dir), { dirty: false, files: [] });
    fs.writeFileSync(path.join(dir, "README.md"), "# changed\n");
    const r = isWorkingTreeDirty(dir);
    assert.equal(r.dirty, true);
    assert.ok(r.files.includes("README.md"));
  } finally {
    rmTmp(dir);
  }
});

test("spawnVariants: parallel stage creates worktrees", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-tasks", sha);

    const r = spawnVariants(dir, {
      fromCheckpoint: "checkpoint/cycle-1-after-tasks",
      variantLetters: ["a", "b", "c"],
      step: "plan",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.parallel, true);
      assert.equal(r.result.branches.length, 3);
      assert.equal(r.result.worktrees?.length, 3);
      for (const wt of r.result.worktrees!) {
        assert.ok(fs.existsSync(path.join(dir, wt)), `worktree ${wt} should exist`);
      }
    }
  } finally {
    rmTmp(dir);
  }
});

test("spawnVariants: sequential stage creates branches only", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-tasks", sha);

    const r = spawnVariants(dir, {
      fromCheckpoint: "checkpoint/cycle-1-after-tasks",
      variantLetters: ["a", "b"],
      step: "implement",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.result.parallel, false);
      assert.equal(r.result.branches.length, 2);
      assert.equal(r.result.worktrees, null);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listTimeline: seeded repo returns expected structure", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-plan", sha);

    const snap = listTimeline(dir);
    assert.equal(snap.checkpoints.length, 1);
    assert.equal(snap.checkpoints[0].tag, "checkpoint/cycle-1-after-plan");
    assert.equal(snap.checkpoints[0].step, "plan");
    assert.equal(snap.checkpoints[0].cycleNumber, 1);
    assert.equal(snap.attempts.length, 0);
    // 010: extended snapshot fields are always arrays — never undefined.
    assert.ok(Array.isArray(snap.commits));
    assert.ok(Array.isArray(snap.selectedPath));
  } finally {
    rmTmp(dir);
  }
});

// ── 010: TimelineSnapshot.commits / selectedPath population ──

/**
 * Make a real commit whose subject matches the step-commit pattern
 * `dex: <step> completed [cycle:N] [feature:-]`. Returns the SHA.
 */
function mkStepCommit(dir: string, step: string, cycle: number, fileName: string): string {
  fs.writeFileSync(path.join(dir, fileName), `${step}-${cycle}\n`);
  execSync(`git add ${fileName}`, { cwd: dir });
  const subject = `dex: ${step} completed [cycle:${cycle}] [feature:-]`;
  const body = `[checkpoint:${step}:${cycle}]`;
  execSync(`git commit -q -m "${subject}" -m "${body}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

test("listTimeline: commits[] is sorted ascending by timestamp and skips WIP", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = mkStepCommit(dir, "plan", 1, "plan.md");
    // A non-step-commit "WIP" commit between two step-commits — must be skipped.
    fs.writeFileSync(path.join(dir, "wip.txt"), "noise\n");
    execSync("git add wip.txt", { cwd: dir });
    execSync('git commit -q -m "wip: scratch work"', { cwd: dir });
    const sha2 = mkStepCommit(dir, "tasks", 1, "tasks.md");

    const snap = listTimeline(dir);
    const shas = snap.commits.map((c) => c.sha);
    assert.deepEqual(shas, [sha1, sha2]);
    // Subjects are step-commit subjects (no "wip:" anywhere).
    assert.ok(snap.commits.every((c) => c.subject.startsWith("dex:")));
    // Each carries shortSha + step + cycle parsed from subject.
    assert.equal(snap.commits[0].shortSha.length, 7);
    assert.equal(snap.commits[0].step, "plan");
    assert.equal(snap.commits[0].cycleNumber, 1);
    assert.equal(snap.commits[1].step, "tasks");
    // hasCheckpointTag: false for both (no tag created in this test).
    assert.equal(snap.commits[0].hasCheckpointTag, false);
    assert.equal(snap.commits[1].hasCheckpointTag, false);
  } finally {
    rmTmp(dir);
  }
});

test("listTimeline: hasCheckpointTag flips true for promoted SHAs", () => {
  const dir = mkTmpRepo();
  try {
    const sha = mkStepCommit(dir, "plan", 1, "plan.md");
    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-plan", sha);
    const snap = listTimeline(dir);
    const planCommit = snap.commits.find((c) => c.sha === sha);
    assert.ok(planCommit, "plan commit should be in commits[]");
    assert.equal(planCommit!.hasCheckpointTag, true);
  } finally {
    rmTmp(dir);
  }
});

test("listTimeline: selectedPath is oldest-first along first-parent of HEAD", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = mkStepCommit(dir, "plan", 1, "plan.md");
    const sha2 = mkStepCommit(dir, "tasks", 1, "tasks.md");
    const sha3 = mkStepCommit(dir, "implement", 1, "impl.md");
    const snap = listTimeline(dir);
    assert.deepEqual(snap.selectedPath, [sha1, sha2, sha3]);
  } finally {
    rmTmp(dir);
  }
});

test("listTimeline: selectedPath shrinks after checking out an earlier commit", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = mkStepCommit(dir, "plan", 1, "plan.md");
    const sha2 = mkStepCommit(dir, "tasks", 1, "tasks.md");
    mkStepCommit(dir, "implement", 1, "impl.md");

    // Move HEAD back to the plan commit (detached). selectedPath now ends at sha1.
    execSync(`git checkout -q ${sha1}`, { cwd: dir });
    const snap = listTimeline(dir);
    assert.deepEqual(snap.selectedPath, [sha1]);
    // commits[] still surfaces all step-commits across all branches.
    assert.equal(snap.commits.length, 3);
    assert.ok(snap.commits.some((c) => c.sha === sha2));
  } finally {
    rmTmp(dir);
  }
});

test("unmarkCheckpoint: deletes canonical step tags at sha, leaves others alone", () => {
  const dir = mkTmpRepo();
  try {
    const sha = mkStepCommit(dir, "plan", 1, "plan.md");
    // Promote the canonical step tag.
    promoteToCheckpoint(dir, "checkpoint/cycle-1-after-plan", sha);
    // Add an unrelated checkpoint/done-* tag at the same sha — must NOT be deleted.
    execSync(`git tag checkpoint/done-abcdef ${sha}`, { cwd: dir });

    const r = unmarkCheckpoint(dir, sha);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.deleted, ["checkpoint/cycle-1-after-plan"]);
    }
    const remaining = execSync("git tag --list", { cwd: dir, encoding: "utf-8" }).trim().split("\n").sort();
    assert.deepEqual(remaining, ["checkpoint/done-abcdef"]);
  } finally {
    rmTmp(dir);
  }
});

test("unselect: switches HEAD to main and deletes the selected-* branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    execSync(`git checkout -q -b selected-20260101T000000 ${sha}`, { cwd: dir });

    const r = unselect(dir, "selected-20260101T000000");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.deleted, "selected-20260101T000000");
      assert.match(r.switchedTo ?? "", /^(main|master)$/);
    }
    const branches = execSync("git branch", { cwd: dir, encoding: "utf-8" });
    assert.equal(branches.includes("selected-20260101T000000"), false);
  } finally {
    rmTmp(dir);
  }
});

test("unselect: refuses non-selected-* branches", () => {
  const dir = mkTmpRepo();
  try {
    const r = unselect(dir, "main");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /selected-\*/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("unselect: prefers main/master over dex/* when both contain the SHA", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    execSync(`git checkout -q -b dex/2026-04-25-abcdef ${sha}`, { cwd: dir });
    execSync(`git checkout -q -b selected-20260101T000000 ${sha}`, { cwd: dir });

    const r = unselect(dir, "selected-20260101T000000");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.match(r.switchedTo ?? "", /^(main|master)$/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("unmarkCheckpoint: no canonical tags → no-op success", () => {
  const dir = mkTmpRepo();
  try {
    const sha = mkStepCommit(dir, "plan", 1, "plan.md");
    const r = unmarkCheckpoint(dir, sha);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.deleted, []);
  } finally {
    rmTmp(dir);
  }
});

test("listTimeline: surfaces step-commits from a sibling branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = mkStepCommit(dir, "plan", 1, "plan.md");
    // Create an attempt branch off sha1 with its own step-commit.
    execSync(`git checkout -q -b attempt-test-a ${sha1}`, { cwd: dir });
    const sha1a = mkStepCommit(dir, "tasks", 1, "tasks-a.md");
    // Switch back to main so HEAD's selectedPath does NOT include sha1a.
    execSync("git checkout -q master 2>/dev/null || git checkout -q main", { cwd: dir });

    const snap = listTimeline(dir);
    const shas = new Set(snap.commits.map((c) => c.sha));
    assert.ok(shas.has(sha1), "main's plan commit must be surfaced");
    assert.ok(shas.has(sha1a), "attempt branch's tasks commit must be surfaced");
    // selectedPath only follows first-parent of current HEAD (main), so
    // sha1a is NOT on the path.
    assert.equal(snap.selectedPath.includes(sha1a), false);
    assert.equal(snap.selectedPath.includes(sha1), true);
  } finally {
    rmTmp(dir);
  }
});

test("variant group file: write → read → delete round-trip", () => {
  const dir = mkTmpRepo();
  try {
    const group = {
      groupId: "00000000-0000-0000-0000-000000000000",
      fromCheckpoint: "checkpoint/cycle-1-after-tasks",
      stage: "plan" as LoopStageType,
      parallel: true,
      createdAt: new Date().toISOString(),
      variants: [
        {
          letter: "a",
          branch: "attempt-20260417T182301-a",
          worktree: ".dex/worktrees/attempt-20260417T182301-a",
          status: "pending" as const,
          runId: null,
          candidateSha: null,
          errorMessage: null,
        },
      ],
      resolved: { kind: null, pickedLetter: null, resolvedAt: null },
    };
    writeVariantGroupFile(dir, group);
    const read = readVariantGroupFile(dir, group.groupId);
    assert.deepEqual(read, group);

    const pending = readPendingVariantGroups(dir);
    assert.equal(pending.length, 1);

    deleteVariantGroupFile(dir, group.groupId);
    assert.equal(readVariantGroupFile(dir, group.groupId), null);
    assert.equal(readPendingVariantGroups(dir).length, 0);
  } finally {
    rmTmp(dir);
  }
});
