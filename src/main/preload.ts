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

  // App config (global ~/.dex/app-config.json)
  getWelcomeDefaults: () =>
    ipcRenderer.invoke("appConfig:getWelcomeDefaults") as Promise<{
      defaultLocation: string;
      defaultName: string;
    }>,

  // Orchestrator
  startRun: (config: Record<string, unknown>) =>
    ipcRenderer.invoke("orchestrator:start", config),
  stopRun: () => ipcRenderer.invoke("orchestrator:stop"),
  answerQuestion: (requestId: string, answers: Record<string, string>) =>
    ipcRenderer.invoke("orchestrator:answer-question", requestId, answers),
  getProjectState: (dir: string) => ipcRenderer.invoke("orchestrator:getProjectState", dir),
  getRunState: () => ipcRenderer.invoke("orchestrator:getRunState") as Promise<{
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

  // Checkpoints (008)
  checkpoints: {
    listTimeline: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:listTimeline", projectDir),
    checkIsRepo: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:checkIsRepo", projectDir) as Promise<boolean>,
    checkIdentity: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:checkIdentity", projectDir),
    estimateVariantCost: (projectDir: string, step: string, variantCount: number) =>
      ipcRenderer.invoke("checkpoints:estimateVariantCost", projectDir, step, variantCount),
    readPendingVariantGroups: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:readPendingVariantGroups", projectDir),
    promote: (projectDir: string, tag: string, sha: string) =>
      ipcRenderer.invoke("checkpoints:promote", projectDir, tag, sha),
    unmark: (projectDir: string, sha: string) =>
      ipcRenderer.invoke("checkpoints:unmark", projectDir, sha),
    unselect: (projectDir: string, branchName: string) =>
      ipcRenderer.invoke("checkpoints:unselect", projectDir, branchName),
    syncStateFromHead: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:syncStateFromHead", projectDir),
    jumpTo: (projectDir: string, targetSha: string, options?: { force?: "save" | "discard" }) =>
      ipcRenderer.invoke("checkpoints:jumpTo", projectDir, targetSha, options),
    spawnVariants: (projectDir: string, request: { fromCheckpoint: string; variantLetters: string[]; step: string }) =>
      ipcRenderer.invoke("checkpoints:spawnVariants", projectDir, request),
    cleanupVariantGroup: (projectDir: string, groupId: string, kind: "keep" | "discard", pickedLetter?: string) =>
      ipcRenderer.invoke("checkpoints:cleanupVariantGroup", projectDir, groupId, kind, pickedLetter),
    initRepo: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:initRepo", projectDir),
    setIdentity: (projectDir: string, name: string, email: string) =>
      ipcRenderer.invoke("checkpoints:setIdentity", projectDir, name, email),
    compareAttempts: (projectDir: string, branchA: string, branchB: string, step: string | null) =>
      ipcRenderer.invoke("checkpoints:compareAttempts", projectDir, branchA, branchB, step),
  },

  // Agent profiles (010 — US4)
  profiles: {
    list: (projectDir: string) =>
      ipcRenderer.invoke("profiles:list", projectDir),
    saveDexJson: (projectDir: string, name: string, dexJson: Record<string, unknown>) =>
      ipcRenderer.invoke("profiles:saveDexJson", projectDir, name, dexJson),
  },

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
