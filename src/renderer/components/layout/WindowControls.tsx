import { useState, useEffect } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { windowService } from "../../services/windowService.js";

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    windowService.isMaximized().then(setIsMaximized);
    return windowService.onMaximizedChange(setIsMaximized);
  }, []);

  const btnStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: "var(--titlebar-height)",
    color: "var(--foreground-muted)",
    transition: "background 0.15s, color 0.15s",
  };

  return (
    <div style={{ display: "flex", WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        style={btnStyle}
        onClick={() => windowService.minimize()}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--surface-hover)";
          e.currentTarget.style.color = "var(--foreground)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--foreground-muted)";
        }}
        title="Minimize"
      >
        <Minus size={14} />
      </button>
      <button
        style={btnStyle}
        onClick={() => windowService.maximize()}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--surface-hover)";
          e.currentTarget.style.color = "var(--foreground)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--foreground-muted)";
        }}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? <Copy size={12} /> : <Square size={12} />}
      </button>
      <button
        style={btnStyle}
        onClick={() => windowService.close()}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "hsl(0, 72%, 50%)";
          e.currentTarget.style.color = "#fff";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--foreground-muted)";
        }}
        title="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}
