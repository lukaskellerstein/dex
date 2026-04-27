import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";
import type { OrchestratorEvent, AgentStep, SubagentInfo } from "../../../core/types.js";

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

import { useLiveTrace, labelForStep } from "../useLiveTrace.js";

function emit(event: OrchestratorEvent) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  act(() => {
    dispatchedHandler!(event);
  });
}

function makeRef<T>(initial: T): MutableRefObject<T> {
  return { current: initial };
}

beforeEach(() => {
  dispatchedHandler = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useLiveTrace", () => {
  it("initializes with empty trace state", () => {
    const viewingHistoricalRef = makeRef(false);
    const modeRef = makeRef<string | null>(null);
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    expect(result.current.liveSteps).toEqual([]);
    expect(result.current.subagents).toEqual([]);
    expect(result.current.currentPhase).toBeNull();
    expect(result.current.currentPhaseTraceId).toBeNull();
    expect(result.current.latestAction).toBeNull();
  });

  it("agent_step appends to liveSteps when not viewing historical", () => {
    const viewingHistoricalRef = makeRef(false);
    const modeRef = makeRef<string | null>("loop");
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    const step: AgentStep = {
      id: "s-1",
      sequenceIndex: 0,
      type: "tool_call",
      content: null,
      metadata: { toolName: "Bash" },
      durationMs: null,
      tokenCount: null,
      createdAt: new Date().toISOString(),
    };
    emit({ type: "agent_step", agentStep: step });
    expect(result.current.liveSteps).toHaveLength(1);
    expect(result.current.liveSteps[0].id).toBe("s-1");
  });

  it("agent_step is dropped when viewing historical", () => {
    const viewingHistoricalRef = makeRef(true);
    const modeRef = makeRef<string | null>("loop");
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    const step: AgentStep = {
      id: "s-x",
      sequenceIndex: 0,
      type: "text",
      content: "hi",
      metadata: null,
      durationMs: null,
      tokenCount: null,
      createdAt: new Date().toISOString(),
    };
    emit({ type: "agent_step", agentStep: step });
    expect(result.current.liveSteps).toHaveLength(0);
  });

  it("step_started resets liveSteps/subagents and sets currentPhase to loop:<step>", () => {
    const viewingHistoricalRef = makeRef(false);
    const modeRef = makeRef<string | null>("loop");
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    // seed something
    act(() => {
      result.current.setLiveSteps([
        {
          id: "old",
          sequenceIndex: 0,
          type: "text",
          content: null,
          metadata: null,
          durationMs: null,
          tokenCount: null,
          createdAt: "",
        },
      ]);
    });
    expect(result.current.liveSteps).toHaveLength(1);

    emit({
      type: "step_started",
      runId: "r-1",
      cycleNumber: 1,
      step: "specify",
      agentRunId: "ar-2",
    });
    expect(result.current.liveSteps).toEqual([]);
    expect(result.current.subagents).toEqual([]);
    expect(result.current.currentPhase?.name).toBe("loop:specify");
    expect(result.current.currentPhaseTraceId).toBe("ar-2");
    expect(result.current.livePhaseTraceIdRef.current).toBe("ar-2");
  });

  it("subagent_started + subagent_completed track lifecycle", () => {
    const viewingHistoricalRef = makeRef(false);
    const modeRef = makeRef<string | null>("loop");
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    const sub: SubagentInfo = {
      id: "sub-1",
      subagentId: "sub-1",
      subagentType: "general-purpose",
      description: "search the codebase",
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    emit({ type: "subagent_started", info: sub });
    expect(result.current.subagents).toHaveLength(1);
    expect(result.current.subagents[0].completedAt).toBeNull();

    emit({ type: "subagent_completed", subagentId: "sub-1" });
    expect(result.current.subagents[0].completedAt).not.toBeNull();
  });

  it("run_completed clears currentPhase + currentPhaseTraceId", () => {
    const viewingHistoricalRef = makeRef(false);
    const modeRef = makeRef<string | null>("loop");
    const { result } = renderHook(() => useLiveTrace({ viewingHistoricalRef, modeRef }));
    emit({ type: "step_started", runId: "r", cycleNumber: 1, step: "plan", agentRunId: "ar" });
    expect(result.current.currentPhase).not.toBeNull();
    emit({
      type: "run_completed",
      totalCost: 1,
      totalDuration: 100,
      taskPhasesCompleted: 1,
      branchName: "b",
      prUrl: null,
    });
    expect(result.current.currentPhase).toBeNull();
    expect(result.current.currentPhaseTraceId).toBeNull();
  });
});

describe("labelForStep", () => {
  it("labels tool_call with the tool name from metadata", () => {
    const step: AgentStep = {
      id: "x", sequenceIndex: 0, type: "tool_call", content: null,
      metadata: { toolName: "Read" }, durationMs: null, tokenCount: null, createdAt: "",
    };
    expect(labelForStep(step)).toBe("Read");
  });

  it("labels subagent_spawn with truncated description", () => {
    const step: AgentStep = {
      id: "x", sequenceIndex: 0, type: "subagent_spawn", content: null,
      metadata: { description: "search for all usages" }, durationMs: null, tokenCount: null, createdAt: "",
    };
    expect(labelForStep(step)).toBe("Task: search for all usages");
  });

  it("returns null for unknown step types (not 'live indicator' material)", () => {
    const step: AgentStep = {
      id: "x", sequenceIndex: 0, type: "tool_result", content: "ok",
      metadata: null, durationMs: null, tokenCount: null, createdAt: "",
    };
    expect(labelForStep(step)).toBeNull();
  });
});
