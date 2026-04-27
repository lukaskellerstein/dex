import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OrchestratorEvent } from "../../../core/types.js";

type EventHandler = (event: OrchestratorEvent) => void;

let dispatchedHandler: EventHandler | null = null;
const answerQuestionMock = vi.fn();

vi.mock("../../services/orchestratorService.js", () => ({
  orchestratorService: {
    subscribeEvents: (handler: EventHandler) => {
      dispatchedHandler = handler;
      return () => {
        dispatchedHandler = null;
      };
    },
    answerQuestion: (...args: unknown[]) => answerQuestionMock(...args),
  },
}));

import { useUserQuestion } from "../useUserQuestion.js";

function emit(event: OrchestratorEvent) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  act(() => {
    dispatchedHandler!(event);
  });
}

beforeEach(() => {
  dispatchedHandler = null;
  answerQuestionMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useUserQuestion", () => {
  it("initializes with no question and isClarifying=false", () => {
    const { result } = renderHook(() => useUserQuestion());
    expect(result.current.pendingQuestion).toBeNull();
    expect(result.current.isClarifying).toBe(false);
  });

  it("clarification_started flips isClarifying true; clarification_completed flips false", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({ type: "clarification_started", runId: "r-1" });
    expect(result.current.isClarifying).toBe(true);
    emit({ type: "clarification_completed", runId: "r-1", fullPlanPath: "/p/GOAL_clarified.md" });
    expect(result.current.isClarifying).toBe(false);
  });

  it("user_input_request stores pendingQuestion; user_input_response clears it", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({
      type: "user_input_request",
      runId: "r-1",
      requestId: "req-1",
      questions: [{ question: "Database?", options: [{ label: "Postgres", value: "pg" }] }],
    });
    expect(result.current.pendingQuestion).toMatchObject({
      requestId: "req-1",
      questions: [{ question: "Database?" }],
    });

    emit({
      type: "user_input_response",
      requestId: "req-1",
      answers: { Database: "Postgres" },
    });
    expect(result.current.pendingQuestion).toBeNull();
  });

  it("answerQuestion calls orchestratorService.answerQuestion AND clears pendingQuestion", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({
      type: "user_input_request",
      runId: "r-1",
      requestId: "req-1",
      questions: [{ question: "Stack?", options: [] }],
    });
    expect(result.current.pendingQuestion).not.toBeNull();

    act(() => {
      result.current.answerQuestion("req-1", { Stack: "Node" });
    });
    expect(answerQuestionMock).toHaveBeenCalledWith("req-1", { Stack: "Node" });
    expect(result.current.pendingQuestion).toBeNull();
  });

  it("run_started clears both isClarifying and pendingQuestion", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({ type: "clarification_started", runId: "r-1" });
    emit({
      type: "user_input_request",
      runId: "r-1",
      requestId: "req-1",
      questions: [],
    });
    expect(result.current.isClarifying).toBe(true);
    expect(result.current.pendingQuestion).not.toBeNull();
    emit({
      type: "run_started",
      config: { projectDir: "/p", specDir: "", mode: "loop", model: "claude-opus-4-6", maxIterations: 1, maxTurns: 1, taskPhases: "all" },
      runId: "r-2",
      branchName: "b",
    });
    expect(result.current.isClarifying).toBe(false);
    expect(result.current.pendingQuestion).toBeNull();
  });
});
