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
  containingBranches?: string[],
  mergedParentShas: string[] = [],
): TimelineCommit => ({
  sha,
  shortSha: sha.slice(0, 7),
  branch,
  containingBranches: containingBranches ?? [branch],
  parentSha,
  mergedParentShas,
  step: step as TimelineCommit["step"],
  cycleNumber,
  subject: `dex: ${step} completed [cycle:${cycleNumber}]`,
  timestamp,
  hasCheckpointTag,
});

const EMPTY_SNAP: TimelineSnapshot = {
  checkpoints: [],
  currentBranch: "",
  pending: [],
  startingPoint: null,
  commits: [],
  selectedPath: [],
};

const OPTS = { laneWidth: 100, rowHeight: 30 };

// ── Tests ───────────────────────────────────────────────

test("layoutTimeline: empty snapshot → no nodes, no edges, sensible bounds", () => {
  const out = layoutTimeline(EMPTY_SNAP, OPTS);
  assert.equal(out.nodes.length, 0);
  assert.equal(out.edges.length, 0);
  assert.equal(out.columns.length, 0);
  assert.ok(out.width >= 320);
  assert.ok(out.height >= 200);
});

test("layoutTimeline: linear single-branch run — within-column edges between consecutive commits", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const c = STEP_COMMIT("c".repeat(40), "main", b.sha, "implement", 1, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, b, c] };
  const out = layoutTimeline(snap, OPTS);
  assert.equal(out.nodes.length, 3);
  assert.equal(out.columns.length, 1);
  assert.equal(out.columns[0].branch, "main");
  // Two within-column edges (a→b, b→c).
  const within = out.edges.filter((e) => e.kind === "within-column");
  assert.equal(within.length, 2);
  assert.equal(within[0].fromId, a.sha);
  assert.equal(within[0].toId, b.sha);
});

test("layoutTimeline: feature branch fork — single fork edge with elbow at child column, parent row", () => {
  // main: a, b. feature/x forks from a. feature/x has commits c, d.
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:04:00Z");
  const c = STEP_COMMIT("c".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const d = STEP_COMMIT("d".repeat(40), "feature/x", c.sha, "plan", 1, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, b, c, d] };
  const out = layoutTimeline(snap, OPTS);

  // Each commit lives in EXACTLY ONE lane.
  assert.equal(out.nodes.length, 4);
  // main is lane 0; feature/x is lane 1.
  const mainCol = out.columns.find((c) => c.branch === "main")!;
  const featCol = out.columns.find((c) => c.branch === "feature/x")!;
  assert.equal(mainCol.columnIndex, 0);
  assert.equal(featCol.columnIndex, 1);

  // Exactly one fork edge: a (parent) → c (first commit on feature/x).
  const forks = out.edges.filter((e) => e.kind === "fork");
  assert.equal(forks.length, 1);
  assert.equal(forks[0].fromId, a.sha);
  assert.equal(forks[0].toId, c.sha);
  assert.ok(forks[0].elbow, "fork edge must carry elbow point");
  // Elbow at child column X, parent's row Y.
  const aNode = out.nodes.find((n) => n.id === a.sha)!;
  assert.equal(forks[0].elbow!.x, featCol.x);
  assert.equal(forks[0].elbow!.y, aNode.y);
});

test("layoutTimeline: two branches forking from same commit get separate lanes", () => {
  // main: a. feature/x forks from a, then feature/y also forks from a.
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const x1 = STEP_COMMIT("x".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const y1 = STEP_COMMIT("y".repeat(40), "feature/y", a.sha, "specify", 1, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, x1, y1] };
  const out = layoutTimeline(snap, OPTS);

  const featX = out.columns.find((c) => c.branch === "feature/x")!;
  const featY = out.columns.find((c) => c.branch === "feature/y")!;
  assert.ok(featX);
  assert.ok(featY);
  assert.notEqual(featX.columnIndex, featY.columnIndex, "parallel branches must not share a lane");
  // Two fork edges, both from a.
  const forks = out.edges.filter((e) => e.kind === "fork");
  assert.equal(forks.length, 2);
  assert.ok(forks.every((f) => f.fromId === a.sha));
});

test("layoutTimeline: chronological allocation — later branches always sit to the right (no recycling)", () => {
  // feature/x: forks at a, ends at x1 (rows 1→2). feature/y forks at b (row 3),
  // after feature/x has ended. Even though feature/x's lane is "free", feature/y
  // must not recycle into it — the user expects newer activity to appear on the
  // right edge of the canvas.
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const x1 = STEP_COMMIT("x".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:03:00Z");
  const y1 = STEP_COMMIT("y".repeat(40), "feature/y", b.sha, "specify", 1, "2026-04-25T10:04:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, x1, b, y1] };
  const out = layoutTimeline(snap, OPTS);

  const featX = out.columns.find((c) => c.branch === "feature/x")!;
  const featYNode = out.nodes.find((n) => n.id === y1.sha)!;
  assert.ok(
    featYNode.columnIndex > featX.columnIndex,
    "feature/y (later forkRow) must sit strictly to the right of feature/x",
  );
});

test("layoutTimeline: branch titles — every lane's tenant is top-pinned at the header row", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const x1 = STEP_COMMIT("x".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:03:00Z");
  const y1 = STEP_COMMIT("y".repeat(40), "feature/y", b.sha, "specify", 1, "2026-04-25T10:04:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, x1, b, y1] };
  const out = layoutTimeline(snap, OPTS);

  // Without recycling each branch owns its lane outright, so every badge
  // sits at the top header row.
  for (const branch of ["main", "feature/x", "feature/y"]) {
    const t = out.branchTitles.find((x) => x.branch === branch)!;
    assert.ok(t, `${branch} must have a title`);
    assert.equal(t.isTopHeader, true, `${branch} title must be top-pinned`);
    assert.equal(t.rowIndex, 0, `${branch} title row must be 0`);
  }
});

test("layoutTimeline: selected-* lane flagged isSelectedLane", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const sel = STEP_COMMIT(
    "s".repeat(40), "selected-x", a.sha, "specify", 1, "2026-04-25T10:02:00Z",
  );
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, sel] };
  const out = layoutTimeline(snap, OPTS);
  const t = out.branchTitles.find((b) => b.branch === "selected-x");
  assert.ok(t);
  assert.equal(t!.isSelectedLane, true);
});

test("layoutTimeline: a third branch forking last gets the rightmost lane", () => {
  // Validates the chronological rule across three branches forking from the
  // same trunk row at increasing fork rows. Whichever forks last must land
  // on the highest lane index.
  const m = STEP_COMMIT("m".repeat(40), "main", null, "plan", 1, "2026-04-25T10:00:00Z");
  const a1 = STEP_COMMIT("a1".padEnd(40, "0"), "dex/featA", m.sha, "specify", 1, "2026-04-25T10:01:00Z");
  const a2 = STEP_COMMIT("a2".padEnd(40, "0"), "dex/featA", a1.sha, "verify", 1, "2026-04-25T10:02:00Z");
  const b1 = STEP_COMMIT("b1".padEnd(40, "0"), "dex/featB", a2.sha, "specify", 1, "2026-04-25T10:03:00Z");
  const c1 = STEP_COMMIT("c1".padEnd(40, "0"), "dex/featC", b1.sha, "specify", 1, "2026-04-25T10:04:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [m, a1, a2, b1, c1] };
  const out = layoutTimeline(snap, OPTS);

  const colA = out.columns.find((c) => c.branch === "dex/featA")!;
  const colB = out.columns.find((c) => c.branch === "dex/featB")!;
  const colC = out.columns.find((c) => c.branch === "dex/featC")!;
  assert.ok(colA && colB && colC, "all three branches must have columns");
  assert.ok(colA.columnIndex < colB.columnIndex, "featB must be right of featA");
  assert.ok(colB.columnIndex < colC.columnIndex, "featC must be right of featB");
});

test("layoutTimeline: dotted column markers — one per non-trunk lane, full canvas height", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const x1 = STEP_COMMIT("x".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const y1 = STEP_COMMIT("y".repeat(40), "feature/y", a.sha, "specify", 1, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, x1, y1] };
  const out = layoutTimeline(snap, OPTS);
  // Two non-trunk lanes → two dotted markers.
  assert.equal(out.dottedMarkers.length, 2);
  // Markers span most of the canvas height.
  for (const m of out.dottedMarkers) {
    assert.ok(m.y2 > m.y1);
    assert.ok(m.y2 - m.y1 > out.rowHeight * 2);
  }
});

test("layoutTimeline: lane segments — one per branch with ≥2 commits, colored by branch", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const x1 = STEP_COMMIT("x1".padEnd(40, "x"), "feature/x", a.sha, "specify", 1, "2026-04-25T10:03:00Z");
  const x2 = STEP_COMMIT("x2".padEnd(40, "x"), "feature/x", x1.sha, "plan", 1, "2026-04-25T10:04:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, b, x1, x2] };
  const out = layoutTimeline(snap, OPTS);
  const mainSeg = out.laneSegments.find((s) => s.branch === "main")!;
  const xSeg = out.laneSegments.find((s) => s.branch === "feature/x")!;
  assert.ok(mainSeg);
  assert.ok(xSeg);
  // segments span first→last commit of their branch.
  assert.ok(mainSeg.y2 > mainSeg.y1);
  assert.ok(xSeg.y2 > xSeg.y1);
});

test("layoutTimeline: merge commit on main — hollow flag + merge edge from merged tip", () => {
  // main: a, then merge commit m (with parent a + parent x1 from feature/x).
  // feature/x: x1.
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const x1 = STEP_COMMIT("x".repeat(40), "feature/x", a.sha, "specify", 1, "2026-04-25T10:02:00Z");
  const m = STEP_COMMIT(
    "m".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:03:00Z",
    false, undefined, [x1.sha],
  );
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, x1, m] };
  const out = layoutTimeline(snap, OPTS);

  // Merge commit m flagged isMerge.
  const mNode = out.nodes.find((n) => n.id === m.sha)!;
  assert.equal(mNode.isMerge, true);

  // One merge edge from x1 → m, with elbow at x1's X and m's Y.
  const merges = out.edges.filter((e) => e.kind === "merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].fromId, x1.sha);
  assert.equal(merges[0].toId, m.sha);
  assert.ok(merges[0].elbow);
  const x1Node = out.nodes.find((n) => n.id === x1.sha)!;
  assert.equal(merges[0].elbow!.x, x1Node.x);
  assert.equal(merges[0].elbow!.y, mNode.y);
});

test("layoutTimeline: promote step on main — main lane extends to merge tip, source lane preserved", () => {
  // Reproduces the post-promote topology where listTimeline has surfaced
  // the merge commit as a `step: "promote"` TimelineCommit and recovered
  // the (now-deleted) source branch's exclusive step-commit. Verifies the
  // main lane reaches all the way to the merge row (so the `main` badge
  // sits on the actual HEAD) and the source-branch lane gets its own
  // column with a merge edge into main.
  const baseline = STEP_COMMIT(
    "a".repeat(40), "main", null, "specify", 0, "2026-05-04T17:45:16Z",
  );
  const sideTip = STEP_COMMIT(
    "b".repeat(40),
    "dex/2026-05-04-clean",
    baseline.parentSha,
    "specify",
    1,
    "2026-05-04T17:45:16.500Z",
  );
  const promoteMerge: TimelineCommit = {
    sha: "c".repeat(40),
    shortSha: "ccccccc",
    branch: "main",
    containingBranches: ["main"],
    parentSha: baseline.sha,
    mergedParentShas: [sideTip.sha],
    step: "promote",
    cycleNumber: -1,
    subject: "dex: promoted dex/2026-05-04-clean to main",
    timestamp: "2026-05-04T17:45:22Z",
    hasCheckpointTag: false,
  };
  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    commits: [baseline, sideTip, promoteMerge],
    currentBranch: "main",
  };
  const out = layoutTimeline(snap, OPTS);

  const baselineNode = out.nodes.find((n) => n.id === baseline.sha)!;
  const mergeNode = out.nodes.find((n) => n.id === promoteMerge.sha)!;
  const sideNode = out.nodes.find((n) => n.id === sideTip.sha)!;

  // Merge node sits in main's column, below baseline, and is hollow.
  assert.equal(mergeNode.branch, "main");
  assert.equal(mergeNode.columnIndex, baselineNode.columnIndex);
  assert.equal(mergeNode.isMerge, true);
  assert.ok(mergeNode.y > baselineNode.y);

  // Side branch claimed its own non-trunk column.
  assert.equal(sideNode.branch, "dex/2026-05-04-clean");
  assert.notEqual(sideNode.columnIndex, baselineNode.columnIndex);

  // Merge edge from sideTip → mergeNode is drawn.
  const merges = out.edges.filter((e) => e.kind === "merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].fromId, sideTip.sha);
  assert.equal(merges[0].toId, promoteMerge.sha);

  // The `main` badge's tail row sits below the merge — proves main's lane
  // extends all the way to its actual HEAD instead of stopping at the
  // last step-commit (the original bug).
  const mainTail = out.branchTitles.find((t) => t.branch === "main" && t.isTail);
  assert.ok(mainTail, "main should have a tail badge once it has ≥2 commits in lane");
  assert.ok(mainTail!.y > mergeNode.y);
});

test("layoutTimeline: color states — selected (blue), kept (red), both, default", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const c = STEP_COMMIT("c".repeat(40), "main", b.sha, "implement", 1, "2026-04-25T10:03:00Z");
  const d = STEP_COMMIT("d".repeat(40), "main", c.sha, "verify", 1, "2026-04-25T10:04:00Z");

  const snap: TimelineSnapshot = {
    ...EMPTY_SNAP,
    checkpoints: [
      { tag: "checkpoint/cycle-1-after-tasks", label: "tasks", sha: b.sha,
        step: "tasks", cycleNumber: 1, featureSlug: null, commitMessage: "",
        timestamp: "2026-04-25T10:02:00Z" },
      { tag: "checkpoint/cycle-1-after-implement", label: "implement", sha: c.sha,
        step: "implement", cycleNumber: 1, featureSlug: null, commitMessage: "",
        timestamp: "2026-04-25T10:03:00Z" },
    ],
    commits: [a, b, c, d],
    selectedPath: [a.sha, c.sha],
  };
  const out = layoutTimeline(snap, OPTS);
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get(a.sha)!.colorState, "selected");
  assert.equal(byId.get(b.sha)!.colorState, "kept");
  assert.equal(byId.get(c.sha)!.colorState, "selected+kept");
  assert.equal(byId.get(d.sha)!.colorState, "default");
});

test("layoutTimeline: cycle bands — one band per contiguous cycleNumber run", () => {
  const a = STEP_COMMIT("a".repeat(40), "main", null, "plan", 1, "2026-04-25T10:01:00Z");
  const b = STEP_COMMIT("b".repeat(40), "main", a.sha, "tasks", 1, "2026-04-25T10:02:00Z");
  const c = STEP_COMMIT("c".repeat(40), "main", b.sha, "specify", 2, "2026-04-25T10:03:00Z");
  const snap: TimelineSnapshot = { ...EMPTY_SNAP, commits: [a, b, c] };
  const out = layoutTimeline(snap, OPTS);
  // 2 contiguous bands: cycle 1 (a, b), cycle 2 (c).
  assert.equal(out.cycleBands.length, 2);
  assert.equal(out.cycleBands[0].cycleNumber, 1);
  assert.equal(out.cycleBands[1].cycleNumber, 2);
});
