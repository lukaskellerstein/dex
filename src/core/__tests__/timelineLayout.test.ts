import test from "node:test";
import assert from "node:assert/strict";
import type { TimelineSnapshot, TimelineCommit } from "../checkpoints.ts";
import { layoutTimeline } from "../../renderer/components/checkpoints/timelineLayout.ts";

// ── Fixture helpers ─────────────────────────────────────

const STEP_COMMIT = (
  sha: string,
  branch: string,
  parentSha: string | null,
  step: string,
  cycleNumber: number,
  timestamp: string,
  hasCheckpointTag = false,
): TimelineCommit => ({
  sha,
  shortSha: sha.slice(0, 7),
  branch,
  parentSha,
  step: step as TimelineCommit["step"],
  cycleNumber,
  subject: `dex: ${step} completed [cycle:${cycleNumber}]`,
  timestamp,
  hasCheckpointTag,
});

const EMPTY_SNAP: TimelineSnapshot = {
  checkpoints: [],
  attempts: [],
  currentAttempt: null,
  pending: [],
  captureBranches: [],
  startingPoint: null,
  commits: [],
  selectedPath: [],
};

const OPTS = { laneWidth: 72, rowHeight: 32 };

// ── Tests ───────────────────────────────────────────────

test("layoutTimeline: empty snapshot → no nodes, no edges, sensible bounds", () => {
  const out = layoutTimeline(EMPTY_SNAP, OPTS);
  assert.equal(out.nodes.length, 0);
  assert.equal(out.edges.length, 0);
  assert.equal(out.columns.length, 0);
  assert.ok(out.width >= 320);
  assert.ok(out.height >= 200);
});

test("layoutTimeline: starting-point only → anchor node, no edges, one column", () => {
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    startingPoint: {
      branch: "main",
      sha: "0".repeat(40),
      shortSha: "0000000",
      subject: "init",
      timestamp: "2026-04-25T10:00:00Z",
    },
  };
  const out = layoutTimeline(snap, OPTS);
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].node.kind, "start");
  assert.equal(out.columns.length, 1);
  assert.equal(out.columns[0].branch, "main");
  assert.equal(out.columns[0].isAnchor, true);
  assert.equal(out.edges.length, 0);
});

test("layoutTimeline: linear single-column run produces within-column edges", () => {
  const a = STEP_COMMIT("a".repeat(40), "dex/run", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "dex/run", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const c = STEP_COMMIT("c".repeat(40), "dex/run", b.sha, "implement", 1, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    startingPoint: {
      branch: "main",
      sha: "9".repeat(40),
      shortSha: "9999999",
      subject: "init",
      timestamp: "2026-04-25T10:00:00Z",
    },
    commits: [a, b, c],
    selectedPath: [a.sha, b.sha, c.sha],
  };
  const out = layoutTimeline(snap, OPTS);
  // 3 step-commits + 1 anchor.
  assert.equal(out.nodes.length, 4);
  // Two columns: main (lane 0 — gitk convention even when anchor-only) +
  // dex/run (lane 1 — actual chain).
  assert.equal(out.columns.length, 2);
  assert.equal(out.columns[0].branch, "main");
  assert.equal(out.columns[1].branch, "dex/run");
  // dex/run carries 2 within-column edges (a→b, b→c). The first commit on
  // dex/run sprouts off the trunk lane (main) at its row — a "trunk-sprout"
  // edge with an explicit fromPoint on main's lane.
  const within = out.edges.filter((e) => e.kind === "within-column");
  assert.equal(within.length, 2);
  const sprout = out.edges.filter((e) => e.kind === "trunk-sprout" && e.toId === a.sha);
  assert.equal(sprout.length, 1);
  assert.ok(sprout[0].fromPoint, "trunk-sprout edge must carry an explicit fromPoint");
});

test("layoutTimeline: branch-off — attempt column connects to its parent step-commit on the run column", () => {
  // Run branch:  plan → tasks
  // Attempt forked from `plan`: produces another `tasks` step-commit on attempt-x.
  const planSha = "a".repeat(40);
  const tasksSha = "b".repeat(40);
  const attemptTasksSha = "c".repeat(40);

  const plan = STEP_COMMIT(planSha, "dex/run", null, "plan", 1, "2026-04-25T10:01:00Z");
  const tasks = STEP_COMMIT(tasksSha, "dex/run", planSha, "tasks", 1, "2026-04-25T10:02:00Z");
  const attemptTasks = STEP_COMMIT(
    attemptTasksSha,
    "attempt-x",
    planSha,
    "tasks",
    1,
    "2026-04-25T10:03:00Z",
  );
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    commits: [plan, tasks, attemptTasks],
    selectedPath: [],
  };
  const out = layoutTimeline(snap, OPTS);
  // No anchor (no startingPoint), 3 commits, 2 columns.
  assert.equal(out.nodes.length, 3);
  assert.equal(out.columns.length, 2);
  // Branch-off edge: plan (on dex/run) → attemptTasks (on attempt-x).
  const branchOffs = out.edges.filter((e) => e.kind === "branch-off");
  assert.equal(branchOffs.length, 1);
  assert.equal(branchOffs[0].fromId, planSha);
  assert.equal(branchOffs[0].toId, attemptTasksSha);
});

test("layoutTimeline: variant fan-out — one parent commit, three branch-off edges to separate columns", () => {
  const parent = STEP_COMMIT("p".repeat(40), "dex/run", null, "tasks", 1, "2026-04-25T10:01:00Z");
  const variantA = STEP_COMMIT("a".repeat(40), "attempt-x-a", parent.sha, "plan", 2, "2026-04-25T10:02:00Z");
  const variantB = STEP_COMMIT("b".repeat(40), "attempt-x-b", parent.sha, "plan", 2, "2026-04-25T10:02:01Z");
  const variantC = STEP_COMMIT("c".repeat(40), "attempt-x-c", parent.sha, "plan", 2, "2026-04-25T10:02:02Z");
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    commits: [parent, variantA, variantB, variantC],
  };
  const out = layoutTimeline(snap, OPTS);
  assert.equal(out.columns.length, 4);
  const branchOffs = out.edges.filter((e) => e.kind === "branch-off");
  assert.equal(branchOffs.length, 3);
  for (const e of branchOffs) {
    assert.equal(e.fromId, parent.sha);
  }
});

test("layoutTimeline: color states — selected (blue), kept (red), both, default", () => {
  const a = STEP_COMMIT("a".repeat(40), "dex/run", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "dex/run", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const c = STEP_COMMIT("c".repeat(40), "dex/run", b.sha, "implement", 1, "2026-04-25T10:03:00Z");
  const d = STEP_COMMIT("d".repeat(40), "dex/run", c.sha, "verify", 1, "2026-04-25T10:04:00Z");

  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    checkpoints: [
      // b is kept; c is kept and on path
      {
        tag: "checkpoint/cycle-1-after-tasks",
        label: "tasks",
        sha: b.sha,
        step: "tasks",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "",
        timestamp: "2026-04-25T10:02:00Z",
      },
      {
        tag: "checkpoint/cycle-1-after-implement",
        label: "implement",
        sha: c.sha,
        step: "implement",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "",
        timestamp: "2026-04-25T10:03:00Z",
      },
    ],
    commits: [a, b, c, d],
    // a and c on selected path; d not on path; b not on path.
    selectedPath: [a.sha, c.sha],
  };
  const out = layoutTimeline(snap, OPTS);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(a.sha)!.colorState, "selected");
  assert.equal(byId.get(b.sha)!.colorState, "kept");
  assert.equal(byId.get(c.sha)!.colorState, "selected+kept");
  assert.equal(byId.get(d.sha)!.colorState, "default");
});

test("layoutTimeline: trunk ordering — main always lane 0 (gitk convention)", () => {
  // main has only the starting-point anchor (zero step-commits). Gitk-style
  // canvases always render main as the leftmost lane regardless — side
  // branches sprout to its right.
  const a = STEP_COMMIT("a".repeat(40), "dex/run", null, "plan", 1, "2026-04-25T10:01:00Z");
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    startingPoint: {
      branch: "main",
      sha: "9".repeat(40),
      shortSha: "9999999",
      subject: "init",
      timestamp: "2026-04-25T10:00:00Z",
    },
    commits: [a],
    selectedPath: [a.sha],
  };
  const out = layoutTimeline(snap, OPTS);
  assert.equal(out.columns[0].branch, "main");
  assert.equal(out.columns[0].isAnchor, true);
  assert.equal(out.columns[1].branch, "dex/run");
});

test("layoutTimeline: bounding box scales with columns and rows", () => {
  const commits: TimelineCommit[] = [];
  let prev: string | null = null;
  for (let i = 0; i < 5; i++) {
    const sha = String.fromCharCode(97 + i).repeat(40);
    commits.push(STEP_COMMIT(sha, "dex/run", prev, "plan", 1, `2026-04-25T10:0${i}:00Z`));
    prev = sha;
  }
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits };
  const tight = layoutTimeline(snap, { laneWidth: 50, rowHeight: 28 });
  const loose = layoutTimeline(snap, { laneWidth: 100, rowHeight: 60 });
  // Loose layout should occupy more space than tight.
  assert.ok(loose.width >= tight.width);
  assert.ok(loose.height >= tight.height);
});
