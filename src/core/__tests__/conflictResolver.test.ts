import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConflicts } from "../conflict-resolver.ts";
import type { ResolverContext, ResolverResult } from "../conflict-resolver.ts";
import { MockAgentRunner } from "../agent/MockAgentRunner.ts";
import { mockConfigPath, type MockOneShotResponse } from "../agent/MockConfig.ts";
import type { ConflictResolverConfig } from "../dexConfig.ts";
import type { RunConfig, OrchestratorEvent } from "../types.ts";

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

function mkProject(oneShotResponses: MockOneShotResponse[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-resolver-"));
  const cfg = { ...VALID_BASE, oneShotResponses };
  const p = mockConfigPath(dir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg));
  return dir;
}

function rmTmp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const RESOLVER_CFG: ConflictResolverConfig = {
  model: null,
  maxIterations: 5,
  maxTurnsPerIteration: 5,
  costCapUsd: 1.0,
  verifyCommand: null, // Skip verification by default for unit tests.
};

function makeCtx(
  projectDir: string,
  overrides: Partial<ResolverContext> = {},
): ResolverContext {
  const events: OrchestratorEvent[] = [];
  const runner = new MockAgentRunner({} as RunConfig, projectDir);
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
    projectDir,
    sourceBranch: "dex/test-source",
    conflictedPaths: [],
    runner,
    config: { ...RESOLVER_CFG },
    primaryCommitSubjects: [],
    sourceCommitSubjects: [],
    goalText: "",
    runConfig,
    emit: (e) => events.push(e),
    abortController: null,
    rlog: {
      run: () => {}, agentRun: () => {}, subagentEvent: () => {},
    } as unknown as ResolverContext["rlog"],
    ...overrides,
    // Carry the events array through metadata so tests can inspect it.
    ...({ _events: events } as object),
  } as ResolverContext;
}

function eventsOf(ctx: ResolverContext): OrchestratorEvent[] {
  return (ctx as unknown as { _events: OrchestratorEvent[] })._events;
}

function writeConflictedFile(projectDir: string, file: string): void {
  const abs = path.resolve(projectDir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(
    abs,
    `line A\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> source\nline B\n`,
    "utf-8",
  );
}

// ── Tests ────────────────────────────────────────────────

test("resolver: clean single-file resolution succeeds + emits expected event sequence", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "resolved",
      cost: 0.01,
      editFile: { path: "foo.txt", content: "merged content\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "foo.txt");
    const ctx = makeCtx(dir, { conflictedPaths: ["foo.txt"] });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.resolvedFiles, ["foo.txt"]);
      assert.equal(r.costUsd, 0.01);
    }
    // File no longer has markers.
    const content = fs.readFileSync(path.join(dir, "foo.txt"), "utf-8");
    assert.equal(/<<<<<<<|>>>>>>>/.test(content), false);
    // Event sequence: file-start → iteration → file-done → done
    const types = eventsOf(ctx).map((e) => e.type);
    assert.deepEqual(types, [
      "conflict-resolver:file-start",
      "conflict-resolver:iteration",
      "conflict-resolver:file-done",
      "conflict-resolver:done",
    ]);
  } finally {
    rmTmp(dir);
  }
});

test("resolver: multi-file — both succeed, file-start emitted once per file, done is terminal", async () => {
  const dir = mkProject([
    {
      matchPrompt: "Resolve the merge conflict in a\\.txt",
      isRegex: true,
      finalText: "ok",
      cost: 0.02,
      editFile: { path: "a.txt", content: "merged a\n" },
    },
    {
      matchPrompt: "Resolve the merge conflict in b\\.txt",
      isRegex: true,
      finalText: "ok",
      cost: 0.03,
      editFile: { path: "b.txt", content: "merged b\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    writeConflictedFile(dir, "b.txt");
    const ctx = makeCtx(dir, { conflictedPaths: ["a.txt", "b.txt"] });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.resolvedFiles, ["a.txt", "b.txt"]);
      assert.equal(r.costUsd, 0.05);
    }
    const types = eventsOf(ctx).map((e) => e.type);
    const fileStarts = types.filter((t) => t === "conflict-resolver:file-start").length;
    const fileDones = types.filter((t) => t === "conflict-resolver:file-done").length;
    assert.equal(fileStarts, 2);
    assert.equal(fileDones, 2);
    // Last event is the terminal done.
    assert.equal(types[types.length - 1], "conflict-resolver:done");
  } finally {
    rmTmp(dir);
  }
});

test("resolver: iteration counter increments globally (not per file)", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "ok",
      cost: 0.01,
      editFile: { path: "a.txt", content: "merged\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    writeConflictedFile(dir, "b.txt");
    // Second file's prompt won't match the regex (different filename), so the
    // mock falls back to permissive default which won't strip markers either.
    // The harness will then halt at b.txt with max_iterations.
    const ctx = makeCtx(dir, { conflictedPaths: ["a.txt", "b.txt"] });
    const r = await resolveConflicts(ctx);
    // b.txt fails because the mock didn't strip its markers.
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "max_iterations");
    }
    const iterations = eventsOf(ctx).filter(
      (e) => e.type === "conflict-resolver:iteration",
    ) as Array<{ n: number }>;
    assert.equal(iterations.length, 2);
    assert.equal(iterations[0].n, 1);
    assert.equal(iterations[1].n, 2);
  } finally {
    rmTmp(dir);
  }
});

test("resolver: max_iterations halts before exceeding cap", async () => {
  const dir = mkProject([]);
  try {
    writeConflictedFile(dir, "a.txt");
    writeConflictedFile(dir, "b.txt");
    writeConflictedFile(dir, "c.txt");
    const ctx = makeCtx(dir, {
      conflictedPaths: ["a.txt", "b.txt", "c.txt"],
      config: { ...RESOLVER_CFG, maxIterations: 2 },
    });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "max_iterations");
      // We try a.txt and b.txt (both fail since mock returns default —
      // markers remain). After 2 iterations, c.txt is in failedFiles too.
      assert.ok(r.failedFiles.includes("c.txt"));
    }
  } finally {
    rmTmp(dir);
  }
});

test("resolver: cost_cap halts before next iteration would exceed it", async () => {
  const dir = mkProject([
    {
      matchPrompt: "Resolve the merge conflict in a\\.txt",
      isRegex: true,
      finalText: "ok",
      cost: 0.20, // First iteration burns most of the budget.
      editFile: { path: "a.txt", content: "merged\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    writeConflictedFile(dir, "b.txt");
    const ctx = makeCtx(dir, {
      conflictedPaths: ["a.txt", "b.txt"],
      config: { ...RESOLVER_CFG, costCapUsd: 0.30 },
    });
    const r = await resolveConflicts(ctx);
    // First iteration costs 0.20; estimated next iteration 0.20 → 0.20+0.20=0.40 > 0.30, halt.
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "cost_cap");
      assert.deepEqual(r.resolvedFiles, ["a.txt"]);
      assert.ok(r.failedFiles.includes("b.txt"));
      assert.equal(r.costUsd, 0.20);
    }
  } finally {
    rmTmp(dir);
  }
});

test("resolver: verify_failed when verify command exits non-zero after clean resolution", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "ok",
      cost: 0.01,
      editFile: { path: "a.txt", content: "merged\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    const ctx = makeCtx(dir, {
      conflictedPaths: ["a.txt"],
      config: { ...RESOLVER_CFG, verifyCommand: "false" }, // shell command that always fails
    });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "verify_failed");
  } finally {
    rmTmp(dir);
  }
});

test("resolver: verify_passes when verify command exits zero", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "ok",
      cost: 0.01,
      editFile: { path: "a.txt", content: "merged\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    const ctx = makeCtx(dir, {
      conflictedPaths: ["a.txt"],
      config: { ...RESOLVER_CFG, verifyCommand: "true" },
    });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, true);
  } finally {
    rmTmp(dir);
  }
});

test("resolver: agent_gave_up when finishedNormally is false", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "I cannot",
      finishedNormally: false,
      cost: 0.01,
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    const ctx = makeCtx(dir, { conflictedPaths: ["a.txt"] });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "agent_gave_up");
      assert.deepEqual(r.failedFiles, ["a.txt"]);
    }
  } finally {
    rmTmp(dir);
  }
});

test("resolver: user_cancelled when AbortController fires before iteration", async () => {
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "ok",
      cost: 0.01,
      editFile: { path: "a.txt", content: "merged\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx(dir, {
      conflictedPaths: ["a.txt"],
      abortController: ac,
    });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "user_cancelled");
  } finally {
    rmTmp(dir);
  }
});

test("resolver: file with markers still present after edit fails with max_iterations", async () => {
  // Mock matches but writes new content that STILL contains markers.
  const dir = mkProject([
    {
      matchPrompt: "merge conflict",
      isRegex: true,
      finalText: "ok",
      cost: 0.01,
      editFile: { path: "a.txt", content: "still has <<<<<<< marker\n" },
    },
  ]);
  try {
    writeConflictedFile(dir, "a.txt");
    const ctx = makeCtx(dir, { conflictedPaths: ["a.txt"] });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "max_iterations");
      assert.ok(r.failedFiles.includes("a.txt"));
    }
  } finally {
    rmTmp(dir);
  }
});

test("resolver: empty conflictedPaths returns ok immediately", async () => {
  const dir = mkProject();
  try {
    const ctx = makeCtx(dir, { conflictedPaths: [] });
    const r = await resolveConflicts(ctx);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.resolvedFiles, []);
      assert.equal(r.costUsd, 0);
    }
    // Only the terminal `done` event is emitted.
    const types = eventsOf(ctx).map((e) => e.type);
    assert.deepEqual(types, ["conflict-resolver:done"]);
  } finally {
    rmTmp(dir);
  }
});
