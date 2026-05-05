import { ipcRenderer } from "electron";

export const checkpointsApi = {
  listTimeline: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:listTimeline", projectDir),
  checkIsRepo: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:checkIsRepo", projectDir) as Promise<boolean>,
  checkIdentity: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:checkIdentity", projectDir),
  deleteBranch: (
    projectDir: string,
    branchName: string,
    opts?: { confirmedLoss?: boolean },
  ) =>
    ipcRenderer.invoke("checkpoints:deleteBranch", projectDir, branchName, opts),
  promoteSummary: (projectDir: string, sourceBranch: string) =>
    ipcRenderer.invoke("checkpoints:promoteSummary", projectDir, sourceBranch),
  mergeToMain: (
    projectDir: string,
    sourceBranch: string,
    opts?: { force?: "save" | "discard" },
  ) =>
    ipcRenderer.invoke("checkpoints:mergeToMain", projectDir, sourceBranch, opts),
  acceptResolverResult: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:acceptResolverResult", projectDir),
  abortResolverMerge: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:abortResolverMerge", projectDir),
  openInEditor: (projectDir: string, files: string[]) =>
    ipcRenderer.invoke("checkpoints:openInEditor", projectDir, files),
  syncStateFromHead: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:syncStateFromHead", projectDir),
  jumpTo: (
    projectDir: string,
    targetSha: string,
    options?: { force?: "save" | "discard" },
  ) =>
    ipcRenderer.invoke("checkpoints:jumpTo", projectDir, targetSha, options),
  initRepo: (projectDir: string) =>
    ipcRenderer.invoke("checkpoints:initRepo", projectDir),
  setIdentity: (projectDir: string, name: string, email: string) =>
    ipcRenderer.invoke("checkpoints:setIdentity", projectDir, name, email),
};
