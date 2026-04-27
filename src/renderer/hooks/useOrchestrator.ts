/**
 * What: Composer that wires 5 domain hooks (useRunSession, usePrerequisites, useUserQuestion, useLoopState, useLiveTrace) into the union shape App.tsx consumes; owns cross-hook imperative methods (loadRunHistory, loadPhaseTrace, loadStageTrace, switchToLive).
 * Not: Does not subscribe to events directly; each domain hook owns its event subscriptions. Does not own any useState — every state lives in a domain hook.
 * Deps: 5 domain hooks; historyService, projectService for the cross-hook loaders; buildLoopStateFromRun for run-history hydration; AgentStep / SubagentInfo / TaskPhase / StepType types.
 */
import { useCallback, useEffect, useRef } from "react";
import type {
  AgentStep,
  SubagentInfo,
  TaskPhase,
  Task,
  StepType,
  LoopTermination,
  PrerequisiteCheck,
} from "../../core/types.js";
import { historyService } from "../services/historyService.js";
import { projectService } from "../services/projectService.js";
import { orchestratorService } from "../services/orchestratorService.js";
import { useRunSession } from "./useRunSession.js";
import { usePrerequisites } from "./usePrerequisites.js";
import { useUserQuestion, type PendingQuestion } from "./useUserQuestion.js";
import {
  useLoopState,
  type UiLoopStage,
  type UiLoopCycle,
  type ImplementSubPhase,
} from "./useLoopState.js";
import { useLiveTrace, type LatestAction } from "./useLiveTrace.js";

// Re-export shape consumers depend on
export type { UiLoopStage, UiLoopCycle, ImplementSubPhase } from "./useLoopState.js";
export type { LatestAction } from "./useLiveTrace.js";
export type { PendingQuestion } from "./useUserQuestion.js";

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
  pendingQuestion: PendingQuestion | null;
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
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
        const { buildLoopStateFromRun } = await import("./buildLoopStateFromRun.js");
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
      const run = await historyService.getLatestProjectRun(projectDir);
      if (!run || run.mode !== "loop") return false;

      // Validate that the project still has artifacts from past runs.
      const specKitMarker = await projectService.readFile(
        `${projectDir}/.specify/integration.json`,
      );
      if (!specKitMarker) return false;

      const phaseTraces = run.agentRuns;

      session.setCurrentRunId(run.runId);
      session.setMode("loop");
      loop.setTotalCost(run.totalCostUsd ?? 0);
      session.setTotalDuration(run.totalDurationMs ?? 0);

      const loopTraces = phaseTraces.filter((pt) => pt.taskPhaseName.startsWith("loop:"));
      const implTraces = phaseTraces.filter((pt) => !pt.taskPhaseName.startsWith("loop:"));

      const preCycle: UiLoopStage[] = [];
      const cycleStageMap = new Map<number, UiLoopStage[]>();

      const isCrashed = run.status === "crashed" || run.status === "stopped";

      for (const pt of loopTraces) {
        const stageType = pt.taskPhaseName.replace("loop:", "") as StepType;
        const runningStatus: UiLoopStage["status"] = isCrashed ? "failed" : "running";
        const step: UiLoopStage = {
          type: stageType,
          status:
            pt.status === "completed"
              ? "completed"
              : pt.status === "stopped"
                ? "stopped"
                : pt.status === "crashed"
                  ? "failed"
                  : pt.status === "running"
                    ? runningStatus
                    : "failed",
          agentRunId: pt.agentRunId,
          specDir: pt.specDir || undefined,
          costUsd: pt.costUsd ?? 0,
          durationMs: pt.durationMs ?? 0,
          startedAt: pt.startedAt,
          completedAt: pt.endedAt ?? undefined,
        };
        if (pt.taskPhaseNumber === 0) {
          preCycle.push(step);
        } else {
          const existing = cycleStageMap.get(pt.taskPhaseNumber) ?? [];
          existing.push(step);
          cycleStageMap.set(pt.taskPhaseNumber, existing);
        }
      }

      loop.setPreCycleStages(preCycle);

      // Group implement sub-phases by specDir.
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
            pt.status === "completed"
              ? ("completed" as const)
              : pt.status === "stopped"
                ? ("stopped" as const)
                : ("completed" as const),
          costUsd: pt.costUsd ?? 0,
          durationMs: pt.durationMs ?? 0,
        });
        implBySpecDir.set(sd, existing);
      }

      // Build cycle entries — derive cycle status from grouped phases.
      const cycles: UiLoopCycle[] = [];
      const sortedEntries = Array.from(cycleStageMap.entries()).sort(
        (a, b) => a[0] - b[0],
      );
      const maxCycleNumber =
        sortedEntries.length > 0 ? sortedEntries[sortedEntries.length - 1][0] : 0;

      for (const [cycleNumber, stages] of sortedEntries) {
        const specDir = stages.find((s) => s.specDir)?.specDir ?? null;
        const implPhases = specDir ? (implBySpecDir.get(specDir) ?? []) : [];
        const allStagesCompleted = stages.every((s) => s.status === "completed");
        const isLastCycleOfCrashedRun = isCrashed && cycleNumber === maxCycleNumber;
        const anyStageRunning = stages.some((s) => s.status === "running");
        const anyStageFailed = stages.some((s) => s.status === "failed");

        const cycleStatus: UiLoopCycle["status"] = isLastCycleOfCrashedRun
          ? "running"
          : anyStageRunning
            ? "running"
            : isCrashed
              ? "running"
              : allStagesCompleted && implPhases.length === 0
                ? "completed"
                : anyStageFailed
                  ? "failed"
                  : "completed";

        cycles.push({
          cycleNumber,
          featureName: specDir,
          specDir,
          decision: null,
          status: cycleStatus,
          costUsd:
            stages.reduce((sum, s) => sum + s.costUsd, 0) +
            implPhases.reduce((sum, p) => sum + p.costUsd, 0),
          stages,
          implementPhases: implPhases,
          startedAt: stages[0]?.startedAt ?? new Date().toISOString(),
        });
      }

      loop.setLoopCycles(cycles);

      // Only set termination for genuinely completed runs.
      if (run.status === "completed") {
        const completedFeatures = cycles
          .filter((c) => c.status === "completed")
          .map((c) => c.featureName ?? c.specDir ?? `Cycle ${c.cycleNumber}`);
        loop.setLoopTermination({
          reason: "gaps_complete",
          cyclesCompleted: cycles.filter((c) => c.status === "completed").length,
          featuresCompleted: completedFeatures,
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
      const t = await historyService.getLatestAgentRun(
        projectDir,
        specDir,
        taskPhase.number,
      );
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
    pendingQuestion: question.pendingQuestion,
    answerQuestion: question.answerQuestion,
    loadRunHistory,
    loadPhaseTrace,
    loadStageTrace,
    switchToLive,
    onPhaseCompleted,
    onTasksUpdated,
  };
}
