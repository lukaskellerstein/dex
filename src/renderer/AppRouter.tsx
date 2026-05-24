/**
 * What: Renders the active view (welcome / overview / tasks / trace / subagent-detail / loop-start / loop-dashboard) based on currentView + project state. Receives orchestrator and project state via props.
 * Not: Does not own state; pulls everything from props. Does not handle navigation transitions — App owns setCurrentView.
 * Deps: useOrchestrator, useProject types; component imports for each view; AppBreadcrumbs for the trace breadcrumb.
 */
import type { ReactNode } from "react";
import type { TaskPhase, SubagentInfo, StepType, LoopTermination, PrerequisiteCheck, Task, AgentStep } from "../core/types.js";
import { WelcomeScreen, type WelcomeNextView } from "./components/welcome/WelcomeScreen.js";
import { AgentStepList } from "./components/agent-trace/AgentStepList.js";
import { SubagentDetailView } from "./components/agent-trace/SubagentDetailView.js";
import { ProjectOverview } from "./components/project-overview/ProjectOverview.js";
import { PhaseView } from "./components/task-board/PhaseView.js";
import { ProgressBar } from "./components/task-board/ProgressBar.js";
import { LoopStartPanel } from "./components/loop/LoopStartPanel.js";
import { LoopDashboard } from "./components/loop/LoopDashboard.js";
import { AppBreadcrumbs } from "./components/AppBreadcrumbs.js";
import type { SpecSummary } from "./hooks/useProject.js";
import type { UiLoopStage, UiLoopCycle, LatestAction } from "./hooks/useOrchestrator.js";
import type { AgentRunRecord } from "../core/runs.js";

export type View =
  | "overview"
  | "tasks"
  | "trace"
  | "subagent-detail"
  | "loop-start"
  | "loop-dashboard";

export interface AppRouterProps {
  // View routing
  currentView: View;
  setCurrentView: (v: View) => void;

  // Project
  projectDir: string | null;
  selectedSpec: string | null;
  specSummaries: SpecSummary[];
  phases: TaskPhase[];
  phaseStats: Map<number, AgentRunRecord>;
  openProjectPath: (target: string) => Promise<{ path: string } | { error: string }>;
  createProject: (parent: string, name: string) => Promise<{ path: string } | { error: string }>;

  // Orchestrator state
  liveSteps: AgentStep[];
  subagents: SubagentInfo[];
  currentPhase: TaskPhase | null;
  currentPhaseTraceId: string | null;
  currentRunId: string | null;
  activeSpecDir: string | null;
  activeTask: Task | null;
  isRunning: boolean;
  viewingHistorical: boolean;
  totalCost: number;
  totalDuration: number;
  mode: string | null;
  currentCycle: number | null;
  currentStage: StepType | null;
  isClarifying: boolean;
  loopCycles: UiLoopCycle[];
  preCycleStages: UiLoopStage[];
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  loopTermination: LoopTermination | null;
  latestAction: LatestAction | null;

  // Imperative actions
  loadRunHistory: (projectDir: string) => Promise<boolean>;
  selectedSubagent: SubagentInfo | null;
  handleWelcomeComplete: (next: WelcomeNextView) => void;
  handleStartLoop: (loopConfig: {
    descriptionFile?: string;
    autoClarification?: boolean;
    resume?: boolean;
  }) => void;
  handleSelectSpec: (spec: string) => void;
  handleSubagentClick: (subagentId: string) => void;
  handleSubagentBadgeClick: (sub: SubagentInfo) => void;
  handleBackFromSubagent: () => void;
  handleStageClick: (step: UiLoopStage) => void;
  handleImplPhaseClick: (phaseTraceId: string) => void;
  handleViewPhaseTrace: (phase: TaskPhase) => void;

  // Debug badge slot
  debugBadge: ReactNode;
}

export function AppRouter(props: AppRouterProps): ReactNode {
  const {
    currentView,
    setCurrentView,
    projectDir,
    selectedSpec,
    specSummaries,
    phases,
    phaseStats,
    openProjectPath,
    createProject,
    liveSteps,
    subagents,
    currentPhase,
    currentPhaseTraceId,
    activeSpecDir,
    activeTask,
    isRunning,
    viewingHistorical,
    totalCost,
    totalDuration,
    mode,
    currentCycle,
    currentStage,
    isClarifying,
    loopCycles,
    preCycleStages,
    prerequisitesChecks,
    isCheckingPrerequisites,
    loopTermination,
    latestAction,
    loadRunHistory,
    selectedSubagent,
    handleWelcomeComplete,
    handleStartLoop,
    handleSelectSpec,
    handleSubagentClick,
    handleSubagentBadgeClick,
    handleBackFromSubagent,
    handleStageClick,
    handleImplPhaseClick,
    handleViewPhaseTrace,
    debugBadge,
  } = props;

  if (!projectDir) {
    return (
      <WelcomeScreen
        openProjectPath={openProjectPath}
        createProject={createProject}
        loadRunHistory={loadRunHistory}
        onComplete={handleWelcomeComplete}
      />
    );
  }

  if (currentView === "subagent-detail" && selectedSubagent) {
    return (
      <SubagentDetailView
        subagent={selectedSubagent}
        parentSteps={liveSteps}
        allSubagents={subagents}
        isRunning={isRunning}
        onBack={handleBackFromSubagent}
      />
    );
  }

  if (currentView === "trace") {
    const traceStartedAt = liveSteps[0]?.createdAt;
    const isLiveTrace = isRunning && !viewingHistorical;
    // Show current phase elapsed time when running live, not the run-level accumulation
    const traceDurationMs =
      isLiveTrace && traceStartedAt
        ? Date.now() - new Date(traceStartedAt).getTime()
        : totalDuration > 0
          ? totalDuration
          : traceStartedAt
            ? Date.now() - new Date(traceStartedAt).getTime()
            : 0;

    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <AppBreadcrumbs
          mode={mode}
          currentCycle={currentCycle}
          currentStage={currentStage}
          loopCycles={loopCycles}
          selectedSpec={selectedSpec}
          currentPhase={currentPhase}
          isLiveTrace={isLiveTrace}
          isClarifying={isClarifying}
          totalCost={totalCost}
          debugBadge={debugBadge}
          onLoopDashboardClick={() => setCurrentView("loop-dashboard")}
          onSpecClick={(spec) => handleSelectSpec(spec)}
          onTasksClick={() => setCurrentView("tasks")}
        />
        <AgentStepList
          steps={liveSteps}
          isRunning={isLiveTrace}
          agentId={currentPhaseTraceId ?? undefined}
          startedAt={traceStartedAt}
          durationMs={traceDurationMs}
          subagents={subagents}
          onSubagentClick={handleSubagentClick}
          onSubagentBadgeClick={handleSubagentBadgeClick}
        />
      </div>
    );
  }

  if (
    currentView === "loop-dashboard" ||
    (currentView === "trace" &&
      mode === "loop" &&
      isRunning &&
      !currentStage &&
      !isClarifying)
  ) {
    return (
      <LoopDashboard
        cycles={loopCycles}
        preCycleStages={preCycleStages}
        prerequisitesChecks={prerequisitesChecks}
        isCheckingPrerequisites={isCheckingPrerequisites}
        currentCycle={currentCycle}
        currentStage={currentStage}
        isClarifying={isClarifying}
        isRunning={isRunning}
        totalCost={totalCost}
        loopTermination={loopTermination}
        specSummaries={specSummaries}
        onStageClick={handleStageClick}
        onImplPhaseClick={handleImplPhaseClick}
        onSelectSpec={handleSelectSpec}
        debugBadge={debugBadge}
        projectDir={projectDir}
        latestAction={latestAction}
      />
    );
  }

  if (currentView === "loop-start") {
    return (
      <LoopStartPanel
        projectDir={projectDir}
        isRunning={isRunning}
        onStart={handleStartLoop}
      />
    );
  }

  if (currentView === "overview" || !selectedSpec) {
    // If project has no specs, show LoopStartPanel so user can generate them.
    if (specSummaries.length === 0) {
      return (
        <LoopStartPanel
          projectDir={projectDir}
          isRunning={isRunning}
          onStart={handleStartLoop}
        />
      );
    }
    return (
      <ProjectOverview
        specSummaries={specSummaries}
        onSelectSpec={handleSelectSpec}
        isRunning={isRunning}
        activeSpecDir={activeSpecDir}
        activePhase={currentPhase}
        activeTask={activeTask}
      />
    );
  }

  // Default: tasks view
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {phases.length > 0 ? (
          phases.map((phase) => (
            <PhaseView
              key={phase.number}
              phase={phase}
              isRunning={
                isRunning &&
                !viewingHistorical &&
                currentPhase?.number === phase.number &&
                activeSpecDir === selectedSpec
              }
              isSelected={
                !isRunning &&
                currentPhase?.number === phase.number &&
                activeSpecDir === selectedSpec
              }
              traceStats={phaseStats.get(phase.number)}
              onViewTrace={handleViewPhaseTrace}
            />
          ))
        ) : (
          <div
            style={{
              textAlign: "center",
              paddingTop: 80,
              color: "var(--foreground-dim)",
            }}
          >
            No phases found in tasks.md
          </div>
        )}
      </div>

      {phases.length > 0 && (
        <ProgressBar
          phases={phases}
          totalCost={totalCost}
          totalDuration={totalDuration}
        />
      )}
    </div>
  );
}
