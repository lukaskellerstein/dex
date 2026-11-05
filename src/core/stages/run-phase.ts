/**
 * What: Build-mode phase runner — `runPhase` drives one TaskPhase via the resolved agent runner, with `RunTaskState` tracking task statuses (on-disk reconciliation; the runner re-emits tasks.md writes itself) and `buildPrompt` producing the prompt: Build mode uses the loop's implement prompt (prompts.buildImplementPrompt) for the spec folder's queue entry — so build mode keeps that entry's `tasks` scope (`buildEntry`) — or for a one-off entry when the folder is in no queue; Plan mode `speckit-plan`.
 * Not: Does not own per-cycle stage execution (that's stages/run-stage.ts). Does not run the build-mode dispatcher itself (stages/build.ts iterates specs and calls runPhase). Does not parse tasks.md from disk — RunTaskState only reconciles a fresh parse handed in by callers.
 * Deps: getActiveContext (for runner/abort), parser.deriveTaskPhaseStatus, prompts.buildImplementPrompt, queue.entryForSpecDir, git.getCurrentBranch, types.{RunConfig, TaskPhase, Task, EmitFn}, log.RunLogger.
 */

import path from "node:path";
import { buildImplementPrompt } from "../entry-prompts.js";
import { getCurrentBranch } from "../git.js";
import type { RunLogger } from "../log.js";
import { getActiveContext } from "../orchestrator.js";
import { deriveTaskPhaseStatus } from "../parser.js";
import { entryForSpecDir, loadQueue, type ResolvedEntry, resolveEntries } from "../queue.js";
import type { EmitFn, RunConfig, Task, TaskPhase } from "../types.js";

const STATUS_RANK: Record<string, number> = {
  not_done: 0,
  code_exists: 1,
  in_progress: 2,
  done: 3,
};

// 011-A4: in-memory task state — on-disk reconciliation. Kept
// alongside runPhase since RunTaskState only matters during phase execution.
export class RunTaskState {
  private phases: TaskPhase[];
  private taskMap: Map<string, Task>;

  constructor(initialPhases: TaskPhase[]) {
    // Deep-clone so mutations don't affect the caller's data
    this.phases = JSON.parse(JSON.stringify(initialPhases));
    this.taskMap = new Map();
    for (const p of this.phases) {
      for (const t of p.tasks) {
        this.taskMap.set(t.id, t);
      }
    }
  }

  /**
   * Re-read tasks.md from disk and reconcile with in-memory state.
   * Promote-only: a task that is "done" on disk but "not_done" in memory
   * gets promoted; nothing is ever demoted.
   */
  reconcileFromDisk(freshPhases: TaskPhase[]): TaskPhase[] {
    for (const freshPhase of freshPhases) {
      for (const freshTask of freshPhase.tasks) {
        const memTask = this.taskMap.get(freshTask.id);
        if (memTask && STATUS_RANK[freshTask.status] > STATUS_RANK[memTask.status]) {
          memTask.status = freshTask.status;
        }
      }
    }

    for (const p of this.phases) {
      p.status = deriveTaskPhaseStatus(p.tasks);
    }

    return this.phases;
  }

  getPhases(): TaskPhase[] {
    return this.phases;
  }

  getIncompletePhases(filter: "all" | number[]): TaskPhase[] {
    if (filter === "all") {
      return this.phases.filter((p) => p.status !== "complete");
    }
    return this.phases.filter((p) => filter.includes(p.number) && p.status !== "complete");
  }
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

/**
 * The queue entry the spec folder belongs to, so build mode keeps its task
 * scope; a one-off entry (no scope) when the folder is in no queue.
 */
export function buildEntry(config: RunConfig): ResolvedEntry {
  const branch = getCurrentBranch(config.projectDir);
  const queue = loadQueue(config.projectDir);
  const target = path.resolve(config.projectDir, config.specDir);
  const found = queue
    ? resolveEntries(queue, branch, null).find(
        (e) => path.resolve(config.projectDir, e.specDir) === target,
      )
    : undefined;
  return found ?? entryForSpecDir(config.specDir, branch);
}

export function buildPrompt(
  config: RunConfig,
  phase: TaskPhase,
  entry: ResolvedEntry = buildEntry(config),
): string {
  if (config.mode !== "plan") {
    return buildImplementPrompt(entry, config.projectDir, { phase, goalPath: null });
  }
  const specPath = path.isAbsolute(config.specDir)
    ? config.specDir
    : path.join(config.projectDir, config.specDir);
  return `/speckit-plan ${specPath} --phase ${phase.number}

After analyzing:
- Update ${specPath}/tasks.md with accurate task statuses
- If you learned operational patterns, update CLAUDE.md
- Commit your changes as this project's rules say (CLAUDE.md, AGENTS.md, CONTRIBUTING). If the rules say nothing about commits, make one commit with a short message that names ${entry.id}.`;
}

// ── Phase Runner ────────────────────────────────────────────────────────────

export async function runPhase(
  config: RunConfig,
  phase: TaskPhase,
  agentRunId: string,
  runId: string,
  emit: EmitFn,
  rlog: RunLogger,
): Promise<{ cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  const ctx = getActiveContext();
  if (!ctx) {
    throw new Error("runPhase called before currentContext was resolved — run() must set it");
  }
  const entry = buildEntry(config);
  const prompt = buildPrompt(config, phase, entry);

  return ctx.runner.runTaskPhase({
    config,
    prompt,
    entryId: entry.id,
    runId,
    taskPhase: phase,
    agentRunId,
    abortController: ctx.abort,
    emit,
    rlog,
    policy: ctx.policy,
  });
}
