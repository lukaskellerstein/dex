import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGapAnalysisDecision,
  applyGapAnalysisDecision,
  shouldRunStage,
  getDecisionSpecDir,
} from "../gap-analysis.ts";
import type { GapAnalysisDecision, StepType } from "../types.ts";

// ── parseGapAnalysisDecision ────────────────────────────────────────────────

test("parseGapAnalysisDecision: RESUME_FEATURE round-trips", () => {
  const d = parseGapAnalysisDecision(
    { decision: "RESUME_FEATURE", reason: "spec is current" },
    "specs/feature-a",
  );
  assert.deepEqual(d, { type: "RESUME_FEATURE", specDir: "specs/feature-a" });
});

test("parseGapAnalysisDecision: REPLAN_FEATURE round-trips", () => {
  const d = parseGapAnalysisDecision(
    { decision: "REPLAN_FEATURE", reason: "spec drifted" },
    "specs/feature-b",
  );
  assert.deepEqual(d, { type: "REPLAN_FEATURE", specDir: "specs/feature-b" });
});

test("parseGapAnalysisDecision: throws on null", () => {
  assert.throws(
    () => parseGapAnalysisDecision(null, "specs/x"),
    /expected object, got null/,
  );
});

test("parseGapAnalysisDecision: throws on non-object (string)", () => {
  assert.throws(
    () => parseGapAnalysisDecision("RESUME_FEATURE", "specs/x"),
    /expected object, got string/,
  );
});

test("parseGapAnalysisDecision: throws on missing decision field", () => {
  assert.throws(
    () => parseGapAnalysisDecision({ reason: "ok" }, "specs/x"),
    /'decision' field is missing or not a string/,
  );
});

test("parseGapAnalysisDecision: throws on non-string decision", () => {
  assert.throws(
    () => parseGapAnalysisDecision({ decision: 42 }, "specs/x"),
    /not a string \(got number\)/,
  );
});

test("parseGapAnalysisDecision: throws on unknown decision string", () => {
  assert.throws(
    () => parseGapAnalysisDecision({ decision: "FROBNICATE" }, "specs/x"),
    /unknown decision "FROBNICATE"/,
  );
});

test("parseGapAnalysisDecision: throws on empty specDir", () => {
  assert.throws(
    () => parseGapAnalysisDecision({ decision: "RESUME_FEATURE" }, ""),
    /specDir is required/,
  );
});

// ── applyGapAnalysisDecision: covers all 5 branches ────────────────────────

test("applyGapAnalysisDecision: NEXT_FEATURE → entry at specify, no specDir", () => {
  const d: GapAnalysisDecision = {
    type: "NEXT_FEATURE",
    name: "Auth",
    description: "user sign-up",
    featureId: 1,
  };
  assert.deepEqual(applyGapAnalysisDecision(d), { nextStep: "specify" });
});

test("applyGapAnalysisDecision: RESUME_FEATURE → entry at implement", () => {
  const d: GapAnalysisDecision = { type: "RESUME_FEATURE", specDir: "specs/a" };
  assert.deepEqual(applyGapAnalysisDecision(d), {
    nextSpecDir: "specs/a",
    nextStep: "implement",
  });
});

test("applyGapAnalysisDecision: REPLAN_FEATURE → entry at plan", () => {
  const d: GapAnalysisDecision = { type: "REPLAN_FEATURE", specDir: "specs/a" };
  assert.deepEqual(applyGapAnalysisDecision(d), {
    nextSpecDir: "specs/a",
    nextStep: "plan",
  });
});

test("applyGapAnalysisDecision: RESUME_AT_STEP — resumeAtStep=specify → next is plan", () => {
  const d: GapAnalysisDecision = {
    type: "RESUME_AT_STEP",
    specDir: "specs/a",
    resumeAtStep: "specify",
  };
  assert.deepEqual(applyGapAnalysisDecision(d), {
    nextSpecDir: "specs/a",
    nextStep: "plan",
  });
});

test("applyGapAnalysisDecision: RESUME_AT_STEP — resumeAtStep=tasks → next is implement", () => {
  const d: GapAnalysisDecision = {
    type: "RESUME_AT_STEP",
    specDir: "specs/a",
    resumeAtStep: "tasks",
  };
  assert.deepEqual(applyGapAnalysisDecision(d), {
    nextSpecDir: "specs/a",
    nextStep: "implement",
  });
});

test("applyGapAnalysisDecision: RESUME_AT_STEP — resumeAtStep=learnings (terminal) → terminate", () => {
  const d: GapAnalysisDecision = {
    type: "RESUME_AT_STEP",
    specDir: "specs/a",
    resumeAtStep: "learnings",
  };
  assert.deepEqual(applyGapAnalysisDecision(d), {
    nextSpecDir: "specs/a",
    terminate: true,
  });
});

test("applyGapAnalysisDecision: GAPS_COMPLETE → terminate", () => {
  const d: GapAnalysisDecision = { type: "GAPS_COMPLETE" };
  assert.deepEqual(applyGapAnalysisDecision(d), { terminate: true });
});

// ── shouldRunStage: per-decision matrix ─────────────────────────────────────

const allSteps: StepType[] = [
  "specify",
  "plan",
  "tasks",
  "implement",
  "verify",
  "learnings",
];

test("shouldRunStage: NEXT_FEATURE runs every cycle stage except gap_analysis", () => {
  const d: GapAnalysisDecision = {
    type: "NEXT_FEATURE",
    name: "x",
    description: "y",
    featureId: 1,
  };
  for (const s of allSteps) assert.equal(shouldRunStage(d, s), true, `NEXT_FEATURE should run ${s}`);
  assert.equal(shouldRunStage(d, "gap_analysis"), false);
});

test("shouldRunStage: REPLAN_FEATURE runs plan→learnings (skips specify)", () => {
  const d: GapAnalysisDecision = { type: "REPLAN_FEATURE", specDir: "specs/a" };
  assert.equal(shouldRunStage(d, "specify"), false);
  for (const s of ["plan", "tasks", "implement", "verify", "learnings"] as StepType[]) {
    assert.equal(shouldRunStage(d, s), true, `REPLAN_FEATURE should run ${s}`);
  }
});

test("shouldRunStage: RESUME_FEATURE runs only implement/verify/learnings", () => {
  const d: GapAnalysisDecision = { type: "RESUME_FEATURE", specDir: "specs/a" };
  for (const s of ["specify", "plan", "tasks"] as StepType[]) {
    assert.equal(shouldRunStage(d, s), false);
  }
  for (const s of ["implement", "verify", "learnings"] as StepType[]) {
    assert.equal(shouldRunStage(d, s), true);
  }
});

test("shouldRunStage: RESUME_AT_STEP — resumeAtStep=plan → runs tasks/implement/verify/learnings", () => {
  const d: GapAnalysisDecision = {
    type: "RESUME_AT_STEP",
    specDir: "specs/a",
    resumeAtStep: "plan",
  };
  assert.equal(shouldRunStage(d, "specify"), false);
  assert.equal(shouldRunStage(d, "plan"), false);
  assert.equal(shouldRunStage(d, "tasks"), true);
  assert.equal(shouldRunStage(d, "implement"), true);
});

test("shouldRunStage: GAPS_COMPLETE runs nothing", () => {
  const d: GapAnalysisDecision = { type: "GAPS_COMPLETE" };
  for (const s of allSteps) assert.equal(shouldRunStage(d, s), false);
  assert.equal(shouldRunStage(d, "gap_analysis"), false);
});

// ── getDecisionSpecDir ──────────────────────────────────────────────────────

test("getDecisionSpecDir: returns specDir for RESUME/REPLAN/RESUME_AT_STEP", () => {
  assert.equal(
    getDecisionSpecDir({ type: "RESUME_FEATURE", specDir: "a" }),
    "a",
  );
  assert.equal(
    getDecisionSpecDir({ type: "REPLAN_FEATURE", specDir: "b" }),
    "b",
  );
  assert.equal(
    getDecisionSpecDir({ type: "RESUME_AT_STEP", specDir: "c", resumeAtStep: "plan" }),
    "c",
  );
});

test("getDecisionSpecDir: returns null for NEXT_FEATURE and GAPS_COMPLETE", () => {
  assert.equal(
    getDecisionSpecDir({ type: "NEXT_FEATURE", name: "x", description: "y", featureId: 1 }),
    null,
  );
  assert.equal(getDecisionSpecDir({ type: "GAPS_COMPLETE" }), null);
});
