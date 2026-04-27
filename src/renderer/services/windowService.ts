/**
 * What: Typed wrapper over window.dexAPI window controls — minimize, maximize, close, isMaximized, onMaximizedChange.
 * Not: Does not own window-state — consumers track maximized via subscribe. No multi-window or always-on-top wrappers.
 * Deps: window.dexAPI window methods.
 */
export type WindowErrorCode = "WINDOW_FAILURE";

export class WindowError extends Error {
  readonly code: WindowErrorCode;

  constructor(code: WindowErrorCode, message: string) {
    super(message);
    this.name = "WindowError";
    this.code = code;
  }
}

function mapToWindowError(err: unknown): WindowError {
  if (err instanceof WindowError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new WindowError("WINDOW_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToWindowError(err);
  }
}

export const windowService = {
  minimize(): Promise<void> {
    return call(() => window.dexAPI.minimize());
  },

  maximize(): Promise<void> {
    return call(() => window.dexAPI.maximize());
  },

  close(): Promise<void> {
    return call(() => window.dexAPI.close());
  },

  isMaximized(): Promise<boolean> {
    return call(() => window.dexAPI.isMaximized());
  },

  onMaximizedChange(cb: (maximized: boolean) => void): () => void {
    return window.dexAPI.onMaximizedChange(cb);
  },
};
