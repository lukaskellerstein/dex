import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AgentStep,
  SubagentInfo,
  Phase,
  Task,
  OrchestratorEvent,
} from "../../core/types.js";

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
  loadPhaseTrace: (projectDir: string, specDir: string, phase: Phase) => Promise<boolean>;
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
  const phaseCompletedCb = useRef<(() => void) | null>(null);
  const tasksUpdatedCb = useRef<((phases: Phase[]) => void) | null>(null);

  const onPhaseCompleted = useCallback((cb: () => void) => {
    phaseCompletedCb.current = cb;
  }, []);

  const onTasksUpdated = useCallback((cb: (phases: Phase[]) => void) => {
    tasksUpdatedCb.current = cb;
  }, []);

  // Sync full running state with main process on mount (survives HMR/reload)
  useEffect(() => {
    window.ralphAPI.getRunState().then(async (state) => {
      if (!state) return;

      setIsRunning(true);
      setCurrentRunId(state.runId);
      setActiveSpecDir(state.specDir);

      // A phase may not have started yet (phaseTraceId is empty between phases)
      if (!state.phaseTraceId) return;

      setCurrentPhaseTraceId(state.phaseTraceId);
      setCurrentPhase({
        number: state.phaseNumber,
        name: state.phaseName,
        purpose: "",
        tasks: [],
        status: "partial",
      });

      // Reload accumulated steps and subagents for the running phase
      const [stepRows, subagentRows] = await Promise.all([
        window.ralphAPI.getPhaseSteps(state.phaseTraceId),
        window.ralphAPI.getPhaseSubagents(state.phaseTraceId),
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
    const unsub = window.ralphAPI.onOrchestratorEvent(
      (event: OrchestratorEvent) => {
        switch (event.type) {
          case "run_started":
            setIsRunning(true);
            setViewingHistorical(false);
            setTotalCost(0);
            setTotalDuration(0);
            setPhasesCompleted(0);
            setCurrentRunId(event.runId);
            setActiveSpecDir(event.config.specDir);
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
            setViewingHistorical(false);
            setCurrentPhase(event.phase);
            setCurrentPhaseTraceId(event.phaseTraceId);
            setActiveTask(null);
            setLiveSteps([]);
            setSubagents([]);
            break;

          case "agent_step":
            setLiveSteps((prev) => [...prev, event.step]);
            break;

          case "subagent_started":
            setSubagents((prev) => [...prev, event.info]);
            break;

          case "subagent_completed":
            setSubagents((prev) =>
              prev.map((s) =>
                s.subagentId === event.subagentId
                  ? { ...s, completedAt: new Date().toISOString() }
                  : s
              )
            );
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
            break;

          case "error":
            break;
        }
      }
    );
    return unsub;
  }, []);

  const loadPhaseTrace = useCallback(
    async (projectDir: string, specDir: string, phase: Phase) => {
      const trace = await window.ralphAPI.getLatestPhaseTrace(
        projectDir,
        specDir,
        phase.number
      );
      if (!trace) return false;

      const [stepRows, subagentRows] = await Promise.all([
        window.ralphAPI.getPhaseSteps(trace.id),
        window.ralphAPI.getPhaseSubagents(trace.id),
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
      setTotalCost(trace.cost_usd ?? 0);
      setTotalDuration(trace.duration_ms ?? 0);
      return true;
    },
    []
  );

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
    loadPhaseTrace,
    onPhaseCompleted,
    onTasksUpdated,
  };
}
