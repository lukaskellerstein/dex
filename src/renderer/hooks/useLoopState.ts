/**
 * What: Owns loop-cycle progression state — preCycleStages, loopCycles, currentCycle, currentStage, totalCost, loopTermination.
 * Not: Does not own live-step data (useLiveTrace), user-question state (useUserQuestion), or run-session metadata (useRunSession). Does not call IPC; subscribes to events only.
 * Deps: orchestratorService.subscribeEvents, OrchestratorEvent / StepType / LoopTermination types.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  OrchestratorEvent,
  StepType,
  LoopTermination,
} from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

// Re-export the cycle/stage shapes consumed by the renderer.
export interface UiLoopStage {
  type: StepType;
  status: "running" | "completed" | "failed" | "stopped";
  agentRunId: string;
  specDir?: string;
  costUsd: number;
  durationMs: number;
  startedAt: string;
  completedAt?: string;
}

export interface ImplementSubPhase {
  taskPhaseNumber: number;
  taskPhaseName: string;
  agentRunId: string;
  status: "running" | "completed" | "stopped";
  costUsd: number;
  durationMs: number;
}

export interface UiLoopCycle {
  cycleNumber: number;
  featureName: string | null;
  specDir: string | null;
  decision: string | null;
  status: "running" | "completed" | "skipped" | "failed";
  costUsd: number;
  stages: UiLoopStage[];
  implementPhases: ImplementSubPhase[];
  startedAt: string;
}

export interface UseLoopStateResult {
  // primary state
  preCycleStages: UiLoopStage[];
  loopCycles: UiLoopCycle[];
  currentCycle: number | null;
  currentStage: StepType | null;
  totalCost: number;
  loopTermination: LoopTermination | null;
  // refs for cross-hook reads (primarily useLiveTrace consumes currentCycleRef/currentStageRef)
  currentCycleRef: React.MutableRefObject<number | null>;
  currentStageRef: React.MutableRefObject<StepType | null>;
  // imperative setters used by the composer's load* / switchToLive helpers
  setPreCycleStages: React.Dispatch<React.SetStateAction<UiLoopStage[]>>;
  setLoopCycles: React.Dispatch<React.SetStateAction<UiLoopCycle[]>>;
  setCurrentCycle: (n: number | null) => void;
  setCurrentStage: (s: StepType | null) => void;
  setTotalCost: React.Dispatch<React.SetStateAction<number>>;
  setLoopTermination: (t: LoopTermination | null) => void;
}

export function useLoopState(): UseLoopStateResult {
  const [preCycleStages, setPreCycleStages] = useState<UiLoopStage[]>([]);
  const [loopCycles, setLoopCycles] = useState<UiLoopCycle[]>([]);
  const [currentCycle, setCurrentCycleState] = useState<number | null>(null);
  const [currentStage, setCurrentStageState] = useState<StepType | null>(null);
  const [totalCost, setTotalCost] = useState(0);
  const [loopTermination, setLoopTermination] = useState<LoopTermination | null>(null);

  // Internal refs that mirror cycle/stage state for synchronous reads inside event handlers.
  const currentCycleRef = useRef<number | null>(null);
  const currentStageRef = useRef<StepType | null>(null);
  // Internal mode ref — captured from run_started; used to gate impl sub-phase tracking.
  const modeRef = useRef<string | null>(null);

  const setCurrentCycle = useCallback((n: number | null) => {
    setCurrentCycleState(n);
    currentCycleRef.current = n;
  }, []);

  const setCurrentStage = useCallback((s: StepType | null) => {
    setCurrentStageState(s);
    currentStageRef.current = s;
  }, []);

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      switch (event.type) {
        case "run_started":
          modeRef.current = event.config.mode;
          setCurrentCycle(null);
          setCurrentStage(null);
          setLoopTermination(null);
          setLoopCycles([]);
          setPreCycleStages([]);
          setTotalCost(0);
          break;

        case "task_phase_started":
          // Track implement sub-phases inside the active loop cycle.
          if (
            modeRef.current === "loop" &&
            currentCycleRef.current != null &&
            currentStageRef.current === "implement"
          ) {
            setLoopCycles((prev) =>
              prev.map((c) =>
                c.cycleNumber === currentCycleRef.current
                  ? {
                      ...c,
                      implementPhases: [
                        ...c.implementPhases,
                        {
                          taskPhaseNumber: event.taskPhase.number,
                          taskPhaseName: event.taskPhase.name,
                          agentRunId: event.agentRunId,
                          status: "running" as const,
                          costUsd: 0,
                          durationMs: 0,
                        },
                      ],
                    }
                  : c,
              ),
            );
          }
          break;

        case "task_phase_completed":
          setTotalCost((prev) => prev + event.cost);
          if (
            modeRef.current === "loop" &&
            currentCycleRef.current != null &&
            currentStageRef.current === "implement"
          ) {
            setLoopCycles((prev) =>
              prev.map((c) =>
                c.cycleNumber === currentCycleRef.current
                  ? {
                      ...c,
                      implementPhases: c.implementPhases.map((ip) =>
                        ip.taskPhaseNumber === event.taskPhase.number
                          ? {
                              ...ip,
                              status: "completed" as const,
                              costUsd: event.cost,
                              durationMs: event.durationMs,
                            }
                          : ip,
                      ),
                    }
                  : c,
              ),
            );
          }
          break;

        case "run_completed":
          setTotalCost(event.totalCost);
          setCurrentCycle(null);
          setCurrentStage(null);
          break;

        case "loop_cycle_started":
          setCurrentCycle(event.cycleNumber);
          setLoopCycles((prev) => [
            ...prev,
            {
              cycleNumber: event.cycleNumber,
              featureName: null,
              specDir: null,
              decision: null,
              status: "running",
              costUsd: 0,
              stages: [],
              implementPhases: [],
              startedAt: new Date().toISOString(),
            },
          ]);
          break;

        case "loop_cycle_completed":
          setLoopCycles((prev) =>
            prev.map((c) =>
              c.cycleNumber === event.cycleNumber
                ? {
                    ...c,
                    // "stopped" → render as paused via "running" status (legacy contract)
                    status:
                      event.decision === "skipped"
                        ? ("skipped" as const)
                        : event.decision === "stopped"
                          ? ("running" as const)
                          : ("completed" as const),
                    featureName: event.featureName,
                    specDir: event.specDir,
                    decision: event.decision,
                    costUsd: event.costUsd,
                  }
                : c,
            ),
          );
          break;

        case "step_started": {
          setCurrentStage(event.step);
          const newStage: UiLoopStage = {
            type: event.step,
            status: "running" as const,
            agentRunId: event.agentRunId,
            specDir: event.specDir,
            costUsd: 0,
            durationMs: 0,
            startedAt: new Date().toISOString(),
          };
          if (event.cycleNumber === 0) {
            setPreCycleStages((prev) => [...prev, newStage]);
          } else {
            setLoopCycles((prev) =>
              prev.map((c) =>
                c.cycleNumber === event.cycleNumber
                  ? {
                      ...c,
                      stages: [...c.stages, newStage],
                      ...(event.specDir && !c.specDir ? { specDir: event.specDir } : {}),
                    }
                  : c,
              ),
            );
          }
          break;
        }

        case "step_completed": {
          setTotalCost((prev) => prev + event.costUsd);
          const stageStatus: UiLoopStage["status"] = event.stopped ? "stopped" : "completed";
          const updateStage = (s: UiLoopStage): UiLoopStage =>
            s.agentRunId === event.agentRunId
              ? {
                  ...s,
                  status: stageStatus,
                  costUsd: event.costUsd,
                  durationMs: event.durationMs,
                  completedAt: new Date().toISOString(),
                }
              : s;
          if (event.cycleNumber === 0) {
            setPreCycleStages((prev) => prev.map(updateStage));
          } else {
            setLoopCycles((prev) =>
              prev.map((c) =>
                c.cycleNumber === event.cycleNumber
                  ? { ...c, stages: c.stages.map(updateStage) }
                  : c,
              ),
            );
          }
          break;
        }

        case "loop_terminated":
          // user_abort is treated as a pause (resumable), not a terminal state.
          if (event.termination.reason !== "user_abort") {
            setLoopTermination(event.termination);
          }
          break;
      }
    });
    return unsub;
  }, [setCurrentCycle, setCurrentStage]);

  return {
    preCycleStages,
    loopCycles,
    currentCycle,
    currentStage,
    totalCost,
    loopTermination,
    currentCycleRef,
    currentStageRef,
    setPreCycleStages,
    setLoopCycles,
    setCurrentCycle,
    setCurrentStage,
    setTotalCost,
    setLoopTermination,
  };
}
