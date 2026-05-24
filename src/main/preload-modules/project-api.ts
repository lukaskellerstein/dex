import { ipcRenderer } from "electron";

export const projectApi = {
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
  pickGoalFile: (defaultDir: string) =>
    ipcRenderer.invoke("project:pick-goal-file", defaultDir) as Promise<string | null>,
  createProject: (parentDir: string, name: string) =>
    ipcRenderer.invoke("project:create-project", parentDir, name) as Promise<
      { path: string } | { error: string }
    >,
  openProjectPath: (projectPath: string) =>
    ipcRenderer.invoke("project:open-path", projectPath) as Promise<
      { path: string } | { error: string }
    >,
  pathExists: (targetPath: string) =>
    ipcRenderer.invoke("project:path-exists", targetPath) as Promise<boolean>,

  // App config (global ~/.dex/app-config.json)
  getWelcomeDefaults: () =>
    ipcRenderer.invoke("appConfig:getWelcomeDefaults") as Promise<{
      defaultLocation: string;
      defaultName: string;
    }>,
};
