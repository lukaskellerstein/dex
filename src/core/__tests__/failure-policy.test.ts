/**
 * The failure policy (015 US4, research R9): verify rounds come from the
 * files, the implement counter from checked in-scope tasks, and every limit
 * pauses or stops the run with the limit named.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { countVerifyRounds, type PickerDecision } from "../picker.ts";
import { DEFAULT_POLICY, type PolicyLimits } from "../policy.ts";
import { type QueueV3, resolveEntries } from "../queue.ts";
import {
  frozenCheck,
  limitCheck,
  progressCheck,
  recordStage,
  runBudgetLeft,
  verifyRoundsCheck,
} from "../stages/post-stage.ts";
import { createInitialState, loadState, saveState } from "../state.ts";
import type { RunConfig } from "../types.ts";
import { commitFile, mkTmpRepo, rmTmp } from "./helpers/git.ts";
import { mkTmpProject, writeFiles } from "./helpers/project.ts";

const LIMITS: PolicyLimits = { ...DEFAULT_POLICY.limits };
const QUEUE: QueueV3 = { version: 3, kind: "new", entries: [{ id: "001-alpha", title: "Alpha" }] };
const [ENTRY] = resolveEntries(QUEUE, "main", "dex/run");

function phase(n: number, name: string): string {
  return `## Phase ${n}: ${name}\n\n- [ ] T00${n} Do ${n}\n`;
}

const stageDecision = (stage: "implement" | "verify" | "plan"): PickerDecision => ({
  kind: "stage",
  entry: ENTRY,
  stage,
  reason: "test",
});

test("countVerifyRounds: counts the Verify fixes V<k> phases only", () => {
  const base = `# Tasks\n\n${phase(1, "Setup")}\n${phase(2, "Core")}`;
  assert.equal(countVerifyRounds(base), 0);
  assert.equal(countVerifyRounds(`${base}\n${phase(3, "Verify fixes V1")}`), 1);
  const three = [3, 4, 5].map((n, i) => phase(n, `Verify fixes V${i + 1}`)).join("\n");
  assert.equal(countVerifyRounds(`${base}\n${three}`), 3);
  assert.equal(countVerifyRounds(`${base}\n${phase(3, "Verify fixes later")}`), 0);
});

let dir: string;
const config: RunConfig = {
  projectDir: "",
  specDir: "",
  mode: "loop",
  model: "m",
  maxIterations: 1,
  maxTurns: 75,
  taskPhases: "all",
};

beforeEach(async () => {
  dir = mkTmpProject({});
  await saveState(
    dir,
    createInitialState({ ...config, projectDir: dir }, "run-1", {
      kind: "new",
      runBranch: "dex/run",
    }),
  );
});

afterEach(() => {
  rmTmp(dir);
});

test("implement counter: +1 for a run that fails the progress gate, 0 again on a pass; pause at the limit", async () => {
  const last = { entryId: ENTRY.id, stage: "implement" as const, taskPhase: 1 };
  assert.equal(recordStage(dir, last, 0.5, false), 1);
  let counters = (await loadState(dir))?.counters ?? {};
  assert.equal(progressCheck(last, stageDecision("implement"), counters, LIMITS), null);

  assert.equal(recordStage(dir, last, 0.5, false), 2);
  counters = (await loadState(dir))?.counters ?? {};
  assert.deepEqual(progressCheck(last, stageDecision("implement"), counters, LIMITS), {
    reason: "limit_reached",
    detail:
      "implement ran 2 times for 001-alpha without passing the progress gate (limits.maxImplementRunsWithoutProgress: 2)",
  });
  // A restore run in place of verify counts too: the limit guards the next verify.
  assert.equal(
    progressCheck(last, stageDecision("verify"), counters, LIMITS)?.reason,
    "limit_reached",
  );
  // A higher limit lets it run again.
  assert.equal(
    progressCheck(last, stageDecision("implement"), counters, {
      ...LIMITS,
      maxImplementRunsWithoutProgress: 3,
    }),
    null,
  );

  assert.equal(recordStage(dir, last, 0.5, true), 0);
  assert.equal((await loadState(dir))?.cumulativeCostUsd, 1.5);
  assert.equal(recordStage(dir, last, 0, null), 0, "a stopped run or another stage leaves it");
});

test("verify rounds: at the limit and not done → pause naming the limit; below it → go on", () => {
  assert.equal(verifyRoundsCheck(stageDecision("implement"), 2, LIMITS), null);
  const guard = verifyRoundsCheck(stageDecision("implement"), 3, LIMITS);
  assert.equal(guard?.reason, "limit_reached");
  assert.match(
    guard?.detail ?? "",
    /^verify failed 3 times for 001-alpha \(limits\.maxVerifyRounds: 3\)/,
  );
  assert.equal(verifyRoundsCheck(stageDecision("verify"), 3, LIMITS)?.reason, "limit_reached");
  // Only implement and verify are verify rounds; an entry before them is unaffected.
  assert.equal(verifyRoundsCheck(stageDecision("plan"), 3, LIMITS), null);
  assert.equal(verifyRoundsCheck({ kind: "complete" }, 3, LIMITS), null);
});

test("stage limits: a turn or budget stop pauses with the limit named; a normal end does not", () => {
  const d = stageDecision("implement") as Extract<PickerDecision, { kind: "stage" }>;
  assert.equal(limitCheck(null, d, { ...LIMITS, maxTurnsPerStage: 40 }, 75), null);
  assert.deepEqual(limitCheck("turns", d, { ...LIMITS, maxTurnsPerStage: 40 }, 75), {
    reason: "limit_reached",
    detail: "001-alpha · implement stopped at the turn limit (limits.maxTurnsPerStage: 40)",
  });
  assert.equal(
    limitCheck("turns", d, LIMITS, 75)?.detail,
    "001-alpha · implement stopped at the turn limit (maxTurns: 75)",
  );
  assert.equal(
    limitCheck("budget", d, { ...LIMITS, maxBudgetUsdPerStage: 2 }, 75)?.detail,
    "001-alpha · implement stopped at the budget limit (limits.maxBudgetUsdPerStage: $2.00)",
  );
});

test("run budget: stops before the next stage once the spend reaches the limit", () => {
  assert.equal(runBudgetLeft(4.99, { ...LIMITS, maxBudgetUsdPerRun: 5 }), true);
  assert.equal(runBudgetLeft(5, { ...LIMITS, maxBudgetUsdPerRun: 5 }), false);
  assert.equal(runBudgetLeft(1000, LIMITS), true);
});

test("frozenCheck: the backstop after a stage — a changed or deleted frozen file pauses; a new one does not", () => {
  const repo = mkTmpRepo();
  try {
    commitFile(repo, "docs/thresholds.md", "p99 < 300ms\n", "thresholds");
    commitFile(repo, "tests/acceptance/a.spec.ts", "test('a')\n", "frozen test");
    const start = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    const frozen = ["docs/thresholds.md", "docs/claim*.md", "tests/acceptance/a.spec.ts"];
    assert.equal(frozenCheck(repo, frozen, start), null);
    writeFiles(repo, { "docs/claim-new.md": "new\n" });
    assert.equal(frozenCheck(repo, frozen, start), null, "a new file matching a glob");
    writeFiles(repo, { "docs/thresholds.md": "p99 < 900ms\n" });
    fs.rmSync(`${repo}/tests/acceptance/a.spec.ts`);
    assert.deepEqual(frozenCheck(repo, frozen, start), {
      reason: "frozen_changed",
      detail: "the stage changed frozen files: docs/thresholds.md, tests/acceptance/a.spec.ts",
    });
    assert.equal(frozenCheck(repo, frozen, null), null, "no start commit, nothing to compare");
  } finally {
    rmTmp(repo);
  }
});
