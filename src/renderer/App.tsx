import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bug, Check, RotateCw, FolderOpen } from "lucide-react";
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
  const [welcomePath, setWelcomePath] = useState("~/Projects/Temp");
  const [welcomeName, setWelcomeName] = useState(() => `project-${Math.random().toString(36).slice(2, 10)}`);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [welcomeTargetExists, setWelcomeTargetExists] = useState(false);

  const handleOpenProject = useCallback(async () => {
    const dir = await project.openProject();
    if (dir) {
      const hasHistory = await orchestrator.loadRunHistory(dir);
      setCurrentView(hasHistory ? "loop-dashboard" : "overview");
    }
  }, [project.openProject, orchestrator.loadRunHistory]);

  // Debounced existence check for the welcome form's target path
  useEffect(() => {
    if (project.projectDir) return;
    const path = welcomePath.trim();
    const name = welcomeName.trim();
    if (!path || !name) {
      setWelcomeTargetExists(false);
      return;
    }
    const target = `${path.replace(/\/$/, "")}/${name}`;
    const id = setTimeout(async () => {
      const exists = await window.dexAPI.pathExists(target);
      setWelcomeTargetExists(exists);
    }, 150);
    return () => clearTimeout(id);
  }, [welcomePath, welcomeName, project.projectDir]);

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
      if (!project.projectDir || !orchestrator.currentRunId) return;
      if (stage.status === "running") {
        await orchestrator.switchToLive(project.projectDir, orchestrator.currentRunId);
      } else {
        await orchestrator.loadStageTrace(project.projectDir, orchestrator.currentRunId, stage.phaseTraceId, stage.type, { costUsd: stage.costUsd, durationMs: stage.durationMs });
      }
      setCurrentView("trace");
    },
    [project.projectDir, orchestrator.currentRunId, orchestrator.switchToLive, orchestrator.loadStageTrace]
  );

  const handleImplPhaseClick = useCallback(
    async (phaseTraceId: string) => {
      if (!project.projectDir || !orchestrator.currentRunId) return;
      await orchestrator.loadStageTrace(project.projectDir, orchestrator.currentRunId, phaseTraceId, "implement");
      setCurrentView("trace");
    },
    [project.projectDir, orchestrator.currentRunId, orchestrator.loadStageTrace]
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

  const handlePickFolder = useCallback(async () => {
    const folder = await window.dexAPI.pickFolder();
    if (folder) {
      setWelcomePath(folder);
      setWelcomeError(null);
    }
  }, []);

  const handleWelcomeSubmit = useCallback(async () => {
    const path = welcomePath.trim();
    const name = welcomeName.trim();
    if (!path || !name) return;
    const target = `${path.replace(/\/$/, "")}/${name}`;

    if (welcomeTargetExists) {
      const result = await project.openProjectPath(target);
      if ("error" in result) {
        setWelcomeError(result.error);
        return;
      }
      const hasHistory = await orchestrator.loadRunHistory(result.path);
      setCurrentView(hasHistory ? "loop-dashboard" : "overview");
      return;
    }

    const result = await project.createProject(path, name);
    if ("error" in result) {
      setWelcomeError(result.error);
      return;
    }
    setCurrentView("loop-start");
  }, [welcomePath, welcomeName, welcomeTargetExists, project.openProjectPath, project.createProject, orchestrator.loadRunHistory]);

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
        phase
      );
      if (found) {
        setCurrentView("trace");
      }
    },
    [project.projectDir, project.selectedSpec, orchestrator.loadPhaseTrace, orchestrator.switchToLive, orchestrator.isRunning, orchestrator.currentPhase, orchestrator.currentRunId]
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
    const canSubmit = welcomePath.trim() !== "" && welcomeName.trim() !== "";
    const combinedPath = `${welcomePath.trim().replace(/\/$/, "")}/${welcomeName.trim()}`;
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
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 440 }}>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--foreground-dim)", display: "block", marginBottom: 6 }}>
              Location
            </label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                data-testid="welcome-path"
                type="text"
                value={welcomePath}
                onChange={(e) => { setWelcomePath(e.target.value); setWelcomeError(null); }}
                placeholder="~/Projects/Temp"
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--surface-elevated)",
                  color: "var(--foreground)",
                  fontSize: "0.84rem",
                  fontFamily: "var(--font-mono)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
              />
              <button
                data-testid="welcome-pick-folder"
                onClick={handlePickFolder}
                title="Pick folder"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  padding: 0,
                  borderRadius: "var(--radius)",
                  border: "1px solid var(--border)",
                  background: "var(--surface-elevated)",
                  color: "var(--foreground-muted)",
                  cursor: "pointer",
                }}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </div>
          <div>
            <label style={{ fontSize: "0.78rem", color: "var(--foreground-dim)", display: "block", marginBottom: 6 }}>
              Project name
            </label>
            <input
              data-testid="welcome-name"
              type="text"
              value={welcomeName}
              onChange={(e) => { setWelcomeName(e.target.value); setWelcomeError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) handleWelcomeSubmit(); }}
              placeholder="my-awesome-project"
              style={{
                width: "100%",
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: `1px solid ${welcomeError ? "var(--status-error)" : "var(--border)"}`,
                background: "var(--surface-elevated)",
                color: "var(--foreground)",
                fontSize: "0.84rem",
                fontFamily: "var(--font-mono)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          {canSubmit && (
            <div style={{ fontSize: "0.72rem", color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
              {combinedPath}
            </div>
          )}
          {welcomeError && (
            <div style={{ fontSize: "0.76rem", color: "var(--status-error)" }}>
              {welcomeError}
            </div>
          )}
          <button
            data-testid="welcome-submit"
            onClick={handleWelcomeSubmit}
            disabled={!canSubmit}
            style={{
              marginTop: 4,
              padding: "8px 16px",
              background: canSubmit ? "var(--primary)" : "var(--surface-elevated)",
              color: canSubmit ? "#fff" : "var(--foreground-disabled)",
              borderRadius: "var(--radius)",
              fontWeight: 500,
              fontSize: "0.84rem",
              cursor: canSubmit ? "pointer" : "not-allowed",
              border: "none",
            }}
          >
            {welcomeTargetExists ? "Open Existing" : "New"}
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
          {orchestrator.mode === "loop" && (() => {
            // Resolve the spec name for the middle crumb from: selected spec →
            // current cycle → last cycle with a specDir. Survives pause, which
            // clears currentCycle via run_completed.
            const currentCycleObj = orchestrator.currentCycle != null
              ? orchestrator.loopCycles.find(c => c.cycleNumber === orchestrator.currentCycle)
              : null;
            const stripSpecs = (s: string) => s.replace(/^specs\//, "");
            const fallbackCycle = [...orchestrator.loopCycles]
              .reverse()
              .find(c => !!c.specDir);
            const specName = project.selectedSpec
              ?? (currentCycleObj?.specDir ? stripSpecs(currentCycleObj.specDir) : null)
              ?? (fallbackCycle?.specDir ? stripSpecs(fallbackCycle.specDir) : null);
            const cycleNumber = orchestrator.currentCycle ?? fallbackCycle?.cycleNumber ?? null;
            const midLabel = cycleNumber != null ? `Cycle ${cycleNumber}` : specName;
            return (
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
                {midLabel && (
                  <>
                    <span
                      onClick={() => {
                        if (specName) {
                          handleSelectSpec(specName);
                        } else {
                          setCurrentView("loop-dashboard");
                        }
                      }}
                      style={{
                        color: "var(--foreground-muted)",
                        cursor: "pointer",
                        transition: "color 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--primary)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--foreground-muted)"; }}
                    >
                      {midLabel}
                    </span>
                    <span style={{ color: "var(--foreground-dim)" }}>/</span>
                  </>
                )}
              </>
            );
          })()}
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
    </>
  );
}
