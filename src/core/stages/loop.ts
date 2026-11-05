/**
 * What: The queue loop (replaces main-loop.ts). Preflight once before the run; then until Stop: the picker decides from files; `complete` ends the run with `queue_complete`; `pause` records a human request and pauses; a stage runs after its checks (preflight before implement and verify, the branch switch for an existing project, the policy's limits), is dispatched (runStage with its R11 prompt — `brief` included — or runImplement / runVerify), and post-stage records it and checks frozen files, leftovers, the limit it hit and the entry's gates. `--once` stops after one stage. `cycleNumber` is the entry's 1-based queue position, so the log tree and runs.ts stay unchanged.
 * Not: Does not repair or reconcile anything: Resume runs this loop again.
 * Deps: picker.pickNext, prompts (stage builders, stageEnv), runStage, cycle-stages.{runImplement, runVerify}, post-stage, branching.prepareBranch, preflight, humanInput.recordPause, git.getHeadSha, state.
 */

import type { LimitHit } from "../agent/AgentRunner.js";
import { prepareBranch } from "../branching.js";
import type { OrchestrationContext } from "../context.js";
import { getHeadSha } from "../git.js";
import { recordPause } from "../humanInput.js";
import { describeQueue, type PickerDecision, pickNext, verifyRoundsOf } from "../picker.js";
import { checkRepos, runPreflight } from "../preflight.js";
import { buildStagePrompt, stageEnv } from "../prompts.js";
import type { QueueV3, ResolvedEntry } from "../queue.js";
import { loadState, mutateState } from "../state.js";
import type { LoopTermination, TerminationReason } from "../types.js";
import { type ImplementResult, runImplement, runVerify, type StageDeps } from "./cycle-stages.js";
import {
  frozenCheck,
  type Guard,
  gateCheck,
  type LastStage,
  leftUncommitted,
  limitCheck,
  progressCheck,
  recordStage,
  runBudgetLeft,
  verifyRoundsCheck,
} from "./post-stage.js";
import { runStage } from "./run-stage.js";

export interface LoopDeps extends StageDeps {
  queue: QueueV3;
  runBranch: string | null;
  /** A pause found before the loop (failed check-only prerequisites); no stage runs. */
  startGuard?: Guard | null;
}

export interface LoopResult {
  termination: LoopTermination;
  cost: number;
  stagesRun: number;
}

type StageDecision = Extract<PickerDecision, { kind: "stage" }>;

interface Cycle {
  number: number;
  entry: ResolvedEntry;
  cost: number;
}

async function dispatch(
  ctx: OrchestrationContext,
  deps: LoopDeps,
  d: StageDecision,
  cycleNumber: number,
): Promise<{ cost: number; implement: ImplementResult | null; limitHit: LimitHit | null }> {
  const { entry, stage } = d;
  if (stage === "implement") {
    const r = await runImplement(deps, entry, d.taskPhase ?? 1, cycleNumber);
    return { cost: r.cost, implement: r, limitHit: r.limitHit };
  }
  if (stage === "verify") {
    const r = await runVerify(deps, entry, cycleNumber);
    return { cost: r.cost, implement: null, limitHit: r.limitHit };
  }
  const r = await runStage({
    config: deps.config,
    prompt: buildStagePrompt(deps.queue, entry, ctx.projectDir, stage),
    runId: deps.runId,
    cycleNumber,
    step: stage,
    specDir: entry.specDir,
    env: stageEnv(entry, stage, deps.kind),
    entryId: entry.id,
  });
  return { cost: r.cost, implement: null, limitHit: r.limitHit };
}

function emitDecision(ctx: OrchestrationContext, runId: string, d: PickerDecision): void {
  ctx.emit({
    type: "stage_decision",
    runId,
    cycleNumber: d.kind === "complete" ? 0 : d.entry.index + 1,
    entryId: d.kind === "complete" ? "" : d.entry.id,
    stage: d.kind === "stage" ? d.stage : null,
    decision: d.kind,
    reason:
      d.kind === "complete"
        ? "every entry is done or skipped"
        : d.kind === "stage"
          ? d.reason
          : d.detail,
  });
  ctx.rlog.run(
    "INFO",
    `loop: decision ${d.kind}`,
    d.kind === "complete"
      ? {}
      : {
          entryId: d.entry.id,
          ...(d.kind === "stage"
            ? { stage: d.stage, taskPhase: d.taskPhase ?? null, reason: d.reason }
            : { detail: d.detail }),
        },
  );
}

function closeCycle(ctx: OrchestrationContext, runId: string, c: Cycle, decision: string): void {
  ctx.emit({
    type: "loop_cycle_completed",
    runId,
    cycleNumber: c.number,
    decision,
    featureName: c.entry.title,
    specDir: c.entry.specDir,
    costUsd: c.cost,
  });
}

/** Emits the cycle events when the picker moves to another entry. */
function enterCycle(
  ctx: OrchestrationContext,
  runId: string,
  current: Cycle | null,
  entry: ResolvedEntry,
): Cycle {
  if (current?.entry.id === entry.id) return current;
  if (current) closeCycle(ctx, runId, current, "done");
  const next: Cycle = { number: entry.index + 1, entry, cost: 0 };
  ctx.emit({ type: "loop_cycle_started", runId, cycleNumber: next.number });
  ctx.state.currentCycle = next.number;
  return next;
}

function pause(
  ctx: OrchestrationContext,
  runId: string,
  entry: ResolvedEntry | null,
  guard: Guard,
): void {
  recordPause(
    { projectDir: ctx.projectDir, runId, emit: ctx.emit },
    entry?.id ?? null,
    guard.reason,
    guard.detail,
  );
  mutateState(ctx.projectDir, (s) => ({
    ...s,
    status: "paused",
    pauseReason: guard.reason,
    pauseDetail: guard.detail,
    pausedAt: new Date().toISOString(),
  }));
  ctx.emit({ type: "paused", runId, reason: guard.reason, detail: guard.detail });
  ctx.rlog.run("WARN", `loop: paused (${guard.reason}) — ${guard.detail}`);
}

/** HEAD before a stage, for the frozen check; null in a repository with no commit yet. */
function headOrNull(projectDir: string): string | null {
  try {
    return getHeadSha(projectDir);
  } catch {
    return null;
  }
}

async function budgetLeft(ctx: OrchestrationContext): Promise<boolean> {
  const spent = (await loadState(ctx.projectDir))?.cumulativeCostUsd ?? 0;
  return runBudgetLeft(spent, ctx.policy.limits);
}

/** The guards between the picker's choice and the stage (research R9). */
async function decisionGuard(
  ctx: OrchestrationContext,
  deps: LoopDeps,
  d: PickerDecision,
  last: LastStage | null,
): Promise<Guard | null> {
  if (d.kind === "pause") return { reason: d.reason, detail: d.detail };
  if (d.kind !== "stage") return null;
  const counters = (await loadState(ctx.projectDir))?.counters ?? {};
  const limits = ctx.policy.limits;
  const stuck = progressCheck(last, d, counters, limits);
  if (stuck || (d.stage !== "implement" && d.stage !== "verify")) return stuck;
  const input = { projectDir: ctx.projectDir, queue: deps.queue, runBranch: deps.runBranch };
  return verifyRoundsCheck(d, verifyRoundsOf(input, d.entry), limits);
}

/** The policy's preflight commands and extra checkouts (research R12). */
async function preflightGuard(ctx: OrchestrationContext): Promise<Guard | null> {
  const log = (level: "INFO" | "WARN", msg: string, data?: unknown) =>
    ctx.rlog.run(level, msg, data);
  const failure =
    (await runPreflight(ctx.policy, ctx.projectDir, log)) ?? checkRepos(ctx.policy, ctx.projectDir);
  return failure ? { reason: "preflight_failed", detail: failure } : null;
}

/** Right before a stage: preflight for implement and verify, then the branch switch (research R4). */
async function beforeStage(
  ctx: OrchestrationContext,
  deps: LoopDeps,
  d: StageDecision,
): Promise<Guard | null> {
  if (d.stage === "implement" || d.stage === "verify") {
    const failed = await preflightGuard(ctx);
    if (failed) return failed;
  }
  const prep = prepareBranch(ctx.projectDir, d.entry, deps.kind);
  if (prep.kind === "dirty") {
    return {
      reason: "dirty_tree",
      detail: `${d.entry.id} · ${d.stage} needs branch ${prep.target}, but the tree has uncommitted files: ${prep.files.join(", ")}`,
    };
  }
  if (prep.switched)
    ctx.rlog.run("INFO", `loop: switched to ${prep.branch} for ${d.entry.id} · ${d.stage}`);
  return null;
}

type StageOutcome =
  /** The agent ran; `after` is a pause the frozen check found once it finished. */
  | { kind: "ran"; cost: number; implement: ImplementResult | null; after: Guard | null }
  /** A check before the stage paused the run; no agent started. */
  | { kind: "blocked"; guard: Guard }
  /** The stage threw because Stop aborted it. */
  | { kind: "stopped" }
  | { kind: "failed" };

/** One stage: the checks before it, the agent, and the dirty-tree and frozen checks after it. */
async function runOneStage(
  ctx: OrchestrationContext,
  deps: LoopDeps,
  d: StageDecision,
  cycle: Cycle,
): Promise<StageOutcome> {
  const stageStartSha = headOrNull(ctx.projectDir);
  let r: Awaited<ReturnType<typeof dispatch>>;
  try {
    const blocked = await beforeStage(ctx, deps, d);
    if (blocked) return { kind: "blocked", guard: blocked };
    r = await dispatch(ctx, deps, d, cycle.number);
  } catch (err) {
    if (ctx.abort.signal.aborted) return { kind: "stopped" };
    const message = err instanceof Error ? err.message : String(err);
    ctx.rlog.run("ERROR", `loop: ${d.stage} failed for ${d.entry.id}: ${message}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    ctx.emit({ type: "error", message: `${d.entry.id} · ${d.stage} failed: ${message}` });
    return { kind: "failed" };
  }
  const dirty = leftUncommitted(ctx.projectDir);
  if (dirty.length > 0)
    ctx.emit({ type: "tree_dirty", runId: deps.runId, cycleNumber: cycle.number, files: dirty });
  // A gate is for a stage that finished: not one that Stop or a limit cut short.
  const finished = !ctx.abort.signal.aborted && r.limitHit === null;
  const after =
    frozenCheck(ctx.projectDir, ctx.policy.frozen, stageStartSha) ??
    limitCheck(r.limitHit, d, ctx.policy.limits, deps.config.maxTurns) ??
    (finished ? gateCheck(d.entry, d.stage) : null);
  return { kind: "ran", cost: r.cost, implement: r.implement, after };
}

function terminate(
  ctx: OrchestrationContext,
  deps: LoopDeps,
  reason: TerminationReason,
  cost: number,
  stagesRun: number,
): LoopResult {
  const view = describeQueue({
    projectDir: ctx.projectDir,
    queue: deps.queue,
    runBranch: deps.runBranch,
  });
  const titles = (status: string) =>
    view.entries.filter((e) => e.status === status).map((e) => e.title);
  const termination: LoopTermination = {
    reason,
    cyclesCompleted: titles("done").length,
    totalCostUsd: cost,
    totalDurationMs: 0,
    featuresCompleted: titles("done"),
    featuresSkipped: titles("skipped"),
  };
  ctx.emit({ type: "loop_terminated", runId: deps.runId, termination });
  ctx.rlog.run("INFO", `loop: terminated — ${reason} after ${stagesRun} stage(s)`);
  return { termination, cost, stagesRun };
}

/** Runs the queue until it is complete, the run pauses, or Stop. */
export async function runQueueLoop(ctx: OrchestrationContext, deps: LoopDeps): Promise<LoopResult> {
  const { runId } = deps;
  let last: LastStage | null = null;
  let cycle: Cycle | null = null;
  let cost = 0;
  let stagesRun = 0;
  let reason: TerminationReason = "user_abort";

  const startGuard = deps.startGuard ?? (await preflightGuard(ctx));
  if (startGuard) {
    pause(ctx, runId, null, startGuard);
    reason = "paused";
  }
  while (!startGuard && !ctx.abort.signal.aborted) {
    if (!(await budgetLeft(ctx))) {
      reason = "budget_exceeded";
      break;
    }
    const d = pickNext({
      projectDir: ctx.projectDir,
      queue: deps.queue,
      runBranch: deps.runBranch,
    });
    emitDecision(ctx, runId, d);
    if (d.kind === "complete") {
      reason = "queue_complete";
      break;
    }
    const guard = await decisionGuard(ctx, deps, d, last);
    if (guard) {
      pause(ctx, runId, d.entry, guard);
      reason = "paused";
      break;
    }
    if (d.kind !== "stage") break;
    cycle = enterCycle(ctx, runId, cycle, d.entry);
    const outcome = await runOneStage(ctx, deps, d, cycle);
    if (outcome.kind === "stopped") break;
    if (outcome.kind === "failed") {
      reason = "failed";
      break;
    }
    if (outcome.kind === "blocked") {
      pause(ctx, runId, d.entry, outcome.guard);
      reason = "paused";
      break;
    }
    cost += outcome.cost;
    cycle.cost += outcome.cost;
    stagesRun++;
    last = { entryId: d.entry.id, stage: d.stage, taskPhase: d.taskPhase ?? null };
    // A stopped stage still cost money, but it says nothing about progress.
    recordStage(
      ctx.projectDir,
      last,
      outcome.cost,
      ctx.abort.signal.aborted ? null : outcome.implement,
    );
    if (outcome.after) {
      pause(ctx, runId, d.entry, outcome.after);
      reason = "paused";
      break;
    }
    // `dex run --once`: one stage, then stop like Stop does (Resume continues).
    if (deps.config.once) break;
  }

  if (ctx.abort.signal.aborted) reason = "user_abort";
  if (cycle) {
    const decision =
      reason === "queue_complete" ? "done" : reason === "user_abort" ? "stopped" : reason;
    closeCycle(ctx, runId, cycle, decision);
  }
  return terminate(ctx, deps, reason, cost, stagesRun);
}
