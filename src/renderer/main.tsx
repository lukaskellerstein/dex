import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/theme.css";
import App from "./App.js";

// Forward renderer-side errors to the main-process terminal log.
// Without this, a thrown error in a hook or render path silently closes the
// BrowserWindow and the user sees nothing in `electron.log`. The handler is
// installed before any React mount so even errors during initial render are
// captured.
function reportError(payload: {
  type: "error" | "unhandledrejection";
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string | null;
}): void {
  try {
    window.dexAPI?.reportRendererError(payload);
  } catch {
    /* preload not ready yet — fall through to console */
  }
}

window.addEventListener("error", (e) => {
  reportError({
    type: "error",
    message: e.message ?? String(e.error ?? "unknown error"),
    source: e.filename,
    line: e.lineno,
    col: e.colno,
    stack: e.error && e.error.stack ? String(e.error.stack) : null,
  });
});

window.addEventListener("unhandledrejection", (e) => {
  const reason: unknown = e.reason;
  const stack =
    reason && typeof reason === "object" && "stack" in reason
      ? String((reason as { stack?: unknown }).stack ?? "")
      : null;
  reportError({
    type: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack,
  });
});

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
