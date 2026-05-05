import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockAgentRunner } from "../MockAgentRunner.ts";
import { mockConfigPath } from "../MockConfig.ts";
import type { OneShotContext } from "../AgentRunner.ts";
import type { RunConfig, AgentStep, OrchestratorEvent } from "../../types.ts";

const VALID_BASE = {
  enabled: true,
  fixtureDir: "/abs/fixtures",
  prerequisites: { prerequisites: { delay: 0 } },
  clarification: {
    clarification_product: { delay: 0 },
    clarification_technical: { delay: 0 },
    clarification_synthesis: { delay: 0 },
    constitution: { delay: 0 },
    manifest_extraction: { delay: 0 },
  },
  dex_loop: {
    cycles: [
      {
        feature: { id: "f1", title: "feat-1" },
        stages: {
          gap_analysis: { delay: 0 },
          specify: { delay: 0 },
          plan: { delay: 0 },
          tasks: { delay: 0 },
          implement: { delay: 0 },
          verify: { delay: 0 },
          learnings: { delay: 0 },
        },
      },
    ],
  },
  completion: { completion: { delay: 0 } },
};

function mkProject(extraConfig: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-1shot-"));
  const cfg = { ...VALID_BASE, ...extraConfig };
  const p = mockConfigPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg));
  return dir;
}

function rmTmp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeCtx(projectDir: string, prompt: string, overrides: Partial<OneShotContext> = {}): OneShotContext {
  const events: OrchestratorEvent[] = [];
  const runConfig: RunConfig = {
    projectDir,
    runId: "test-run",
    mode: "loop",
    model: "claude-test",
    specDir: "specs/test",
    maxTurns: 5,
    maxIterations: 5,
    autoClarification: false,
  } as unknown as RunConfig;
  return {
    config: runConfig,
    prompt,
    abortController: null,
    emit: (e: OrchestratorEvent) => events.push(e),
    rlog: {
      run: () => {}, agentRun: () => {}, subagentEvent: () => {},
    } as unknown as OneShotContext["rlog"],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

test("runOneShot: matches scripted exact-match response", async () => {
  const dir = mkProject({
    oneShotResponses: [
      {
        matchPrompt: "hello",
        finalText: "world",
        cost: 0.123,
        inputTokens: 10,
        outputTokens: 5,
      },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "hello"));
    assert.equal(r.finalText, "world");
    assert.equal(r.cost, 0.123);
    assert.equal(r.inputTokens, 10);
    assert.equal(r.outputTokens, 5);
    assert.equal(r.finishedNormally, true);
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: matches scripted regex response", async () => {
  const dir = mkProject({
    oneShotResponses: [
      {
        matchPrompt: "merge conflict.*<<<<<<<",
        isRegex: true,
        finalText: "resolved",
      },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(
      makeCtx(dir, "Please resolve this merge conflict in foo.ts:\n<<<<<<< HEAD"),
    );
    assert.equal(r.finalText, "resolved");
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: applies editFile side effect to cwd", async () => {
  const dir = mkProject({
    oneShotResponses: [
      {
        matchPrompt: "edit foo",
        finalText: "done",
        editFile: { path: "foo.txt", content: "new contents\n" },
      },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    await runner.runOneShot(makeCtx(dir, "edit foo", { cwd: dir }));
    const written = fs.readFileSync(path.join(dir, "foo.txt"), "utf-8");
    assert.equal(written, "new contents\n");
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: editFile creates intermediate dirs", async () => {
  const dir = mkProject({
    oneShotResponses: [
      {
        matchPrompt: "edit nested",
        finalText: "done",
        editFile: { path: "nested/deeper/foo.txt", content: "x\n" },
      },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    await runner.runOneShot(makeCtx(dir, "edit nested", { cwd: dir }));
    assert.equal(fs.existsSync(path.join(dir, "nested/deeper/foo.txt")), true);
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: returns permissive default when no entry matches", async () => {
  const dir = mkProject({ oneShotResponses: [] });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "anything"));
    assert.match(r.finalText, /mock default/);
    assert.equal(r.finishedNormally, true);
    assert.equal(r.cost, 0);
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: returns permissive default when oneShotResponses unset", async () => {
  const dir = mkProject(); // no oneShotResponses key at all
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "anything"));
    assert.equal(r.finishedNormally, true);
    assert.match(r.finalText, /mock default/);
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: honours finishedNormally:false override (agent gave up)", async () => {
  const dir = mkProject({
    oneShotResponses: [
      { matchPrompt: "give up", finalText: "I cannot", finishedNormally: false },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "give up"));
    assert.equal(r.finishedNormally, false);
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: aborted controller short-circuits to finishedNormally:false", async () => {
  const dir = mkProject({
    oneShotResponses: [{ matchPrompt: "hi", finalText: "hello" }],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const ac = new AbortController();
    ac.abort();
    const r = await runner.runOneShot(makeCtx(dir, "hi", { abortController: ac }));
    assert.equal(r.finishedNormally, false);
    assert.equal(r.finalText, "");
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: first matching entry wins (order-sensitive)", async () => {
  const dir = mkProject({
    oneShotResponses: [
      { matchPrompt: "x", finalText: "first" },
      { matchPrompt: "x", finalText: "second" },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "x"));
    assert.equal(r.finalText, "first");
  } finally {
    rmTmp(dir);
  }
});

test("runOneShot: bad regex source is skipped silently (treated as non-match)", async () => {
  const dir = mkProject({
    oneShotResponses: [
      { matchPrompt: "[", isRegex: true, finalText: "should not match" },
      { matchPrompt: "fallback", finalText: "ok" },
    ],
  });
  try {
    const runner = new MockAgentRunner({} as RunConfig, dir);
    const r = await runner.runOneShot(makeCtx(dir, "fallback"));
    assert.equal(r.finalText, "ok");
  } finally {
    rmTmp(dir);
  }
});
