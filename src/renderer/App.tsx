import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug } from "lucide-react";
import { CopyBadge } from "./components/shared/CopyBadge.js";
import type { WelcomeNextView } from "./components/welcome/WelcomeScreen.js";
import type { TaskPhase, RunConfig, SubagentInfo } from "../core/types.js";
import { AppShell } from "./components/layout/AppShell.js";
import { TopTabBar, type TopTab } from "./components/layout/TopTabBar.js";
import { TimelineView } from "./components/checkpoints/TimelineView.js";
import { LoopStartPanel } from "./components/loop/LoopStartPanel.js";
import { LoopDashboard } from "./components/loop/LoopDashboard.js";
import { ClarificationPanel } from "./components/loop/ClarificationPanel.js";
import { useOrchestrator } from "./hooks/useOrchestrator.js";
import { useProject } from "./hooks/useProject.js";
import { CheckpointsEnvelope } from "./components/checkpoints/CheckpointsEnvelope.js";
import { orchestratorService } from "./services/orchestratorService.js";
import { checkpointService } from "./services/checkpointService.js";
import { useTimeline } from "./components/checkpoints/hooks/useTimeline.js";
import { AppRouter, type View } from "./AppRouter.js";

interface DebugContext {
  runId: string | null;
  agentRunId: string | null;
  mode: string | null;
  cycle: number | null;
  step: string | null;
  specDir: string | null;
  phase: string | null;
  phaseNumber: number | null;
  phaseName: string | null;
  projectDir: string | null;
  view: string;
  isRunning: boolean;
  viewingHistorical: boolean;
  branch: string | null;
  // 008 checkpoint fields
  currentAttemptBranch: string | null;
  lastCheckpointTag: string | null;
  candidateSha: string | null;
}

// Mirrors core/runs.ts `slugForTaskPhaseName` — duplicated here because core/runs
// pulls in node:fs and can't be imported from the renderer.
function phaseSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function projectName(projectDir: string): string {
  return projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir;
}

function buildDebugPayload(ctx: DebugContext): string {
  const lines: string[] = ["Dex Debug Context", "─────────────────"];
  const add = (label: string, val: unknown) => {
    if (val != null && val !== "") lines.push(`${label.padEnd(16)} ${val}`);
  };
  add("RunID:", ctx.runId);
  add("AgentRunID:", ctx.agentRunId);
  add("Mode:", ctx.mode);
  add("Cycle:", ctx.cycle);
  add("Stage:", ctx.step);
  add("SpecDir:", ctx.specDir);
  add("TaskPhase:", ctx.phase);
  add("ProjectDir:", ctx.projectDir);
  add("Branch:", ctx.branch);
  add("View:", ctx.view);
  add("IsRunning:", ctx.isRunning);
  add("ViewHistory:", ctx.viewingHistorical);
  add("CurrentAttemptBranch:", ctx.currentAttemptBranch);
  add("LastCheckpointTag:", ctx.lastCheckpointTag);
  add("CandidateSha:", ctx.candidateSha);
  // Resolved log paths — primary keys for jumping straight from "weird UI" to "right log file"
  if (ctx.runId && ctx.projectDir) {
    const proj = projectName(ctx.projectDir);
    const runDir = `~/.dex/logs/${proj}/${ctx.runId}/`;
    add("RunDir:", runDir);
    add("RunLog:", `${runDir}run.log`);
    if (ctx.phaseNumber != null && ctx.phaseName) {
      const slug = phaseSlug(ctx.phaseName);
      add("PhaseLog:", `${runDir}phase-${ctx.phaseNumber}_${slug}/agent.log`);
    }
    add("RunRecord:", `${ctx.projectDir}/.dex/runs/${ctx.runId}.json`);
  }
  add("Timestamp:", new Date().toISOString());
  return lines.join("\n");
}

function DebugCopyBadge({ context }: { context: DebugContext }) {
  return (
    <CopyBadge
      getCopyText={() => buildDebugPayload(context)}
      label="debug"
      icon={<Bug size={10} />}
      title="Copy debug context to clipboard"
    />
  );
}

export default function App() {
  const project = useProject();
  const orchestrator = useOrchestrator();
  const [currentView, setCurrentView] = useState<View>("overview");
  const [topTab, setTopTab] = useState<TopTab>("timeline");
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  // Derive selectedSubagent from live data so completedAt updates propagate
  const selectedSubagent = useMemo(
    () =>
      selectedSubagentId
        ? (orchestrator.subagents.find((s) => s.subagentId === selectedSubagentId) ?? null)
        : null,
    [selectedSubagentId, orchestrator.subagents],
  );
  const [, setTick] = useState(0);

  const handleOpenProject = useCallback(async () => {
    const dir = await project.openProject();
    if (dir) {
      const hasHistory = await orchestrator.loadRunHistory(dir);
      setCurrentView(hasHistory ? "loop-dashboard" : "overview");
    }
  }, [project.openProject, orchestrator.loadRunHistory]);

  const handleWelcomeComplete = useCallback((next: WelcomeNextView) => {
    setCurrentView(next);
  }, []);

  // Tick every second while running so duration updates in realtime
  useEffect(() => {
    if (!orchestrator.isRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [orchestrator.isRunning]);

  const handleSubagentClick = useCallback((subagentId: string) => {
    setSelectedSubagentId(subagentId);
    setCurrentView("subagent-detail");
  }, []);

  const handleSubagentBadgeClick = useCallback((sub: SubagentInfo) => {
    setSelectedSubagentId(sub.subagentId);
    setCurrentView("subagent-detail");
  }, []);

  const handleBackFromSubagent = useCallback(() => {
    setSelectedSubagentId(null);
    setCurrentView("trace");
  }, []);

  const handleStageClick = useCallback(
    async (step: import("./hooks/useOrchestrator.js").UiLoopStage) => {
      if (!project.projectDir || !orchestrator.currentRunId) return;
      if (step.status === "running") {
        await orchestrator.switchToLive(project.projectDir, orchestrator.currentRunId);
      } else {
        await orchestrator.loadStageTrace(
          project.projectDir,
          orchestrator.currentRunId,
          step.agentRunId,
          step.type,
          { costUsd: step.costUsd, durationMs: step.durationMs },
        );
      }
      setCurrentView("trace");
    },
    [
      project.projectDir,
      orchestrator.currentRunId,
      orchestrator.switchToLive,
      orchestrator.loadStageTrace,
    ],
  );

  const handleImplPhaseClick = useCallback(
    async (phaseTraceId: string) => {
      if (!project.projectDir || !orchestrator.currentRunId) return;
      await orchestrator.loadStageTrace(
        project.projectDir,
        orchestrator.currentRunId,
        phaseTraceId,
        "implement",
      );
      setCurrentView("trace");
    },
    [project.projectDir, orchestrator.currentRunId, orchestrator.loadStageTrace],
  );

  // Auto-refresh phases when a phase completes or tasks change mid-phase
  useEffect(() => {
    orchestrator.onPhaseCompleted(() => {
      // During loop implement, updateSpecSummary (from onTasksUpdated) is the
      // authoritative source.  refreshProject() would overwrite with disk data
      // that may not reflect in-memory TodoWrite updates yet.
      if (orchestrator.mode === "loop" && orchestrator.currentStage === "implement") return;
      project.refreshProject();
    });
    orchestrator.onTasksUpdated((phases) => {
      project.setPhases(phases);
      if (orchestrator.activeSpecDir) {
        project.updateSpecSummary(orchestrator.activeSpecDir, phases);
      }
    });
  });

  // Refresh project when entering implement step so the newly-created spec
  // appears in specSummaries (the spec was created during specify/plan/tasks).
  const prevStageRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStageRef.current;
    prevStageRef.current = orchestrator.currentStage;
    if (orchestrator.currentStage === "implement" && prev !== "implement" && project.projectDir) {
      project.refreshProject();
    }
  }, [orchestrator.currentStage]);

  // Auto-show loop dashboard when loop terminates (dashboard handles completion phase)
  useEffect(() => {
    if (orchestrator.loopTermination && !orchestrator.isRunning) {
      setCurrentView("loop-dashboard");
    }
  }, [orchestrator.loopTermination, orchestrator.isRunning]);

  // Auto-switch to loop dashboard when loop starts running
  useEffect(() => {
    if (orchestrator.isRunning && orchestrator.mode === "loop") {
      if (currentView === "loop-start" || currentView === "overview") {
        setCurrentView("loop-dashboard");
      }
    }
  }, [orchestrator.isRunning, orchestrator.mode]);

  const handleStartLoop = (loopConfig: {
    descriptionFile?: string;
    maxLoopCycles?: number;
    maxBudgetUsd?: number;
    autoClarification?: boolean;
    resume?: boolean;
  }) => {
    if (!project.projectDir) return;

    const { resume, ...rest } = loopConfig;
    const config: RunConfig = {
      projectDir: project.projectDir,
      specDir: "",
      mode: "loop",
      model: "claude-opus-4-6",
      maxIterations: 50,
      maxTurns: 75,
      taskPhases: "all",
      ...rest,
      ...(resume ? { resume: true } : {}),
    };
    orchestratorService.startRun(config);
  };

  const handleSelectSpec = useCallback((spec: string) => {
    project.selectSpec(spec);
    setCurrentView("tasks");
  }, [project.selectSpec]);

  const handleGoHome = useCallback(() => {
    if (orchestrator.isRunning) return; // don't allow while running
    project.clearProject();
    setCurrentView("overview");
  }, [orchestrator.isRunning, project.clearProject]);

  const handleDeselectSpec = () => {
    project.deselectSpec();
    const hasLoopHistory =
      orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0;
    if (hasLoopHistory || orchestrator.mode === "loop") {
      setCurrentView("loop-dashboard");
    } else {
      setCurrentView("overview");
    }
  };

  const handleStart = async (partial: Partial<RunConfig>) => {
    const projectDir = partial.projectDir ?? project.projectDir!;

    // If we have loop history (paused loop), resume in loop mode
    const hasLoopHistory =
      orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0;
    if (hasLoopHistory || orchestrator.mode === "loop") {
      // 010 — sync state.json from HEAD's step-commit before resuming so the
      // orchestrator continues from wherever the user navigated to in the
      // Timeline, not from where state.json was last frozen by the previous
      // run. No-op when HEAD isn't on a step-commit.
      try {
        await checkpointService.syncStateFromHead(projectDir);
      } catch (err) {
        console.warn("[app] syncStateFromHead before resume failed:", err);
      }
      handleStartLoop({ resume: true });
      return;
    }

    // Default: run all unfinished specs in build mode
    const firstUnfinished = project.specSummaries.find((s) => s.doneTasks < s.totalTasks);
    if (!firstUnfinished) return;

    const config: RunConfig = {
      projectDir,
      specDir: firstUnfinished.name,
      mode: "build",
      model: "claude-opus-4-6",
      maxIterations: 20,
      maxTurns: 75,
      taskPhases: "all",
      runAllSpecs: true,
    };
    orchestratorService.startRun(config);
  };

  const handleViewPhaseTrace = useCallback(
    async (phase: TaskPhase) => {
      // If this is the actively running phase, switch back to live stream
      if (orchestrator.isRunning && orchestrator.currentPhase?.number === phase.number) {
        if (project.projectDir && orchestrator.currentRunId) {
          orchestrator.switchToLive(project.projectDir, orchestrator.currentRunId);
        }
        setCurrentView("trace");
        return;
      }
      if (!project.projectDir || !project.selectedSpec) return;
      const found = await orchestrator.loadPhaseTrace(
        project.projectDir,
        project.selectedSpec,
        phase,
      );
      if (found) {
        setCurrentView("trace");
      }
    },
    [
      project.projectDir,
      project.selectedSpec,
      orchestrator.loadPhaseTrace,
      orchestrator.switchToLive,
      orchestrator.isRunning,
      orchestrator.currentPhase,
      orchestrator.currentRunId,
    ],
  );

  // 008 checkpoint tracking for DEBUG badge
  const [checkpointDebug, setCheckpointDebug] = useState<{
    currentAttemptBranch: string | null;
    lastCheckpointTag: string | null;
    candidateSha: string | null;
  }>({ currentAttemptBranch: null, lastCheckpointTag: null, candidateSha: null });
  useEffect(() => {
    const off = orchestratorService.subscribeEvents((raw) => {
      const e = raw as unknown as {
        type?: string;
        checkpointTag?: string;
        candidateSha?: string;
        attemptBranch?: string;
      };
      if (e.type === "step_candidate") {
        setCheckpointDebug((prev) => ({
          currentAttemptBranch: e.attemptBranch ?? prev.currentAttemptBranch,
          lastCheckpointTag: e.checkpointTag ?? prev.lastCheckpointTag,
          candidateSha: e.candidateSha ?? prev.candidateSha,
        }));
      } else if (e.type === "checkpoint_promoted") {
        setCheckpointDebug((prev) => ({
          ...prev,
          lastCheckpointTag: e.checkpointTag ?? prev.lastCheckpointTag,
        }));
      }
    });
    return off;
  }, []);

  // Timeline snapshot only used here for the live git branch — cheap (cached in
  // useTimeline, refreshed on orchestrator events).
  const { snapshot: timelineSnapshot } = useTimeline(project.projectDir);

  const debugContext = useMemo<DebugContext>(
    () => ({
      runId: orchestrator.currentRunId,
      agentRunId: orchestrator.currentPhaseTraceId,
      mode: orchestrator.mode,
      cycle: orchestrator.currentCycle,
      step: orchestrator.currentStage,
      specDir: orchestrator.activeSpecDir,
      phase: orchestrator.currentPhase
        ? `${orchestrator.currentPhase.number} - ${orchestrator.currentPhase.name}`
        : null,
      phaseNumber: orchestrator.currentPhase?.number ?? null,
      phaseName: orchestrator.currentPhase?.name ?? null,
      projectDir: project.projectDir,
      view: currentView,
      isRunning: orchestrator.isRunning,
      viewingHistorical: orchestrator.viewingHistorical,
      branch: timelineSnapshot.currentBranch || null,
      currentAttemptBranch: checkpointDebug.currentAttemptBranch,
      lastCheckpointTag: checkpointDebug.lastCheckpointTag,
      candidateSha: checkpointDebug.candidateSha,
    }),
    [
      orchestrator.currentRunId,
      orchestrator.currentPhaseTraceId,
      orchestrator.mode,
      orchestrator.currentCycle,
      orchestrator.currentStage,
      orchestrator.activeSpecDir,
      orchestrator.currentPhase,
      project.projectDir,
      currentView,
      orchestrator.isRunning,
      orchestrator.viewingHistorical,
      timelineSnapshot.currentBranch,
      checkpointDebug.currentAttemptBranch,
      checkpointDebug.lastCheckpointTag,
      checkpointDebug.candidateSha,
    ],
  );

  const debugBadge = <DebugCopyBadge context={debugContext} />;

  const content = (
    <AppRouter
      currentView={currentView}
      setCurrentView={setCurrentView}
      projectDir={project.projectDir}
      selectedSpec={project.selectedSpec}
      specSummaries={project.specSummaries}
      phases={project.phases}
      phaseStats={project.phaseStats}
      openProjectPath={project.openProjectPath}
      createProject={project.createProject}
      liveSteps={orchestrator.liveSteps}
      subagents={orchestrator.subagents}
      currentPhase={orchestrator.currentPhase}
      currentPhaseTraceId={orchestrator.currentPhaseTraceId}
      currentRunId={orchestrator.currentRunId}
      activeSpecDir={orchestrator.activeSpecDir}
      activeTask={orchestrator.activeTask}
      isRunning={orchestrator.isRunning}
      viewingHistorical={orchestrator.viewingHistorical}
      totalCost={orchestrator.totalCost}
      totalDuration={orchestrator.totalDuration}
      mode={orchestrator.mode}
      currentCycle={orchestrator.currentCycle}
      currentStage={orchestrator.currentStage}
      isClarifying={orchestrator.isClarifying}
      loopCycles={orchestrator.loopCycles}
      preCycleStages={orchestrator.preCycleStages}
      prerequisitesChecks={orchestrator.prerequisitesChecks}
      isCheckingPrerequisites={orchestrator.isCheckingPrerequisites}
      loopTermination={orchestrator.loopTermination}
      latestAction={orchestrator.latestAction}
      loadRunHistory={orchestrator.loadRunHistory}
      selectedSubagent={selectedSubagent}
      handleWelcomeComplete={handleWelcomeComplete}
      handleStartLoop={handleStartLoop}
      handleSelectSpec={handleSelectSpec}
      handleSubagentClick={handleSubagentClick}
      handleSubagentBadgeClick={handleSubagentBadgeClick}
      handleBackFromSubagent={handleBackFromSubagent}
      handleStageClick={handleStageClick}
      handleImplPhaseClick={handleImplPhaseClick}
      handleViewPhaseTrace={handleViewPhaseTrace}
      debugBadge={debugBadge}
    />
  );

  const tabs = project.projectDir ? <TopTabBar active={topTab} onChange={setTopTab} /> : null;

  // 010 — when the user is on the Steps tab, force the Loop dashboard regardless
  // of whichever sub-view currentView points at. Spec / trace / subagent
  // detail views remain reachable from inside the dashboard via spec-card
  // clicks; they don't belong on the top-level "Steps" tab.
  const stepsTabContent =
    project.projectDir &&
    project.specSummaries.length === 0 &&
    !orchestrator.isRunning ? (
      <LoopStartPanel
        projectDir={project.projectDir}
        isRunning={orchestrator.isRunning}
        onStart={handleStartLoop}
      />
    ) : project.projectDir ? (
      <LoopDashboard
        cycles={orchestrator.loopCycles}
        preCycleStages={orchestrator.preCycleStages}
        prerequisitesChecks={orchestrator.prerequisitesChecks}
        isCheckingPrerequisites={orchestrator.isCheckingPrerequisites}
        currentCycle={orchestrator.currentCycle}
        currentStage={orchestrator.currentStage}
        isClarifying={orchestrator.isClarifying}
        isRunning={orchestrator.isRunning}
        totalCost={orchestrator.totalCost}
        loopTermination={orchestrator.loopTermination}
        specSummaries={project.specSummaries}
        onStageClick={handleStageClick}
        onImplPhaseClick={handleImplPhaseClick}
        onSelectSpec={handleSelectSpec}
        debugBadge={debugBadge}
        projectDir={project.projectDir}
        latestAction={orchestrator.latestAction}
      />
    ) : (
      content
    );

  const shellContent =
    topTab === "timeline" && project.projectDir ? (
      <TimelineView projectDir={project.projectDir} />
    ) : topTab === "steps" && project.projectDir ? (
      stepsTabContent
    ) : (
      content
    );

  return (
    <>
      <AppShell
        projectDir={project.projectDir}
        aggregate={project.aggregate}
        isRunning={orchestrator.isRunning}
        isPausedLoop={
          !orchestrator.isRunning &&
          (orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0) &&
          !orchestrator.loopTermination
        }
        onOpenProject={handleOpenProject}
        onGoHome={handleGoHome}
        onRefreshProject={project.refreshProject}
        onDeselectSpec={handleDeselectSpec}
        onStart={handleStart}
        onStop={() => orchestratorService.stopRun()}
        tabs={tabs}
        content={shellContent}
      />
      <ClarificationPanel />
      <CheckpointsEnvelope projectDir={project.projectDir ?? null} />
    </>
  );
}
