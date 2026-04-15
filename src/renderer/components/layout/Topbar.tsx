import { RefreshCw, Play, Square, FolderOpen } from "lucide-react";
import type { RunConfig } from "../../../core/types.js";

interface AggregateStats {
  totalSpecs: number;
  unfinishedSpecs: number;
  totalPhases: number;
  incompletePhases: number;
  totalTasks: number;
  doneTasks: number;
}

export interface TopbarProps {
  projectDir: string | null;
  aggregate: AggregateStats;
  isRunning: boolean;
  onOpenProject: () => void;
  onRefreshProject: () => void;
  onDeselectSpec: () => void;
  onStart: (config: Partial<RunConfig>) => void;
  onStop: () => void;
}

export function Topbar({
  projectDir,
  aggregate,
  isRunning,
  onOpenProject,
  onRefreshProject,
  onDeselectSpec,
  onStart,
  onStop,
}: TopbarProps) {
  const canStart = !!projectDir && aggregate.unfinishedSpecs > 0 && !isRunning;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        flex: 1,
        height: "100%",
        gap: 12,
        paddingLeft: 14,
        paddingRight: 8,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {/* App Brand */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "0.92rem",
          fontWeight: 600,
          color: "var(--foreground-muted)",
          flexShrink: 0,
        }}
      >
        <img
          src="./logo.png"
          alt="Ralph Claude"
          style={{ width: 18, height: 18, borderRadius: 3 }}
        />
        Ralph Claude
      </div>

      <div
        style={{
          width: 1,
          height: 16,
          background: "var(--border)",
          flexShrink: 0,
        }}
      />

      {/* Project */}
      {projectDir ? (
        <>
          <button
            onClick={onDeselectSpec}
            style={{
              fontSize: "0.85rem",
              color: "var(--foreground-muted)",
              background: "transparent",
              padding: "2px 6px",
              borderRadius: "var(--radius)",
              cursor: "pointer",
              transition: "color 0.15s, background 0.15s",
              flexShrink: 0,
            }}
            title={projectDir}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--foreground)";
              e.currentTarget.style.background = "var(--primary-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            {projectDir.split("/").pop()}
          </button>
          <button
            onClick={onOpenProject}
            title="Open different project"
            style={{
              flexShrink: 0,
              padding: 4,
              borderRadius: "var(--radius)",
              color: "var(--foreground-dim)",
              background: "transparent",
              display: "flex",
              alignItems: "center",
              transition: "color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--foreground-muted)";
              e.currentTarget.style.background = "var(--primary-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-dim)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <FolderOpen size={12} />
          </button>
          <button
            onClick={onRefreshProject}
            title="Refresh project specs"
            style={{
              flexShrink: 0,
              padding: 4,
              borderRadius: "var(--radius)",
              color: "var(--foreground-dim)",
              background: "transparent",
              display: "flex",
              alignItems: "center",
              transition: "color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--foreground-muted)";
              e.currentTarget.style.background = "var(--primary-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-dim)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <RefreshCw size={12} />
          </button>
        </>
      ) : (
        <button
          onClick={onOpenProject}
          style={{
            padding: "3px 10px",
            background: "var(--primary)",
            color: "#fff",
            borderRadius: "var(--radius)",
            fontWeight: 500,
            fontSize: "0.8rem",
            flexShrink: 0,
          }}
        >
          Open Project
        </button>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Aggregate Stats */}
      {projectDir && aggregate.totalSpecs > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: "0.78rem",
            color: "var(--foreground-dim)",
            flexShrink: 0,
          }}
        >
          <span>
            Specs{" "}
            <span style={{ color: "var(--foreground-muted)", fontFamily: "var(--font-mono)" }}>
              {aggregate.totalSpecs - aggregate.unfinishedSpecs}/{aggregate.totalSpecs}
            </span>
          </span>
          <span>
            Phases{" "}
            <span style={{ color: "var(--foreground-muted)", fontFamily: "var(--font-mono)" }}>
              {aggregate.totalPhases - aggregate.incompletePhases}/{aggregate.totalPhases}
            </span>
          </span>
          <span>
            Tasks{" "}
            <span style={{ color: "var(--foreground-muted)", fontFamily: "var(--font-mono)" }}>
              {aggregate.doneTasks}/{aggregate.totalTasks}
            </span>
          </span>
        </div>
      )}

      {/* Run Controls (compact) */}
      {projectDir && (
        <div style={{ flexShrink: 0 }}>
          {isRunning ? (
            <button
              onClick={onStop}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 10px",
                borderRadius: "var(--radius)",
                fontSize: "0.8rem",
                fontWeight: 500,
                background: "rgba(239, 68, 68, 0.15)",
                color: "var(--status-error)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                cursor: "pointer",
              }}
            >
              <Square size={11} />
              Stop
            </button>
          ) : (
            <button
              onClick={() =>
                onStart({ projectDir: projectDir! })
              }
              disabled={!canStart}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "3px 10px",
                borderRadius: "var(--radius)",
                fontSize: "0.8rem",
                fontWeight: 500,
                background: canStart ? "var(--primary)" : "var(--surface-elevated)",
                color: canStart ? "#fff" : "var(--foreground-disabled)",
                opacity: canStart ? 1 : 0.5,
                cursor: canStart ? "pointer" : "not-allowed",
              }}
            >
              <Play size={11} />
              Start
            </button>
          )}
        </div>
      )}
    </div>
  );
}
