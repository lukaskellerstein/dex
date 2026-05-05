import { ipcRenderer } from "electron";

export type RendererErrorPayload = {
  type: "error" | "unhandledrejection";
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string | null;
};

export const devApi = {
  reportRendererError: (payload: RendererErrorPayload): void => {
    ipcRenderer.send("dev:renderer-error", payload);
  },
};
