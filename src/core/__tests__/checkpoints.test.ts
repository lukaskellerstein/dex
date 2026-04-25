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
