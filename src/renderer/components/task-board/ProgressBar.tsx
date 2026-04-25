import { Clock, DollarSign, Layers } from "lucide-react";
import type { TaskPhase } from "../../../core/types.js";

interface ProgressBarProps {
  phases: TaskPhase[];
  totalCost: number;
  totalDuration: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
}

export function ProgressBar({
  phases,
  totalCost,
  totalDuration,
}: ProgressBarProps) {
  const completedPhases = phases.filter(
    (p) => p.status === "complete"
  ).length;
  const progress =
    phases.length > 0 ? (completedPhases / phases.length) * 100 : 0;

  return (
    <div
      style={{
        padding: "12px 16px",
        borderTop: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Progress bar */}
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
            width: `${progress}%`,
            background: "var(--primary)",
            borderRadius: 2,
            transition: "width 0.3s ease",
          }}
        />
      </div>

      {/* Stats */}
      <div
        style={{
          display: "flex",
          gap: 16,
          fontSize: "0.8rem",
          color: "var(--foreground-dim)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Layers size={12} />
          {completedPhases}/{phases.length} phases
        </span>
        {totalCost > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <DollarSign size={12} />
            ${totalCost.toFixed(2)}
          </span>
        )}
        {totalDuration > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Clock size={12} />
            {formatDuration(totalDuration)}
          </span>
        )}
      </div>
    </div>
  );
}
