import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  Pause,
  ScrollText,
} from "lucide-react";
import type { Phase } from "../../../core/types.js";
import type { PhaseTraceRow } from "../../../core/database.js";
import { TaskRow } from "./TaskRow.js";
import { StatsBar } from "../shared/StatsBar.js";
import type { AgentStats } from "../../utils/computeStats.js";

interface PhaseViewProps {
  phase: Phase;
  isRunning: boolean;
  isSelected: boolean;
  traceStats?: PhaseTraceRow | null;
  onViewTrace?: (phase: Phase) => void;
}

function PhaseStatusIcon({ status, isRunning }: { status: Phase["status"]; isRunning: boolean }) {
  if (isRunning) {
    return (
      <Loader2
        size={16}
        color="#7c3aed"
        style={{ animation: "spin 1s linear infinite" }}
      />
    );
  }
  switch (status) {
    case "complete":
      return <CheckCircle2 size={16} color="var(--status-success)" />;
    case "partial":
      return <Pause size={16} color="var(--status-warning)" />;
    case "not_started":
      return <Circle size={16} color="var(--foreground-dim)" />;
  }
}

export function PhaseView({ phase, isRunning, isSelected, traceStats, onViewTrace }: PhaseViewProps) {
  const highlighted = isRunning || isSelected;
  const [expanded, setExpanded] = useState(true);

  const doneTasks = phase.tasks.filter((t) => t.status === "done").length;

  return (
    <div
      style={{
        borderRadius: "var(--radius-lg)",
        border: `1px solid ${highlighted ? "var(--primary)" : "var(--border)"}`,
        background: highlighted
          ? "rgba(124, 58, 237, 0.05)"
          : "var(--surface)",
        overflow: "hidden",
        flexShrink: 0,
        transition: "border-color 0.2s",
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          padding: "10px 14px",
          textAlign: "left",
          background: "transparent",
          color: "var(--foreground)",
          minHeight: 40,
        }}
      >
        <span style={{ flexShrink: 0, display: "flex" }}>
          {expanded ? (
            <ChevronDown size={14} color="var(--foreground-dim)" />
          ) : (
            <ChevronRight size={14} color="var(--foreground-dim)" />
          )}
        </span>
        <span style={{ flexShrink: 0, display: "flex" }}>
          <PhaseStatusIcon status={phase.status} isRunning={isRunning} />
        </span>
        <span style={{ fontWeight: 600, fontSize: "0.95rem", flexShrink: 0 }}>
          Phase {phase.number}
        </span>
        {isRunning && (
          <span
            style={{
              fontSize: "0.7rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--primary)",
              background: "var(--primary-muted)",
              padding: "1px 8px",
              borderRadius: "var(--radius)",
              flexShrink: 0,
            }}
          >
            Running
          </span>
        )}
        <span
          style={{
            color: "var(--foreground-muted)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {phase.name}
        </span>
        <span
          style={{
            fontSize: "0.8rem",
            color: "var(--foreground-dim)",
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
          }}
        >
          {doneTasks}/{phase.tasks.length}
        </span>
        {isRunning && onViewTrace && (
          <span
            role="button"
            title="View live agent trace"
            onClick={(e) => {
              e.stopPropagation();
              onViewTrace(phase);
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: "var(--radius)",
              fontSize: "0.75rem",
              fontWeight: 600,
              color: "var(--primary)",
              background: "var(--primary-muted)",
              cursor: "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(124, 58, 237, 0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "var(--primary-muted)";
            }}
          >
            <ScrollText size={12} />
            Live Trace
          </span>
        )}
        {!isRunning && onViewTrace && phase.status !== "not_started" && (
          <span
            role="button"
            title="View agent trace for this phase"
            onClick={(e) => {
              e.stopPropagation();
              onViewTrace(phase);
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              padding: "2px 6px",
              borderRadius: "var(--radius)",
              color: "var(--foreground-dim)",
              cursor: "pointer",
              transition: "color 0.15s, background 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--primary)";
              e.currentTarget.style.background = "var(--primary-muted)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-dim)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <ScrollText size={14} />
          </span>
        )}
      </button>

      {/* Purpose */}
      {expanded && phase.purpose && (
        <div
          style={{
            padding: "0 14px 8px 44px",
            fontSize: "0.85rem",
            color: "var(--foreground-dim)",
            fontStyle: "italic",
          }}
        >
          {phase.purpose}
        </div>
      )}

      {/* Phase stats from historical trace — hide for not-started and currently-running phases */}
      {expanded && traceStats && phase.status !== "not_started" && !isRunning && (traceStats.cost_usd != null || traceStats.duration_ms != null) && (
        <div style={{ padding: "0 14px 8px 44px" }}>
          <StatsBar
            compact
            stats={{
              durationMs: traceStats.duration_ms,
              costUsd: traceStats.cost_usd,
              inputTokens: traceStats.input_tokens,
              outputTokens: traceStats.output_tokens,
              stepCount: 0,
              toolCount: 0,
              mcpCount: 0,
              subagentCount: 0,
              skillCount: 0,
              errorCount: 0,
            }}
          />
        </div>
      )}

      {/* Tasks */}
      {expanded && (
        <div style={{ padding: "0 6px 8px" }}>
          {phase.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
