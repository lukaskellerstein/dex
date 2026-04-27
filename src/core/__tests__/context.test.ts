import test from "node:test";
import assert from "node:assert/strict";
import { createContext, type OrchestrationContext, type RunState } from "../context.ts";

// Minimal fakes — context.ts is a pure builder, so we only need a shape that
// satisfies the interface, not actual runner / logger / emit behaviour.
const fakeRunner = {} as unknown as OrchestrationContext["runner"];
const fakeRlog = {} as unknown as OrchestrationContext["rlog"];
const noop: OrchestrationContext["emit"] = () => {};
const baseState: RunState = {
  runId: "test-run",
  projectDir: "/tmp/dex-test",
  specDir: "",
  mode: "loop",
  model: "claude-opus-4-6",
  agentRunId: "",
  taskPhaseNumber: 0,
  taskPhaseName: "",
};

test("createContext: returns a value with all required fields", () => {
  const abort = new AbortController();
  const released: { count: number } = { count: 0 };
  const ctx = createContext({
    abort,
    runner: fakeRunner,
    state: { ...baseState },
    projectDir: "/tmp/dex-test",
    releaseLock: async () => {
      released.count += 1;
    },
    emit: noop,
    rlog: fakeRlog,
  });

  assert.equal(ctx.abort, abort, "abort should be the same instance");
  assert.equal(ctx.runner, fakeRunner, "runner threaded through");
  assert.equal(ctx.projectDir, "/tmp/dex-test", "projectDir threaded through");
  assert.equal(ctx.emit, noop, "emit threaded through");
  assert.equal(ctx.rlog, fakeRlog, "rlog threaded through");
  assert.equal(ctx.state.runId, "test-run", "state threaded through");
});

test("createContext: pendingQuestion starts empty", () => {
  const ctx = createContext({
    abort: new AbortController(),
    runner: fakeRunner,
    state: { ...baseState },
    projectDir: "/tmp/dex-test",
    releaseLock: async () => {},
    emit: noop,
    rlog: fakeRlog,
  });

  assert.equal(ctx.pendingQuestion.promise, null);
  assert.equal(ctx.pendingQuestion.resolve, null);
  assert.equal(ctx.pendingQuestion.requestId, null);
});

test("createContext: state field is mutable (mirrors orchestrator.ts:380 mutation pattern)", () => {
  const initialState: RunState = { ...baseState, agentRunId: "" };
  const ctx = createContext({
    abort: new AbortController(),
    runner: fakeRunner,
    state: initialState,
    projectDir: "/tmp/dex-test",
    releaseLock: async () => {},
    emit: noop,
    rlog: fakeRlog,
  });

  // The orchestrator updates ctx.state.X = Y after each phase boundary.
  ctx.state.agentRunId = "phase-1";
  ctx.state.taskPhaseNumber = 1;
  assert.equal(ctx.state.agentRunId, "phase-1");
  assert.equal(initialState.agentRunId, "phase-1", "state object identity preserved — mutations visible through both refs");
});

test("createContext: abort signal flows through ctx", () => {
  const abort = new AbortController();
  const ctx = createContext({
    abort,
    runner: fakeRunner,
    state: { ...baseState },
    projectDir: "/tmp/dex-test",
    releaseLock: async () => {},
    emit: noop,
    rlog: fakeRlog,
  });

  assert.equal(ctx.abort.signal.aborted, false);
  abort.abort();
  assert.equal(ctx.abort.signal.aborted, true, "external abort visible through ctx.abort.signal");
});

test("createContext: releaseLock is callable and awaitable", async () => {
  let count = 0;
  const ctx = createContext({
    abort: new AbortController(),
    runner: fakeRunner,
    state: { ...baseState },
    projectDir: "/tmp/dex-test",
    releaseLock: async () => {
      count += 1;
    },
    emit: noop,
    rlog: fakeRlog,
  });

  await ctx.releaseLock();
  await ctx.releaseLock();
  assert.equal(count, 2);
});
