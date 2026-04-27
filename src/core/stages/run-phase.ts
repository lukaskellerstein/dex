/**
 * What: Build-mode phase runner — `runPhase` drives one TaskPhase via the resolved agent runner, with `RunTaskState` tracking task statuses (TodoWrite + on-disk reconciliation) and `buildPrompt` producing the slash-command prompt for either Build (`speckit-implement`) or Plan (`speckit-plan`) modes.
 * Not: Does not own per-cycle stage execution (that's stages/run-stage.ts). Does not run the build-mode dispatcher itself (stages/build.ts iterates specs and calls runPhase). Does not parse tasks.md from disk — RunTaskState only reconciles a fresh parse handed in by callers.
 * Deps: getActiveContext (for runner/abort), parser.{deriveTaskPhaseStatus, extractTaskIds}, types.{RunConfig, TaskPhase, Task, EmitFn}, log.RunLogger.
 */

import type { RunConfig, TaskPhase, Task, EmitFn } from "../types.js";
import type { RunLogger } from "../log.js";
import { deriveTaskPhaseStatus, extractTaskIds } from "../parser.js";
import { getActiveContext } from "../orchestrator.js";

const STATUS_RANK: Record<string, number> = {
  not_done: 0,
  code_exists: 1,
  in_progress: 2,
  done: 3,
};

// 011-A4: in-memory task state — TodoWrite + on-disk reconciliation. Kept
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

  /** Apply TodoWrite statuses. Promotes only (never demotes). Returns current phases. */
  updateFromTodoWrite(
    todos: Array<{ content?: string; status?: string }>,
  ): TaskPhase[] {
    const updates = new Map<string, "in_progress" | "done">();

    for (const todo of todos) {
      if (!todo.content) continue;
      const ids = extractTaskIds(todo.content);
      const mapped =
        todo.status === "completed" ? "done" : todo.status === "in_progress" ? "in_progress" : null;
      if (!mapped) continue;
      for (const id of ids) {
        updates.set(id, mapped);
      }
    }

    if (updates.size === 0) return this.phases;

    for (const [id, newStatus] of updates) {
      const task = this.taskMap.get(id);
      if (task && STATUS_RANK[newStatus] > STATUS_RANK[task.status]) {
        task.status = newStatus;
      }
    }

    // Re-derive phase statuses
    for (const p of this.phases) {
      p.status = deriveTaskPhaseStatus(p.tasks);
    }

    return this.phases;
  }

  /**
   * Re-read tasks.md from disk and reconcile with in-memory state.
   * Promote-only: a task that is "done" on disk but "not_done" in memory
   * gets promoted. A task that is "done" in memory stays "done" even if
   * disk says otherwise (agent may have used TodoWrite earlier).
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
    return this.phases.filter(
      (p) => filter.includes(p.number) && p.status !== "complete",
    );
  }
}

// ── Prompt Builder ──────────────────────────────────────────────────────────

export function buildPrompt(config: RunConfig, phase: TaskPhase): string {
  // Resolve the spec directory to an absolute path so the agent knows exactly
  // which spec to work on (specDir may be relative like "specs/001-product-catalog").
  const specPath = config.specDir.startsWith("/")
    ? config.specDir
    : `${config.projectDir}/${config.specDir}`;

  const skillName = config.mode === "plan" ? "speckit-plan" : "speckit-implement";

  // The prompt starts with the slash command — the SDK harness expands it as
  // a user invocation (disable-model-invocation only blocks the model from
  // calling the Skill tool on its own, not user-invoked slash commands).
  const afterSteps = config.mode === "plan"
    ? `After analyzing:
- Update ${specPath}/tasks.md with accurate task statuses
- If you learned operational patterns, update CLAUDE.md
- Commit: git add -A -- ':!.dex/' && git commit -m "plan: TaskPhase ${phase.number} gap analysis"`
    : `IMPORTANT — update tasks.md incrementally:
- After completing EACH task, immediately mark it [x] in ${specPath}/tasks.md before moving to the next task. This drives a real-time progress UI.

After implementing all tasks:
- Run build/typecheck to verify changes compile
- Run tests if they exist
- Commit: git add -A -- ':!.dex/' && git commit -m "Phase ${phase.number}: ${phase.name}"
- If you learned operational patterns, update CLAUDE.md`;

  return `/${skillName} ${specPath} --phase ${phase.number}

${afterSteps}`;
}

// ── Phase Runner ────────────────────────────────────────────────────────────

export async function runPhase(
  config: RunConfig,
  phase: TaskPhase,
  agentRunId: string,
  runId: string,
  emit: EmitFn,
  rlog: RunLogger,
  runTaskState: RunTaskState,
): Promise<{ cost: number; durationMs: number; inputTokens: number; outputTokens: number }> {
  const ctx = getActiveContext();
  if (!ctx) {
    throw new Error("runPhase called before currentContext was resolved — run() must set it");
  }
  const prompt = buildPrompt(config, phase);

  // Delegate SDK invocation to the resolved agent runner. TodoWrite detection
  // stays here (not in the runner) because runTaskState is orchestrator-owned.
  return ctx.runner.runTaskPhase({
    config,
    prompt,
    runId,
    taskPhase: phase,
    agentRunId,
    abortController: ctx.abort,
    emit,
    rlog,
    onTodoWrite: (todos) => {
      const updatedPhases = runTaskState.updateFromTodoWrite(todos);
      emit({ type: "tasks_updated", taskPhases: updatedPhases });
    },
  });
}
