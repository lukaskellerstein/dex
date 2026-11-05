/**
 * The app's one read (015 US8, research R17, contracts/ipc-events.md
 * § RunSnapshot): the fresh state, the picker's queue view with per-entry cost
 * from the run record, and validation errors verbatim — written nowhere.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { runSnapshot } from "../run-snapshot.ts";
import * as runs from "../runs.ts";
import { createInitialState, saveState } from "../state.ts";
import type { RunConfig } from "../types.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkExistingProject, writeFile } from "./helpers/loop.ts";
import { mkTmpProject } from "./helpers/project.ts";

const CONFIG: RunConfig = { projectDir: "", specDir: "", mode: "loop", model: "m", maxIterations: 1, maxTurns: 1, taskPhases: "all" };

function agentRun(projectDir: string, runId: string, featureSlug: string, costUsd: number): void {
  const agentRunId = `${featureSlug}-${costUsd}`;
  runs.startAgentRun(projectDir, runId, {
    agentRunId,
    runId,
    specDir: `specs/${featureSlug}`,
    taskPhaseNumber: 1,
    taskPhaseName: "x",
    step: "implement",
    cycleNumber: 1,
    featureSlug,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  runs.completeAgentRun(projectDir, runId, agentRunId, {
    status: "completed",
    costUsd,
    durationMs: 1,
    inputTokens: null,
    outputTokens: null,
  });
}

test("runSnapshot: state, the queue view with per-entry cost from the run record, no errors, nothing written", async () => {
  const dir = mkExistingProject();
  try {
    await saveState(dir, createInitialState({ ...CONFIG, projectDir: dir }, "run-1", { kind: "existing", runBranch: null }));
    runs.startRun(dir, {
      runId: "run-1",
      mode: "loop",
      model: "m",
      specDir: "",
      startedAt: new Date().toISOString(),
      status: "running",
      writerPid: process.pid,
      description: null,
      descriptionFile: null,
      fullPlanPath: null,
      maxBudgetUsd: null,
    });
    agentRun(dir, "run-1", "900-fixture-a", 0.25);
    agentRun(dir, "run-1", "900-fixture-a", 0.5);
    const before = fs.readFileSync(path.join(dir, ".dex/runs/run-1.json"), "utf-8");

    const snap = runSnapshot(dir);
    assert.equal(snap.state?.runId, "run-1");
    assert.deepEqual(snap.errors, []);
    assert.deepEqual(
      snap.queue?.entries.map((e) => [e.id, e.status, e.nextStage, e.taskPhase, e.costUsd]),
      [
        ["900-fixture-a", "active", "implement", 1, 0.75],
        ["901-fixture-b", "pending", "specify", null, 0],
      ],
    );
    assert.equal(fs.readFileSync(path.join(dir, ".dex/runs/run-1.json"), "utf-8"), before);
  } finally {
    rmTmp(dir);
  }
});

test("runSnapshot: no queue yet → queue null; a broken queue or policy → its error, verbatim", () => {
  const empty = mkTmpProject({});
  const dir = mkExistingProject();
  try {
    assert.deepEqual(runSnapshot(empty), { state: null, queue: null, errors: [] });

    writeFile(dir, ".dex/policy.json", '{ "permissionMode": "yolo" }\n');
    const badPolicy = runSnapshot(dir);
    assert.equal(badPolicy.errors.length, 1);
    assert.match(badPolicy.errors[0], /policy\.json/);
    assert.equal(badPolicy.queue?.entries.length, 2, "the queue is still described");

    writeFile(dir, ".dex/queue.json", '{ "version": 3, "kind": "existing", "entries": [] }\n');
    const badQueue = runSnapshot(dir);
    assert.equal(badQueue.queue, null);
    assert.match(badQueue.errors[0], /queue\.json/);
  } finally {
    rmTmp(empty);
    rmTmp(dir);
  }
});
