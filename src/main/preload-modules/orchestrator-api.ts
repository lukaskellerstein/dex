import { ipcRenderer } from "electron";
import type { RunConfig, OrchestratorEvent } from "../../core/types.js";

// Module-level fan-out: a single ipcRenderer listener feeds N renderer
// subscribers. Without this, every hook that calls `onOrchestratorEvent`
// adds another listener to the IpcRenderer EventEmitter — the renderer has
// 10+ such hooks, which trips Node's default MaxListeners cap and emits
// `MaxListenersExceededWarning` on every page load.
const subscribers = new Set<(event: OrchestratorEvent) => void>();
let ipcAttached = false;
const ipcHandler = (_e: Electron.IpcRendererEvent, data: OrchestratorEvent): void => {
  for (const cb of subscribers) cb(data);
};

export const orchestratorApi = {
  startRun: (config: RunConfig) =>
    ipcRenderer.invoke("orchestrator:start", config),
  stopRun: () => ipcRenderer.invoke("orchestrator:stop"),
  answerQuestion: (requestId: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("orchestrator:answer-question", requestId, answers),
  getProjectState: (dir: string) =>
    ipcRenderer.invoke("orchestrator:getProjectState", dir),
  getRunState: () =>
    ipcRenderer.invoke("orchestrator:getRunState") as Promise<{
      runId: string;
      projectDir: string;
      specDir: string;
      mode: string;
      model: string;
      agentRunId: string;
      taskPhaseNumber: number;
      taskPhaseName: string;
      currentCycle?: number;
      currentStep?: string;
      isClarifying?: boolean;
      cyclesCompleted?: number;
    } | null>,

  onOrchestratorEvent: (cb: (event: OrchestratorEvent) => void) => {
    if (!ipcAttached) {
      ipcRenderer.on("orchestrator:event", ipcHandler);
      ipcAttached = true;
    }
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  },
};
