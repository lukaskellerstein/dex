import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../../../core/run-snapshot.js";
import type { OrchestratorEvent } from "../../../core/types.js";

type EventHandler = (event: OrchestratorEvent) => void;

let dispatchedHandler: EventHandler | null = null;
const getRunSnapshotMock = vi.fn();

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

vi.mock("../../services/projectService.js", () => ({
  projectService: { getRunSnapshot: (dir: string) => getRunSnapshotMock(dir) },
}));

import { queueProgress, startActionFor, useRunSnapshot } from "../useRunSnapshot.js";

function snapshot(stage: string): RunSnapshot {
  return {
    state: null,
    queue: {
      kind: "existing",
      entries: [
        {
          id: "001-a",
          title: "A",
          status: "active",
          nextStage: stage as "plan",
          reason: "r",
          taskPhase: null,
          costUsd: 0,
        },
      ],
    },
    errors: [],
    digests: [],
  };
}

const nextStage = (s: RunSnapshot | null) => s?.queue?.entries[0]?.nextStage;

/** Only the type matters to the hook, so the tests send bare events. */
async function emit(event: { type: string }) {
  if (!dispatchedHandler) throw new Error("no handler subscribed");
  await act(async () => {
    dispatchedHandler!(event as unknown as OrchestratorEvent);
  });
}

const BOUNDARIES = [
  "run_started",
  "step_started",
  "step_completed",
  "paused",
  "run_completed",
  "loop_terminated",
];

beforeEach(() => {
  dispatchedHandler = null;
  getRunSnapshotMock.mockReset().mockResolvedValue(snapshot("specify"));
});

describe("useRunSnapshot", () => {
  it("fetches the snapshot for the project on mount", async () => {
    const { result } = renderHook(() => useRunSnapshot("/p"));
    await waitFor(() => expect(nextStage(result.current.snapshot)).toBe("specify"));
    expect(getRunSnapshotMock).toHaveBeenCalledWith("/p");
  });

  it("fetches nothing without a project", () => {
    const { result } = renderHook(() => useRunSnapshot(null));
    expect(result.current.snapshot).toBeNull();
    expect(getRunSnapshotMock).not.toHaveBeenCalled();
  });

  it("fetches again on every stage-boundary event", async () => {
    const { result } = renderHook(() => useRunSnapshot("/p"));
    await waitFor(() => expect(getRunSnapshotMock).toHaveBeenCalledTimes(1));
    for (const [i, type] of BOUNDARIES.entries()) {
      getRunSnapshotMock.mockResolvedValueOnce(snapshot(`stage-${i}`));
      await emit({ type });
      await waitFor(() => expect(nextStage(result.current.snapshot)).toBe(`stage-${i}`));
    }
    expect(getRunSnapshotMock).toHaveBeenCalledTimes(1 + BOUNDARIES.length);
  });

  it("ignores the live trace: agent_step and subagent events fetch nothing", async () => {
    renderHook(() => useRunSnapshot("/p"));
    await waitFor(() => expect(getRunSnapshotMock).toHaveBeenCalledTimes(1));
    await emit({ type: "agent_step" });
    await emit({ type: "subagent_started" });
    await emit({ type: "user_input_request" });
    expect(getRunSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the last snapshot when a fetch fails", async () => {
    const { result } = renderHook(() => useRunSnapshot("/p"));
    await waitFor(() => expect(nextStage(result.current.snapshot)).toBe("specify"));
    getRunSnapshotMock.mockRejectedValueOnce(new Error("ipc down"));
    await emit({ type: "step_completed" });
    await waitFor(() => expect(getRunSnapshotMock).toHaveBeenCalledTimes(2));
    expect(nextStage(result.current.snapshot)).toBe("specify");
  });

  it("a slow older fetch never overwrites a newer one", async () => {
    let resolveSlow: (s: RunSnapshot) => void = () => {};
    getRunSnapshotMock.mockReset();
    getRunSnapshotMock.mockReturnValueOnce(new Promise<RunSnapshot>((r) => (resolveSlow = r)));
    getRunSnapshotMock.mockResolvedValueOnce(snapshot("tasks"));
    const { result } = renderHook(() => useRunSnapshot("/p"));
    await emit({ type: "step_started" });
    await waitFor(() => expect(nextStage(result.current.snapshot)).toBe("tasks"));
    await act(async () => resolveSlow(snapshot("specify")));
    expect(nextStage(result.current.snapshot)).toBe("tasks");
  });

  it("refresh() fetches on demand", async () => {
    const { result } = renderHook(() => useRunSnapshot("/p"));
    await waitFor(() => expect(getRunSnapshotMock).toHaveBeenCalledTimes(1));
    getRunSnapshotMock.mockResolvedValueOnce(snapshot("plan"));
    await act(async () => result.current.refresh());
    expect(nextStage(result.current.snapshot)).toBe("plan");
  });
});

describe("startActionFor", () => {
  const entry = (status: "active" | "pending" | "done") => ({
    id: "001-a",
    title: "A",
    status,
    nextStage: null,
    reason: "r",
    taskPhase: null,
    costUsd: 0,
  });
  const snap = (over: Partial<RunSnapshot>): RunSnapshot => ({
    state: null,
    queue: null,
    errors: [],
    digests: [],
    ...over,
  });
  const state = (status: "paused" | "completed", descriptionFile?: string) =>
    ({
      status,
      config: {
        model: "m",
        maxTurns: 1,
        maxIterations: 1,
        ...(descriptionFile ? { descriptionFile } : {}),
      },
    }) as RunSnapshot["state"];
  const queue = (...entries: ReturnType<typeof entry>[]) => ({
    kind: "existing" as const,
    entries,
  });

  it("refuses on a validation error, and does nothing without a snapshot", () => {
    expect(startActionFor(null, 3)).toBe("none");
    expect(startActionFor(snap({ errors: ["bad policy"], queue: queue(entry("active")) }), 3)).toBe(
      "none",
    );
  });

  it("with a queue: Resume when paused or when a run state exists; start the loop otherwise; nothing when all done", () => {
    expect(startActionFor(snap({ queue: queue(entry("done")), state: state("paused") }), 0)).toBe(
      "resume",
    );
    expect(
      startActionFor(snap({ queue: queue(entry("active")), state: state("completed") }), 0),
    ).toBe("resume");
    expect(startActionFor(snap({ queue: queue(entry("pending")) }), 0)).toBe("start-loop");
    expect(
      startActionFor(snap({ queue: queue(entry("done")), state: state("completed") }), 5),
    ).toBe("none");
  });

  it("without a queue: a new project's run resumes; spec folders run in build mode", () => {
    expect(startActionFor(snap({ state: state("paused", "/p/GOAL.md") }), 0)).toBe("resume");
    expect(startActionFor(snap({ state: state("completed") }), 2)).toBe("build");
    expect(startActionFor(snap({}), 0)).toBe("none");
  });
});

describe("queueProgress", () => {
  const row = (id: string, status: "done" | "active" | "pending" | "skipped") => ({
    id,
    title: id,
    status,
    nextStage: null,
    reason: "r",
    taskPhase: null,
    costUsd: 0,
  });

  it("counts the queue's entries: skipped ones do not run, pending ones are the cycles still to come", () => {
    const snapshot: RunSnapshot = {
      state: null,
      errors: [],
      digests: [],
      queue: {
        kind: "new",
        entries: [
          row("001-a", "done"),
          row("002-b", "active"),
          row("003-c", "pending"),
          row("004-d", "skipped"),
        ],
      },
    };
    expect(queueProgress(snapshot)).toEqual({ done: 1, total: 3, pending: 1 });
  });

  it("is null without a queue", () => {
    expect(queueProgress(null)).toBeNull();
    expect(queueProgress({ state: null, queue: null, errors: [], digests: [] })).toBeNull();
  });
});
