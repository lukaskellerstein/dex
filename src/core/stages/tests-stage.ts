/**
 * What: The `tests` stage (D-016-2, FR-009–FR-013). A fresh agent that does not implement writes the entry's acceptance tests and `<specDir>/acceptance.json`; Dex records a `tests` stage record, then runs the red-first gate itself: it reads and validates the record, runs its command once, and `gates.redFirst` decides — an assertion failure passes, a pass pauses (`red_first_green`), a crash sends the loop back to `tests` once and pauses the second time (R20). The red-first record is keyed by the acceptance.json content hash, which the picker reads. Amend mode (R10): an approved test amendment is pending, so the agent changes that one file (scope: the file and the spec folder), Dex marks the amendment applied and runs no red-first gate.
 * Not: Picks no stage (the picker sends the entry here) and writes no tracked file: acceptance.json is the agent's.
 * Deps: runStage, entry-prompts.{buildTestsPrompt, TESTS_SCHEMA}, acceptance.readAcceptance, scope.stageScope, sensors.runSensor, gates.{redFirst, isCrash}, evidence.{readStageRecords, pendingAmendment, markAmendmentApplied}, gate-runs.{writeGateRecord, blankRecord, ctxOrThrow}, tree-stamp.treeStamp, tree-reader.workingTree.
 */

import { RECORDED_ACCEPTANCE, readAcceptance } from "../acceptance.js";
import { attemptSlice } from "../attempt-log.js";
import { buildTestsPrompt, TESTS_SCHEMA } from "../entry-prompts.js";
import { markAmendmentApplied, pendingAmendment, readStageRecords } from "../evidence.js";
import { isCrash, redFirst } from "../gates.js";
import { stageEnv } from "../prompts.js";
import type { ResolvedEntry } from "../queue.js";
import { stageScope } from "../scope.js";
import { runSensor } from "../sensors.js";
import { workingTree } from "../tree-reader.js";
import { treeStamp } from "../tree-stamp.js";
import { headOrNull, type StageDeps } from "./cycle-stages.js";
import { blankRecord, ctxOrThrow, type GatedRun, writeGateRecord } from "./gate-runs.js";
import { runStage } from "./run-stage.js";

/** The agent's summary, when its structured output has one. */
function summaryOf(output: unknown): string | null {
  const s = (output as { summary?: unknown } | null)?.summary;
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

/** The red-first gate (FR-013): Dex runs the recorded acceptance command once, in its own process. */
async function redFirstGate(
  deps: StageDeps,
  entry: ResolvedEntry,
  previousCrash: boolean,
): Promise<GatedRun["guard"]> {
  const ctx = ctxOrThrow();
  const read = readAcceptance(workingTree(ctx.projectDir), entry, ctx.policy);
  const record = read.kind === "ok" ? read.record : null;
  const run = record
    ? await runSensor(
        { name: RECORDED_ACCEPTANCE, command: record.command, timeoutSec: record.timeoutSec },
        { cwd: ctx.projectDir, env: ctx.policy.env, signal: ctx.abort.signal },
      )
    : null;
  if (ctx.abort.signal.aborted) return null;
  if (run) {
    ctx.emit({
      type: "sensor_run",
      runId: deps.runId,
      entryId: entry.id,
      stage: "red-first",
      agentRunId: null,
      run,
    });
  }
  const problem =
    read.kind === "missing"
      ? `the tests stage wrote no ${entry.specDir}/acceptance.json`
      : read.kind === "invalid"
        ? read.message
        : undefined;
  const decision = redFirst(run, record, previousCrash, problem);
  const head = headOrNull(ctx.projectDir);
  writeGateRecord(
    ctx,
    deps.runId,
    {
      ...blankRecord(entry, "red-first"),
      startSha: head,
      endSha: head,
      treeStamp: treeStamp(ctx.projectDir),
      runs: run ? [run] : [],
      gate: decision,
      acceptanceHash: read.kind === "missing" ? null : read.hash,
    },
    null,
  );
  return decision.outcome === "pause" && decision.pauseReason
    ? { reason: decision.pauseReason, detail: `${entry.id}: ${decision.reason}` }
    : null;
}

/**
 * The tests stage: create mode, then the red-first gate; or amend mode for an
 * approved amendment (R10), scoped to that one file, with no red-first run —
 * the implementation can already exist (spec § Edge cases).
 */
export async function runTests(
  deps: StageDeps,
  entry: ResolvedEntry,
  cycleNumber: number,
): Promise<GatedRun> {
  const ctx = ctxOrThrow();
  const amendment = pendingAmendment(ctx.projectDir, entry.id);
  const last = readStageRecords(ctx.projectDir, entry.id, "red-first").at(-1);
  const previousCrash = !amendment && isCrash(last?.gate ?? null);
  const startSha = headOrNull(ctx.projectDir);
  const r = await runStage({
    config: deps.config,
    prompt: buildTestsPrompt(entry, ctx.projectDir, {
      testGlobs: ctx.policy.testGlobs,
      testSupport: ctx.policy.testSupport,
      lastCrash:
        previousCrash && last?.gate
          ? { reason: last.gate.reason, run: last.runs[0] ?? null }
          : null,
      amendment,
      attempts: attemptSlice(ctx.projectDir, entry.id),
    }),
    outputFormat: {
      type: "json_schema",
      schema: TESTS_SCHEMA as unknown as Record<string, unknown>,
    },
    runId: deps.runId,
    cycleNumber,
    step: "tests",
    specDir: entry.specDir,
    env: stageEnv(entry, "tests", deps.kind),
    entryId: entry.id,
    scope: stageScope(ctx.policy, entry, "tests", null, amendment?.file ?? null),
  });
  const out = { cost: r.cost, limitHit: r.limitHit, ran: "tests" as const, progressPassed: null };
  // A stage cut short wrote nothing to judge: the picker runs it again.
  if (ctx.abort.signal.aborted || r.limitHit) return { ...out, guard: null };
  writeGateRecord(
    ctx,
    deps.runId,
    {
      ...blankRecord(entry, "tests"),
      mode: amendment ? "amend" : "create",
      startSha,
      endSha: headOrNull(ctx.projectDir),
      treeStamp: treeStamp(ctx.projectDir),
      summary: summaryOf(r.structuredOutput),
    },
    r.agentRunId,
  );
  if (amendment) {
    markAmendmentApplied(ctx.projectDir, entry.id, amendment.file);
    ctx.rlog.run("INFO", `tests: ${entry.id} · applied the amendment of ${amendment.file}`);
    return { ...out, guard: null };
  }
  return { ...out, guard: await redFirstGate(deps, entry, previousCrash) };
}
