import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { deleteBranch, mergeToMain, computePromoteSummary } from "../checkpoints/branchOps.ts";

function mkTmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-bo-"));
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

function head(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

function currentBranch(dir: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

function branches(dir: string): string[] {
  return execSync("git branch --format=%(refname:short)", { cwd: dir, encoding: "utf-8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function commitOnCurrent(dir: string, file: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), `${msg}\n`);
  execSync(`git add ${file}`, { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

function commitWithCheckpointTrailer(
  dir: string,
  file: string,
  step: string,
  cycle: number,
): string {
  fs.writeFileSync(path.join(dir, file), `${step}-${cycle}\n`);
  execSync(`git add ${file}`, { cwd: dir });
  execSync(
    `git commit -q -m "dex: ${step} completed [cycle:${cycle}]" -m "[checkpoint:${step}:${cycle}]"`,
    { cwd: dir },
  );
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf-8" }).trim();
}

// ── Refusal cases ────────────────────────────────────────

test("deleteBranch: refuses main with is_protected", () => {
  const dir = mkTmpRepo();
  try {
    const r = deleteBranch(dir, "main");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "is_protected");
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: refuses master with is_protected", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git branch master", { cwd: dir });
    const r = deleteBranch(dir, "master");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "is_protected");
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: refuses user branches with not_dex_owned", () => {
  const dir = mkTmpRepo();
  try {
    execSync("git branch feature/foo", { cwd: dir });
    const r = deleteBranch(dir, "feature/foo");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "not_dex_owned");
  } finally {
    rmTmp(dir);
  }
});

// ── Successful deletion paths ────────────────────────────

test("deleteBranch: removes a selected-* branch when HEAD is elsewhere — no lost-work", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git branch selected-20260101T000000 ${sha}`, { cwd: dir });
    // HEAD is on main — no switch needed.
    const r = deleteBranch(dir, "selected-20260101T000000");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.deleted, "selected-20260101T000000");
      assert.equal(r.switchedTo, null);
    }
    assert.equal(branches(dir).includes("selected-20260101T000000"), false);
    assert.equal(currentBranch(dir), "main");
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: HEAD on target → switches to main and deletes", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-aaaaaa ${sha}`, { cwd: dir });
    const r = deleteBranch(dir, "dex/2026-05-04-aaaaaa");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.switchedTo, "main");
    }
    assert.equal(currentBranch(dir), "main");
    assert.equal(branches(dir).includes("dex/2026-05-04-aaaaaa"), false);
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: HEAD on target, no main → falls back to master", () => {
  const dir = mkTmpRepo();
  try {
    // Recreate the repo with master as the default branch.
    execSync("git branch -m main master", { cwd: dir });
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-bbbbbb ${sha}`, { cwd: dir });
    const r = deleteBranch(dir, "dex/2026-05-04-bbbbbb");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.switchedTo, "master");
    assert.equal(currentBranch(dir), "master");
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: HEAD on target, neither main nor master → no_primary_to_switch_to", () => {
  const dir = mkTmpRepo();
  try {
    // Create a dex/* branch carrying HEAD, then rename main away so neither
    // primary exists.
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-cccccc ${sha}`, { cwd: dir });
    execSync(`git branch -D main`, { cwd: dir });
    const r = deleteBranch(dir, "dex/2026-05-04-cccccc");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "no_primary_to_switch_to");
    // Branch must still exist — refusal is non-destructive.
    assert.equal(branches(dir).includes("dex/2026-05-04-cccccc"), true);
  } finally {
    rmTmp(dir);
  }
});

// ── Lost-work detection ──────────────────────────────────

test("deleteBranch: branch with unique step-commits returns would_lose_work with labels + short SHAs", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-dddddd ${sha}`, { cwd: dir });
    const planSha = commitWithCheckpointTrailer(dir, "plan.md", "plan", 2);
    const tasksSha = commitWithCheckpointTrailer(dir, "tasks.md", "tasks", 2);
    execSync(`git checkout -q main`, { cwd: dir });

    const r = deleteBranch(dir, "dex/2026-05-04-dddddd");
    assert.equal(r.ok, false);
    if (!r.ok && r.error === "would_lose_work") {
      assert.equal(r.lostSteps.length, 2);
      // Each LostStep carries shortSha and a label that mentions the step.
      const shas = r.lostSteps.map((s) => s.shortSha);
      assert.ok(shas.includes(planSha.slice(0, 7)));
      assert.ok(shas.includes(tasksSha.slice(0, 7)));
      const labels = r.lostSteps.map((s) => s.label).join("|");
      assert.match(labels, /plan|tasks/);
    } else {
      assert.fail(`expected would_lose_work, got ${JSON.stringify(r)}`);
    }
    // Branch survives the refusal.
    assert.equal(branches(dir).includes("dex/2026-05-04-dddddd"), true);
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: confirmedLoss skips the lost-work check and deletes", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-eeeeee ${sha}`, { cwd: dir });
    commitWithCheckpointTrailer(dir, "plan.md", "plan", 0);
    execSync(`git checkout -q main`, { cwd: dir });

    const r = deleteBranch(dir, "dex/2026-05-04-eeeeee", { confirmedLoss: true });
    assert.equal(r.ok, true);
    assert.equal(branches(dir).includes("dex/2026-05-04-eeeeee"), false);
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: branch with no unique commits passes the lost-work check", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    // Branch points at the same commit as main — nothing unique.
    execSync(`git branch dex/2026-05-04-ffffff ${sha}`, { cwd: dir });
    const r = deleteBranch(dir, "dex/2026-05-04-ffffff");
    assert.equal(r.ok, true);
  } finally {
    rmTmp(dir);
  }
});

// ── Mid-run safety ───────────────────────────────────────

test("deleteBranch: refuses when state.json reports running on the target branch", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-gggggg ${sha}`, { cwd: dir });
    // Write state.json reporting a running run; HEAD is on the target.
    fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dex", "state.json"),
      JSON.stringify({ status: "running", runId: "test" }),
    );
    const r = deleteBranch(dir, "dex/2026-05-04-gggggg");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "branch_in_active_run");
    // Branch survives.
    assert.equal(branches(dir).includes("dex/2026-05-04-gggggg"), true);
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: state.json running but HEAD elsewhere → not refused", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    // Branch carries no unique commits and HEAD stays on main.
    execSync(`git branch dex/2026-05-04-hhhhhh ${sha}`, { cwd: dir });
    fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dex", "state.json"),
      JSON.stringify({ status: "running", runId: "test" }),
    );
    const r = deleteBranch(dir, "dex/2026-05-04-hhhhhh");
    assert.equal(r.ok, true);
  } finally {
    rmTmp(dir);
  }
});

test("deleteBranch: state.json paused → not refused even if HEAD on target", () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-iiiiii ${sha}`, { cwd: dir });
    fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dex", "state.json"),
      JSON.stringify({ status: "paused", runId: "test" }),
    );
    const r = deleteBranch(dir, "dex/2026-05-04-iiiiii");
    assert.equal(r.ok, true);
  } finally {
    rmTmp(dir);
  }
});

// ── Avoiding accidental dex/* on dex/* lost-work false positives ─────

test("deleteBranch: when source branch shares its tip with another tracked dex/* branch, no lost-work warning", () => {
  // Regression check: the unique-commit query excludes every other dex/* and
  // selected-* branch. Two dex/* branches at the same SHA must each be
  // deletable without a lost-work warning, because each one's commits are
  // reachable from the other.
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git branch dex/2026-05-04-jjjjjj ${sha}`, { cwd: dir });
    execSync(`git branch dex/2026-05-04-kkkkkk ${sha}`, { cwd: dir });
    const r = deleteBranch(dir, "dex/2026-05-04-jjjjjj");
    assert.equal(r.ok, true);
  } finally {
    rmTmp(dir);
  }
});

// ── mergeToMain (014/US2 — clean-merge path) ─────────────

test("mergeToMain: clean merge produces a single-parent squash commit on main", async () => {
  const dir = mkTmpRepo();
  try {
    // Create a dex/* branch ahead of main with one commit.
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-mmmmmm ${sha1}`, { cwd: dir });
    commitOnCurrent(dir, "feature.md", "feature on dex/*");
    execSync(`git checkout -q main`, { cwd: dir });

    const r = await mergeToMain(dir, "dex/2026-05-04-mmmmmm");
    assert.equal(r.ok, true);
    if (r.ok && r.mode === "clean") {
      // Single-parent squash commit (no merge topology).
      const parentCount = execSync(
        `git log -1 --format='%P' ${r.mergeSha}`,
        { cwd: dir, encoding: "utf-8" },
      ).trim().split(" ").filter(Boolean).length;
      assert.equal(parentCount, 1);
      // Squash subject names the source branch (timeline parser depends on this).
      const subject = execSync(
        `git log -1 --format=%s ${r.mergeSha}`,
        { cwd: dir, encoding: "utf-8" },
      ).trim();
      assert.match(subject, /^dex: promoted dex\/2026-05-04-mmmmmm to main$/);
      assert.equal(r.mergedSource, "dex/2026-05-04-mmmmmm");
    } else {
      assert.fail(`expected clean mode, got ${JSON.stringify(r)}`);
    }
    // Source branch is kept — Timeline drill-down walks it to recover
    // the version's agent-step history.
    assert.equal(branches(dir).includes("dex/2026-05-04-mmmmmm"), true);
    // HEAD is on main.
    assert.equal(currentBranch(dir), "main");
    // Pending-promote sidecar is cleared on success.
    assert.equal(
      fs.existsSync(path.join(dir, ".git", "dex-pending-promote")),
      false,
    );
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: NEVER creates a checkpoint/promoted-* tag (regression)", async () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-nnnnnn ${sha1}`, { cwd: dir });
    commitOnCurrent(dir, "feat.md", "x");
    execSync(`git checkout -q main`, { cwd: dir });
    await mergeToMain(dir, "dex/2026-05-04-nnnnnn");
    const tags = execSync(`git tag --list 'checkpoint/promoted-*'`, {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    assert.equal(tags, "", "no checkpoint/promoted-* tag should be created");
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: refuses non-Dex-owned source with not_dex_owned", async () => {
  const dir = mkTmpRepo();
  try {
    execSync(`git branch feature/foo`, { cwd: dir });
    const r = await mergeToMain(dir, "feature/foo");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "not_dex_owned");
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: refuses when no main/master exists", async () => {
  const dir = mkTmpRepo();
  try {
    const sha = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-oooooo ${sha}`, { cwd: dir });
    execSync(`git branch -D main`, { cwd: dir });
    const r = await mergeToMain(dir, "dex/2026-05-04-oooooo");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "no_primary_branch");
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: dirty tree returns dirty_working_tree without force", async () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-pppppp ${sha1}`, { cwd: dir });
    commitOnCurrent(dir, "feat.md", "x");
    execSync(`git checkout -q main`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty\n");
    const r = await mergeToMain(dir, "dex/2026-05-04-pppppp");
    assert.equal(r.ok, false);
    if (!r.ok && r.error === "dirty_working_tree") {
      assert.ok(r.files.length > 0);
      assert.ok(r.files.includes("README.md"));
    }
    // Source branch is intact (refusal is non-destructive).
    assert.equal(branches(dir).includes("dex/2026-05-04-pppppp"), true);
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: dirty + force=save autosaves and proceeds", async () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-qqqqqq ${sha1}`, { cwd: dir });
    commitOnCurrent(dir, "feat.md", "x");
    execSync(`git checkout -q main`, { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "# dirty-saved\n");
    const r = await mergeToMain(dir, "dex/2026-05-04-qqqqqq", { force: "save" });
    assert.equal(r.ok, true);
    // Autosave commit landed on main before the merge — verify by subject.
    const autosave = execSync(
      `git log main --grep='^dex: pre-promote autosave' --oneline`,
      { cwd: dir, encoding: "utf-8" },
    ).trim();
    assert.ok(autosave.length > 0, "expected pre-promote autosave commit on main");
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: refuses when state.json running on the source branch", async () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-rrrrrr ${sha1}`, { cwd: dir });
    commitOnCurrent(dir, "feat.md", "x");
    fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dex", "state.json"),
      JSON.stringify({ status: "running", runId: "test" }),
    );
    // HEAD is on the source branch — that triggers the in-active-run check.
    const r = await mergeToMain(dir, "dex/2026-05-04-rrrrrr");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "branch_in_active_run");
  } finally {
    rmTmp(dir);
  }
});

test("mergeToMain: refuses when state.json running on main", async () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git branch dex/2026-05-04-ssssss ${sha1}`, { cwd: dir });
    fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".dex", "state.json"),
      JSON.stringify({ status: "running", runId: "test" }),
    );
    // HEAD is on main; state says running → main_in_active_run.
    const r = await mergeToMain(dir, "dex/2026-05-04-ssssss");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "main_in_active_run");
  } finally {
    rmTmp(dir);
  }
});

// ── computePromoteSummary ────────────────────────────────

test("computePromoteSummary: counts files, +/-, top-5, fullPaths", () => {
  const dir = mkTmpRepo();
  try {
    const sha1 = head(dir);
    execSync(`git checkout -q -b dex/2026-05-04-tttttt ${sha1}`, { cwd: dir });
    // Create six modified/new files on the source branch.
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.md`), `body ${i}\n`);
    }
    execSync(`git add -A`, { cwd: dir });
    execSync(`git commit -q -m feat`, { cwd: dir });
    execSync(`git checkout -q main`, { cwd: dir });

    const summary = computePromoteSummary(dir, "dex/2026-05-04-tttttt");
    assert.equal(summary.fileCount, 6);
    assert.equal(summary.added, 6);
    assert.equal(summary.removed, 0);
    assert.equal(summary.topPaths.length, 5);
    assert.equal(summary.fullPaths.length, 6);
  } finally {
    rmTmp(dir);
  }
});
