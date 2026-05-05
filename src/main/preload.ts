import { contextBridge } from "electron";
import type { DexAPI } from "../renderer/electron.js";
import { projectApi } from "./preload-modules/project-api.js";
import { orchestratorApi } from "./preload-modules/orchestrator-api.js";
import { historyApi } from "./preload-modules/history-api.js";
import { checkpointsApi } from "./preload-modules/checkpoints-api.js";
import { profilesApi } from "./preload-modules/profiles-api.js";
import { windowApi } from "./preload-modules/window-api.js";
import { devApi } from "./preload-modules/dev-api.js";

const dexAPI = {
  ...projectApi,
  ...orchestratorApi,
  ...historyApi,
  ...windowApi,
  ...devApi,
  checkpoints: checkpointsApi,
  profiles: profilesApi,
} satisfies DexAPI;

contextBridge.exposeInMainWorld("dexAPI", dexAPI);
