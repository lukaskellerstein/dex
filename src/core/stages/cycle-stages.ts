/**
 * What: The two stages that need more than one prompt — `runImplement` (one task phase per call, through the runner's runTaskPhase) and `runVerify` (Dex computes the tasks.md fingerprint right before the stage and hands it to the agent, which writes verify.md). Both return what post-stage needs.
 * Not: Does not decide which phase or whether verify runs — the picker does. Writes no run state and parses no verify.md (post-stage and the picker do).
 * Deps: runStage, getActiveContext, parser.parseTasksMd, picker.tasksHash, queue.{isFixPhase, isInScope}, prompts.{buildImplementPrompt, buildVerifyPrompt, stageEnv}, runs.*.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LimitHit } from "../agent/AgentRunner.js";
import { getActiveContext } from "../orchestrator.js";
import { parseTasksMd } from "../parser.js";
import { tasksHash } from "../picker.js";
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

/** What the verify prompt states about tasks.md: its fingerprint, the round, and where a fix phase goes. */
export function verifyFacts(tasksMd: string): VerifyExtras {
  const phases = parseTasksMd(tasksMd);
  return {
    tasksHash: tasksHash(tasksMd),
    round: phases.filter(isFixPhase).length + 1,
    nextPhaseNumber: Math.max(0, ...phases.map((p) => p.number)) + 1,
    nextTaskId: nextTaskId(phases),
  };
}

/** The verify agent: fresh context, the fingerprint Dex computed, writes verify.md. */
export async function runVerify(
  deps: StageDeps,
  entry: ResolvedEntry,
  cycleNumber: number,
): Promise<{ cost: number; tasksHash: string; limitHit: LimitHit | null }> {
  const ctx = ctxOrThrow();
  const facts = verifyFacts(readTasks(ctx.projectDir, entry));
  const hash = facts.tasksHash;
  const prompt = buildVerifyPrompt(entry, ctx.projectDir, facts);
  const r = await runStage({
    config: deps.config,
    prompt,
    runId: deps.runId,
    cycleNumber,
    step: "verify",
    specDir: entry.specDir,
    env: stageEnv(entry, "verify", deps.kind),
    entryId: entry.id,
  });
  return { cost: r.cost, tasksHash: hash, limitHit: r.limitHit };
}
