import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dexAPI", {
  // Project
  openProject: () => ipcRenderer.invoke("project:open"),
  listSpecs: (dir: string) => ipcRenderer.invoke("project:list-specs", dir),
  parseSpec: (dir: string, spec: string) =>
    ipcRenderer.invoke("project:parse-spec", dir, spec),
  readFile: (filePath: string) =>
    ipcRenderer.invoke("project:read-file", filePath) as Promise<string | null>,
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke("project:write-file", filePath, content) as Promise<boolean>,
  pickFolder: () =>
    ipcRenderer.invoke("project:pick-folder") as Promise<string | null>,
  createProject: (parentDir: string, name: string) =>
    ipcRenderer.invoke("project:create-project", parentDir, name) as Promise<{ path: string } | { error: string }>,
  openProjectPath: (projectPath: string) =>
    ipcRenderer.invoke("project:open-path", projectPath) as Promise<{ path: string } | { error: string }>,
  pathExists: (targetPath: string) =>
    ipcRenderer.invoke("project:path-exists", targetPath) as Promise<boolean>,

  // Orchestrator
  startRun: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("orchestrator:start", config),
  stopRun: () => ipcRenderer.invoke("orchestrator:stop"),
  answerQuestion: (requestId: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("orchestrator:answer-question", requestId, answers),
  isRunning: () => ipcRenderer.invoke("orchestrator:isRunning") as Promise<boolean>,
  getProjectState: (dir: string) => ipcRenderer.invoke("orchestrator:getProjectState", dir),
  getRunState: () => ipcRenderer.invoke("orchestrator:getRunState") as Promise<{
    runId: string;
    projectDir: string;
    specDir: string;
    mode: string;
    model: string;
    phaseTraceId: string;
    phaseNumber: number;
    phaseName: string;
    currentCycle?: number;
    currentStage?: string;
    isClarifying?: boolean;
    loopsCompleted?: number;
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

  // History — per-project JSON storage (007-sqlite-removal)
  listRuns: (projectDir: string, limit?: number) =>
    ipcRenderer.invoke("history:list-runs", projectDir, limit),
  getRun: (projectDir: string, runId: string) =>
    ipcRenderer.invoke("history:get-run", projectDir, runId),
  getLatestProjectRun: (projectDir: string) =>
    ipcRenderer.invoke("history:get-latest-project-run", projectDir),
  getPhaseSteps: (projectDir: string, runId: string, phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-steps", projectDir, runId, phaseTraceId),
  getPhaseSubagents: (projectDir: string, runId: string, phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-subagents", projectDir, runId, phaseTraceId),
  getLatestPhaseTrace: (projectDir: string, specDir: string, phaseNumber: number) =>
    ipcRenderer.invoke("history:get-latest-phase-trace", projectDir, specDir, phaseNumber),
  getSpecPhaseStats: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-phase-stats", projectDir, specDir),
  getSpecAggregateStats: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-aggregate-stats", projectDir, specDir),

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
