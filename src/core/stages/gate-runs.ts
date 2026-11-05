/**
 * What: Dex's own sensor runs around the agent stages, and the records they leave (research R6, R7, R11, R12). `baselineGate` runs the fast checks (plus the standing ones before verify) unless the entry's last record already ran them on this exact tree, writes a `baseline` record and emits `sensor_run` and `gate_decided`. `progressGate` runs the fast checks after an implement run, diffs tasks.md (plan-diff.diffTasks), reads what the run did to the tests (frozen tests changed, test files deleted or renamed, new skip markers), fingerprints the run and writes the `implement` record. `writeGateRecord` writes every record, emits `gate_decided`, and appends a tests, implement or verify record's section to the attempt log (R14). `implementStage` is the whole implement step: baseline, then a task phase (green) or a restore run (red), then the progress gate, the stall and the flaky guards. `restoreBeforeVerify` is the verify step's baseline: red runs a restore run instead of the verifier.
 * Not: Decides nothing itself — gates.ts does, from the runs. Picks no stage and writes no run state.
 * Deps: sensors.runSensors, gates.*, tree-stamp.*, evidence.{writeStageRecord, readStageRecords, evidenceKey, tasksHash}, attempt-log.appendAttempt, plan-diff.*, acceptance.fastChecksFor, parser.parseTasksMd, queue.isInScope, cycle-stages.{runImplement, headOrNull, readTasks}, post-stage.{stallCheck, flakyCheck}.
 */

import { fastChecksFor } from "../acceptance.js";
import type { LimitHit } from "../agent/AgentRunner.js";
import { appendAttempt } from "../attempt-log.js";
import type { OrchestrationContext } from "../context.js";
import {
  evidenceKey,
  type NewStageRecord,
  readStageRecords,
  type StageRecord,
  type TestChangesRecord,
  tasksHash,
  writeStageRecord,
} from "../evidence.js";
import {
  baseline,
  fingerprint,
  type GateDecision,
  type GatePause,
  progress,
  redNames,
} from "../gates.js";
import { getActiveContext } from "../orchestrator.js";
import { parseTasksMd } from "../parser.js";
import { addedLines, diffTasks, skipMarkers, testFileChanges } from "../plan-diff.js";
import { isInScope, type ResolvedEntry, type StageName } from "../queue.js";
import { isGreen, runSensors, type SensorRun, type SensorSpec } from "../sensors.js";
import { diffHashSince, diffSince, nameStatusSince, treeStamp } from "../tree-stamp.js";
import {
  headOrNull,
  type ImplementMode,
  type ImplementResult,
  runImplement,
  type StageDeps,
} from "./cycle-stages.js";
import { flakyCheck, stallCheck } from "./post-stage.js";

/** What one gated step did, for post-stage. */
export interface GatedRun {
  cost: number;
  limitHit: LimitHit | null;
  /** The stage that ran: a red baseline before verify runs `implement` (a restore run) instead. */
  ran: StageName;
  /** implement only: whether the run passed the progress gate; null otherwise and when stopped. */
  progressPassed: boolean | null;
  /** A pause the gates raised: plan_changed, frozen_changed, tests_changed, stalled, flaky_check. */
  guard: GatePause | null;
}

interface Baseline {
  decision: GateDecision;
  runs: SensorRun[];
}

export function ctxOrThrow(): OrchestrationContext {
  const ctx = getActiveContext();
  if (!ctx) throw new Error("gate-runs called before currentContext was resolved");
  return ctx;
}

/** Runs `specs` with the policy's env and re-runs; emits one `sensor_run` per run. */
export async function runChecks(
  ctx: OrchestrationContext,
  runId: string,
  entry: ResolvedEntry,
  stage: string,
  agentRunId: string | null,
  specs: SensorSpec[],
): Promise<SensorRun[]> {
  return runSensors(specs, {
    cwd: ctx.projectDir,
    env: ctx.policy.env,
    signal: ctx.abort.signal,
    rerunOnFail: ctx.policy.checks.rerunOnFail,
    onRun: (run) => {
      ctx.emit({ type: "sensor_run", runId, entryId: entry.id, stage, agentRunId, run });
      ctx.rlog.run("INFO", `sensor: ${entry.id} · ${stage} · ${run.name} ${run.result}`, {
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        reruns: run.reruns,
      });
    },
  });
}

/** The stages an agent ran: each leaves a section in the attempt log (R14). Dex's own runs do not. */
const AGENT_STAGES: ReadonlySet<string> = new Set(["tests", "implement", "verify"]);

function logAttempt(projectDir: string, rec: StageRecord, notes: string[]): void {
  if (!AGENT_STAGES.has(rec.stage)) return;
  const mode = rec.mode && rec.mode !== "phase" ? ` (${rec.mode})` : "";
  appendAttempt(projectDir, rec.entryId, {
    at: rec.at,
    stage: `${rec.stage}${mode}`,
    taskPhase: rec.taskPhase,
    summary: rec.summary,
    notes,
    gate: rec.gate ? `${rec.gate.gate} ${rec.gate.outcome} — ${rec.gate.reason}` : null,
    failing: rec.runs.filter((r) => !isGreen(r)),
  });
}

/**
 * Writes the record, announces its gate decision and, for an agent stage,
 * appends its section to the attempt log: the agent's summary and `notes`,
 * the gate, the failing runs (R14).
 */
export function writeGateRecord(
  ctx: OrchestrationContext,
  runId: string,
  rec: NewStageRecord,
  agentRunId: string | null,
  notes: string[] = [],
): StageRecord {
  const { record: written, file } = writeStageRecord(ctx.projectDir, rec);
  logAttempt(ctx.projectDir, written, notes);
  if (rec.gate) {
    ctx.emit({
      type: "gate_decided",
      runId,
      entryId: rec.entryId,
      agentRunId,
      decision: rec.gate,
      evidenceFile: file,
    });
    ctx.rlog.run("INFO", `gate: ${rec.entryId} · ${rec.gate.gate} ${rec.gate.outcome} — ${rec.gate.reason}`);
  }
  return written;
}

export function blankRecord(entry: ResolvedEntry, stage: NewStageRecord["stage"]): NewStageRecord {
  return {
    entryId: entry.id,
    stage,
    mode: null,
    taskPhase: null,
    key: null,
    tasksHash: null,
    startSha: null,
    endSha: null,
    treeStamp: "",
    runs: [],
    planDiff: null,
    testChanges: null,
    fingerprint: null,
    gate: null,
    acceptanceHash: null,
    summary: null,
  };
}

/** The entry's last record that already ran every one of `specs` on this exact tree (R6). */
function reusable(records: StageRecord[], stamp: string, specs: SensorSpec[]): StageRecord | null {
  const last = [...records].reverse().find((r) => r.treeStamp === stamp && r.runs.length > 0);
  if (!last) return null;
  const ran = new Set(last.runs.map((r) => r.name));
  return specs.every((s) => ran.has(s.name)) ? last : null;
}

/** Before implement or verify (FR-019): the fast checks, plus the standing ones before verify. */
export async function baselineGate(
  runId: string,
  entry: ResolvedEntry,
  stage: "implement" | "verify",
): Promise<Baseline> {
  const ctx = ctxOrThrow();
  const specs = [
    ...fastChecksFor(ctx.policy, entry),
    ...(stage === "verify" ? ctx.policy.checks.standing : []),
  ];
  if (specs.length === 0) return { decision: baseline([]), runs: [] };
  const names = new Set(specs.map((s) => s.name));
  const reused = reusable(readStageRecords(ctx.projectDir, entry.id), treeStamp(ctx.projectDir), specs);
  if (reused) {
    const runs = reused.runs.filter((r) => names.has(r.name));
    ctx.rlog.run("INFO", `gate: ${entry.id} · baseline reuses ${reused.stage}-${reused.n} (same tree)`);
    return { decision: baseline(runs), runs };
  }
  const runs = await runChecks(ctx, runId, entry, "baseline", null, specs);
  const decision = baseline(runs);
  if (ctx.abort.signal.aborted) return { decision, runs };
  const head = headOrNull(ctx.projectDir);
  writeGateRecord(
    ctx,
    runId,
    {
      ...blankRecord(entry, "baseline"),
      mode: stage,
      startSha: head,
      endSha: head,
      treeStamp: treeStamp(ctx.projectDir),
      runs,
      gate: decision,
    },
    null,
  );
  return { decision, runs };
}

/** In-scope task ids that are done after the run and were not done before it. */
export function newlyTicked(entry: ResolvedEntry, before: string, after: string): string[] {
  const doneBefore = new Set(
    parseTasksMd(before).flatMap((p) => p.tasks.filter((t) => t.status === "done").map((t) => t.id)),
  );
  return parseTasksMd(after).flatMap((p) =>
    p.tasks
      .filter((t) => t.status === "done" && !doneBefore.has(t.id) && isInScope(entry, p, t))
      .map((t) => t.id),
  );
}

interface ProgressContext {
  runId: string;
  mode: ImplementMode;
  /** The checks red at the run's baseline (restore mode). */
  redAtBaseline: string[];
  /** 015's evidence key, taken before the run. */
  key: string | null;
}

/** What the run did to the tests since its start commit (FR-027, FR-028); nothing without a commit. */
function testChangesOf(projectDir: string, impl: ImplementResult, testGlobs: string[]): TestChangesRecord {
  if (!impl.startSha) return { frozenChanged: [], testsDeletedOrRenamed: [], skipMarkers: [] };
  const files = testFileChanges(nameStatusSince(projectDir, impl.startSha), testGlobs, impl.frozen);
  const markers = skipMarkers(addedLines(diffSince(projectDir, impl.startSha)), testGlobs);
  return { ...files, skipMarkers: markers };
}

/** After an implement run (FR-018, FR-026–FR-028): the fast checks, the plan diff, the test changes and the fingerprint. */
export async function progressGate(
  entry: ResolvedEntry,
  impl: ImplementResult,
  pc: ProgressContext,
): Promise<{ decision: GateDecision; record: StageRecord | null }> {
  const ctx = ctxOrThrow();
  const runs = await runChecks(ctx, pc.runId, entry, "implement", impl.agentRunId, fastChecksFor(ctx.policy, entry));
  const ticked = newlyTicked(entry, impl.tasksBefore, impl.tasksAfter);
  const violations = diffTasks(impl.tasksBefore, impl.tasksAfter);
  const testChanges = testChangesOf(ctx.projectDir, impl, ctx.policy.testGlobs);
  const decision = progress({
    mode: pc.mode.mode,
    runs,
    newlyTicked: ticked,
    planViolations: violations,
    testChanges,
    redAtBaseline: pc.redAtBaseline,
  });
  if (ctx.abort.signal.aborted) return { decision, record: null };
  const diffHash = impl.startSha ? diffHashSince(ctx.projectDir, impl.startSha) : "";
  const rec = writeGateRecord(
    ctx,
    pc.runId,
    {
      ...blankRecord(entry, "implement"),
      mode: pc.mode.mode,
      taskPhase: pc.mode.mode === "phase" ? pc.mode.taskPhase : null,
      key: pc.key,
      tasksHash: tasksHash(impl.tasksBefore),
      startSha: impl.startSha,
      endSha: headOrNull(ctx.projectDir),
      treeStamp: treeStamp(ctx.projectDir),
      runs,
      planDiff: { newlyTicked: ticked, violations },
      testChanges,
      fingerprint: fingerprint(runs, diffHash),
      gate: decision,
      summary: impl.attempt?.summary ?? null,
    },
    impl.agentRunId,
    impl.attempt?.notes ?? [],
  );
  return { decision, record: rec };
}

/** The last implement record's gate, when it failed: the next phase prompt shows it. */
function lastFailedGate(projectDir: string, entry: ResolvedEntry) {
  const last = readStageRecords(projectDir, entry.id, "implement").at(-1);
  if (!last?.gate || last.gate.outcome === "pass") return null;
  return { reason: last.gate.reason, failing: last.runs.filter((r) => !isGreen(r)) };
}

/** One implement run with its gates around it; `mode` is what the baseline asked for. */
async function gatedImplement(
  deps: StageDeps,
  entry: ResolvedEntry,
  mode: ImplementMode,
  base: Baseline,
  cycleNumber: number,
): Promise<GatedRun> {
  const ctx = ctxOrThrow();
  const key = evidenceKey(ctx.projectDir, deps.kind, entry);
  const impl = await runImplement(deps, entry, mode, cycleNumber);
  const out = { cost: impl.cost, limitHit: impl.limitHit, ran: "implement" as const };
  if (ctx.abort.signal.aborted || impl.limitHit)
    return { ...out, progressPassed: null, guard: null };
  const { decision, record: rec } = await progressGate(entry, impl, {
    runId: deps.runId,
    mode,
    redAtBaseline: redNames(base.runs),
    key,
  });
  if (ctx.abort.signal.aborted) return { ...out, progressPassed: null, guard: null };
  const records = readStageRecords(ctx.projectDir, entry.id);
  const pause: GatePause | null =
    decision.outcome === "pause" && decision.pauseReason
      ? { reason: decision.pauseReason, detail: `${entry.id}: ${decision.reason}` }
      : null;
  const guard =
    pause ??
    (decision.outcome === "pass" ? null : stallCheck(records)) ??
    flakyCheck(records, [...base.runs, ...(rec?.runs ?? [])]);
  return { ...out, progressPassed: decision.outcome === "pass", guard };
}

/** The implement step (FR-018, FR-019): a red baseline turns the phase into a restore run. */
export async function implementStage(
  deps: StageDeps,
  entry: ResolvedEntry,
  taskPhase: number,
  cycleNumber: number,
): Promise<GatedRun> {
  const ctx = ctxOrThrow();
  const base = await baselineGate(deps.runId, entry, "implement");
  if (ctx.abort.signal.aborted)
    return { cost: 0, limitHit: null, ran: "implement", progressPassed: null, guard: null };
  const mode: ImplementMode =
    base.decision.outcome === "pass"
      ? { mode: "phase", taskPhase, lastGate: lastFailedGate(ctx.projectDir, entry) }
      : { mode: "restore", failing: base.runs.filter((r) => !isGreen(r)) };
  return gatedImplement(deps, entry, mode, base, cycleNumber);
}

/**
 * The verify step's baseline (R7): fast and standing checks. Red runs a
 * restore run instead of the verifier, which may write only tasks.md; green
 * returns null and the verifier runs.
 */
export async function restoreBeforeVerify(
  deps: StageDeps,
  entry: ResolvedEntry,
  cycleNumber: number,
): Promise<GatedRun | null> {
  const ctx = ctxOrThrow();
  const base = await baselineGate(deps.runId, entry, "verify");
  if (ctx.abort.signal.aborted)
    return { cost: 0, limitHit: null, ran: "verify", progressPassed: null, guard: null };
  const flaky = flakyCheck(readStageRecords(ctx.projectDir, entry.id), base.runs);
  if (base.decision.outcome === "pass") {
    return flaky ? { cost: 0, limitHit: null, ran: "verify", progressPassed: null, guard: flaky } : null;
  }
  const failing = base.runs.filter((r) => !isGreen(r));
  return gatedImplement(deps, entry, { mode: "restore", failing }, base, cycleNumber);
}
