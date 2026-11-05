/**
 * What: The two stages that need more than one prompt — `runImplement` (one task phase per call, through the runner's runTaskPhase) and `runVerify` (Dex keys the entry right before the stage, the agent returns its verdict as structured output, and Dex writes the evidence record). Both return what post-stage needs.
 * Not: Does not decide which phase or whether verify runs — the picker does. Writes no run state (post-stage does).
 * Deps: runStage, getActiveContext, parser.parseTasksMd, evidence.*, queue.{isFixPhase, isInScope}, prompts.{buildImplementPrompt, buildVerifyPrompt, stageEnv}, runs.*.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LimitHit } from "../agent/AgentRunner.js";
import {
  evidenceKey,
  parseVerdict,
  tasksHash,
  VERIFY_SCHEMA,
  type VerifyVerdict,
  writeVerifyRecord,
} from "../evidence.js";
import { getActiveContext } from "../orchestrator.js";
import { parseTasksMd } from "../parser.js";
import {
  buildImplementPrompt,
  buildVerifyPrompt,
  stageEnv,
  type VerifyExtras,
} from "../prompts.js";
import { isFixPhase, isInScope, type QueueV3, type ResolvedEntry } from "../queue.js";
import * as runs from "../runs.js";
import type { RunConfig, TaskPhase } from "../types.js";
import { runStage } from "./run-stage.js";

export interface StageDeps {
  config: RunConfig;
  runId: string;
  kind: QueueV3["kind"];
  /** The project goal for new projects (read-only context); null for existing ones. */
  goalPath: string | null;
}

export interface ImplementResult {
  cost: number;
  /** Checked in-scope tasks before and after the run (research R9). */
  checkedBefore: number;
  checkedAfter: number;
  limitHit: LimitHit | null;
}

function readTasks(projectDir: string, entry: ResolvedEntry): string {
  return fs.readFileSync(path.join(projectDir, entry.specDir, "tasks.md"), "utf-8");
}

/** Checked tasks that count toward the entry: its scope, plus every fix phase. */
export function countCheckedInScope(entry: ResolvedEntry, phases: TaskPhase[]): number {
  return phases.flatMap((p) => p.tasks.filter((t) => isInScope(entry, p, t) && t.status === "done"))
    .length;
}

function ctxOrThrow() {
  const ctx = getActiveContext();
  if (!ctx) throw new Error("cycle-stages called before currentContext was resolved");
  return ctx;
}

/** One `/speckit-implement --phase N` agent for `entry`. */
export async function runImplement(
  deps: StageDeps,
  entry: ResolvedEntry,
  taskPhase: number,
  cycleNumber: number,
): Promise<ImplementResult> {
  const ctx = ctxOrThrow();
  const { projectDir, emit, rlog, state } = ctx;
  const phases = parseTasksMd(readTasks(projectDir, entry));
  const phase = phases.find((p) => p.number === taskPhase);
  if (!phase) throw new Error(`${entry.specDir}/tasks.md has no phase ${taskPhase}`);
  const checkedBefore = countCheckedInScope(entry, phases);

  const agentRunId = crypto.randomUUID();
  runs.startAgentRun(projectDir, deps.runId, {
    agentRunId,
    runId: deps.runId,
    specDir: entry.specDir,
    taskPhaseNumber: phase.number,
    taskPhaseName: phase.name,
    step: "implement",
    cycleNumber,
    featureSlug: entry.id,
    startedAt: new Date().toISOString(),
    status: "running",
  });
  rlog.startAgentRun(cycleNumber, "implement", agentRunId);
  rlog.agentRun("INFO", `runImplement: ${entry.id} phase ${phase.number} (${phase.name})`);
  Object.assign(state, {
    currentStep: "implement",
    specDir: entry.specDir,
    agentRunId,
    taskPhaseNumber: phase.number,
    taskPhaseName: phase.name,
  });
  emit({
    type: "step_started",
    runId: deps.runId,
    cycleNumber,
    step: "implement",
    agentRunId,
    specDir: entry.specDir,
    taskPhaseNumber: phase.number,
  });
  emit({ type: "tasks_updated", taskPhases: phases });
  emit({ type: "task_phase_started", taskPhase: phase, iteration: 0, agentRunId });

  const r = await ctx.runner.runTaskPhase({
    config: { ...deps.config, specDir: entry.specDir },
    prompt: buildImplementPrompt(entry, projectDir, { phase, goalPath: deps.goalPath }),
    runId: deps.runId,
    taskPhase: phase,
    agentRunId,
    abortController: ctx.abort,
    emit,
    rlog,
    env: stageEnv(entry, "implement", deps.kind),
    entryId: entry.id,
    policy: ctx.policy,
  });

  const after = parseTasksMd(readTasks(projectDir, entry));
  const stopped = ctx.abort.signal.aborted;
  runs.completeAgentRun(projectDir, deps.runId, agentRunId, {
    status: stopped ? "stopped" : "completed",
    costUsd: r.cost,
    durationMs: r.durationMs,
    inputTokens: r.inputTokens || null,
    outputTokens: r.outputTokens || null,
  });
  emit({ type: "tasks_updated", taskPhases: after });
  emit({
    type: "task_phase_completed",
    taskPhase: after.find((p) => p.number === phase.number) ?? phase,
    cost: r.cost,
    durationMs: r.durationMs,
  });
  emit({
    type: "step_completed",
    runId: deps.runId,
    cycleNumber,
    step: "implement",
    agentRunId,
    costUsd: r.cost,
    durationMs: r.durationMs,
    ...(stopped ? { stopped: true } : {}),
  });
  return {
    cost: r.cost,
    checkedBefore,
    checkedAfter: countCheckedInScope(entry, after),
    limitHit: r.limitHit ?? null,
  };
}

/** `T<max+1>`, padded like the file's ids (T009 → T010). */
function nextTaskId(phases: TaskPhase[]): string {
  const ids = phases.flatMap((p) => p.tasks.map((t) => t.id));
  const max = Math.max(0, ...ids.map((id) => Number(id.slice(1))));
  const width = Math.max(3, ...ids.map((id) => id.length - 1));
  return `T${String(max + 1).padStart(width, "0")}`;
}

/** What the verify prompt states about tasks.md: the round, and where a fix phase goes. */
export function verifyFacts(tasksMd: string): VerifyExtras {
  const phases = parseTasksMd(tasksMd);
  return {
    round: phases.filter(isFixPhase).length + 1,
    nextPhaseNumber: Math.max(0, ...phases.map((p) => p.number)) + 1,
    nextTaskId: nextTaskId(phases),
  };
}

/**
 * The verify agent: fresh context, returns its verdict as structured output. Dex
 * keys the record with what the agent checked — the entry as it was when the
 * stage started — so a commit during the stage sends the entry back to verify.
 */
export async function runVerify(
  deps: StageDeps,
  entry: ResolvedEntry,
  cycleNumber: number,
): Promise<{ cost: number; verdict: VerifyVerdict | null; limitHit: LimitHit | null }> {
  const ctx = ctxOrThrow();
  const key = evidenceKey(ctx.projectDir, deps.kind, entry);
  if (key === null) {
    throw new Error(
      `verify ${entry.id}: cannot key the record (no branch "${entry.branch}" or no ${entry.specDir})`,
    );
  }
  const tasksMd = readTasks(ctx.projectDir, entry);
  const prompt = buildVerifyPrompt(entry, ctx.projectDir, verifyFacts(tasksMd));
  const r = await runStage({
    outputFormat: {
      type: "json_schema",
      schema: VERIFY_SCHEMA as unknown as Record<string, unknown>,
    },
    config: deps.config,
    prompt,
    runId: deps.runId,
    cycleNumber,
    step: "verify",
    specDir: entry.specDir,
    env: stageEnv(entry, "verify", deps.kind),
    entryId: entry.id,
  });
  const verdict = parseVerdict(r.structuredOutput);
  if (verdict) {
    writeVerifyRecord(ctx.projectDir, {
      version: 1,
      entryId: entry.id,
      key,
      tasksHash: tasksHash(tasksMd),
      checked: new Date().toISOString(),
      ...verdict,
    });
  }
  return { cost: r.cost, verdict, limitHit: r.limitHit };
}
