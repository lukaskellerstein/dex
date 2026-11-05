import { contextBridge } from "electron";
import type { DexAPI } from "../renderer/electron.js";
import { devApi } from "./preload-modules/dev-api.js";
import { historyApi } from "./preload-modules/history-api.js";
import { orchestratorApi } from "./preload-modules/orchestrator-api.js";
import { projectApi } from "./preload-modules/project-api.js";
import { windowApi } from "./preload-modules/window-api.js";

const dexAPI = {
  ...projectApi,
  ...orchestratorApi,
  ...historyApi,
  ...windowApi,
  ...devApi,
} satisfies DexAPI;

contextBridge.exposeInMainWorld("dexAPI", dexAPI);
