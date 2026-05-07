import { useState, useEffect, useCallback } from "react";
import type { TaskPhase } from "../../core/types.js";
import type { AgentRunRecord, SpecStats } from "../../core/runs.js";
import type { DexState } from "../../core/state.js";
import { projectService } from "../services/projectService.js";
import { historyService } from "../services/historyService.js";
import { orchestratorService } from "../services/orchestratorService.js";

export interface SpecSummary {
  name: string;
  phases: TaskPhase[];
  totalTasks: number;
  doneTasks: number;
  completedPhases: number;
  totalPhases: number;
  stats?: SpecStats;
}

export function useProject() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [specSummaries, setSpecSummaries] = useState<SpecSummary[]>([]);
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [phases, setPhases] = useState<TaskPhase[]>([]);
  const [phaseStats, setPhaseStats] = useState<Map<number, AgentRunRecord>>(new Map());
  const [dexStatus, setDexStatus] = useState<DexState["status"] | null>(null);

  const refreshDexStatus = useCallback(async (dir: string | null) => {
    if (!dir) { setDexStatus(null); return; }
    try {
      const state = await orchestratorService.getProjectState(dir);
      setDexStatus(state?.status ?? null);
    } catch {
      setDexStatus(null);
    }
  }, []);

  // Re-read state.json whenever a status-changing orchestrator event fires so
  // the topbar Resume button reflects reality (paused vs completed/failed).
  useEffect(() => {
    if (!projectDir) {
      setDexStatus(null);
      return;
    }
    void refreshDexStatus(projectDir);
    const unsub = orchestratorService.subscribeEvents((evt) => {
      if (
        evt.type === "run_started" ||
        evt.type === "run_completed" ||
        evt.type === "paused" ||
        evt.type === "loop_reset"
      ) {
        void refreshDexStatus(projectDir);
      }
    });
    return unsub;
  }, [projectDir, refreshDexStatus]);

  const loadSpecs = async (dir: string) => {
    const specList = await projectService.listSpecs(dir);

    const summaries: SpecSummary[] = [];
    for (const spec of specList) {
      const [parsed, stats] = await Promise.all([
        projectService.parseSpec(dir, spec),
        historyService.getSpecAggregateStats(dir, spec).catch(() => undefined),
      ]);
      const totalTasks = parsed.reduce((s, p) => s + p.tasks.length, 0);
      const doneTasks = parsed.reduce(
        (s, p) => s + p.tasks.filter((t) => t.status === "done").length,
        0
      );
      summaries.push({
        name: spec,
        phases: parsed,
        totalTasks,
        doneTasks,
        completedPhases: parsed.filter((p) => p.status === "complete").length,
        totalPhases: parsed.length,
        stats,
      });
    }
    setSpecSummaries(summaries);
    return specList;
  };

  const clearProject = () => {
    setProjectDir(null);
    setSelectedSpec(null);
    setPhases([]);
    setSpecSummaries([]);
    setPhaseStats(new Map());
  };

  const openProject = async (): Promise<string | null> => {
    const dir = await projectService.openProject();
    if (dir) {
      setProjectDir(dir);
      setSelectedSpec(null);
      setPhases([]);
      await loadSpecs(dir);
    }
    return dir;
  };

  const openProjectPath = async (projectPath: string): Promise<{ path: string } | { error: string }> => {
    const result = await projectService.openProjectPath(projectPath);
    if ("path" in result) {
      setProjectDir(result.path);
      setSelectedSpec(null);
      setPhases([]);
      await loadSpecs(result.path);
    }
    return result;
  };

  const createProject = async (parentDir: string, name: string): Promise<{ path: string } | { error: string }> => {
    const result = await projectService.createProject(parentDir, name);
    if ("path" in result) {
      setProjectDir(result.path);
      setSelectedSpec(null);
      setPhases([]);
      setSpecSummaries([]);
    }
    return result;
  };

  const refreshProject = async () => {
    if (!projectDir) return;
    const specList = await loadSpecs(projectDir);
    // If the selected spec no longer exists, deselect it
    if (selectedSpec && !specList.includes(selectedSpec)) {
      setSelectedSpec(null);
      setPhases([]);
    } else if (selectedSpec) {
      // Re-parse the selected spec to pick up task changes
      const parsed = await projectService.parseSpec(projectDir, selectedSpec);
      setPhases(parsed);
    }
  };

  const selectSpec = async (specName: string) => {
    if (!projectDir) return;
    setSelectedSpec(specName);
    const [parsed, traceRows] = await Promise.all([
      projectService.parseSpec(projectDir, specName),
      historyService.getSpecAgentRuns(projectDir, specName).catch(() => [] as AgentRunRecord[]),
    ]);
    setPhases(parsed);
    const statsMap = new Map<number, AgentRunRecord>();
    for (const row of traceRows) statsMap.set(row.taskPhaseNumber, row);
    setPhaseStats(statsMap);
  };

  const deselectSpec = () => {
    setSelectedSpec(null);
    setPhases([]);
    setPhaseStats(new Map());
  };

  const updateSpecSummary = (specDir: string, updatedPhases: TaskPhase[]) => {
    const totalTasks = updatedPhases.reduce((acc, p) => acc + p.tasks.length, 0);
    const doneTasks = updatedPhases.reduce(
      (acc, p) => acc + p.tasks.filter((t) => t.status === "done").length,
      0
    );
    const completedPhases = updatedPhases.filter((p) => p.status === "complete").length;
    const totalPhases = updatedPhases.length;

    setSpecSummaries((prev) => {
      const found = prev.some((s) => s.name === specDir);
      if (found) {
        return prev.map((s) => {
          if (s.name !== specDir) return s;
          return { ...s, phases: updatedPhases, totalTasks, doneTasks, completedPhases, totalPhases };
        });
      }
      // Spec not yet in summaries — add it (happens when implement step
      // emits tasks_updated before refreshProject has loaded the spec)
      return [
        ...prev,
        { name: specDir, phases: updatedPhases, totalTasks, doneTasks, completedPhases, totalPhases },
      ];
    });
  };

  // Aggregate stats across all specs
  const aggregate = {
    totalSpecs: specSummaries.length,
    unfinishedSpecs: specSummaries.filter(
      (s) => s.doneTasks < s.totalTasks
    ).length,
    totalPhases: specSummaries.reduce((s, sp) => s + sp.totalPhases, 0),
    incompletePhases: specSummaries.reduce(
      (s, sp) => s + sp.totalPhases - sp.completedPhases,
      0
    ),
    totalTasks: specSummaries.reduce((s, sp) => s + sp.totalTasks, 0),
    doneTasks: specSummaries.reduce((s, sp) => s + sp.doneTasks, 0),
  };

  return {
    projectDir,
    specSummaries,
    selectedSpec,
    phases,
    setPhases,
    phaseStats,
    aggregate,
    dexStatus,
    clearProject,
    openProject,
    openProjectPath,
    createProject,
    refreshProject,
    selectSpec,
    deselectSpec,
    updateSpecSummary,
  };
}
