import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  checkpointTagFor,
  labelFor,
  isParallelizable,
  listTimeline,
  CHECKPOINT_MESSAGE_PREFIX,
} from "../checkpoints.ts";

// Inline tag promotion — used to be `promoteToCheckpoint` from recordMode.ts
// (deleted in 013-cleanup-2). The tests still need to seed checkpoint tags;
// they do so directly via git.
function tagAt(dir: string, tag: string, sha: string): void {
  execSync(`git tag -f ${tag} ${sha}`, { cwd: dir });
}
import type { StepType } from "../types.ts";

const STAGES: StepType[] = [
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

test("listTimeline: seeded repo returns expected structure", () => {
  const dir = mkTmpRepo();
  try {
    const sha = execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
    tagAt(dir, "checkpoint/cycle-1-after-plan", sha);

    const snap = listTimeline(dir);
    assert.equal(snap.checkpoints.length, 1);
    assert.equal(snap.checkpoints[0].tag, "checkpoint/cycle-1-after-plan");
    assert.equal(snap.checkpoints[0].step, "plan");
    assert.equal(snap.checkpoints[0].cycleNumber, 1);
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
    tagAt(dir, "checkpoint/cycle-1-after-plan", sha);
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

// Note: unselect() was removed in 014; deleteBranch (in branchOps.ts) subsumes
// it with stricter HEAD-handling (always main, fallback master). See
// branchOps.test.ts for the new test coverage.

test("listTimeline: surfaces step-commits from a sibling branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = mkStepCommit(dir, "plan", 1, "plan.md");
    // Create a dex/* run branch off sha1 with its own step-commit.
    execSync(`git checkout -q -b dex/test-a ${sha1}`, { cwd: dir });
    const sha1a = mkStepCommit(dir, "tasks", 1, "tasks-a.md");
    // Switch back to main so HEAD's selectedPath does NOT include sha1a.
    execSync("git checkout -q master 2>/dev/null || git checkout -q main", { cwd: dir });

    const snap = listTimeline(dir);
    const shas = new Set(snap.commits.map((c) => c.sha));
    assert.ok(shas.has(sha1), "main's plan commit must be surfaced");
    assert.ok(shas.has(sha1a), "sibling branch's tasks commit must be surfaced");
    // selectedPath only follows first-parent of current HEAD (main), so
    // sha1a is NOT on the path.
    assert.equal(snap.selectedPath.includes(sha1a), false);
    assert.equal(snap.selectedPath.includes(sha1), true);
  } finally {
    rmTmp(dir);
  }
});

