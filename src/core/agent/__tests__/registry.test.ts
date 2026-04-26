import test from "node:test";
import assert from "node:assert/strict";
import {
  registerAgent,
  createAgentRunner,
  getRegisteredAgents,
  UnknownAgentError,
  __clearRegistryForTests,
} from "../registry.ts";
import type { AgentRunner } from "../AgentRunner.ts";
import type { RunConfig } from "../../types.ts";

function stubConfig(): RunConfig {
  return {
    projectDir: "/tmp/test",
    specDir: "specs/x",
    mode: "loop",
    model: "claude-sonnet-4-6",
    maxIterations: 1,
    maxTurns: 1,
    taskPhases: "all",
  };
}

function makeStubRunner(): AgentRunner {
  return {
    runStep: async () => ({
      cost: 0, durationMs: 0, structuredOutput: null, result: "",
      inputTokens: 0, outputTokens: 0, sessionId: null,
    }),
    runTaskPhase: async () => ({
      cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
    }),
  };
}

test("registry: register factory, createAgentRunner returns an instance", () => {
  __clearRegistryForTests();
  const stub = makeStubRunner();
  registerAgent("stub", () => stub);
  const runner = createAgentRunner("stub", stubConfig(), "/tmp/test");
  assert.equal(runner, stub);
});

test("registry: createAgentRunner throws UnknownAgentError listing registered names", () => {
  __clearRegistryForTests();
  registerAgent("stub-a", () => makeStubRunner());
  registerAgent("stub-b", () => makeStubRunner());
  try {
    createAgentRunner("nope", stubConfig(), "/tmp/test");
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof UnknownAgentError);
    const msg = (err as Error).message;
    assert.match(msg, /stub-a/);
    assert.match(msg, /stub-b/);
    assert.match(msg, /nope/);
  }
});

test("registry: UnknownAgentError on empty registry mentions none registered", () => {
  __clearRegistryForTests();
  try {
    createAgentRunner("anything", stubConfig(), "/tmp/test");
    assert.fail("expected throw");
  } catch (err) {
    assert.ok(err instanceof UnknownAgentError);
    assert.match((err as Error).message, /No agents registered/);
  }
});

test("registry: registerAgent rejects empty name", () => {
  __clearRegistryForTests();
  assert.throws(
    () => registerAgent("", () => makeStubRunner()),
    /name must be a non-empty string/,
  );
});

test("registry: registerAgent is idempotent for same factory reference", () => {
  __clearRegistryForTests();
  const factory = () => makeStubRunner();
  registerAgent("claude", factory);
  registerAgent("claude", factory); // should not throw
  assert.deepEqual([...getRegisteredAgents()].sort(), ["claude"]);
});

test("registry: registerAgent throws when registering a different factory under an existing name", () => {
  __clearRegistryForTests();
  registerAgent("claude", () => makeStubRunner());
  assert.throws(
    () => registerAgent("claude", () => makeStubRunner()),
    /already registered with a different factory/,
  );
});

test("registry: getRegisteredAgents returns all registered names", () => {
  __clearRegistryForTests();
  registerAgent("a", () => makeStubRunner());
  registerAgent("b", () => makeStubRunner());
  registerAgent("c", () => makeStubRunner());
  assert.deepEqual([...getRegisteredAgents()].sort(), ["a", "b", "c"]);
});
