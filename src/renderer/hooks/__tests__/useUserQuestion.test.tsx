import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorEvent } from "../../../core/types.js";

type EventHandler = (event: OrchestratorEvent) => void;

let dispatchedHandler: EventHandler | null = null;
const answerRequestMock = vi.fn();
const getRunStateMock = vi.fn();
const getProjectStateMock = vi.fn();

vi.mock("../../services/orchestratorService.js", () => ({
  orchestratorService: {
    subscribeEvents: (handler: EventHandler) => {
      dispatchedHandler = handler;
      return () => {
        dispatchedHandler = null;
      };
    },
    answerRequest: (...args: unknown[]) => answerRequestMock(...args),
    getRunState: () => getRunStateMock(),
    getProjectState: (dir: string) => getProjectStateMock(dir),
  },
}));

import { useUserQuestion } from "../useUserQuestion.js";

function emit(event: OrchestratorEvent) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  act(() => {
    dispatchedHandler!(event);
  });
}

const APPROVAL: OrchestratorEvent = {
  type: "tool_approval_request",
  runId: "r-1",
  requestId: "req-2",
  toolName: "Bash",
  subject: "git push origin feature-x",
  input: { command: "git push origin feature-x" },
  source: "settings",
  reason: "projectSettings ask rule Bash(git push:*)",
};

beforeEach(() => {
  dispatchedHandler = null;
  answerRequestMock.mockReset();
  getRunStateMock.mockReset().mockResolvedValue(null);
  getProjectStateMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useUserQuestion", () => {
  it("initializes with no request and isClarifying=false", () => {
    const { result } = renderHook(() => useUserQuestion());
    expect(result.current.pendingRequest).toBeNull();
    expect(result.current.isClarifying).toBe(false);
  });

  it("clarification_started flips isClarifying true; clarification_completed flips false", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({ type: "clarification_started", runId: "r-1" });
    expect(result.current.isClarifying).toBe(true);
    emit({ type: "clarification_completed", runId: "r-1", fullPlanPath: "/p/GOAL_clarified.md" });
    expect(result.current.isClarifying).toBe(false);
  });

  it("user_input_request holds a question; user_input_response for it clears it", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({
      type: "user_input_request",
      runId: "r-1",
      requestId: "req-1",
      questions: [
        {
          question: "Database?",
          header: "Database",
          multiSelect: false,
          options: [{ label: "Postgres", description: "Relational, default choice" }],
        },
      ],
    });
    expect(result.current.pendingRequest).toMatchObject({
      kind: "question",
      requestId: "req-1",
      questions: [{ question: "Database?" }],
    });

    emit({ type: "user_input_response", requestId: "other", answers: {} });
    expect(result.current.pendingRequest).not.toBeNull();
    emit({ type: "user_input_response", requestId: "req-1", answers: { Database: "Postgres" } });
    expect(result.current.pendingRequest).toBeNull();
  });

  it("answerQuestion sends a question answer through answer-request and clears the request", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({
      type: "user_input_request",
      runId: "r-1",
      requestId: "req-1",
      questions: [{ question: "Stack?", header: "Stack", multiSelect: false, options: [] }],
    });
    act(() => {
      result.current.answerQuestion("req-1", { Stack: "Node" });
    });
    expect(answerRequestMock).toHaveBeenCalledWith("req-1", {
      kind: "question",
      answers: { Stack: "Node" },
    });
    expect(result.current.pendingRequest).toBeNull();
  });

  it("tool_approval_request holds an approval; a deny carries the reason", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit(APPROVAL);
    expect(result.current.pendingRequest).toMatchObject({
      kind: "tool_approval",
      requestId: "req-2",
      toolName: "Bash",
      subject: "git push origin feature-x",
      source: "settings",
    });
    act(() => {
      result.current.answerToolApproval("req-2", "deny", "not today");
    });
    expect(answerRequestMock).toHaveBeenCalledWith("req-2", {
      kind: "tool_approval",
      decision: "deny",
      message: "not today",
    });
    expect(result.current.pendingRequest).toBeNull();
  });

  it("request_resolved elsewhere (CLI, Stop) clears the held request", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit(APPROVAL);
    emit({ type: "request_resolved", requestId: "req-2", by: "stop" });
    expect(result.current.pendingRequest).toBeNull();
  });

  it("restores a held approval from the live run's pending requests after a reload", async () => {
    getRunStateMock.mockResolvedValue({ projectDir: "/p", runId: "r-1" });
    getProjectStateMock.mockResolvedValue({
      pendingRequests: [
        {
          id: "p-1",
          entryId: null,
          askedAt: "t",
          kind: "pause",
          reason: "gate",
          detail: "",
          options: [],
        },
        {
          id: "req-9",
          entryId: "021-agent-entry",
          askedAt: "t",
          kind: "tool_approval",
          toolName: "Bash",
          subject: "kubectl apply -f x.yaml",
          input: { command: "kubectl apply -f x.yaml" },
          source: "policy",
          reason: "deploys need a human",
        },
      ],
    });
    const { result } = renderHook(() => useUserQuestion());
    await waitFor(() => expect(result.current.pendingRequest?.requestId).toBe("req-9"));
    expect(getProjectStateMock).toHaveBeenCalledWith("/p");
    expect(result.current.pendingRequest).toMatchObject({
      kind: "tool_approval",
      source: "policy",
    });
  });

  it("run_started clears both isClarifying and the held request", () => {
    const { result } = renderHook(() => useUserQuestion());
    emit({ type: "clarification_started", runId: "r-1" });
    emit({ type: "user_input_request", runId: "r-1", requestId: "req-1", questions: [] });
    expect(result.current.isClarifying).toBe(true);
    expect(result.current.pendingRequest).not.toBeNull();
    emit({
      type: "run_started",
      config: {
        projectDir: "/p",
        specDir: "",
        mode: "loop",
        model: "claude-opus-4-6",
        maxIterations: 1,
        maxTurns: 1,
        taskPhases: "all",
      },
      runId: "r-2",
      branchName: "b",
    });
    expect(result.current.isClarifying).toBe(false);
    expect(result.current.pendingRequest).toBeNull();
  });
});
