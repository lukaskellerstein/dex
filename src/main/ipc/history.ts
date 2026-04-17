import { ipcMain } from "electron";
import * as runs from "../../core/runs.js";
import type { PhaseRecord, RunRecord } from "../../core/runs.js";

export function registerHistoryHandlers(): void {
  ipcMain.handle("history:list-runs", (_event, projectDir: string, limit?: number) => {
    return runs.listRuns(projectDir, limit);
  });

  ipcMain.handle("history:get-run", (_event, projectDir: string, runId: string) => {
    return runs.readRun(projectDir, runId);
  });

  ipcMain.handle("history:get-latest-project-run", (_event, projectDir: string) => {
    const list = runs.listRuns(projectDir, 1);
    return list[0] ?? null;
  });

  ipcMain.handle(
    "history:get-phase-steps",
    (_event, projectDir: string, runId: string, phaseTraceId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      const phase = run.phases.find((p) => p.phaseTraceId === phaseTraceId);
      if (!phase) return [];
      const slug = runs.slugForPhaseName(phase.phaseName);
      return runs.readSteps(projectDir, runId, slug, phase.phaseNumber);
    },
  );

  ipcMain.handle(
    "history:get-phase-subagents",
    (_event, projectDir: string, runId: string, phaseTraceId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      return run.phases.find((p) => p.phaseTraceId === phaseTraceId)?.subagents ?? [];
    },
  );

  ipcMain.handle(
    "history:get-latest-phase-trace",
    (_event, projectDir: string, specDir: string, phaseNumber: number): PhaseRecord | null => {
      const list = runs.listRuns(projectDir);
      let best: PhaseRecord | null = null;
      for (const run of list) {
        for (const phase of run.phases) {
          if (phase.phaseNumber !== phaseNumber) continue;
          if (phase.specDir !== specDir && phase.specDir !== null) continue;
          if (!best || best.startedAt < phase.startedAt) best = phase;
        }
      }
      return best;
    },
  );

  ipcMain.handle(
    "history:get-spec-phase-stats",
    (_event, projectDir: string, specDir: string): PhaseRecord[] => {
      const list = runs.listRuns(projectDir);
      return runs.latestPhasesForSpec(list, specDir);
    },
  );

  ipcMain.handle(
    "history:get-spec-aggregate-stats",
    (_event, projectDir: string, specDir: string) => {
      const list: RunRecord[] = runs.listRuns(projectDir);
      return runs.getSpecAggregateStats(list, specDir);
    },
  );
}
