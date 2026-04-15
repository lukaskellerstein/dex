import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ralphAPI", {
  // Project
  openProject: () => ipcRenderer.invoke("project:open"),
  listSpecs: (dir: string) => ipcRenderer.invoke("project:list-specs", dir),
  parseSpec: (dir: string, spec: string) =>
    ipcRenderer.invoke("project:parse-spec", dir, spec),

  // Orchestrator
  startRun: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("orchestrator:start", config),
  stopRun: () => ipcRenderer.invoke("orchestrator:stop"),
  isRunning: () => ipcRenderer.invoke("orchestrator:isRunning") as Promise<boolean>,
  getRunState: () => ipcRenderer.invoke("orchestrator:getRunState") as Promise<{
    runId: string;
    projectDir: string;
    specDir: string;
    mode: string;
    model: string;
    phaseTraceId: string;
    phaseNumber: number;
    phaseName: string;
  } | null>,

  // Orchestrator events
  onOrchestratorEvent: (cb: (event: Record<string, unknown>) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: Record<string, unknown>
    ) => cb(data);
    ipcRenderer.on("orchestrator:event", handler);
    return () => ipcRenderer.removeListener("orchestrator:event", handler);
  },

  // History
  listRuns: (limit?: number) => ipcRenderer.invoke("history:list-runs", limit),
  getRun: (runId: string) => ipcRenderer.invoke("history:get-run", runId),
  getPhaseSteps: (phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-steps", phaseTraceId),
  getPhaseSubagents: (phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-subagents", phaseTraceId),
  getLatestPhaseTrace: (projectDir: string, specDir: string, phaseNumber: number) =>
    ipcRenderer.invoke("history:get-latest-phase-trace", projectDir, specDir, phaseNumber),

  // Window controls
  minimize: () => ipcRenderer.invoke("window-minimize"),
  maximize: () => ipcRenderer.invoke("window-maximize"),
  close: () => ipcRenderer.invoke("window-close"),
  isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, val: boolean) => cb(val);
    ipcRenderer.on("window-maximized-changed", handler);
    return () =>
      ipcRenderer.removeListener("window-maximized-changed", handler);
  },
});
