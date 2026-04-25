import { ipcMain } from "electron";
import { getWelcomeDefaults } from "../../core/appConfig.js";

export function registerAppConfigHandlers(): void {
  ipcMain.handle("appConfig:getWelcomeDefaults", () => getWelcomeDefaults());
}
