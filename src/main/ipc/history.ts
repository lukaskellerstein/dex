import { ipcMain } from "electron";
import * as runs from "../../core/runs.js";
import type { AgentRunRecord, RunRecord } from "../../core/runs.js";

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
    "history:get-agent-steps",
    (_event, projectDir: string, runId: string, agentRunId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      const agentRun = run.agentRuns.find((a) => a.agentRunId === agentRunId);
      if (!agentRun) return [];
      const slug = runs.slugForTaskPhaseName(agentRun.taskPhaseName);
      return runs.readAgentSteps(projectDir, runId, slug, agentRun.taskPhaseNumber);
    },
  );

  ipcMain.handle(
    "history:get-agent-run-subagents",
    (_event, projectDir: string, runId: string, agentRunId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      return run.agentRuns.find((a) => a.agentRunId === agentRunId)?.subagents ?? [];
    },
  );

  ipcMain.handle(
    "history:get-latest-agent-run",
    (_event, projectDir: string, specDir: string, taskPhaseNumber: number): AgentRunRecord | null => {
      const list = runs.listRuns(projectDir);
      let best: AgentRunRecord | null = null;
      for (const run of list) {
        for (const ar of run.agentRuns) {
          if (ar.taskPhaseNumber !== taskPhaseNumber) continue;
          if (ar.specDir !== specDir && ar.specDir !== null) continue;
          if (!best || best.startedAt < ar.startedAt) best = ar;
        }
      }
      return best;
    },
  );

  ipcMain.handle(
    "history:get-spec-agent-runs",
    (_event, projectDir: string, specDir: string): AgentRunRecord[] => {
      const list = runs.listRuns(projectDir);
      return runs.latestAgentRunsForSpec(list, specDir);
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
