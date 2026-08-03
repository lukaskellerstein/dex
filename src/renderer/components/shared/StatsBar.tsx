import {
  AlertTriangle,
  Clock,
  DollarSign,
  GitFork,
  Hash,
  Layers,
  Plug,
  Sparkles,
  Wrench,
} from "lucide-react";
import type { AgentStats } from "../../utils/computeStats.js";
import {
  formatCost,
  formatDurationDetailed as formatDuration,
  formatTokens,
} from "../../utils/formatters.js";

function MetricItem({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: "error";
}) {
  const color = highlight === "error" ? "var(--status-error)" : undefined;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        color: color ?? "var(--foreground-muted)",
      }}
    >
      <span style={{ color: color ?? "var(--foreground-dim)", display: "flex" }}>{icon}</span>
      <span style={{ color: color ?? "var(--foreground-dim)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Separator() {
  return (
    <span
      style={{
        width: 1,
        height: 14,
        background: "var(--border)",
        flexShrink: 0,
      }}
    />
  );
}

interface StatsBarProps {
  stats: AgentStats;
  compact?: boolean;
}

/**
 * Horizontal stats bar matching VEX's AgentTrace metrics row.
 * `compact` mode shows only cost, duration, tokens (for phase headers).
 */
export function StatsBar({ stats, compact }: StatsBarProps) {
  if (compact) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          fontSize: "0.72rem",
          fontFamily: "var(--font-mono)",
          flexWrap: "wrap",
        }}
      >
        <MetricItem
          icon={<Clock size={11} />}
          label="duration"
          value={formatDuration(stats.durationMs)}
        />
        <Separator />
        <MetricItem
          icon={<DollarSign size={11} />}
          label="cost"
          value={formatCost(stats.costUsd)}
        />
        <Separator />
        <MetricItem icon={<Hash size={11} />} label="in" value={formatTokens(stats.inputTokens)} />
        <Separator />
        <MetricItem
          icon={<Hash size={11} />}
          label="out"
          value={formatTokens(stats.outputTokens)}
        />
        {stats.errorCount > 0 && (
          <>
            <Separator />
            <MetricItem
              icon={<AlertTriangle size={11} />}
              label="errors"
              value={String(stats.errorCount)}
              highlight="error"
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "6px 20px",
        fontSize: "0.72rem",
        fontFamily: "var(--font-mono)",
        borderBottom: "1px solid var(--border)",
        flexWrap: "wrap",
      }}
    >
      <MetricItem
        icon={<Clock size={12} />}
        label="duration"
        value={formatDuration(stats.durationMs)}
      />
      <Separator />
      <MetricItem icon={<DollarSign size={12} />} label="cost" value={formatCost(stats.costUsd)} />
      <Separator />
      <MetricItem icon={<Hash size={12} />} label="in" value={formatTokens(stats.inputTokens)} />
      <Separator />
      <MetricItem icon={<Hash size={12} />} label="out" value={formatTokens(stats.outputTokens)} />
      <Separator />
      <MetricItem icon={<Layers size={12} />} label="steps" value={String(stats.stepCount)} />
      <Separator />
      <MetricItem icon={<Wrench size={12} />} label="tools" value={String(stats.toolCount)} />
      <Separator />
      <MetricItem icon={<Plug size={12} />} label="mcp" value={String(stats.mcpCount)} />
      <Separator />
      <MetricItem
        icon={<GitFork size={12} />}
        label="subagents"
        value={String(stats.subagentCount)}
      />
      <Separator />
      <MetricItem icon={<Sparkles size={12} />} label="skills" value={String(stats.skillCount)} />
      <Separator />
      <MetricItem
        icon={<AlertTriangle size={12} />}
        label="errors"
        value={String(stats.errorCount)}
        highlight={stats.errorCount > 0 ? "error" : undefined}
      />
    </div>
  );
}
