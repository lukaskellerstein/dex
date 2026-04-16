import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Check, RotateCw, FolderPlus } from "lucide-react";
import type { Phase, Task, RunConfig, SubagentInfo } from "../core/types.js";
import { AgentStepList } from "./components/agent-trace/AgentStepList.js";
import { SubagentDetailView } from "./components/agent-trace/SubagentDetailView.js";
import { AppShell } from "./components/layout/AppShell.js";
import { ProjectOverview } from "./components/project-overview/ProjectOverview.js";
import { PhaseView } from "./components/task-board/PhaseView.js";
import { ProgressBar } from "./components/task-board/ProgressBar.js";
import { LoopStartPanel } from "./components/loop/LoopStartPanel.js";
import { LoopDashboard } from "./components/loop/LoopDashboard.js";
import { ClarificationPanel } from "./components/loop/ClarificationPanel.js";
import { useOrchestrator } from "./hooks/useOrchestrator.js";
import { useProject } from "./hooks/useProject.js";

interface DebugContext {
  runId: string | null;
  phaseTraceId: string | null;
  mode: string | null;
  cycle: number | null;
  stage: string | null;
  specDir: string | null;
  phase: string | null;
  projectDir: string | null;
  view: string;
  isRunning: boolean;
  viewingHistorical: boolean;
}

function buildDebugPayload(ctx: DebugContext): string {
  const lines: string[] = ["Dex Debug Context", "─────────────────"];
  const add = (label: string, val: unknown) => {
    if (val != null && val !== "") lines.push(`${label.padEnd(16)} ${val}`);
  };
  add("RunID:", ctx.runId);
  add("PhaseTraceID:", ctx.phaseTraceId);
  add("Mode:", ctx.mode);
  add("Cycle:", ctx.cycle);
  add("Stage:", ctx.stage);
  add("SpecDir:", ctx.specDir);
  add("Phase:", ctx.phase);
  add("ProjectDir:", ctx.projectDir);
  add("View:", ctx.view);
  add("IsRunning:", ctx.isRunning);
  add("ViewHistory:", ctx.viewingHistorical);
  add("Timestamp:", new Date().toISOString());
  return lines.join("\n");
}

function DebugCopyBadge({ context }: { context: DebugContext }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(buildDebugPayload(context));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [context]);
  return (
    <span
      title={copied ? "Copied!" : "Copy debug context to clipboard"}
      onClick={handleClick}
      style={{
        fontSize: "0.68rem",
        padding: "1px 5px",
        borderRadius: "var(--radius)",
        background: copied
          ? "color-mix(in srgb, var(--status-success) 15%, var(--surface-elevated))"
          : "var(--surface-elevated)",
        border: `1px solid ${copied ? "var(--status-success)" : "var(--border)"}`,
        color: copied ? "var(--status-success)" : "var(--foreground-dim)",
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
      }}
    >
      {copied ? <Check size={10} /> : <Bug size={10} />}
      {copied ? "copied" : "debug"}
    </span>
  );
}

type View = "overview" | "tasks" | "trace" | "subagent-detail" | "loop-start" | "loop-dashboard" | "loop-summary";

export default function App() {
  const project = useProject();
  const orchestrator = useOrchestrator();
  const [currentView, setCurrentView] = useState<View>("overview");
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);

  // Derive selectedSubagent from live data so completedAt updates propagate
  const selectedSubagent = useMemo(
    () => selectedSubagentId ? orchestrator.subagents.find((s) => s.subagentId === selectedSubagentId) ?? null : null,
    [selectedSubagentId, orchestrator.subagents]
  );
  const [, setTick] = useState(0);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [newProjectFolder, setNewProjectFolder] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const newProjectInputRef = useRef<HTMLInputElement>(null);

  const handleOpenProject = useCallback(async () => {
    const dir = await project.openProject();
    if (dir) {
      const hasHistory = await orchestrator.loadRunHistory(dir);
      setCurrentView(hasHistory ? "loop-dashboard" : "overview");
    }
  }, [project.openProject, orchestrator.loadRunHistory]);

  // Tick every second while running so duration updates in realtime
  useEffect(() => {
    if (!orchestrator.isRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [orchestrator.isRunning]);

  const handleSubagentClick = useCallback(
    (subagentId: string) => {
      setSelectedSubagentId(subagentId);
      setCurrentView("subagent-detail");
    },
    []
  );

  const handleSubagentBadgeClick = useCallback(
    (sub: SubagentInfo) => {
      setSelectedSubagentId(sub.subagentId);
      setCurrentView("subagent-detail");
    },
    []
  );

  const handleBackFromSubagent = useCallback(() => {
    setSelectedSubagentId(null);
    setCurrentView("trace");
  }, []);

  const handleStageClick = useCallback(
    async (stage: import("./hooks/useOrchestrator.js").UiLoopStage) => {
      if (stage.status === "running") {
        await orchestrator.switchToLive();
      } else {
        await orchestrator.loadStageTrace(stage.phaseTraceId, stage.type, { costUsd: stage.costUsd, durationMs: stage.durationMs });
      }
      setCurrentView("trace");
    },
    [orchestrator.switchToLive, orchestrator.loadStageTrace]
  );

  const handleImplPhaseClick = useCallback(
    async (phaseTraceId: string) => {
      await orchestrator.loadStageTrace(phaseTraceId, "implement");
      setCurrentView("trace");
    },
    [orchestrator.loadStageTrace]
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

  // Refresh project when entering implement stage so the newly-created spec
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

  const handleNewProject = useCallback(() => {
    setNewProjectFolder(null);
    setNewProjectName("");
    setNewProjectError(null);
    setShowNewProjectDialog(true);
  }, []);

  const handlePickFolder = useCallback(async () => {
    const folder = await window.dexAPI.pickFolder();
    if (folder) {
      setNewProjectFolder(folder);
      setNewProjectError(null);
      setTimeout(() => newProjectInputRef.current?.focus(), 50);
    }
  }, []);

  const handleNewProjectSubmit = useCallback(async () => {
    const name = newProjectName.trim();
    if (!name || !newProjectFolder) return;
    const result = await project.createProject(newProjectFolder, name);
    if ("error" in result) {
      setNewProjectError(result.error);
      return;
    }
    setShowNewProjectDialog(false);
    setCurrentView("loop-start");
  }, [newProjectName, newProjectFolder, project.createProject]);

  const handleStartLoop = (loopConfig: {
    descriptionFile?: string;
    maxLoopCycles?: number;
    maxBudgetUsd?: number;
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
      phases: "all",
      ...rest,
      ...(resume ? { resume: true } : {}),
    };
    window.dexAPI.startRun(config);
  };

  const handleSelectSpec = (spec: string) => {
    project.selectSpec(spec);
    setCurrentView("tasks");
  };

  const handleGoHome = useCallback(() => {
    if (orchestrator.isRunning) return; // don't allow while running
    project.clearProject();
    setCurrentView("overview");
  }, [orchestrator.isRunning, project.clearProject]);

  const handleDeselectSpec = () => {
    project.deselectSpec();
    const hasLoopHistory = orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0;
    if (hasLoopHistory || orchestrator.mode === "loop") {
      setCurrentView("loop-dashboard");
    } else {
      setCurrentView("overview");
    }
  };

  const handleStart = (partial: Partial<RunConfig>) => {
    const projectDir = partial.projectDir ?? project.projectDir!;

    // If we have loop history (paused loop), resume in loop mode
    const hasLoopHistory = orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0;
    if (hasLoopHistory || orchestrator.mode === "loop") {
      // Resume from state file
      handleStartLoop({ resume: true });
      return;
    }

    // Default: run all unfinished specs in build mode
    const firstUnfinished = project.specSummaries.find(
      (s) => s.doneTasks < s.totalTasks
    );
    if (!firstUnfinished) return;

    const config: RunConfig = {
      projectDir,
      specDir: firstUnfinished.name,
      mode: "build",
      model: "claude-opus-4-6",
      maxIterations: 20,
      maxTurns: 75,
      phases: "all",
      runAllSpecs: true,
    };
    window.dexAPI.startRun(config);
  };



  const handleViewPhaseTrace = useCallback(
    async (phase: Phase) => {
      // If this is the actively running phase, switch back to live stream
      if (orchestrator.isRunning && orchestrator.currentPhase?.number === phase.number) {
        orchestrator.switchToLive();
        setCurrentView("trace");
        return;
      }
      if (!project.projectDir || !project.selectedSpec) return;
      const found = await orchestrator.loadPhaseTrace(
        project.projectDir,
        project.selectedSpec,
        phase
      );
      if (found) {
        setCurrentView("trace");
      }
    },
    [project.projectDir, project.selectedSpec, orchestrator.loadPhaseTrace, orchestrator.switchToLive, orchestrator.isRunning, orchestrator.currentPhase]
  );

  const debugContext = useMemo<DebugContext>(() => ({
    runId: orchestrator.currentRunId,
    phaseTraceId: orchestrator.currentPhaseTraceId,
    mode: orchestrator.mode,
    cycle: orchestrator.currentCycle,
    stage: orchestrator.currentStage,
    specDir: orchestrator.activeSpecDir,
    phase: orchestrator.currentPhase
      ? `${orchestrator.currentPhase.number} - ${orchestrator.currentPhase.name}`
      : null,
    projectDir: project.projectDir,
    view: currentView,
    isRunning: orchestrator.isRunning,
    viewingHistorical: orchestrator.viewingHistorical,
  }), [
    orchestrator.currentRunId, orchestrator.currentPhaseTraceId, orchestrator.mode,
    orchestrator.currentCycle, orchestrator.currentStage, orchestrator.activeSpecDir,
    orchestrator.currentPhase, project.projectDir, currentView,
    orchestrator.isRunning, orchestrator.viewingHistorical,
  ]);

  let content;

  if (!project.projectDir) {
    content = (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          paddingTop: 120,
          gap: 16,
          color: "var(--foreground-dim)",
        }}
      >
        <span style={{ fontSize: "0.88rem" }}>Create a new project or open an existing one</span>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={handleNewProject}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              background: "var(--primary)",
              color: "#fff",
              borderRadius: "var(--radius)",
              fontWeight: 500,
              fontSize: "0.84rem",
              cursor: "pointer",
              border: "none",
            }}
          >
            <FolderPlus size={14} />
            New Project
          </button>
          <button
            onClick={handleOpenProject}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              background: "var(--surface-elevated)",
              color: "var(--foreground-muted)",
              borderRadius: "var(--radius)",
              fontWeight: 500,
              fontSize: "0.84rem",
              cursor: "pointer",
              border: "1px solid var(--border)",
            }}
          >
            Open Existing
          </button>
        </div>
      </div>
    );
  } else if (currentView === "subagent-detail" && selectedSubagent) {
    content = (
      <SubagentDetailView
        subagent={selectedSubagent}
        parentSteps={orchestrator.liveSteps}
        allSubagents={orchestrator.subagents}
        isRunning={orchestrator.isRunning}
        onBack={handleBackFromSubagent}
      />
    );
  } else if (currentView === "trace") {
    const traceStartedAt = orchestrator.liveSteps[0]?.createdAt;
    const isLiveTrace = orchestrator.isRunning && !orchestrator.viewingHistorical;
    // Show current phase elapsed time when running live, not the run-level accumulation
    const traceDurationMs = isLiveTrace && traceStartedAt
      ? Date.now() - new Date(traceStartedAt).getTime()
      : orchestrator.totalDuration > 0
        ? orchestrator.totalDuration
        : traceStartedAt
          ? Date.now() - new Date(traceStartedAt).getTime()
          : 0;

    content = (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* Breadcrumb: spec / phase */}
        <div
          style={{
            position: "relative",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "color-mix(in srgb, var(--primary) 4%, var(--background))",
            fontSize: "0.82rem",
          }}
        >
          {orchestrator.mode === "loop" && (
            <>
              <span
                onClick={() => setCurrentView("loop-dashboard")}
                style={{
                  color: "var(--foreground-muted)",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--foreground-muted)"; }}
              >
                Loop
              </span>
              <span style={{ color: "var(--foreground-dim)" }}>/</span>
              {orchestrator.currentCycle != null && (
                <>
                  <span
                    onClick={() => setCurrentView("loop-dashboard")}
                    style={{
                      color: "var(--foreground-muted)",
                      cursor: "pointer",
                      transition: "color 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--primary)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--foreground-muted)"; }}
                  >
                    Cycle {orchestrator.currentCycle}
                  </span>
                  <span style={{ color: "var(--foreground-dim)" }}>/</span>
                </>
              )}
            </>
          )}
          {orchestrator.mode !== "loop" && project.selectedSpec && (
            <>
              <span
                onClick={() => setCurrentView("tasks")}
                style={{
                  color: "var(--foreground-muted)",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--primary)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--foreground-muted)"; }}
              >
                {project.selectedSpec}
              </span>
              <span style={{ color: "var(--foreground-dim)" }}>/</span>
            </>
          )}
          {orchestrator.currentPhase && (
            <span style={{ fontWeight: 600, color: "var(--foreground)" }}>
              {orchestrator.currentPhase.name.startsWith("loop:")
                ? orchestrator.currentPhase.name.replace("loop:", "").replace("_", " ")
                : `Phase ${orchestrator.currentPhase.number}: ${orchestrator.currentPhase.name}`}
            </span>
          )}
          {/* Center: loop indicators */}
          {isLiveTrace && orchestrator.mode === "loop" && (
            <span style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "0.75rem",
              color: "var(--foreground-muted)",
            }}>
              <RotateCw size={11} style={{ animation: "spin 2s linear infinite" }} />
              {orchestrator.isClarifying ? (
                <span style={{ color: "var(--primary)" }}>Clarifying...</span>
              ) : (
                <>
                  {orchestrator.currentCycle != null && (
                    <span>
                      Cycle <span style={{ fontFamily: "var(--font-mono)", color: "var(--foreground)" }}>{orchestrator.currentCycle}</span>
                    </span>
                  )}
                  {orchestrator.currentStage && (
                    <span style={{
                      padding: "1px 6px",
                      borderRadius: "var(--radius)",
                      background: "var(--primary-muted)",
                      color: "var(--primary)",
                      fontWeight: 500,
                    }}>
                      {orchestrator.currentStage.replace("_", " ")}
                    </span>
                  )}
                </>
              )}
              {orchestrator.totalCost != null && orchestrator.totalCost > 0 && (
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  ${orchestrator.totalCost.toFixed(2)}
                </span>
              )}
            </span>
          )}
          {/* Right: debug context badge */}
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <DebugCopyBadge context={debugContext} />
          </span>
        </div>
        <AgentStepList
          steps={orchestrator.liveSteps}
          isRunning={isLiveTrace}
          agentId={orchestrator.currentPhaseTraceId ?? undefined}
          startedAt={traceStartedAt}
          durationMs={traceDurationMs}
          subagents={orchestrator.subagents}
          onSubagentClick={handleSubagentClick}
          onSubagentBadgeClick={handleSubagentBadgeClick}
        />
      </div>
    );
  } else if (currentView === "loop-dashboard" || currentView === "loop-summary" || (currentView === "trace" && orchestrator.mode === "loop" && orchestrator.isRunning && !orchestrator.currentStage && !orchestrator.isClarifying)) {
    content = (
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
        debugBadge={<DebugCopyBadge context={debugContext} />}
      />
    );
  } else if (currentView === "loop-start") {
    content = project.projectDir ? (
      <LoopStartPanel
        projectDir={project.projectDir}
        isRunning={orchestrator.isRunning}
        onStart={handleStartLoop}
      />
    ) : null;
  } else if (currentView === "overview" || !project.selectedSpec) {
    // If project has no specs, show LoopStartPanel so user can generate them
    if (project.projectDir && project.specSummaries.length === 0) {
      content = (
        <LoopStartPanel
          projectDir={project.projectDir}
          isRunning={orchestrator.isRunning}
          onStart={handleStartLoop}
        />
      );
    } else {
      content = (
        <ProjectOverview
          specSummaries={project.specSummaries}
          onSelectSpec={handleSelectSpec}

          isRunning={orchestrator.isRunning}
          activeSpecDir={orchestrator.activeSpecDir}
          activePhase={orchestrator.currentPhase}
          activeTask={orchestrator.activeTask}
        />
      );
    }
  } else {
    content = (
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
          {project.phases.length > 0 ? (
            project.phases.map((phase) => (
              <PhaseView
                key={phase.number}
                phase={phase}
                isRunning={orchestrator.isRunning && !orchestrator.viewingHistorical && orchestrator.currentPhase?.number === phase.number && orchestrator.activeSpecDir === project.selectedSpec}
                isSelected={!orchestrator.isRunning && orchestrator.currentPhase?.number === phase.number && orchestrator.activeSpecDir === project.selectedSpec}
                traceStats={project.phaseStats.get(phase.number)}
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

        {project.phases.length > 0 && (
          <ProgressBar
            phases={project.phases}
            totalCost={orchestrator.totalCost}
            totalDuration={orchestrator.totalDuration}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <AppShell
        projectDir={project.projectDir}
        aggregate={project.aggregate}
        isRunning={orchestrator.isRunning}
        isPausedLoop={!orchestrator.isRunning && (orchestrator.loopCycles.length > 0 || orchestrator.preCycleStages.length > 0) && !orchestrator.loopTermination}
        onOpenProject={handleOpenProject}
        onGoHome={handleGoHome}
        onRefreshProject={project.refreshProject}
        onDeselectSpec={handleDeselectSpec}
        onStart={handleStart}
        onStop={() => window.dexAPI.stopRun()}
        content={content}
      />
      {orchestrator.pendingQuestion && (
        <ClarificationPanel
          requestId={orchestrator.pendingQuestion.requestId}
          questions={orchestrator.pendingQuestion.questions}
          onAnswer={orchestrator.answerQuestion}
        />
      )}
      {showNewProjectDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.5)",
          }}
          onClick={() => setShowNewProjectDialog(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "24px 28px",
              width: 440,
              boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: "0.92rem", fontWeight: 600, color: "var(--foreground)", marginBottom: 20 }}>
              New Project
            </div>

            {/* Step 1: Pick folder */}
            <label style={{ fontSize: "0.78rem", color: "var(--foreground-dim)", display: "block", marginBottom: 6 }}>
              Location
            </label>
            <button
              onClick={handlePickFolder}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--surface-elevated)",
                color: newProjectFolder ? "var(--foreground)" : "var(--foreground-dim)",
                fontSize: "0.84rem",
                fontFamily: "inherit",
                cursor: "pointer",
                textAlign: "left",
                boxSizing: "border-box",
                transition: "border-color 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--primary)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
            >
              <FolderPlus size={14} style={{ flexShrink: 0, color: "var(--primary)" }} />
              {newProjectFolder ?? "Select folder..."}
            </button>

            {/* Step 2: Project name (shown after folder is selected) */}
            {newProjectFolder && (
              <div style={{ marginTop: 14 }}>
                <label style={{ fontSize: "0.78rem", color: "var(--foreground-dim)", display: "block", marginBottom: 6 }}>
                  Project name
                </label>
                <input
                  ref={newProjectInputRef}
                  type="text"
                  value={newProjectName}
                  onChange={(e) => { setNewProjectName(e.target.value); setNewProjectError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleNewProjectSubmit(); if (e.key === "Escape") setShowNewProjectDialog(false); }}
                  placeholder="my-awesome-project"
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: "var(--radius)",
                    border: `1px solid ${newProjectError ? "var(--status-error)" : "var(--border)"}`,
                    background: "var(--surface-elevated)",
                    color: "var(--foreground)",
                    fontSize: "0.84rem",
                    fontFamily: "inherit",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                {newProjectName.trim() && (
                  <div style={{ fontSize: "0.72rem", color: "var(--foreground-dim)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
                    {newProjectFolder}/{newProjectName.trim()}
                  </div>
                )}
              </div>
            )}

            {newProjectError && (
              <div style={{ fontSize: "0.76rem", color: "var(--status-error)", marginTop: 8 }}>
                {newProjectError}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button
                onClick={() => setShowNewProjectDialog(false)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "var(--radius)",
                  fontSize: "0.82rem",
                  background: "var(--surface-elevated)",
                  color: "var(--foreground-muted)",
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleNewProjectSubmit}
                disabled={!newProjectFolder || !newProjectName.trim()}
                style={{
                  padding: "6px 14px",
                  borderRadius: "var(--radius)",
                  fontSize: "0.82rem",
                  fontWeight: 600,
                  background: newProjectFolder && newProjectName.trim() ? "var(--primary)" : "var(--surface-elevated)",
                  color: newProjectFolder && newProjectName.trim() ? "#fff" : "var(--foreground-disabled)",
                  border: "none",
                  cursor: newProjectFolder && newProjectName.trim() ? "pointer" : "not-allowed",
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
