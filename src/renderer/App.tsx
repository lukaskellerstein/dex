import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import type { Phase, Task, RunConfig, SubagentInfo } from "../core/types.js";
import { AgentStepList } from "./components/agent-trace/AgentStepList.js";
import { SubagentList } from "./components/agent-trace/SubagentList.js";
import { SubagentDetailView } from "./components/agent-trace/SubagentDetailView.js";
import { AppShell } from "./components/layout/AppShell.js";
import { ProjectOverview } from "./components/project-overview/ProjectOverview.js";
import { PhaseView } from "./components/task-board/PhaseView.js";
import { ProgressBar } from "./components/task-board/ProgressBar.js";
import { useOrchestrator } from "./hooks/useOrchestrator.js";
import { useProject } from "./hooks/useProject.js";

function CopyBadge({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);
  return (
    <span
      title={copied ? "Copied!" : "Click to copy"}
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
      {label}:{value}
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </span>
  );
}

type View = "overview" | "tasks" | "trace" | "subagent-detail";

export default function App() {
  const project = useProject();
  const orchestrator = useOrchestrator();
  const [currentView, setCurrentView] = useState<View>("overview");
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentInfo | null>(null);

  const handleSubagentClick = useCallback(
    (subagentId: string) => {
      const sub = orchestrator.subagents.find((s) => s.subagentId === subagentId);
      if (sub) {
        setSelectedSubagent(sub);
        setCurrentView("subagent-detail");
      }
    },
    [orchestrator.subagents]
  );

  const handleSubagentBadgeClick = useCallback(
    (sub: SubagentInfo) => {
      setSelectedSubagent(sub);
      setCurrentView("subagent-detail");
    },
    []
  );

  const handleBackFromSubagent = useCallback(() => {
    setSelectedSubagent(null);
    setCurrentView("trace");
  }, []);

  // Auto-refresh phases when a phase completes or tasks change mid-phase
  useEffect(() => {
    orchestrator.onPhaseCompleted(() => project.refreshProject());
    orchestrator.onTasksUpdated((phases) => {
      project.setPhases(phases);
      if (orchestrator.activeSpecDir) {
        project.updateSpecSummary(orchestrator.activeSpecDir, phases);
      }
    });
  });

  const handleSelectSpec = (spec: string) => {
    project.selectSpec(spec);
    setCurrentView("tasks");
  };

  const handleDeselectSpec = () => {
    project.deselectSpec();
    setCurrentView("overview");
  };

  const handleStart = (partial: Partial<RunConfig>) => {
    const projectDir = partial.projectDir ?? project.projectDir!;

    // Default: run all unfinished specs
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
    window.ralphAPI.startRun(config);
  };

  const handleStartSpec = (specName: string) => {
    if (!project.projectDir || orchestrator.isRunning) return;

    const config: RunConfig = {
      projectDir: project.projectDir,
      specDir: specName,
      mode: "build",
      model: "claude-opus-4-6",
      maxIterations: 20,
      maxTurns: 75,
      phases: "all",
    };
    window.ralphAPI.startRun(config);
  };

  const handleViewPhaseTrace = useCallback(
    async (phase: Phase) => {
      // If this is the actively running phase, just switch to trace view
      // — liveSteps already has the streaming data
      if (orchestrator.isRunning && orchestrator.currentPhase?.number === phase.number) {
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
    [project.projectDir, project.selectedSpec, orchestrator.loadPhaseTrace, orchestrator.isRunning, orchestrator.currentPhase]
  );

  let content;

  if (!project.projectDir) {
    content = (
      <div
        style={{
          textAlign: "center",
          paddingTop: 80,
          color: "var(--foreground-dim)",
        }}
      >
        Open a project to get started
      </div>
    );
  } else if (currentView === "subagent-detail" && selectedSubagent) {
    content = (
      <SubagentDetailView
        subagent={selectedSubagent}
        parentSteps={orchestrator.liveSteps}
        isRunning={orchestrator.isRunning}
        onBack={handleBackFromSubagent}
      />
    );
  } else if (currentView === "trace") {
    const traceStartedAt = orchestrator.liveSteps[0]?.createdAt;
    const traceDurationMs = orchestrator.totalDuration > 0
      ? orchestrator.totalDuration
      : traceStartedAt
        ? Date.now() - new Date(traceStartedAt).getTime()
        : 0;

    content = (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {/* Breadcrumb: spec / phase */}
        <div
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "color-mix(in srgb, var(--primary) 4%, var(--background))",
            fontSize: "0.82rem",
          }}
        >
          {project.selectedSpec && (
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
              Phase {orchestrator.currentPhase.number}: {orchestrator.currentPhase.name}
            </span>
          )}
          {orchestrator.currentRunId && (
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              <CopyBadge label="run" value={orchestrator.currentRunId} />
            </span>
          )}
        </div>
        <AgentStepList
          steps={orchestrator.liveSteps}
          isRunning={orchestrator.isRunning}
          agentId={orchestrator.currentPhaseTraceId ?? undefined}
          startedAt={traceStartedAt}
          durationMs={traceDurationMs}
          subagents={orchestrator.subagents}
          onSubagentClick={handleSubagentClick}
        />
        <SubagentList subagents={orchestrator.subagents} isParentRunning={orchestrator.isRunning} onSubagentClick={handleSubagentBadgeClick} />
      </div>
    );
  } else if (currentView === "overview" || !project.selectedSpec) {
    content = (
      <ProjectOverview
        specSummaries={project.specSummaries}
        onSelectSpec={handleSelectSpec}
        onStartSpec={handleStartSpec}
        isRunning={orchestrator.isRunning}
        activeSpecDir={orchestrator.activeSpecDir}
        activePhase={orchestrator.currentPhase}
        activeTask={orchestrator.activeTask}
      />
    );
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
    <AppShell
      projectDir={project.projectDir}
      aggregate={project.aggregate}
      isRunning={orchestrator.isRunning}
      onOpenProject={project.openProject}
      onRefreshProject={project.refreshProject}
      onDeselectSpec={handleDeselectSpec}
      onStart={handleStart}
      onStop={() => window.ralphAPI.stopRun()}
      content={content}
    />
  );
}
