import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GateDecision } from "../../../../core/gates.js";
import type { SensorRun } from "../../../../core/sensors.js";
import type { OrchestratorEvent } from "../../../../core/types.js";
import { AgentStepItem } from "../AgentStepItem.js";
import { GateCard } from "../GateCard.js";
import { GateTracker, gateMeta } from "../GateCard.logic.js";

const run = (name: string, result: SensorRun["result"], tail: string[] = []): SensorRun => ({
  name,
  command: `npm run ${name}`,
  exitCode: result === "pass" ? 0 : 1,
  signal: null,
  durationMs: 1500,
  result,
  reruns: 0,
  tail,
});

const decision = (
  gate: GateDecision["gate"],
  outcome: GateDecision["outcome"],
  reason: string,
): GateDecision => ({
  gate,
  outcome,
  reason,
  pauseReason: null,
  next: null,
});

const sensor = (r: SensorRun): OrchestratorEvent => ({
  type: "sensor_run",
  runId: "run-1",
  entryId: "003-promo",
  stage: "implement",
  agentRunId: "a-1",
  run: r,
});

const gate = (d: GateDecision): OrchestratorEvent => ({
  type: "gate_decided",
  runId: "run-1",
  entryId: "003-promo",
  agentRunId: "a-1",
  decision: d,
  evidenceFile: ".dex/evidence/003-promo/implement-1.json",
});

afterEach(cleanup);

describe("GateTracker", () => {
  it("one gate step per decision, with the entry's runs since the last one", () => {
    const t = new GateTracker();
    expect(t.push(sensor(run("unit", "fail")))).toBeNull();
    expect(t.push(sensor(run("lint", "pass")))).toBeNull();
    const step = t.push(gate(decision("progress", "fail", "1 fast check is red: unit")));
    expect(step?.type).toBe("gate");
    expect(gateMeta(step ?? ({} as never))?.runs.map((r) => r.name)).toEqual(["unit", "lint"]);
    const next = t.push(gate(decision("done", "pass", "acceptance is green")));
    expect(gateMeta(next ?? ({} as never))?.runs).toEqual([]);
  });

  it("a baseline gate waits for the stage it guards", () => {
    const t = new GateTracker();
    t.push(sensor(run("unit", "pass")));
    expect(t.push(gate(decision("baseline", "pass", "every check is green")))).toBeNull();
    const carried = t.takeCarried();
    expect(carried.map((s) => gateMeta(s)?.decision.gate)).toEqual(["baseline"]);
    expect(t.takeCarried()).toEqual([]);
  });
});

describe("GateCard", () => {
  it("shows the gate, the outcome, the reason and each run; a tail opens on click", () => {
    const t = new GateTracker();
    t.push(sensor(run("unit", "fail", ["FAIL src/promo.test.ts > rejects an expired code"])));
    t.push(sensor(run("lint", "pass")));
    const step = t.push(gate(decision("progress", "fail", "1 fast check is red: unit")));
    if (!step) throw new Error("no gate step");
    render(<AgentStepItem step={step} resultSteps={[]} />);
    expect(screen.getByTestId("gate-card").textContent).toMatch(/progress gate/);
    expect(screen.getByTestId("gate-outcome").textContent).toBe("fail");
    expect(screen.getByTestId("gate-reason").textContent).toBe("1 fast check is red: unit");
    expect(screen.getAllByTestId("gate-run-result").map((e) => e.textContent)).toEqual([
      "fail",
      "pass",
    ]);
    expect(screen.queryByTestId("gate-run-tail")).toBeNull();
    fireEvent.click(screen.getByText("unit"));
    expect(screen.getByTestId("gate-run-tail").textContent).toMatch(/rejects an expired code/);
  });

  it("a pause shows as a pause", () => {
    const meta = {
      entryId: "e",
      decision: decision("red-first", "pause", "the tests pass"),
      runs: [],
      evidenceFile: "",
    };
    render(<GateCard meta={meta} />);
    expect(screen.getByTestId("gate-outcome").textContent).toBe("pause");
  });
});
