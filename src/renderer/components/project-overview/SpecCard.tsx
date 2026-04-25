import { CheckCircle, FileText, Loader2, Cog, Clock, DollarSign, Hash } from "lucide-react";
import type { TaskPhase, Task } from "../../../core/types.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { useState } from "react";

function formatSpecDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function formatSpecTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

interface SpecCardProps {
  summary: SpecSummary;
  onClick: () => void;

  isActive?: boolean;
  isRunning?: boolean;
  activePhase?: TaskPhase | null;
  activeTask?: Task | null;
}

function MiniProgress({ done, total, color }: { done: number; total: number; color: string }) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  return (
    <div
      style={{
        height: 4,
        borderRadius: 2,
        background: "var(--border)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${pct}%`,
          background: color,
          borderRadius: 2,
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

export function SpecCard({ summary, onClick, isActive, isRunning, activePhase, activeTask }: SpecCardProps) {
  const [hovered, setHovered] = useState(false);
  const isComplete = summary.doneTasks === summary.totalTasks && summary.totalTasks > 0;
  const displayName = summary.name.split("/").pop() ?? summary.name;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 12,
        padding: 16,
        background: hovered ? "var(--surface-hover)" : "var(--surface-elevated)",
        border: "1px solid",
        borderColor: isActive
          ? "var(--primary)"
          : hovered
            ? "var(--border-bright)"
            : "var(--border)",
        borderRadius: "var(--radius-lg)",
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.15s, border-color 0.15s",
        minWidth: 180,
        ...(isActive ? { width: "100%", flexBasis: "100%" } : {}),
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {isActive ? (
          <Loader2
            size={16}
            color="var(--primary)"
            style={{ animation: "spin 1s linear infinite" }}
          />
        ) : isComplete ? (
          <CheckCircle size={16} color="var(--status-success)" />
        ) : (
          <FileText size={16} color="var(--foreground-dim)" />
        )}
        <span
          style={{
            fontSize: "0.95rem",
            fontWeight: 600,
            color: "var(--foreground)",
            flex: 1,
          }}
        >
          {displayName}
        </span>
        {isActive && (
          <span
            style={{
              fontSize: "0.65rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--primary)",
              background: "var(--primary-muted)",
              padding: "1px 6px",
              borderRadius: "var(--radius)",
            }}
          >
            Running
          </span>
        )}
      </div>

      {/* Active phase & task */}
      {isActive && activePhase && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: "0.8rem",
              color: "var(--primary)",
            }}
          >
            <span style={{ fontWeight: 600 }}>TaskPhase {activePhase.number}</span>
            <span style={{ color: "var(--foreground-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {activePhase.name}
            </span>
          </div>
          {activeTask && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                fontSize: "0.77rem",
                color: "var(--foreground-muted)",
                paddingLeft: 16,
              }}
            >
              <Cog
                size={10}
                color="var(--primary)"
                style={{ animation: "spin 2s linear infinite", flexShrink: 0, marginTop: 3 }}
              />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.73rem", flexShrink: 0 }}>
                {activeTask.id}
              </span>
              <span>
                {activeTask.description}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Phases */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.8rem",
              marginBottom: 4,
            }}
          >
            <span style={{ color: "var(--foreground-dim)" }}>Phases</span>
            <span
              style={{
                color: "var(--foreground-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.78rem",
                marginLeft: 12,
              }}
            >
              {summary.completedPhases}/{summary.totalPhases}
            </span>
          </div>
          <MiniProgress
            done={summary.completedPhases}
            total={summary.totalPhases}
            color="var(--status-info)"

          />
        </div>

        {/* Tasks */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.8rem",
              marginBottom: 4,
            }}
          >
            <span style={{ color: "var(--foreground-dim)" }}>Tasks</span>
            <span
              style={{
                color: "var(--foreground-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.78rem",
                marginLeft: 12,
              }}
            >
              {summary.doneTasks}/{summary.totalTasks}
            </span>
          </div>
          <MiniProgress
            done={summary.doneTasks}
            total={summary.totalTasks}
            color="var(--primary)"
          />
        </div>

        {/* Aggregate stats from historical traces */}
        {summary.stats && summary.stats.agentRunsWithTraces > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontSize: "0.72rem",
              fontFamily: "var(--font-mono)",
              color: "var(--foreground-dim)",
              paddingTop: 4,
              flexWrap: "wrap",
            }}
          >
            {summary.stats.totalCostUsd > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <DollarSign size={10} />
                ${summary.stats.totalCostUsd.toFixed(2)}
              </span>
            )}
            {summary.stats.totalDurationMs > 0 && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Clock size={10} />
                {formatSpecDuration(summary.stats.totalDurationMs)}
              </span>
            )}
            {(summary.stats.totalInputTokens > 0 || summary.stats.totalOutputTokens > 0) && (
              <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Hash size={10} />
                {formatSpecTokens(summary.stats.totalInputTokens + summary.stats.totalOutputTokens)}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}
