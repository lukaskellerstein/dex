import type { RunRecord } from "../../core/runs.js";
import type { StepType } from "../../core/types.js";
import type { ImplementSubPhase, UiLoopCycle, UiLoopStage } from "./useOrchestrator.js";

export interface LoopStateRebuild {
  preCycleStages: UiLoopStage[];
  loopCycles: UiLoopCycle[];
  totalCost: number;
}

/**
 * Reconstruct the loop dashboard's state (pre-cycle stages, per-cycle stages
 * with nested implement sub-phases, and aggregate cost) from a persisted
 * RunRecord. Used on mount/HMR so the UI re-hydrates without waiting for
 * live events.
 *
 * Pure data transformation — no React, no setters, no IO. Easy to unit-test.
 */
export function buildLoopStateFromRun(
  runData: RunRecord,
  currentCycle: number | null,
): LoopStateRebuild {
  const loopTraces = runData.agentRuns.filter((pt) => pt.taskPhaseName.startsWith("loop:"));
  const implTraces = runData.agentRuns.filter((pt) => !pt.taskPhaseName.startsWith("loop:"));

  const preCycleStages: UiLoopStage[] = [];
  const cycleMap = new Map<number, UiLoopStage[]>();

  for (const pt of loopTraces) {
    const stageType = pt.taskPhaseName.replace("loop:", "") as StepType;
    const stage: UiLoopStage = {
      type: stageType,
      status:
        pt.status === "completed"
          ? "completed"
          : pt.status === "stopped"
            ? "stopped"
            : pt.status === "running"
              ? "running"
              : "failed",
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
      const existing = cycleMap.get(pt.taskPhaseNumber) ?? [];
      existing.push(stage);
      cycleMap.set(pt.taskPhaseNumber, existing);
    }
  }

  // Group implement sub-phases by specDir (each cycle has a unique specDir).
  const implBySpecDir = new Map<string, ImplementSubPhase[]>();
  for (const pt of implTraces) {
    const sd = pt.specDir || "";
    if (!sd) continue;
    const existing = implBySpecDir.get(sd) ?? [];
    existing.push({
      taskPhaseNumber: pt.taskPhaseNumber,
      taskPhaseName: pt.taskPhaseName,
      agentRunId: pt.agentRunId,
      status:
        pt.status === "completed" ? "completed" : pt.status === "stopped" ? "stopped" : "running",
      costUsd: pt.costUsd ?? 0,
      durationMs: pt.durationMs ?? 0,
    });
    implBySpecDir.set(sd, existing);
  }

  const loopCycles: UiLoopCycle[] = [];
  for (const [cycleNumber, stages] of Array.from(cycleMap.entries()).sort((a, b) => a[0] - b[0])) {
    const isActive = cycleNumber === currentCycle;
    const allCompleted = stages.every((s) => s.status === "completed");
    const specDir = stages.find((s) => s.specDir)?.specDir ?? null;
    const implPhases = specDir ? (implBySpecDir.get(specDir) ?? []) : [];
    loopCycles.push({
      cycleNumber,
      featureName: specDir,
      specDir,
      decision: null,
      status: isActive && !allCompleted ? "running" : "completed",
      costUsd: stages.reduce((sum, s) => sum + s.costUsd, 0),
      stages,
      implementPhases: implPhases,
      startedAt: stages[0]?.startedAt ?? new Date().toISOString(),
    });
  }

  const allStages = [...preCycleStages, ...Array.from(cycleMap.values()).flat()];
  const totalCost = allStages.reduce((sum, s) => sum + s.costUsd, 0);

  return { preCycleStages, loopCycles, totalCost };
}
