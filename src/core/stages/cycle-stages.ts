/**
 * What: The implement step's agent — `runImplement`: a task phase through the runner's runTaskPhase, or a "restore green first" run through runStage (research R7), both under the implement scope (the frozen test set, R9) and asked for `ATTEMPT_SCHEMA` (summary and notes, R8). It returns what the progress gate needs: the start commit, tasks.md before and after, the frozen set, and the agent's attempt output. Also the small helpers the gated stages share (`StageDeps`, `readTasks`, `headOrNull`).
 * Not: Does not decide which phase runs — the picker does — and runs no sensor (stages/gate-runs.ts does). Writes no run state (post-stage does). The verify stage is stages/verify-stage.ts.
 * Deps: runStage, getActiveContext, parser.parseTasksMd, entry-prompts.{buildImplementPrompt, buildRestorePrompt}, prompts.stageEnv, git.getHeadSha, runs.*.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { currentAcceptance } from "../acceptance.js";
import type { LimitHit } from "../agent/AgentRunner.js";
import { attemptSlice } from "../attempt-log.js";
import {
  ATTEMPT_SCHEMA,
  buildImplementPrompt,
  buildRestorePrompt,
  type GateEvidence,
} from "../entry-prompts.js";
import { getHeadSha } from "../git.js";
import { getActiveContext } from "../orchestrator.js";
import { parseTasksMd } from "../parser.js";
import { stageEnv } from "../prompts.js";
import type { QueueV3, ResolvedEntry } from "../queue.js";
import * as runs from "../runs.js";
import { type StageScope, stageScope } from "../scope.js";
import type { SensorRun } from "../sensors.js";
import type { RunConfig } from "../types.js";
import { runStage } from "./run-stage.js";

export interface StageDeps {
  config: RunConfig;
  runId: string;
  kind: QueueV3["kind"];
  /** The project goal for new projects (read-only context); null for existing ones. */
  goalPath: string | null;
}

/** A task phase, or a "restore green first" run with the red checks (research R7). */
export type ImplementMode =
  | { mode: "phase"; taskPhase: number; lastGate: GateEvidence | null }
  | { mode: "restore"; failing: SensorRun[] };

export interface ImplementResult {
  cost: number;
  limitHit: LimitHit | null;
  agentRunId: string;
  /** HEAD when the run started; null in a repository with no commit. */
  startSha: string | null;
  /** tasks.md before and after the run, for the progress gate's plan diff. */
  tasksBefore: string;
  tasksAfter: string;
  /** The entry's frozen test set when the run started (FR-014). */
  frozen: string[];
  /** The agent's own summary and notes, for the attempt log; null when it returned none. */
  attempt: Attempt | null;
}

export interface Attempt {
  summary: string;
  notes: string[];
}

const ATTEMPT_FORMAT = {
  type: "json_schema" as const,
  schema: ATTEMPT_SCHEMA as unknown as Record<string, unknown>,
};

/** The attempt output, or null when it does not have the shape. */
export function parseAttempt(raw: unknown): Attempt | null {
  const r = raw as { summary?: unknown; notes?: unknown } | null;
  if (!r || typeof r.summary !== "string") return null;
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
  return { summary: r.summary, notes };
}

export function readTasks(projectDir: string, entry: ResolvedEntry): string {
  return fs.readFileSync(path.join(projectDir, entry.specDir, "tasks.md"), "utf-8");
}

export function headOrNull(projectDir: string): string | null {
  try {
    return getHeadSha(projectDir);
  } catch {
    return null;
  }
}

function ctxOrThrow() {
  const ctx = getActiveContext();
  if (!ctx) throw new Error("cycle-stages called before currentContext was resolved");
  return ctx;
}

/** One implement agent for `entry`: a task phase, or a restore run. */
export async function runImplement(
  deps: StageDeps,
  entry: ResolvedEntry,
  mode: ImplementMode,
  cycleNumber: number,
): Promise<ImplementResult> {
  const { projectDir, policy } = ctxOrThrow();
  const startSha = headOrNull(projectDir);
  const tasksBefore = readTasks(projectDir, entry);
  const scope = stageScope(policy, entry, "implement", currentAcceptance(projectDir, entry, policy));
  const frozen = scope?.protect ?? [];
  const r =
    mode.mode === "phase"
      ? await runTaskPhase(deps, entry, { ...mode, frozen, scope }, tasksBefore, cycleNumber)
      : await runStage({
          config: deps.config,
          prompt: buildRestorePrompt(entry, projectDir, {
            failing: mode.failing,
            frozen,
            attempts: attemptSlice(projectDir, entry.id),
          }),
          outputFormat: ATTEMPT_FORMAT,
          runId: deps.runId,
          cycleNumber,
          step: "implement",
          specDir: entry.specDir,
          env: stageEnv(entry, "implement", deps.kind),
          entryId: entry.id,
          scope,
        });
  return {
    cost: r.cost,
    limitHit: r.limitHit,
    agentRunId: r.agentRunId,
    startSha,
    tasksBefore,
    tasksAfter: readTasks(projectDir, entry),
    frozen,
    attempt: parseAttempt(r.structuredOutput),
  };
}

type PhaseRun = Extract<ImplementMode, { mode: "phase" }> & {
  frozen: string[];
  scope: StageScope | null;
};

/** One `/speckit-implement --phase N` agent for `entry`. */
async function runTaskPhase(
  deps: StageDeps,
  entry: ResolvedEntry,
  mode: PhaseRun,
  tasksMd: string,
  cycleNumber: number,
): Promise<{
  cost: number;
  limitHit: LimitHit | null;
  agentRunId: string;
  structuredOutput: unknown | null;
}> {
  const ctx = ctxOrThrow();
  const { projectDir, emit, rlog, state } = ctx;
  const phases = parseTasksMd(tasksMd);
  const phase = phases.find((p) => p.number === mode.taskPhase);
  if (!phase) throw new Error(`${entry.specDir}/tasks.md has no phase ${mode.taskPhase}`);

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
    prompt: buildImplementPrompt(entry, projectDir, {
      phase,
      goalPath: deps.goalPath,
      lastGate: mode.lastGate,
      frozen: mode.frozen,
      attempts: attemptSlice(projectDir, entry.id),
    }),
    runId: deps.runId,
    taskPhase: phase,
    agentRunId,
    abortController: ctx.abort,
    emit,
    rlog,
    env: stageEnv(entry, "implement", deps.kind),
    entryId: entry.id,
    policy: ctx.policy,
    scope: mode.scope ?? undefined,
    outputFormat: ATTEMPT_FORMAT,
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
    limitHit: r.limitHit ?? null,
    agentRunId,
    structuredOutput: r.structuredOutput ?? null,
  };
}

