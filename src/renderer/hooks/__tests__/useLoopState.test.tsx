import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OrchestratorEvent, RunConfig } from "../../../core/types.js";

type EventHandler = (event: OrchestratorEvent) => void;

let dispatchedHandler: EventHandler | null = null;

vi.mock("../../services/orchestratorService.js", () => ({
  orchestratorService: {
    subscribeEvents: (handler: EventHandler) => {
      dispatchedHandler = handler;
      return () => {
        dispatchedHandler = null;
      };
    },
  },
}));

import { useLoopState } from "../useLoopState.js";

function emit(event: OrchestratorEvent) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  act(() => {
    dispatchedHandler!(event);
  });
}

const baseConfig: RunConfig = {
  projectDir: "/p",
  specDir: "",
  mode: "loop",
  model: "claude-opus-4-6",
  maxIterations: 50,
  maxTurns: 75,
  taskPhases: "all",
};

beforeEach(() => {
  dispatchedHandler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useLoopState", () => {
  it("initializes with empty cycle/stage state", () => {
    const { result } = renderHook(() => useLoopState());
    expect(result.current.preCycleStages).toEqual([]);
    expect(result.current.loopCycles).toEqual([]);
    expect(result.current.currentCycle).toBeNull();
    expect(result.current.currentStage).toBeNull();
    expect(result.current.totalCost).toBe(0);
    expect(result.current.loopTermination).toBeNull();
  });

  it("run_started clears all loop state and captures mode", () => {
    const { result } = renderHook(() => useLoopState());
    // Pre-seed something to confirm clearing.
    act(() => {
      result.current.setLoopCycles([{ cycleNumber: 99, featureName: "x", specDir: null, decision: null, status: "running", costUsd: 0, stages: [], implementPhases: [], startedAt: "" }]);
      result.current.setTotalCost(42);
    });
    expect(result.current.loopCycles.length).toBe(1);

    emit({
      type: "run_started",
      config: baseConfig,
      runId: "r-1",
      branchName: "dex/foo",
    });
    expect(result.current.loopCycles).toEqual([]);
    expect(result.current.preCycleStages).toEqual([]);
    expect(result.current.totalCost).toBe(0);
    expect(result.current.loopTermination).toBeNull();
  });

  it("loop_cycle_started inserts a running cycle with the cycleNumber", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({ type: "loop_cycle_started", runId: "r-1", cycleNumber: 1 });
    expect(result.current.currentCycle).toBe(1);
    expect(result.current.loopCycles).toHaveLength(1);
    expect(result.current.loopCycles[0]).toMatchObject({
      cycleNumber: 1,
      status: "running",
      stages: [],
      implementPhases: [],
    });
  });

  it("loop_cycle_completed maps decision=stopped to status=running (legacy contract)", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({ type: "loop_cycle_started", runId: "r-1", cycleNumber: 1 });
    emit({
      type: "loop_cycle_completed",
      runId: "r-1",
      cycleNumber: 1,
      decision: "stopped",
      featureName: "Auth",
      specDir: "specs/001-auth",
      costUsd: 0.5,
    });
    // "stopped" → "running" preserves the paused-renders-as-running invariant.
    expect(result.current.loopCycles[0].status).toBe("running");
    expect(result.current.loopCycles[0].decision).toBe("stopped");
    expect(result.current.loopCycles[0].featureName).toBe("Auth");
  });

  it("step_started inserts pre-cycle stages when cycleNumber=0", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "step_started",
      runId: "r-1",
      cycleNumber: 0,
      step: "clarification",
      agentRunId: "ar-1",
    });
    expect(result.current.preCycleStages).toHaveLength(1);
    expect(result.current.preCycleStages[0]).toMatchObject({
      type: "clarification",
      status: "running",
      agentRunId: "ar-1",
    });
    expect(result.current.currentStage).toBe("clarification");
  });

  it("step_completed accumulates totalCost and updates the matching stage", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({ type: "step_started", runId: "r-1", cycleNumber: 0, step: "specify", agentRunId: "ar-1" });
    emit({
      type: "step_completed",
      runId: "r-1",
      cycleNumber: 0,
      step: "specify",
      agentRunId: "ar-1",
      costUsd: 0.25,
      durationMs: 1000,
    });
    expect(result.current.totalCost).toBe(0.25);
    expect(result.current.preCycleStages[0]).toMatchObject({
      status: "completed",
      costUsd: 0.25,
      durationMs: 1000,
    });
  });

  it("loop_terminated with reason=user_abort is ignored (paused, not terminal)", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "loop_terminated",
      runId: "r-1",
      termination: {
        reason: "user_abort",
        cyclesCompleted: 1,
        featuresCompleted: [],
        featuresSkipped: [],
        totalCostUsd: 0,
        totalDurationMs: 0,
      },
    });
    expect(result.current.loopTermination).toBeNull();
  });

  it("loop_terminated with reason=gaps_complete sets termination", () => {
    const { result } = renderHook(() => useLoopState());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "loop_terminated",
      runId: "r-1",
      termination: {
        reason: "gaps_complete",
        cyclesCompleted: 3,
        featuresCompleted: ["A", "B", "C"],
        featuresSkipped: [],
        totalCostUsd: 1.5,
        totalDurationMs: 5000,
      },
    });
    expect(result.current.loopTermination?.reason).toBe("gaps_complete");
    expect(result.current.loopTermination?.featuresCompleted).toEqual(["A", "B", "C"]);
  });
});
