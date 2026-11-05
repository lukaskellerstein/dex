import type { AgentRunRecord, RunRecord } from "../../core/runs.js";
import type { StepType } from "../../core/types.js";
import type { ImplementSubPhase, UiLoopCycle, UiLoopStage } from "./useLoopState.js";

export interface LoopStateRebuild {
  preCycleStages: UiLoopStage[];
  loopCycles: UiLoopCycle[];
  totalCost: number;
}

const isLoopStage = (pt: AgentRunRecord) => pt.taskPhaseName.startsWith("loop:");

/**
 * An agent run's status as the dashboard shows it. A run that ended (paused,
 * stopped, crashed) cannot still be running one: that record is stopped.
 */
function statusOf(pt: AgentRunRecord, runEnded: boolean): UiLoopStage["status"] {
  if (pt.status === "completed") return "completed";
  if (pt.status === "stopped") return "stopped";
  if (pt.status === "running") return runEnded ? "stopped" : "running";
  return "failed";
}

/** The highest entry (cycle) number the run reached; null before the first entry. */
export function lastCycleOf(runData: RunRecord): number | null {
  const cycles = runData.agentRuns.filter(isLoopStage).map((pt) => pt.taskPhaseNumber);
  const last = Math.max(0, ...cycles);
  return last > 0 ? last : null;
}

/**
 * Reconstruct the loop dashboard's stage history (pre-cycle stages, per-cycle
 * stages with nested implement sub-phases, and the cost of every agent run)
 * from a persisted RunRecord. `activeCycle` is the entry still in progress —
 * the live cycle on mount, or the last one of a run that did not finish.
 *
 * Pure data transformation — no React, no setters, no IO. Easy to unit-test.
 */
export function buildLoopStateFromRun(runData: RunRecord, activeCycle: number | null): LoopStateRebuild {
  const runEnded = runData.status !== "running";
  const preCycleStages: UiLoopStage[] = [];
  const cycleMap = new Map<number, UiLoopStage[]>();

  for (const pt of runData.agentRuns.filter(isLoopStage)) {
    const stage: UiLoopStage = {
      type: pt.taskPhaseName.replace("loop:", "") as StepType,
      status: statusOf(pt, runEnded),
      agentRunId: pt.agentRunId,
      specDir: pt.specDir || undefined,
      costUsd: pt.costUsd ?? 0,
      durationMs: pt.durationMs ?? 0,
      startedAt: pt.startedAt,
      completedAt: pt.endedAt ?? undefined,
    };
    if (pt.taskPhaseNumber === 0) {
      preCycleStages.push(stage);
    } else {
      cycleMap.set(pt.taskPhaseNumber, [...(cycleMap.get(pt.taskPhaseNumber) ?? []), stage]);
    }
  }

  // Group implement sub-phases by specDir (each cycle has a unique specDir).
  const implBySpecDir = new Map<string, ImplementSubPhase[]>();
  for (const pt of runData.agentRuns.filter((a) => !isLoopStage(a))) {
    if (!pt.specDir) continue;
    const status = statusOf(pt, runEnded);
    implBySpecDir.set(pt.specDir, [
      ...(implBySpecDir.get(pt.specDir) ?? []),
      {
        taskPhaseNumber: pt.taskPhaseNumber,
        taskPhaseName: pt.taskPhaseName,
        agentRunId: pt.agentRunId,
        status: status === "failed" ? "stopped" : status,
        costUsd: pt.costUsd ?? 0,
        durationMs: pt.durationMs ?? 0,
      },
    ]);
  }

  const loopCycles: UiLoopCycle[] = [];
  for (const [cycleNumber, stages] of Array.from(cycleMap.entries()).sort((a, b) => a[0] - b[0])) {
    const allCompleted = stages.every((s) => s.status === "completed");
    const specDir = stages.find((s) => s.specDir)?.specDir ?? null;
    const implPhases = specDir ? (implBySpecDir.get(specDir) ?? []) : [];
    const cost = [...stages, ...implPhases].reduce((sum, s) => sum + s.costUsd, 0);
    loopCycles.push({
      cycleNumber,
      featureName: specDir,
      specDir,
      decision: null,
      status: cycleNumber === activeCycle && !allCompleted ? "running" : "completed",
      costUsd: cost,
      stages,
      implementPhases: implPhases,
      startedAt: stages[0]?.startedAt ?? new Date().toISOString(),
    });
  }

  const totalCost = runData.agentRuns.reduce((sum, pt) => sum + (pt.costUsd ?? 0), 0);
  return { preCycleStages, loopCycles, totalCost };
}
