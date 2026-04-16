import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AgentStep,
  SubagentInfo,
  Phase,
  Task,
  OrchestratorEvent,
  LoopStageType,
  LoopTermination,
  UserInputQuestion,
  PrerequisiteCheck,
} from "../../core/types.js";

export interface PendingQuestion {
  requestId: string;
  questions: UserInputQuestion[];
}

// UI-side accumulated stage/cycle data
export interface UiLoopStage {
  type: LoopStageType;
  status: "running" | "completed" | "failed" | "stopped";
  phaseTraceId: string;
  specDir?: string;
  costUsd: number;
  durationMs: number;
  startedAt: string;
  completedAt?: string;
}

export interface ImplementSubPhase {
  phaseNumber: number;
  phaseName: string;
  phaseTraceId: string;
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

export interface OrchestratorHook {
  liveSteps: AgentStep[];
  subagents: SubagentInfo[];
  currentPhase: Phase | null;
  activeSpecDir: string | null;
  activeTask: Task | null;
  isRunning: boolean;
  viewingHistorical: boolean;
  totalCost: number;
  totalDuration: number;
  phasesCompleted: number;
  currentRunId: string | null;
  currentPhaseTraceId: string | null;
  // Loop-mode state
  mode: string | null;
  currentCycle: number | null;
  currentStage: LoopStageType | null;
  isClarifying: boolean;
  loopTermination: LoopTermination | null;
  loopCycles: UiLoopCycle[];
  preCycleStages: UiLoopStage[];
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  pendingQuestion: PendingQuestion | null;
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
  loadRunHistory: (projectDir: string) => Promise<boolean>;
  loadPhaseTrace: (projectDir: string, specDir: string, phase: Phase) => Promise<boolean>;
  loadStageTrace: (phaseTraceId: string, stageType: LoopStageType, meta?: { costUsd?: number; durationMs?: number }) => Promise<boolean>;
  switchToLive: () => Promise<void>;
  onPhaseCompleted: (cb: () => void) => void;
  onTasksUpdated: (cb: (phases: Phase[]) => void) => void;
}

export function useOrchestrator(): OrchestratorHook {
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [currentPhase, setCurrentPhase] = useState<Phase | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [totalCost, setTotalCost] = useState(0);
  const [totalDuration, setTotalDuration] = useState(0);
  const [phasesCompleted, setPhasesCompleted] = useState(0);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [currentPhaseTraceId, setCurrentPhaseTraceId] = useState<string | null>(null);
  const [activeSpecDir, setActiveSpecDir] = useState<string | null>(null);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [viewingHistorical, setViewingHistorical] = useState(false);
  const [mode, setMode] = useState<string | null>(null);
  const [currentCycle, setCurrentCycle] = useState<number | null>(null);
  const [currentStage, setCurrentStage] = useState<LoopStageType | null>(null);
  const [isClarifying, setIsClarifying] = useState(false);
  const [loopTermination, setLoopTermination] = useState<LoopTermination | null>(null);
  const [loopCycles, setLoopCycles] = useState<UiLoopCycle[]>([]);
  const [preCycleStages, setPreCycleStages] = useState<UiLoopStage[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [prerequisitesChecks, setPrerequisitesChecks] = useState<PrerequisiteCheck[]>([]);
  const [isCheckingPrerequisites, setIsCheckingPrerequisites] = useState(false);
  const viewingHistoricalRef = useRef(false);
  const modeRef = useRef<string | null>(null);
  const currentCycleRef = useRef<number | null>(null);
  const currentStageRef = useRef<LoopStageType | null>(null);
  // Tracks the *live* phaseTraceId from events, not overwritten by loadStageTrace/loadPhaseTrace
  const livePhaseTraceIdRef = useRef<string | null>(null);
  // Tracks the *live* phase from events, not overwritten by loadStageTrace/loadPhaseTrace
  const livePhaseRef = useRef<Phase | null>(null);
  const phaseCompletedCb = useRef<(() => void) | null>(null);
  const tasksUpdatedCb = useRef<((phases: Phase[]) => void) | null>(null);

  const onPhaseCompleted = useCallback((cb: () => void) => {
    phaseCompletedCb.current = cb;
  }, []);

  const onTasksUpdated = useCallback((cb: (phases: Phase[]) => void) => {
    tasksUpdatedCb.current = cb;
  }, []);

  const answerQuestion = useCallback((requestId: string, answers: Record<string, string>) => {
    window.dexAPI.answerQuestion(requestId, answers);
    setPendingQuestion(null);
  }, []);

  // Sync full running state with main process on mount (survives HMR/reload)
  useEffect(() => {
    window.dexAPI.getRunState().then(async (state) => {
      if (!state) return;

      setIsRunning(true);
      setCurrentRunId(state.runId);
      setActiveSpecDir(state.specDir);
      setMode(state.mode);
      modeRef.current = state.mode;
      if (state.currentCycle != null) {
        setCurrentCycle(state.currentCycle);
        currentCycleRef.current = state.currentCycle;
      }
      if (state.currentStage) {
        setCurrentStage(state.currentStage as LoopStageType);
        currentStageRef.current = state.currentStage as LoopStageType;
      }
      if (state.isClarifying) setIsClarifying(true);

      // Rebuild loop dashboard state from DB
      if (state.mode === "loop") {
        const runData = await window.dexAPI.getRun(state.runId);
        if (runData) {
          const loopTraces = runData.phases.filter((pt) => pt.phase_name.startsWith("loop:"));
          const implTraces = runData.phases.filter((pt) => !pt.phase_name.startsWith("loop:"));
          const preCycle: UiLoopStage[] = [];
          const cycleMap = new Map<number, UiLoopStage[]>();

          for (const pt of loopTraces) {
            const stageType = pt.phase_name.replace("loop:", "") as LoopStageType;
            const stage: UiLoopStage = {
              type: stageType,
              status: pt.status === "completed" ? "completed"
                : pt.status === "stopped" ? "stopped"
                : pt.status === "running" ? "running"
                : "failed",
              phaseTraceId: pt.id,
              specDir: pt.spec_dir || undefined,
              costUsd: pt.cost_usd ?? 0,
              durationMs: pt.duration_ms ?? 0,
              startedAt: pt.created_at,
              completedAt: pt.completed_at ?? undefined,
            };
            if (pt.phase_number === 0) {
              preCycle.push(stage);
            } else {
              const existing = cycleMap.get(pt.phase_number) ?? [];
              existing.push(stage);
              cycleMap.set(pt.phase_number, existing);
            }
          }

          setPreCycleStages(preCycle);

          // Group implement sub-phases by spec_dir (each cycle has a unique specDir)
          const implBySpecDir = new Map<string, ImplementSubPhase[]>();
          for (const pt of implTraces) {
            const sd = pt.spec_dir || "";
            if (!sd) continue;
            const existing = implBySpecDir.get(sd) ?? [];
            existing.push({
              phaseNumber: pt.phase_number,
              phaseName: pt.phase_name,
              phaseTraceId: pt.id,
              status: pt.status === "completed" ? "completed" as const
                : pt.status === "stopped" ? "stopped" as const
                : "running" as const,
              costUsd: pt.cost_usd ?? 0,
              durationMs: pt.duration_ms ?? 0,
            });
            implBySpecDir.set(sd, existing);
          }

          // Build cycle entries from the phase_traces grouped by cycle number
          const cycles: UiLoopCycle[] = [];
          for (const [cycleNumber, stages] of Array.from(cycleMap.entries()).sort((a, b) => a[0] - b[0])) {
            const isActive = cycleNumber === state.currentCycle;
            const allCompleted = stages.every((s) => s.status === "completed");
            const specDir = stages.find((s) => s.specDir)?.specDir ?? null;
            const implPhases = specDir ? (implBySpecDir.get(specDir) ?? []) : [];
            cycles.push({
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
          setLoopCycles(cycles);

          // Also accumulate totalCost from completed stages
          const allStages = [...preCycle, ...Array.from(cycleMap.values()).flat()];
          const cost = allStages.reduce((sum, s) => sum + s.costUsd, 0);
          setTotalCost(cost);
        }
      }

      // A phase may not have started yet (phaseTraceId is empty between phases)
      if (!state.phaseTraceId) return;

      setCurrentPhaseTraceId(state.phaseTraceId);
      livePhaseTraceIdRef.current = state.phaseTraceId;
      setCurrentPhase({
        number: state.phaseNumber,
        name: state.phaseName,
        purpose: "",
        tasks: [],
        status: "partial",
      });

      // Reload accumulated steps and subagents for the running phase
      const [stepRows, subagentRows] = await Promise.all([
        window.dexAPI.getPhaseSteps(state.phaseTraceId),
        window.dexAPI.getPhaseSubagents(state.phaseTraceId),
      ]);

      setLiveSteps(
        stepRows.map((row) => ({
          id: row.id,
          sequenceIndex: row.sequence_index,
          type: row.type as AgentStep["type"],
          content: row.content,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          durationMs: row.duration_ms,
          tokenCount: row.token_count,
          createdAt: row.created_at,
        }))
      );

      setSubagents(
        subagentRows.map((row) => ({
          id: row.id,
          subagentId: row.subagent_id,
          subagentType: row.subagent_type,
          description: row.description,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        }))
      );
    });
  }, []);

  useEffect(() => {
    const unsub = window.dexAPI.onOrchestratorEvent(
      (event: OrchestratorEvent) => {
        switch (event.type) {
          case "run_started":
            setIsRunning(true);
            setViewingHistorical(false);
            viewingHistoricalRef.current = false;
            setTotalCost(0);
            setTotalDuration(0);
            setPhasesCompleted(0);
            setCurrentRunId(event.runId);
            setActiveSpecDir(event.config.specDir);
            setMode(event.config.mode);
            modeRef.current = event.config.mode;
            setCurrentCycle(null);
            currentCycleRef.current = null;
            setCurrentStage(null);
            currentStageRef.current = null;
            setIsClarifying(false);
            setLoopTermination(null);
            setLoopCycles([]);
            setPreCycleStages([]);
            setPendingQuestion(null);
            setPrerequisitesChecks([]);
            setIsCheckingPrerequisites(false);
            break;

          case "spec_started":
            setActiveSpecDir(event.specDir);
            break;

          case "spec_completed":
            // Clear active spec so the overview card stops showing "RUNNING"
            // The next spec_started (if any) will set it again
            setActiveSpecDir(null);
            setCurrentPhase(null);
            setCurrentPhaseTraceId(null);
            break;

          case "phase_started":
            // In loop mode, keep the stage-level phase name (e.g. "loop:plan")
            // instead of overwriting it with the internal phase name
            if (modeRef.current !== "loop") {
              setCurrentPhase(event.phase);
              livePhaseRef.current = event.phase;
            }
            setCurrentPhaseTraceId(event.phaseTraceId);
            livePhaseTraceIdRef.current = event.phaseTraceId;
            // Only reset steps if user is watching the live stream;
            // don't disrupt historical phase viewing
            if (!viewingHistoricalRef.current) {
              setLiveSteps([]);
              setSubagents([]);
              setActiveTask(null);
            }
            // Track implement sub-phases in loop mode
            if (modeRef.current === "loop" && currentCycleRef.current != null && currentStageRef.current === "implement") {
              setLoopCycles((prev) =>
                prev.map((c) =>
                  c.cycleNumber === currentCycleRef.current
                    ? {
                        ...c,
                        implementPhases: [
                          ...c.implementPhases,
                          {
                            phaseNumber: event.phase.number,
                            phaseName: event.phase.name,
                            phaseTraceId: event.phaseTraceId,
                            status: "running" as const,
                            costUsd: 0,
                            durationMs: 0,
                          },
                        ],
                      }
                    : c
                )
              );
            }
            break;

          case "agent_step":
            if (!viewingHistoricalRef.current) {
              setLiveSteps((prev) => [...prev, event.step]);
            }
            break;

          case "subagent_started":
            if (!viewingHistoricalRef.current) {
              setSubagents((prev) => [...prev, event.info]);
            }
            break;

          case "subagent_completed":
            if (!viewingHistoricalRef.current) {
              setSubagents((prev) =>
                prev.map((s) =>
                  s.subagentId === event.subagentId
                    ? { ...s, completedAt: new Date().toISOString() }
                    : s
                )
              );
            }
            break;

          case "tasks_updated": {
            // Find the first in-progress task across all phases
            const inProgress = event.phases
              .flatMap((p) => p.tasks)
              .find((t) => t.status === "in_progress") ?? null;
            setActiveTask(inProgress);
            // Keep currentPhase in sync with the updated phase data
            setCurrentPhase((prev) => {
              if (!prev) return prev;
              const updated = event.phases.find((p) => p.number === prev.number);
              return updated ?? prev;
            });
            tasksUpdatedCb.current?.(event.phases);
            break;
          }

          case "phase_completed":
            setTotalCost((prev) => prev + event.cost);
            setTotalDuration((prev) => prev + event.durationMs);
            setPhasesCompleted((prev) => prev + 1);
            phaseCompletedCb.current?.();
            // Update implement sub-phase in loop mode
            if (modeRef.current === "loop" && currentCycleRef.current != null && currentStageRef.current === "implement") {
              setLoopCycles((prev) =>
                prev.map((c) =>
                  c.cycleNumber === currentCycleRef.current
                    ? {
                        ...c,
                        implementPhases: c.implementPhases.map((ip) =>
                          ip.phaseNumber === event.phase.number
                            ? { ...ip, status: "completed" as const, costUsd: event.cost, durationMs: event.durationMs }
                            : ip
                        ),
                      }
                    : c
                )
              );
            }
            break;

          case "run_completed":
            setIsRunning(false);
            setActiveSpecDir(null);
            setActiveTask(null);
            setCurrentPhase(null);
            setCurrentPhaseTraceId(null);
            setTotalCost(event.totalCost);
            setTotalDuration(event.totalDuration);
            setPhasesCompleted(event.phasesCompleted);
            setCurrentCycle(null);
            currentCycleRef.current = null;
            setCurrentStage(null);
            currentStageRef.current = null;
            setIsClarifying(false);
            setPendingQuestion(null);
            break;

          case "error":
            break;

          // Prerequisites events
          case "prerequisites_started":
            setIsCheckingPrerequisites(true);
            setPrerequisitesChecks([]);
            break;

          case "prerequisites_check":
            setPrerequisitesChecks((prev) => {
              const idx = prev.findIndex((c) => c.name === event.check.name);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = event.check;
                return next;
              }
              return [...prev, event.check];
            });
            break;

          case "prerequisites_completed":
            setIsCheckingPrerequisites(false);
            break;

          // Loop mode events
          case "clarification_started":
            setIsClarifying(true);
            break;

          case "clarification_question":
            break;

          case "user_input_request":
            setPendingQuestion({
              requestId: event.requestId,
              questions: event.questions,
            });
            break;

          case "user_input_response":
            // Auto-answered (autoClarification mode) — clear the pending question
            setPendingQuestion(null);
            break;

          case "clarification_completed":
            setIsClarifying(false);
            break;

          case "loop_cycle_started":
            setCurrentCycle(event.cycleNumber);
            currentCycleRef.current = event.cycleNumber;
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
                      status: event.decision === "skipped" ? "skipped" as const
                        : event.decision === "stopped" ? "running" as const  // "running" renders as paused when !isRunning
                        : "completed" as const,
                      featureName: event.featureName,
                      specDir: event.specDir,
                      decision: event.decision,
                      costUsd: event.costUsd,
                    }
                  : c
              )
            );
            break;

          case "stage_started": {
            setCurrentStage(event.stage);
            currentStageRef.current = event.stage;
            setCurrentPhaseTraceId(event.phaseTraceId);
            livePhaseTraceIdRef.current = event.phaseTraceId;
            // Track live phase so switchToLive can restore the correct breadcrumb
            const stagePhase: Phase = {
              number: 0,
              name: `loop:${event.stage}`,
              purpose: "",
              tasks: [],
              status: "partial",
            };
            livePhaseRef.current = stagePhase;
            if (!viewingHistoricalRef.current) {
              setCurrentPhase(stagePhase);
            }
            if (event.specDir) setActiveSpecDir(event.specDir);
            // Reset steps for new stage (so trace view shows this stage's steps)
            if (!viewingHistoricalRef.current) {
              setLiveSteps([]);
              setSubagents([]);
            }
            const newStage: UiLoopStage = {
              type: event.stage,
              status: "running" as const,
              phaseTraceId: event.phaseTraceId,
              specDir: event.specDir,
              costUsd: 0,
              durationMs: 0,
              startedAt: new Date().toISOString(),
            };
            if (event.cycleNumber === 0) {
              // Pre-cycle stages (clarification, constitution)
              setPreCycleStages((prev) => [...prev, newStage]);
            } else {
              setLoopCycles((prev) =>
                prev.map((c) =>
                  c.cycleNumber === event.cycleNumber
                    ? { ...c, stages: [...c.stages, newStage], ...(event.specDir && !c.specDir ? { specDir: event.specDir } : {}) }
                    : c
                )
              );
            }
            break;
          }

          case "stage_completed": {
            setTotalCost((prev) => prev + event.costUsd);
            setTotalDuration((prev) => prev + event.durationMs);
            const stageStatus = event.stopped ? "stopped" as const : "completed" as const;
            const updateStage = (s: UiLoopStage) =>
              s.phaseTraceId === event.phaseTraceId
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
                    : c
                )
              );
            }
            break;
          }

          case "loop_terminated":
            setLoopTermination(event.termination);
            break;

          case "state_reconciled":
            // Log drift summary — UI display can be enhanced later
            if (event.driftSummary) {
              const ds = event.driftSummary;
              if (ds.missingArtifacts.length > 0 || ds.modifiedArtifacts.length > 0 || Object.keys(ds.taskRegressions).length > 0) {
                console.info("[dex] State reconciliation detected drift:", ds);
              }
            }
            break;
        }
      }
    );
    return unsub;
  }, []);

  const loadRunHistory = useCallback(async (projectDir: string): Promise<boolean> => {
    const data = await window.dexAPI.getLatestProjectRun(projectDir);
    if (!data || data.run.mode !== "loop") return false;

    // Validate that the project still has artifacts from past runs.
    // If .specify/integration.json doesn't exist, the project was reset — history is stale.
    const specKitMarker = await window.dexAPI.readFile(`${projectDir}/.specify/integration.json`);
    if (!specKitMarker) return false;

    const { run, phases: phaseTraces, loopCycles: cycleRows } = data;

    setCurrentRunId(run.id);
    setMode("loop");
    modeRef.current = "loop";
    setTotalCost(run.total_cost_usd ?? 0);
    setTotalDuration(run.total_duration_ms ?? 0);

    // Separate loop stages (phase_name starts with "loop:") from implement phases
    const loopTraces = phaseTraces.filter((pt) => pt.phase_name.startsWith("loop:"));
    const implTraces = phaseTraces.filter((pt) => !pt.phase_name.startsWith("loop:"));

    // Build pre-cycle stages (phase_number === 0)
    const preCycle: UiLoopStage[] = [];
    const cycleStageMap = new Map<number, UiLoopStage[]>();

    const isCrashed = run.status === "crashed" || run.status === "stopped";

    for (const pt of loopTraces) {
      const stageType = pt.phase_name.replace("loop:", "") as LoopStageType;
      // A "running" phase trace is only an orphan if the run itself is dead.
      // While the orchestrator is genuinely active, "running" means live.
      const runningStatus: UiLoopStage["status"] = isCrashed ? "failed" : "running";
      const stage: UiLoopStage = {
        type: stageType,
        status: pt.status === "completed" ? "completed"
          : pt.status === "stopped" ? "stopped"
          : pt.status === "crashed" ? "failed"
          : pt.status === "running" ? runningStatus
          : "failed",
        phaseTraceId: pt.id,
        specDir: pt.spec_dir || undefined,
        costUsd: pt.cost_usd ?? 0,
        durationMs: pt.duration_ms ?? 0,
        startedAt: pt.created_at,
        completedAt: pt.completed_at ?? undefined,
      };
      if (pt.phase_number === 0) {
        preCycle.push(stage);
      } else {
        const existing = cycleStageMap.get(pt.phase_number) ?? [];
        existing.push(stage);
        cycleStageMap.set(pt.phase_number, existing);
      }
    }

    setPreCycleStages(preCycle);

    // Group implement sub-phases by spec_dir
    const implBySpecDir = new Map<string, ImplementSubPhase[]>();
    for (const pt of implTraces) {
      const sd = pt.spec_dir || "";
      if (!sd) continue;
      const existing = implBySpecDir.get(sd) ?? [];
      existing.push({
        phaseNumber: pt.phase_number,
        phaseName: pt.phase_name,
        phaseTraceId: pt.id,
        status: pt.status === "completed" ? "completed" as const
          : pt.status === "stopped" ? "stopped" as const
          : "completed" as const, // crashed impl phases are effectively done for display
        costUsd: pt.cost_usd ?? 0,
        durationMs: pt.duration_ms ?? 0,
      });
      implBySpecDir.set(sd, existing);
    }

    // Build cycle entries — prefer loop_cycles table for decision/feature_name, fall back to phase_traces
    const cycleRowMap = new Map(cycleRows.map((c) => [c.cycle_number, c]));
    const cycles: UiLoopCycle[] = [];

    const sortedEntries = Array.from(cycleStageMap.entries()).sort((a, b) => a[0] - b[0]);
    const maxCycleNumber = sortedEntries.length > 0 ? sortedEntries[sortedEntries.length - 1][0] : 0;

    for (const [cycleNumber, stages] of sortedEntries) {
      const cycleRow = cycleRowMap.get(cycleNumber);
      const specDir = cycleRow?.spec_dir ?? stages.find((s) => s.specDir)?.specDir ?? null;
      const implPhases = specDir ? (implBySpecDir.get(specDir) ?? []) : [];
      const allStagesCompleted = stages.every((s) => s.status === "completed");
      // A cycle is only truly complete if the loop_cycles row says so —
      // stages alone can't tell us (there's no loop:implement stage, and verify/learnings may not exist)
      const cycleExplicitlyCompleted = cycleRow?.status === "completed";
      const cycleExplicitlyFailed = cycleRow?.status === "failed";
      // For stopped/crashed runs, the last cycle was interrupted — don't trust its "completed" status
      const isLastCycleOfCrashedRun = isCrashed && cycleNumber === maxCycleNumber;
      // Defensive: if any stage in this cycle is still "running" or "failed", the cycle
      // cannot be honestly "completed" — orchestrator may have inconsistent state.
      const anyStageRunning = stages.some((s) => s.status === "running");
      const anyStageFailed = stages.some((s) => s.status === "failed");

      const cycleStatus = cycleRow?.status === "skipped" ? "skipped" as const
        : isLastCycleOfCrashedRun ? "running" as const // paused mid-cycle
        : cycleExplicitlyFailed ? "failed" as const
        : anyStageRunning ? "running" as const // override "completed" if a stage is still live
        : cycleExplicitlyCompleted && anyStageFailed ? "failed" as const
        : cycleExplicitlyCompleted ? "completed" as const
        : isCrashed ? "running" as const // paused mid-cycle
        : allStagesCompleted && implPhases.length === 0 ? "completed" as const
        : anyStageFailed ? "failed" as const
        : "running" as const;

      cycles.push({
        cycleNumber,
        featureName: cycleRow?.feature_name ?? specDir,
        specDir,
        decision: cycleRow?.decision ?? null,
        status: cycleStatus,
        costUsd: cycleRow?.cost_usd ?? stages.reduce((sum, s) => sum + s.costUsd, 0),
        stages,
        implementPhases: implPhases,
        startedAt: stages[0]?.startedAt ?? new Date().toISOString(),
      });
    }

    setLoopCycles(cycles);

    // Only set termination for genuinely completed runs — crashed = paused, not terminated
    if (run.status === "completed") {
      const completedFeatures = cycleRows
        .filter((c) => c.status === "completed" && c.decision !== "skipped")
        .map((c) => c.feature_name ?? c.spec_dir ?? `Cycle ${c.cycle_number}`);
      const skippedFeatures = cycleRows
        .filter((c) => c.status === "skipped" || c.decision === "skipped")
        .map((c) => c.feature_name ?? c.spec_dir ?? `Cycle ${c.cycle_number}`);

      setLoopTermination({
        reason: "gaps_complete",
        cyclesCompleted: cycles.filter((c) => c.status === "completed").length,
        featuresCompleted: completedFeatures,
        featuresSkipped: skippedFeatures,
        totalCostUsd: run.total_cost_usd ?? 0,
      });
    }

    return true;
  }, []);

  const loadPhaseTrace = useCallback(
    async (projectDir: string, specDir: string, phase: Phase) => {
      const trace = await window.dexAPI.getLatestPhaseTrace(
        projectDir,
        specDir,
        phase.number
      );
      if (!trace) return false;

      const [stepRows, subagentRows] = await Promise.all([
        window.dexAPI.getPhaseSteps(trace.id),
        window.dexAPI.getPhaseSubagents(trace.id),
      ]);

      const steps: AgentStep[] = stepRows.map((row) => ({
        id: row.id,
        sequenceIndex: row.sequence_index,
        type: row.type as AgentStep["type"],
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        durationMs: row.duration_ms,
        tokenCount: row.token_count,
        createdAt: row.created_at,
      }));

      const subs: SubagentInfo[] = subagentRows.map((row) => ({
        id: row.id,
        subagentId: row.subagent_id,
        subagentType: row.subagent_type,
        description: row.description,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      }));

      setLiveSteps(steps);
      setSubagents(subs);
      setCurrentPhase(phase);
      setCurrentPhaseTraceId(trace.id);
      setViewingHistorical(true);
      viewingHistoricalRef.current = true;
      setTotalCost(trace.cost_usd ?? 0);
      setTotalDuration(trace.duration_ms ?? 0);
      return true;
    },
    []
  );

  const loadStageTrace = useCallback(
    async (phaseTraceId: string, stageType: LoopStageType, meta?: { costUsd?: number; durationMs?: number }) => {
      const [stepRows, subagentRows] = await Promise.all([
        window.dexAPI.getPhaseSteps(phaseTraceId),
        window.dexAPI.getPhaseSubagents(phaseTraceId),
      ]);

      setLiveSteps(
        stepRows.map((row) => ({
          id: row.id,
          sequenceIndex: row.sequence_index,
          type: row.type as AgentStep["type"],
          content: row.content,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          durationMs: row.duration_ms,
          tokenCount: row.token_count,
          createdAt: row.created_at,
        }))
      );
      setSubagents(
        subagentRows.map((row) => ({
          id: row.id,
          subagentId: row.subagent_id,
          subagentType: row.subagent_type,
          description: row.description,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        }))
      );
      setCurrentPhase({
        number: 0,
        name: `loop:${stageType}`,
        purpose: "",
        tasks: [],
        status: "complete",
      });
      setCurrentPhaseTraceId(phaseTraceId);
      setViewingHistorical(true);
      viewingHistoricalRef.current = true;
      if (meta?.costUsd != null) setTotalCost(meta.costUsd);
      if (meta?.durationMs != null) setTotalDuration(meta.durationMs);
      return true;
    },
    []
  );

  const switchToLive = useCallback(async () => {
    // Use the ref to get the actual live phaseTraceId — it's never overwritten
    // by loadStageTrace/loadPhaseTrace, so it always points to the running phase.
    const liveId = livePhaseTraceIdRef.current;

    // Reload steps already accumulated for the current phase from DB
    // so the user sees the full history, not just new events.
    // Keep viewingHistoricalRef true during load to prevent duplicate
    // steps from incoming events; flip it after setLiveSteps.
    if (liveId) {
      const [stepRows, subagentRows] = await Promise.all([
        window.dexAPI.getPhaseSteps(liveId),
        window.dexAPI.getPhaseSubagents(liveId),
      ]);

      setLiveSteps(
        stepRows.map((row) => ({
          id: row.id,
          sequenceIndex: row.sequence_index,
          type: row.type as AgentStep["type"],
          content: row.content,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          durationMs: row.duration_ms,
          tokenCount: row.token_count,
          createdAt: row.created_at,
        }))
      );
      setSubagents(
        subagentRows.map((row) => ({
          id: row.id,
          subagentId: row.subagent_id,
          subagentType: row.subagent_type,
          description: row.description,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        }))
      );
      setCurrentPhaseTraceId(liveId);
    } else {
      setLiveSteps([]);
      setSubagents([]);
    }

    // Restore the live phase so breadcrumb shows the correct stage name
    if (livePhaseRef.current) {
      setCurrentPhase(livePhaseRef.current);
    }

    setViewingHistorical(false);
    viewingHistoricalRef.current = false;
  }, []);

  return {
    liveSteps,
    subagents,
    currentPhase,
    activeSpecDir,
    activeTask,
    isRunning,
    viewingHistorical,
    totalCost,
    totalDuration,
    phasesCompleted,
    currentRunId,
    currentPhaseTraceId,
    mode,
    currentCycle,
    currentStage,
    isClarifying,
    loopTermination,
    loopCycles,
    preCycleStages,
    prerequisitesChecks,
    isCheckingPrerequisites,
    pendingQuestion,
    answerQuestion,
    loadRunHistory,
    loadPhaseTrace,
    loadStageTrace,
    switchToLive,
    onPhaseCompleted,
    onTasksUpdated,
  };
}
