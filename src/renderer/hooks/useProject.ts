import { useState } from "react";
import type { Phase } from "../../core/types.js";
import type { PhaseRecord, SpecStats } from "../../core/runs.js";

export interface SpecSummary {
  name: string;
  phases: Phase[];
  totalTasks: number;
  doneTasks: number;
  completedPhases: number;
  totalPhases: number;
  stats?: SpecStats;
}

/** Map of phaseNumber → latest PhaseRecord (for displaying per-phase stats) */
export type PhaseStatsMap = Map<number, PhaseRecord>;

export function useProject() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [specs, setSpecs] = useState<string[]>([]);
  const [specSummaries, setSpecSummaries] = useState<SpecSummary[]>([]);
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [phaseStats, setPhaseStats] = useState<PhaseStatsMap>(new Map());

  const loadSpecs = async (dir: string) => {
    const specList = await window.dexAPI.listSpecs(dir);
    setSpecs(specList);

    const summaries: SpecSummary[] = [];
    for (const spec of specList) {
      const [parsed, stats] = await Promise.all([
        window.dexAPI.parseSpec(dir, spec),
        window.dexAPI.getSpecAggregateStats(dir, spec).catch(() => undefined),
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
    setSpecs([]);
    setSpecSummaries([]);
    setPhaseStats(new Map());
  };

  const openProject = async (): Promise<string | null> => {
    const dir = await window.dexAPI.openProject();
    if (dir) {
      setProjectDir(dir);
      setSelectedSpec(null);
      setPhases([]);
      await loadSpecs(dir);
    }
    return dir;
  };

  const openProjectPath = async (projectPath: string): Promise<{ path: string } | { error: string }> => {
    const result = await window.dexAPI.openProjectPath(projectPath);
    if ("path" in result) {
      setProjectDir(result.path);
      setSelectedSpec(null);
      setPhases([]);
      await loadSpecs(result.path);
    }
    return result;
  };

  const createProject = async (parentDir: string, name: string): Promise<{ path: string } | { error: string }> => {
    const result = await window.dexAPI.createProject(parentDir, name);
    if ("path" in result) {
      setProjectDir(result.path);
      setSelectedSpec(null);
      setPhases([]);
      setSpecs([]);
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
      const parsed = await window.dexAPI.parseSpec(projectDir, selectedSpec);
      setPhases(parsed);
    }
  };

  const selectSpec = async (specName: string) => {
    if (!projectDir) return;
    setSelectedSpec(specName);
    const [parsed, traceRows] = await Promise.all([
      window.dexAPI.parseSpec(projectDir, specName),
      window.dexAPI.getSpecPhaseStats(projectDir, specName).catch(() => [] as PhaseRecord[]),
    ]);
    setPhases(parsed);
    const statsMap = new Map<number, PhaseRecord>();
    for (const row of traceRows) statsMap.set(row.phaseNumber, row);
    setPhaseStats(statsMap);
  };

  const deselectSpec = () => {
    setSelectedSpec(null);
    setPhases([]);
    setPhaseStats(new Map());
  };

  const updateSpecSummary = (specDir: string, updatedPhases: Phase[]) => {
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
      // Spec not yet in summaries — add it (happens when implement stage
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
    specs,
    specSummaries,
    selectedSpec,
    phases,
    setPhases,
    phaseStats,
    aggregate,
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
