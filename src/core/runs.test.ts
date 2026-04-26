import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  readRun,
  listRuns,
  updateRun,
  startRun,
  completeRun,
  startPhase,
  completePhase,
  recordSubagent,
  reconcileCrashedRuns,
  appendStep,
  readSteps,
  upsertFailureCount,
  latestPhasesForSpec,
  getSpecAggregateStats,
  phaseLogDir,
  type RunRecord,
  type PhaseRecord,
} from "./runs.js";

function tempProject(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `runs-test-${name}-`));
  return dir;
}

function makeRunInput(runId = "11111111-1111-1111-1111-111111111111"): Parameters<typeof startRun>[1] {
  return {
    runId,
    mode: "loop",
    model: "claude-opus-4-7",
    specDir: "specs/foo",
    startedAt: new Date().toISOString(),
    status: "running",
    writerPid: process.pid,
  };
}

test("writeRun + readRun round-trip preserves all fields", () => {
  const dir = tempProject("rt");
  const run = startRun(dir, makeRunInput());
  const back = readRun(dir, run.runId);
  assert.deepEqual(back, run);
});

test("listRuns returns [] for non-existent directory", () => {
  const dir = tempProject("empty");
  fs.rmSync(path.join(dir, ".dex"), { recursive: true, force: true });
  assert.deepEqual(listRuns(dir), []);
});

test("listRuns returns one record for one file", () => {
  const dir = tempProject("one");
  startRun(dir, makeRunInput());
  const list = listRuns(dir);
  assert.equal(list.length, 1);
});

test("listRuns sorts by startedAt descending", () => {
  const dir = tempProject("sort");
  startRun(dir, { ...makeRunInput("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), startedAt: "2026-04-17T10:00:00.000Z" });
  startRun(dir, { ...makeRunInput("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), startedAt: "2026-04-17T12:00:00.000Z" });
  startRun(dir, { ...makeRunInput("cccccccc-cccc-cccc-cccc-cccccccccccc"), startedAt: "2026-04-17T11:00:00.000Z" });
  const list = listRuns(dir);
  assert.deepEqual(list.map((r) => r.runId.slice(0, 1)), ["b", "c", "a"]);
});

test("listRuns skips malformed JSON files and continues", () => {
  const dir = tempProject("corrupt");
  startRun(dir, makeRunInput());
  fs.writeFileSync(path.join(dir, ".dex", "runs", "garbage.json"), "{not json");
  const list = listRuns(dir);
  assert.equal(list.length, 1);
});

test("writeRun is atomic — leaves no .tmp visible to listRuns on success", () => {
  const dir = tempProject("atom");
  startRun(dir, makeRunInput());
  const files = fs.readdirSync(path.join(dir, ".dex", "runs"));
  assert.equal(files.filter((f) => f.endsWith(".tmp")).length, 0);
});

test("startPhase + completePhase round-trip with cost recomputation", () => {
  const dir = tempProject("phase");
  const run = startRun(dir, makeRunInput());
  startPhase(dir, run.runId, {
    phaseTraceId: "phase-1",
    runId: run.runId,
    specDir: "specs/foo",
    phaseNumber: 1,
    phaseName: "loop:specify",
    stage: "specify",
    cycleNumber: 1,
    featureSlug: "foo",
    startedAt: new Date().toISOString(),
    status: "running",
  });
  completePhase(dir, run.runId, "phase-1", { status: "completed", costUsd: 0.5, inputTokens: 100, outputTokens: 50 });
  const back = readRun(dir, run.runId)!;
  assert.equal(back.phases.length, 1);
  assert.equal(back.phases[0].status, "completed");
  assert.equal(back.totalCostUsd, 0.5);
  assert.equal(back.phasesCompleted, 1);
  assert.ok(back.phases[0].endedAt);
  assert.ok(back.phases[0].durationMs !== null && back.phases[0].durationMs >= 0);
});

test("recordSubagent upserts by id (no duplicates)", () => {
  const dir = tempProject("sub");
  const run = startRun(dir, makeRunInput());
  startPhase(dir, run.runId, {
    phaseTraceId: "phase-1",
    runId: run.runId,
    specDir: "specs/foo",
    phaseNumber: 1,
    phaseName: "loop:plan",
    stage: "plan",
    cycleNumber: 1,
    featureSlug: "foo",
    startedAt: new Date().toISOString(),
    status: "running",
  });
  recordSubagent(dir, run.runId, "phase-1", {
    id: "sub-1",
    type: "specify",
    description: null,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    costUsd: 0,
  });
  recordSubagent(dir, run.runId, "phase-1", {
    id: "sub-1",
    type: "specify",
    description: null,
    status: "ok",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1234,
    costUsd: 0,
  });
  const back = readRun(dir, run.runId)!;
  assert.equal(back.phases[0].subagents.length, 1);
  assert.equal(back.phases[0].subagents[0].status, "ok");
  assert.equal(back.phases[0].subagents[0].durationMs, 1234);
});

test("reconcileCrashedRuns transitions stale running runs", () => {
  const dir = tempProject("crash");
  const run = startRun(dir, makeRunInput());
  startPhase(dir, run.runId, {
    phaseTraceId: "phase-1",
    runId: run.runId,
    specDir: "specs/foo",
    phaseNumber: 1,
    phaseName: "loop:specify",
    stage: "specify",
    cycleNumber: 1,
    featureSlug: "foo",
    startedAt: new Date().toISOString(),
    status: "running",
  });
  recordSubagent(dir, run.runId, "phase-1", {
    id: "sub-1",
    type: "specify",
    description: null,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    costUsd: 0,
  });
  reconcileCrashedRuns(dir, () => false); // pretend writer is dead
  const back = readRun(dir, run.runId)!;
  assert.equal(back.status, "crashed");
  assert.equal(back.phases[0].status, "crashed");
  assert.equal(back.phases[0].subagents[0].status, "crashed");
});

test("reconcileCrashedRuns leaves alive runs untouched", () => {
  const dir = tempProject("alive");
  startRun(dir, makeRunInput());
  reconcileCrashedRuns(dir, () => true);
  const back = readRun(dir, "11111111-1111-1111-1111-111111111111")!;
  assert.equal(back.status, "running");
});

test("appendStep + readSteps round-trip including malformed line skip", () => {
  const dir = tempProject("steps");
  const runId = "44444444-4444-4444-4444-444444444444";
  const slug = "loop-specify";
  const phaseNumber = 1;
  for (let i = 0; i < 5; i++) {
    appendStep(dir, runId, slug, phaseNumber, {
      id: `s-${i}`,
      phaseTraceId: "phase-1",
      sequenceIndex: i,
      type: "tool_call",
      content: `step ${i}`,
      metadata: { costUsd: i * 0.01 },
      durationMs: 10,
      tokenCount: 5,
      createdAt: new Date().toISOString(),
    });
  }
  // Inject a partial last line (simulated crash mid-append)
  const file = path.join(phaseLogDir(dir, runId, slug, phaseNumber), "steps.jsonl");
  fs.appendFileSync(file, '{"id":"s-5","incomp');
  const back = readSteps(dir, runId, slug, phaseNumber);
  assert.equal(back.length, 5);
  assert.equal(back[0].id, "s-0");
  assert.equal(back[4].id, "s-4");
});

test("readSteps returns [] for missing file", () => {
  const dir = tempProject("nosteps");
  const out = readSteps(dir, "no-such-run", "x", 1);
  assert.deepEqual(out, []);
});

test("getSpecAggregateStats picks latest phase per phaseNumber across runs", () => {
  const baseRun = (runId: string, when: string, costs: number[]): RunRecord => ({
    runId,
    mode: "loop",
    model: "m",
    specDir: "s",
    startedAt: when,
    endedAt: null,
    status: "completed",
    totalCostUsd: 0,
    totalDurationMs: 0,
    phasesCompleted: costs.length,
    writerPid: 0,
    description: null,
    fullPlanPath: null,
    maxLoopCycles: null,
    maxBudgetUsd: null,
    loopsCompleted: 1,
    failureCounters: {},
    phases: costs.map((c, i): PhaseRecord => ({
      phaseTraceId: `${runId}-p${i + 1}`,
      runId,
      specDir: "specs/foo",
      phaseNumber: i + 1,
      phaseName: `loop:p${i + 1}`,
      stage: "specify",
      cycleNumber: 1,
      featureSlug: "foo",
      startedAt: when,
      endedAt: when,
      status: "completed",
      costUsd: c,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      subagents: [],
      checkpointTag: null,
      candidateSha: null,
    })),
  });
  const runs: RunRecord[] = [
    baseRun("old", "2026-04-15T00:00:00.000Z", [1, 2]),
    baseRun("new", "2026-04-17T00:00:00.000Z", [10, 20]),
  ];
  const stats = getSpecAggregateStats(runs, "specs/foo");
  assert.equal(stats.phasesWithTraces, 2);
  assert.equal(stats.totalCostUsd, 30); // latest only
  assert.equal(stats.totalInputTokens, 20);
});

test("updateRun throws on unknown run", () => {
  const dir = tempProject("unknown");
  assert.throws(() => updateRun(dir, "no-such", () => {}));
});

test("completeRun sets terminal fields", () => {
  const dir = tempProject("complete");
  const run = startRun(dir, makeRunInput());
  completeRun(dir, run.runId, "completed", 1.5, 60000, 4);
  const back = readRun(dir, run.runId)!;
  assert.equal(back.status, "completed");
  assert.equal(back.totalCostUsd, 1.5);
  assert.equal(back.totalDurationMs, 60000);
  assert.equal(back.phasesCompleted, 4);
  assert.ok(back.endedAt);
});

test("US3 cross-project isolation: two projects produce disjoint runs", () => {
  const a = tempProject("isoA");
  const b = tempProject("isoB");
  const runA = startRun(a, { ...makeRunInput("a1111111-1111-1111-1111-111111111111") });
  const runB = startRun(b, { ...makeRunInput("b2222222-2222-2222-2222-222222222222") });
  const listA = listRuns(a);
  const listB = listRuns(b);
  assert.equal(listA.length, 1);
  assert.equal(listB.length, 1);
  assert.equal(listA[0].runId, runA.runId);
  assert.equal(listB[0].runId, runB.runId);
  assert.notEqual(listA[0].runId, listB[0].runId);
});

test("latestPhasesForSpec returns one row per phaseNumber, latest wins", () => {
  const runs: RunRecord[] = [
    {
      runId: "old", mode: "loop", model: "m", specDir: "s", startedAt: "2026-04-15T00:00:00.000Z",
      endedAt: null, status: "completed", totalCostUsd: 0, totalDurationMs: 0, phasesCompleted: 1,
      writerPid: 0, description: null, fullPlanPath: null, maxLoopCycles: null, maxBudgetUsd: null,
      loopsCompleted: 1, failureCounters: {},
      phases: [{
        phaseTraceId: "old-1", runId: "old", specDir: "specs/foo", phaseNumber: 1,
        phaseName: "loop:specify", stage: "specify", cycleNumber: 1, featureSlug: "foo",
        startedAt: "2026-04-15T00:00:00.000Z", endedAt: "2026-04-15T00:01:00.000Z", status: "completed",
        costUsd: 1, durationMs: 60000, inputTokens: 1, outputTokens: 1, subagents: [],
        checkpointTag: null, candidateSha: null,
      }],
    },
    {
      runId: "new", mode: "loop", model: "m", specDir: "s", startedAt: "2026-04-17T00:00:00.000Z",
      endedAt: null, status: "completed", totalCostUsd: 0, totalDurationMs: 0, phasesCompleted: 1,
      writerPid: 0, description: null, fullPlanPath: null, maxLoopCycles: null, maxBudgetUsd: null,
      loopsCompleted: 1, failureCounters: {},
      phases: [{
        phaseTraceId: "new-1", runId: "new", specDir: "specs/foo", phaseNumber: 1,
        phaseName: "loop:specify", stage: "specify", cycleNumber: 1, featureSlug: "foo",
        startedAt: "2026-04-17T00:00:00.000Z", endedAt: "2026-04-17T00:01:00.000Z", status: "completed",
        costUsd: 5, durationMs: 60000, inputTokens: 1, outputTokens: 1, subagents: [],
        checkpointTag: null, candidateSha: null,
      }],
    },
  ];
  const rows = latestPhasesForSpec(runs, "specs/foo");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phaseTraceId, "new-1");
  assert.equal(rows[0].costUsd, 5);
});
