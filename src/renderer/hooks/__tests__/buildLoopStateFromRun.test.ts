import { describe, expect, it } from "vitest";
import type { AgentRunRecord, RunRecord } from "../../../core/runs.js";
import { buildLoopStateFromRun, lastCycleOf } from "../buildLoopStateFromRun.js";

function agentRun(over: Partial<AgentRunRecord>): AgentRunRecord {
  return {
    agentRunId: "a",
    runId: "r",
    specDir: "specs/001-alpha",
    taskPhaseNumber: 1,
    taskPhaseName: "loop:specify",
    step: "specify",
    cycleNumber: 1,
    featureSlug: "001-alpha",
    startedAt: "t0",
    endedAt: null,
    status: "completed",
    costUsd: 0,
    durationMs: 0,
    inputTokens: null,
    outputTokens: null,
    ...over,
  } as AgentRunRecord;
}

function run(status: RunRecord["status"], agentRuns: AgentRunRecord[]): RunRecord {
  return { runId: "r", mode: "loop", status, agentRuns, totalCostUsd: 0 } as unknown as RunRecord;
}

const RUNS = [
  agentRun({
    agentRunId: "pre",
    taskPhaseNumber: 0,
    taskPhaseName: "loop:prerequisites",
    specDir: null,
    costUsd: 0.1,
  }),
  agentRun({ agentRunId: "s1", costUsd: 0.5 }),
  agentRun({ agentRunId: "i1", taskPhaseName: "Core", step: "implement", costUsd: 1 }),
  agentRun({
    agentRunId: "s2",
    taskPhaseNumber: 2,
    taskPhaseName: "loop:plan",
    specDir: "specs/002-beta",
    status: "running",
    costUsd: 0.25,
  }),
];

describe("buildLoopStateFromRun", () => {
  it("counts every agent run's cost: a cycle's includes its implement phases, the total includes all", () => {
    const rebuilt = buildLoopStateFromRun(run("completed", RUNS), null);
    expect(rebuilt.preCycleStages.map((s) => s.type)).toEqual(["prerequisites"]);
    expect(
      rebuilt.loopCycles.map((c) => [c.cycleNumber, c.costUsd, c.implementPhases.length]),
    ).toEqual([
      [1, 1.5, 1],
      [2, 0.25, 0],
    ]);
    expect(rebuilt.totalCost).toBeCloseTo(1.85);
  });

  it("a run that ended cannot still run a stage: its open record shows stopped, its last cycle as the one to resume", () => {
    const ended = run("paused", RUNS);
    expect(lastCycleOf(ended)).toBe(2);
    const rebuilt = buildLoopStateFromRun(ended, lastCycleOf(ended));
    const last = rebuilt.loopCycles[1];
    expect(last.stages[0].status).toBe("stopped");
    expect(last.status).toBe("running");
    expect(rebuilt.loopCycles[0].status).toBe("completed");
  });

  it("a live run keeps its open stage running", () => {
    const rebuilt = buildLoopStateFromRun(run("running", RUNS), 2);
    expect(rebuilt.loopCycles[1].stages[0].status).toBe("running");
  });
});
