import test from "node:test";
import assert from "node:assert/strict";
import type { TimelineSnapshot } from "../checkpoints.ts";
import { layoutTimeline } from "../../renderer/components/checkpoints/timelineLayout.ts";

test("layoutTimeline: empty snapshot", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [],
    attempts: [],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: null,
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 0);
  assert.equal(out.edges.length, 0);
  assert.ok(out.width >= 320);
  assert.ok(out.height >= 200);
});

test("layoutTimeline: canonical-only produces canonical lane + edges", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [
      {
        tag: "checkpoint/after-prerequisites",
        label: "prerequisites done",
        sha: "a".repeat(40),
        stage: "prerequisites",
        cycleNumber: 0,
        featureSlug: null,
        commitMessage: "dex: prerequisites completed [cycle:0]",
        timestamp: "2026-04-17T18:00:00Z",
      },
      {
        tag: "checkpoint/cycle-1-after-plan",
        label: "cycle 1 · plan written",
        sha: "b".repeat(40),
        stage: "plan",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "dex: plan completed [cycle:1]",
        timestamp: "2026-04-17T18:15:00Z",
      },
    ],
    attempts: [],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: null,
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 2);
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].kind, "canonical");
  assert.equal(out.nodes[0].lane, "canonical");
  assert.equal(out.nodes[0].laneIndex, 0);
  assert.equal(out.nodes[1].lane, "canonical");
});

test("layoutTimeline: attempt branches off a checkpoint", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [
      {
        tag: "checkpoint/cycle-1-after-plan",
        label: "cycle 1 · plan written",
        sha: "b".repeat(40),
        stage: "plan",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "dex: plan completed [cycle:1]",
        timestamp: "2026-04-17T18:15:00Z",
      },
    ],
    attempts: [
      {
        branch: "attempt-20260417T182301",
        sha: "c".repeat(40),
        isCurrent: true,
        baseCheckpoint: "checkpoint/cycle-1-after-plan",
        stepsAhead: 1,
        timestamp: "2026-04-17T18:23:01Z",
        variantGroup: null,
      },
    ],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: null,
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 2);
  const attempt = out.nodes.find((n) => n.node.kind === "attempt")!;
  assert.equal(attempt.lane, "attempt");
  assert.ok(attempt.laneIndex >= 1);
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].kind, "branch-off");
});

test("layoutTimeline: multi-variant fan-out uses variant lanes", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [
      {
        tag: "checkpoint/cycle-1-after-tasks",
        label: "cycle 1 · tasks generated",
        sha: "b".repeat(40),
        stage: "tasks",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "dex: tasks completed [cycle:1]",
        timestamp: "2026-04-17T18:15:00Z",
      },
    ],
    attempts: [
      {
        branch: "attempt-20260417T182301-a",
        sha: "c1".padEnd(40, "0"),
        isCurrent: false,
        baseCheckpoint: "checkpoint/cycle-1-after-tasks",
        stepsAhead: 1,
        timestamp: "2026-04-17T18:23:01Z",
        variantGroup: "a",
      },
      {
        branch: "attempt-20260417T182301-b",
        sha: "c2".padEnd(40, "0"),
        isCurrent: false,
        baseCheckpoint: "checkpoint/cycle-1-after-tasks",
        stepsAhead: 1,
        timestamp: "2026-04-17T18:23:01Z",
        variantGroup: "b",
      },
      {
        branch: "attempt-20260417T182301-c",
        sha: "c3".padEnd(40, "0"),
        isCurrent: true,
        baseCheckpoint: "checkpoint/cycle-1-after-tasks",
        stepsAhead: 1,
        timestamp: "2026-04-17T18:23:01Z",
        variantGroup: "c",
      },
    ],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: null,
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  const variantNodes = out.nodes.filter((n) => n.lane === "variant");
  assert.equal(variantNodes.length, 3);
  // Each variant occupies a distinct lane column
  const lanes = new Set(variantNodes.map((n) => n.laneIndex));
  assert.equal(lanes.size, 3);
  // Three branch-off edges from the tasks checkpoint
  const branchEdges = out.edges.filter((e) => e.kind === "branch-off");
  assert.equal(branchEdges.length, 3);
});

test("layoutTimeline: starting point only — fresh project shows single anchor node", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [],
    attempts: [],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: {
      branch: "main",
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      subject: "initial commit",
      timestamp: "2026-04-25T10:00:00Z",
    },
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].node.kind, "start");
  assert.equal(out.nodes[0].lane, "canonical");
  assert.equal(out.edges.length, 0);
});

test("layoutTimeline: starting point + checkpoint connects via canonical edge", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [
      {
        tag: "checkpoint/after-prerequisites",
        label: "prerequisites done",
        sha: "b".repeat(40),
        stage: "prerequisites",
        cycleNumber: 0,
        featureSlug: null,
        commitMessage: "dex: prerequisites completed [cycle:0]",
        timestamp: "2026-04-25T10:05:00Z",
      },
    ],
    attempts: [],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: {
      branch: "main",
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      subject: "initial commit",
      timestamp: "2026-04-25T10:00:00Z",
    },
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 2);
  assert.equal(out.nodes[0].node.kind, "start");
  assert.equal(out.nodes[1].node.kind, "checkpoint");
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].kind, "canonical");
  assert.equal(out.edges[0].toId, "checkpoint/after-prerequisites");
});

test("layoutTimeline: unavailable checkpoint still placed in canonical lane", () => {
  const snap: TimelineSnapshot = {
    checkpoints: [
      {
        tag: "checkpoint/cycle-1-after-plan",
        label: "checkpoint/cycle-1-after-plan (unavailable)",
        sha: "",
        stage: "plan",
        cycleNumber: 1,
        featureSlug: null,
        commitMessage: "",
        timestamp: "",
        unavailable: true,
      },
    ],
    attempts: [],
    currentAttempt: null,
    pending: [],
    captureBranches: [],
    startingPoint: null,
  };
  const out = layoutTimeline(snap, { columnWidth: 72, rowHeight: 64 });
  assert.equal(out.nodes.length, 1);
  assert.equal(out.nodes[0].unavailable, true);
  assert.equal(out.nodes[0].lane, "canonical");
});
