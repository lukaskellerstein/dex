/**
 * What: Composer that wires 5 domain hooks (useRunSession, usePrerequisites, useUserQuestion, useLoopState, useLiveTrace) into the union shape App.tsx consumes; owns cross-hook imperative methods (loadRunHistory, loadPhaseTrace, loadStageTrace, switchToLive).
 * Not: Does not subscribe to events directly; each domain hook owns its event subscriptions. Does not own any useState — every state lives in a domain hook.
 * Deps: 5 domain hooks; historyService, projectService for the cross-hook loaders; buildLoopStateFromRun (the one rebuild of a run's stage history, on mount and in loadRunHistory); AgentStep / SubagentInfo / TaskPhase / StepType types.
 */
import { useCallback, useEffect, useRef } from "react";
import type {
  AgentStep,
  LoopTermination,
  PrerequisiteCheck,
  StepType,
  SubagentInfo,
  Task,
  TaskPhase,
} from "../../core/types.js";
import { historyService } from "../services/historyService.js";
import { orchestratorService } from "../services/orchestratorService.js";
import { projectService } from "../services/projectService.js";
import { buildLoopStateFromRun, lastCycleOf } from "./buildLoopStateFromRun.js";
import { type LatestAction, useLiveTrace } from "./useLiveTrace.js";
import { type UiLoopCycle, type UiLoopStage, useLoopState } from "./useLoopState.js";
import { usePrerequisites } from "./usePrerequisites.js";
import { useRunSession } from "./useRunSession.js";
import { useUserQuestion } from "./useUserQuestion.js";

export type { LatestAction } from "./useLiveTrace.js";
// Re-export shape consumers depend on
export type { ImplementSubPhase, UiLoopCycle, UiLoopStage } from "./useLoopState.js";

interface OrchestratorHook {
  liveSteps: AgentStep[];
  /** Most recent "interesting" step in the running stage — what the agent is actively doing. */
  latestAction: LatestAction | null;
  subagents: SubagentInfo[];
  currentPhase: TaskPhase | null;
  activeSpecDir: string | null;
  activeTask: Task | null;
  isRunning: boolean;
  viewingHistorical: boolean;
  totalCost: number;
  totalDuration: number;
  currentRunId: string | null;
  currentPhaseTraceId: string | null;
  // Loop-mode state
  mode: string | null;
  currentCycle: number | null;
  currentStage: StepType | null;
  isClarifying: boolean;
  loopTermination: LoopTermination | null;
  loopCycles: UiLoopCycle[];
  preCycleStages: UiLoopStage[];
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  loadRunHistory: (projectDir: string) => Promise<boolean>;
  loadPhaseTrace: (projectDir: string, specDir: string, taskPhase: TaskPhase) => Promise<boolean>;
  loadStageTrace: (
    projectDir: string,
    runId: string,
    agentRunId: string,
    stageType: StepType,
    meta?: { costUsd?: number; durationMs?: number },
  ) => Promise<boolean>;
  switchToLive: (projectDir: string, runId: string) => Promise<void>;
  onPhaseCompleted: (cb: () => void) => void;
  onTasksUpdated: (cb: (taskPhases: TaskPhase[]) => void) => void;
}

export function useOrchestrator(): OrchestratorHook {
  const session = useRunSession();
  const prereq = usePrerequisites();
  const question = useUserQuestion();
  const loop = useLoopState();
  const trace = useLiveTrace({
    viewingHistoricalRef: session.viewingHistoricalRef,
    modeRef: session.modeRef,
  });

  // Phase-completion / tasks-updated callbacks (App.tsx-level imperative hooks).
  const phaseCompletedCb = useRef<(() => void) | null>(null);
  const tasksUpdatedCb = useRef<((taskPhases: TaskPhase[]) => void) | null>(null);

  const onPhaseCompleted = useCallback((cb: () => void) => {
    phaseCompletedCb.current = cb;
  }, []);

  const onTasksUpdated = useCallback((cb: (taskPhases: TaskPhase[]) => void) => {
    tasksUpdatedCb.current = cb;
  }, []);

  // Cross-cutting events that need callback fan-out — subscribe at the composer level
  // and delegate to the domain hook setters where needed.
  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event) => {
      if (event.type === "task_phase_completed") {
        phaseCompletedCb.current?.();
      } else if (event.type === "tasks_updated") {
        tasksUpdatedCb.current?.(event.taskPhases);
      }
    });
    return unsub;
  }, []);

  // Sync full running state with main process on mount (survives HMR/reload).
  useEffect(() => {
    orchestratorService.getRunState().then(async (state) => {
      if (!state) return;

      session.setIsRunning(true);
      session.setCurrentRunId(state.runId);
      session.setActiveSpecDir(state.specDir);
      session.setMode(state.mode);
      if (state.currentCycle != null) {
        loop.setCurrentCycle(state.currentCycle);
      }
      if (state.currentStep) {
        loop.setCurrentStage(state.currentStep as StepType);
      }
      if (state.isClarifying) question.setIsClarifying(true);

      // Rebuild loop dashboard state from JSON store.
      if (state.mode === "loop") {
        const runData = await historyService.getRun(state.projectDir, state.runId);
        if (runData) {
          const rebuilt = buildLoopStateFromRun(runData, state.currentCycle ?? null);
          loop.setPreCycleStages(rebuilt.preCycleStages);
          loop.setLoopCycles(rebuilt.loopCycles);
          loop.setTotalCost(rebuilt.totalCost);
        }
      }

      // A phase may not have started yet (agentRunId is empty between phases).
      if (!state.agentRunId) return;

      trace.setCurrentPhaseTraceId(state.agentRunId);
      trace.livePhaseTraceIdRef.current = state.agentRunId;
      trace.setCurrentPhase({
        number: state.taskPhaseNumber,
        name: state.taskPhaseName,
        purpose: "",
        tasks: [],
        status: "partial",
      });

      // Reload accumulated steps and subagents for the running phase.
      const [stepRows, subagentRows] = await Promise.all([
        historyService.getAgentSteps(state.projectDir, state.runId, state.agentRunId),
        historyService.getAgentRunSubagents(state.projectDir, state.runId, state.agentRunId),
      ]);

      trace.setLiveSteps(
        stepRows.map((row) => ({
          id: row.id,
          sequenceIndex: row.sequenceIndex,
          type: row.type,
          content: row.content,
          metadata: row.metadata,
          durationMs: row.durationMs,
          tokenCount: row.tokenCount,
          createdAt: row.createdAt,
        })),
      );

      trace.setSubagents(
        subagentRows.map((row) => ({
          id: row.id,
          subagentId: row.id,
          subagentType: row.type,
          description: row.description,
          startedAt: row.startedAt,
          completedAt: row.endedAt,
        })),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, []);

  const loadRunHistory = useCallback(
    async (projectDir: string): Promise<boolean> => {
      // No state.json, no run to show: the latest run record alone can be
      // from a project whose run state was removed.
      const liveState = await orchestratorService.getProjectState(projectDir);
      if (!liveState) return false;

      const run = await historyService.getLatestProjectRun(projectDir);
      if (run?.mode !== "loop") return false;

      // Validate that the project still has artifacts from past runs.
      const specKitMarker = await projectService.readFile(
        `${projectDir}/.specify/integration.json`,
      );
      if (!specKitMarker) return false;

      session.setCurrentRunId(run.runId);
      session.setMode("loop");
      session.setTotalDuration(run.totalDurationMs ?? 0);

      // A run that did not finish shows its last entry as the one to resume.
      const finished = run.status === "completed";
      const rebuilt = buildLoopStateFromRun(run, finished ? null : lastCycleOf(run));
      loop.setPreCycleStages(rebuilt.preCycleStages);
      loop.setLoopCycles(rebuilt.loopCycles);
      loop.setTotalCost(run.totalCostUsd ?? rebuilt.totalCost);

      // Only set termination for genuinely completed runs.
      if (finished) {
        const completed = rebuilt.loopCycles.filter((c) => c.status === "completed");
        loop.setLoopTermination({
          reason: "queue_complete",
          cyclesCompleted: completed.length,
          featuresCompleted: completed.map((c) => c.featureName ?? c.specDir ?? `Cycle ${c.cycleNumber}`),
          featuresSkipped: [],
          totalCostUsd: run.totalCostUsd ?? 0,
          totalDurationMs: run.totalDurationMs ?? 0,
        });
      }

      return true;
    },
    [session, loop],
  );

  const loadPhaseTrace = useCallback(
    async (projectDir: string, specDir: string, taskPhase: TaskPhase) => {
      const t = await historyService.getLatestAgentRun(projectDir, specDir, taskPhase.number);
      if (!t) return false;

      const [stepRows, subagentRows] = await Promise.all([
        historyService.getAgentSteps(projectDir, t.runId, t.agentRunId),
        historyService.getAgentRunSubagents(projectDir, t.runId, t.agentRunId),
      ]);

      const steps: AgentStep[] = stepRows.map((row) => ({
        id: row.id,
        sequenceIndex: row.sequenceIndex,
        type: row.type,
        content: row.content,
        metadata: row.metadata,
        durationMs: row.durationMs,
        tokenCount: row.tokenCount,
        createdAt: row.createdAt,
      }));

      const subs: SubagentInfo[] = subagentRows.map((row) => ({
        id: row.id,
        subagentId: row.id,
        subagentType: row.type,
        description: row.description,
        startedAt: row.startedAt,
        completedAt: row.endedAt,
      }));

      trace.setLiveSteps(steps);
      trace.setSubagents(subs);
      trace.setCurrentPhase(taskPhase);
      trace.setCurrentPhaseTraceId(t.agentRunId);
      session.setCurrentRunId(t.runId);
      session.setActiveSpecDir(specDir);
      session.setViewingHistorical(true);
      loop.setTotalCost(t.costUsd ?? 0);
      session.setTotalDuration(t.durationMs ?? 0);
      return true;
    },
    [session, loop, trace],
  );

  const loadStageTrace = useCallback(
    async (
      projectDir: string,
      runId: string,
      agentRunId: string,
      stageType: StepType,
      meta?: { costUsd?: number; durationMs?: number },
    ) => {
      const [stepRows, subagentRows] = await Promise.all([
        historyService.getAgentSteps(projectDir, runId, agentRunId),
        historyService.getAgentRunSubagents(projectDir, runId, agentRunId),
      ]);

      trace.setLiveSteps(
        stepRows.map((row) => ({
          id: row.id,
          sequenceIndex: row.sequenceIndex,
          type: row.type,
          content: row.content,
          metadata: row.metadata,
          durationMs: row.durationMs,
          tokenCount: row.tokenCount,
          createdAt: row.createdAt,
        })),
      );
      trace.setSubagents(
        subagentRows.map((row) => ({
          id: row.id,
          subagentId: row.id,
          subagentType: row.type,
          description: row.description,
          startedAt: row.startedAt,
          completedAt: row.endedAt,
        })),
      );
      trace.setCurrentPhase({
        number: 0,
        name: `loop:${stageType}`,
        purpose: "",
        tasks: [],
        status: "complete",
      });
      trace.setCurrentPhaseTraceId(agentRunId);
      loop.setCurrentStage(stageType);
      session.setViewingHistorical(true);
      if (meta?.costUsd != null) loop.setTotalCost(meta.costUsd);
      if (meta?.durationMs != null) session.setTotalDuration(meta.durationMs);
      return true;
    },
    [session, loop, trace],
  );

  const switchToLive = useCallback(
    async (projectDir: string, runId: string) => {
      // Use the ref to get the actual live agentRunId — never overwritten by loaders.
      const liveId = trace.livePhaseTraceIdRef.current;

      if (liveId) {
        const [stepRows, subagentRows] = await Promise.all([
          historyService.getAgentSteps(projectDir, runId, liveId),
          historyService.getAgentRunSubagents(projectDir, runId, liveId),
        ]);

        trace.setLiveSteps(
          stepRows.map((row) => ({
            id: row.id,
            sequenceIndex: row.sequenceIndex,
            type: row.type,
            content: row.content,
            metadata: row.metadata,
            durationMs: row.durationMs,
            tokenCount: row.tokenCount,
            createdAt: row.createdAt,
          })),
        );
        trace.setSubagents(
          subagentRows.map((row) => ({
            id: row.id,
            subagentId: row.id,
            subagentType: row.type,
            description: row.description,
            startedAt: row.startedAt,
            completedAt: row.endedAt,
          })),
        );
        trace.setCurrentPhaseTraceId(liveId);
      } else {
        trace.setLiveSteps([]);
        trace.setSubagents([]);
      }

      // Restore the live phase so breadcrumb shows the correct step name.
      if (trace.livePhaseRef.current) {
        trace.setCurrentPhase(trace.livePhaseRef.current);
      }

      session.setViewingHistorical(false);
    },
    [session, trace],
  );

  return {
    liveSteps: trace.liveSteps,
    latestAction: trace.latestAction,
    subagents: trace.subagents,
    currentPhase: trace.currentPhase,
    activeSpecDir: session.activeSpecDir,
    activeTask: session.activeTask,
    isRunning: session.isRunning,
    viewingHistorical: session.viewingHistorical,
    totalCost: loop.totalCost,
    totalDuration: session.totalDuration,
    currentRunId: session.currentRunId,
    currentPhaseTraceId: trace.currentPhaseTraceId,
    mode: session.mode,
    currentCycle: loop.currentCycle,
    currentStage: loop.currentStage,
    isClarifying: question.isClarifying,
    loopTermination: loop.loopTermination,
    loopCycles: loop.loopCycles,
    preCycleStages: loop.preCycleStages,
    prerequisitesChecks: prereq.prerequisitesChecks,
    isCheckingPrerequisites: prereq.isCheckingPrerequisites,
    loadRunHistory,
    loadPhaseTrace,
    loadStageTrace,
    switchToLive,
    onPhaseCompleted,
    onTasksUpdated,
  };
}
