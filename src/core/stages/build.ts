/**
 * What: Build-mode runner — iterates over the requested spec dirs (one or many) and drives `runPhase` for every incomplete task phase, recording task_phase_started/completed events plus runs-table audit entries. Stops on user_abort or per-spec failure.
 * Not: Does not run the autonomous loop (that's stages/main-loop.ts). Does not own per-spec / per-phase parsing — delegates to parser.parseTasksFile and RunTaskState. Does not call clarification or prerequisites — those are loop-mode-only.
 * Deps: OrchestrationContext, runPhase + RunTaskState + listSpecDirs + isSpecComplete (orchestrator.ts; circular but call-time-safe), parser.parseTasksFile, runs.startAgentRun/completeAgentRun.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import type { RunConfig, EmitFn } from "../types.js";
import type { RunLogger } from "../log.js";
import * as runs from "../runs.js";
import { parseTasksFile } from "../parser.js";
// Circular import: orchestrator.ts hosts these top-level helpers and runPhase
// itself; both sides export only functions/classes so ESM init is safe.
import {
  listSpecDirs,
  isSpecComplete,
  RunTaskState,
  runPhase,
} from "../orchestrator.js";

export async function runBuild(
  ctx: OrchestrationContext,
  deps: {
    config: RunConfig;
    runId: string;
    rlog: RunLogger;
  },
): Promise<{ taskPhasesCompleted: number; totalCost: number }> {
  const { config, runId, rlog } = deps;
  const emit: EmitFn = ctx.emit;
  const abort = ctx.abort;
  const state = ctx.state;

  let taskPhasesCompleted = 0;
  let totalCost = 0;
  const runStart = Date.now();

  // Determine which specs to process
  const specDirs = config.runAllSpecs
    ? listSpecDirs(config.projectDir).filter(
        (s) => !isSpecComplete(config.projectDir, s),
      )
    : [config.specDir];

  if (specDirs.length === 0) {
    rlog.run("INFO", "runBuild: no unfinished specs found");
    return { taskPhasesCompleted, totalCost };
  }

  rlog.run("INFO", `runBuild: will process ${specDirs.length} spec(s)`, { specDirs });

  for (const specDir of specDirs) {
    if (abort.signal.aborted) break;

    const specConfig = { ...config, specDir };

    emit({ type: "spec_started", specDir });
    state.specDir = specDir;
    rlog.run("INFO", `runBuild: starting spec ${specDir}`);

    const initialPhases = parseTasksFile(config.projectDir, specDir);
    const runTaskState = new RunTaskState(initialPhases);

    let iteration = 0;
    let specFailed = false;

    while (iteration < config.maxIterations) {
      if (abort.signal.aborted) break;

      const targetPhases = runTaskState.getIncompletePhases(config.taskPhases);

      const phase = targetPhases[0];
      if (!phase) break;

      const agentRunId = crypto.randomUUID();
      runs.startAgentRun(config.projectDir, runId, {
        agentRunId,
        runId,
        specDir,
        taskPhaseNumber: phase.number,
        taskPhaseName: phase.name,
        step: null,
        cycleNumber: null,
        featureSlug: path.basename(specDir),
        startedAt: new Date().toISOString(),
        status: "running",
      });

      rlog.startAgentRun(phase.number, phase.name, agentRunId);
      state.agentRunId = agentRunId;
      state.taskPhaseNumber = phase.number;
      state.taskPhaseName = phase.name;
      emit({ type: "task_phase_started", taskPhase: phase, iteration, agentRunId });
      emit({ type: "tasks_updated", taskPhases: runTaskState.getPhases() });

      try {
        const result = await runPhase(specConfig, phase, agentRunId, runId, emit, rlog, runTaskState);

        runs.completeAgentRun(config.projectDir, runId, agentRunId, {
          status: "completed",
          costUsd: result.cost,
          durationMs: result.durationMs,
          inputTokens: result.inputTokens || null,
          outputTokens: result.outputTokens || null,
        });

        taskPhasesCompleted++;
        totalCost += result.cost;

        const freshPhases = parseTasksFile(config.projectDir, specDir);
        const reconciledPhases = runTaskState.reconcileFromDisk(freshPhases);
        emit({ type: "tasks_updated", taskPhases: reconciledPhases });

        emit({
          type: "task_phase_completed",
          taskPhase: { ...phase, status: "complete" },
          cost: result.cost,
          durationMs: result.durationMs,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        rlog.agentRun("ERROR", `Phase ${phase.number} failed: ${message}`, { stack });
        rlog.run("ERROR", `Phase ${phase.number} failed: ${message}`);
        runs.completeAgentRun(config.projectDir, runId, agentRunId, {
          status: "failed",
          costUsd: 0,
          durationMs: Date.now() - runStart,
        });
        emit({
          type: "error",
          message: `Phase ${phase.number} failed: ${message}`,
          taskPhaseNumber: phase.number,
        });
        specFailed = true;
        break;
      }

      iteration++;
    }

    if (!specFailed && !abort.signal.aborted) {
      rlog.run("INFO", `runBuild: spec ${specDir} completed`);
      emit({ type: "spec_completed", specDir, taskPhasesCompleted });
    }

    if (specFailed) break;
  }

  return { taskPhasesCompleted, totalCost };
}
