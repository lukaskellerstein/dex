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

/**
 * Optimistic next-stage map used to close the ~200ms gap between
 * `step_completed` for stage X and `step_started` for the next stage —
 * during that window the orchestrator is committing the post-stage
 * checkpoint and no event has updated `currentStage` yet, so the UI
 * would otherwise briefly show NO stage as running. Mirrors the actual
 * sequence the orchestrator emits, NOT the raw STEP_ORDER (e.g.
 * `implement` is followed by `verify`, not `implement_fix`, because
 * `implement_fix` only fires inside a verify-failure retry loop).
 */
const NEXT_STAGE_AFTER: Partial<Record<StepType, StepType>> = {
  prerequisites: "clarification_product",
  clarification_product: "clarification_technical",
  clarification_technical: "clarification_synthesis",
  clarification_synthesis: "constitution",
  constitution: "manifest_extraction",
  manifest_extraction: "gap_analysis",
  gap_analysis: "specify",
  specify: "plan",
  plan: "tasks",
  tasks: "implement",
  implement: "verify",
  implement_fix: "verify",
  verify: "learnings",
  // After learnings the next event is the next cycle's gap_analysis,
  // which arrives via its own step_started — no optimistic advance.
};

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

        case "loop_reset":
          // Fired after a successful squash-merge to main — the just-shipped
          // run's state is no longer relevant; the Steps tab should fall back
          // to the "no run yet" view so the user can pick another spec.
          modeRef.current = null;
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
          // GAPS_COMPLETE means the orchestrator opened a cycle (incremented
          // cycleNumber + emitted `loop_cycle_started`) only to discover via
          // gap_analysis that no features remain. There's no real work in
          // this cycle — drop it from the UI instead of rendering an empty
          // ghost row labelled "gaps complete". The "all 3 features done"
          // story is told by the surrounding `loop_terminated` event.
          if (event.decision === "GAPS_COMPLETE") {
            setLoopCycles((prev) => prev.filter((c) => c.cycleNumber !== event.cycleNumber));
            break;
          }
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
          // Optimistically advance currentStage so the about-to-start
          // stage flips to "running" without waiting for `step_started`
          // — closes the post-checkpoint gap window. Skipped on stop so
          // a paused cycle doesn't briefly highlight a phantom "next"
          // stage. Overwritten the moment the real `step_started` fires.
          if (!event.stopped) {
            const next = NEXT_STAGE_AFTER[event.step];
            if (next) setCurrentStage(next);
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
