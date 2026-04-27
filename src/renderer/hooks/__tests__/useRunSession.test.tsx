import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OrchestratorEvent } from "../../../core/types.js";

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

import { useRunSession } from "../useRunSession.js";

function emit(event: OrchestratorEvent) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  act(() => {
    dispatchedHandler!(event);
  });
}

const baseConfig = {
  projectDir: "/p",
  specDir: "specs/001-foo",
  mode: "loop",
  model: "claude-opus-4-6",
  maxIterations: 50,
  maxTurns: 75,
  taskPhases: "all" as const,
};

beforeEach(() => {
  dispatchedHandler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRunSession", () => {
  it("initializes with all session metadata empty/false", () => {
    const { result } = renderHook(() => useRunSession());
    expect(result.current.mode).toBeNull();
    expect(result.current.isRunning).toBe(false);
    expect(result.current.currentRunId).toBeNull();
    expect(result.current.totalDuration).toBe(0);
    expect(result.current.activeSpecDir).toBeNull();
    expect(result.current.activeTask).toBeNull();
    expect(result.current.viewingHistorical).toBe(false);
  });

  it("run_started flips isRunning + sets runId/specDir/mode + clears viewingHistorical/totalDuration", () => {
    const { result } = renderHook(() => useRunSession());
    act(() => {
      result.current.setTotalDuration(999);
      result.current.setViewingHistorical(true);
    });
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    expect(result.current.isRunning).toBe(true);
    expect(result.current.currentRunId).toBe("r-1");
    expect(result.current.activeSpecDir).toBe("specs/001-foo");
    expect(result.current.mode).toBe("loop");
    expect(result.current.modeRef.current).toBe("loop");
    expect(result.current.totalDuration).toBe(0);
    expect(result.current.viewingHistorical).toBe(false);
  });

  it("run_completed flips isRunning false and freezes totalDuration to event total", () => {
    const { result } = renderHook(() => useRunSession());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    expect(result.current.isRunning).toBe(true);
    emit({
      type: "run_completed",
      totalCost: 1.25,
      totalDuration: 6000,
      taskPhasesCompleted: 4,
      branchName: "b",
      prUrl: "https://github.com/x/y/pull/1",
    });
    expect(result.current.isRunning).toBe(false);
    expect(result.current.totalDuration).toBe(6000);
    expect(result.current.activeSpecDir).toBeNull();
    expect(result.current.activeTask).toBeNull();
  });

  it("step_completed and task_phase_completed accumulate totalDuration", () => {
    const { result } = renderHook(() => useRunSession());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "step_completed",
      runId: "r-1", cycleNumber: 1, step: "specify", agentRunId: "ar-1",
      costUsd: 0.1, durationMs: 1000,
    });
    expect(result.current.totalDuration).toBe(1000);
    emit({
      type: "task_phase_completed",
      taskPhase: { number: 1, name: "Setup", purpose: "", tasks: [], status: "complete" },
      cost: 0.05,
      durationMs: 2500,
    });
    expect(result.current.totalDuration).toBe(3500);
  });

  it("tasks_updated extracts the in-progress task as activeTask", () => {
    const { result } = renderHook(() => useRunSession());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "tasks_updated",
      taskPhases: [
        {
          number: 1,
          name: "Setup",
          purpose: "",
          tasks: [
            { number: 1, description: "init", status: "done", parallel: false },
            { number: 2, description: "config", status: "in_progress", parallel: false },
          ],
          status: "partial",
        },
      ],
    });
    expect(result.current.activeTask).toMatchObject({
      number: 2,
      description: "config",
      status: "in_progress",
    });
  });

  it("setViewingHistorical flips both state AND ref", () => {
    const { result } = renderHook(() => useRunSession());
    expect(result.current.viewingHistoricalRef.current).toBe(false);
    act(() => result.current.setViewingHistorical(true));
    expect(result.current.viewingHistorical).toBe(true);
    expect(result.current.viewingHistoricalRef.current).toBe(true);
  });

  it("phase-scoped errors are NOT routed here (run-level only — no-op for now)", () => {
    const { result } = renderHook(() => useRunSession());
    emit({ type: "run_started", config: baseConfig, runId: "r-1", branchName: "b" });
    emit({
      type: "error",
      message: "manifest extraction failed",
      taskPhaseNumber: 5,
    });
    // No state change observable — error handler is a placeholder.
    expect(result.current.isRunning).toBe(true);
  });
});
