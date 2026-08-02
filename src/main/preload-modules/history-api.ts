import { ipcRenderer } from "electron";

export const historyApi = {
  getRun: (projectDir: string, runId: string) =>
    ipcRenderer.invoke("history:get-run", projectDir, runId),
  getLatestProjectRun: (projectDir: string) =>
    ipcRenderer.invoke("history:get-latest-project-run", projectDir),
  getAgentSteps: (projectDir: string, runId: string, agentRunId: string) =>
    ipcRenderer.invoke("history:get-agent-steps", projectDir, runId, agentRunId),
  getAgentRunSubagents: (projectDir: string, runId: string, agentRunId: string) =>
    ipcRenderer.invoke("history:get-agent-run-subagents", projectDir, runId, agentRunId),
  getLatestAgentRun: (projectDir: string, specDir: string, taskPhaseNumber: number) =>
    ipcRenderer.invoke("history:get-latest-agent-run", projectDir, specDir, taskPhaseNumber),
  getSpecAgentRuns: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-agent-runs", projectDir, specDir),
  getSpecAggregateStats: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-aggregate-stats", projectDir, specDir),
};
