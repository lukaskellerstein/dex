import type { ReactNode } from "react";
import { WindowControls } from "./WindowControls.js";
import { Topbar, type TopbarProps } from "./Topbar.js";

interface AppShellProps extends TopbarProps {
  content: ReactNode;
  tabs?: ReactNode;
}

export function AppShell({ content, tabs, ...topbarProps }: AppShellProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Title Bar + Topbar */}
      <div
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          WebkitAppRegion: "drag",
          userSelect: "none",
          height: "var(--titlebar-height)",
        } as React.CSSProperties}
      >
        <Topbar {...topbarProps} />
        <WindowControls />
      </div>

      {/* Tabs (optional) */}
      {tabs}

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {content}
      </div>
    </div>
  );
}
