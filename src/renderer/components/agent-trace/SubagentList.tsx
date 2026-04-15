import { useState, useCallback } from "react";
import {
  GitFork,
  Loader2,
  CheckCircle,
  Clock,
  Bot,
  ChevronDown,
  Copy,
  Check,
} from "lucide-react";
import type { SubagentInfo } from "../../../core/types.js";

interface SubagentListProps {
  subagents: SubagentInfo[];
  isParentRunning?: boolean;
  onSubagentClick?: (subagent: SubagentInfo) => void;
}

function formatDuration(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const sec = Math.round((end - start) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function CopyBadge({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <span
      title={copied ? "Copied!" : "Click to copy"}
      onClick={handleClick}
      style={{
        fontSize: "0.68rem",
        padding: "1px 5px",
        borderRadius: "var(--radius)",
        background: copied
          ? "color-mix(in srgb, var(--status-success) 15%, var(--surface-elevated))"
          : "var(--surface-elevated)",
        border: `1px solid ${copied ? "var(--status-success)" : "var(--border)"}`,
        color: copied ? "var(--status-success)" : "var(--foreground-dim)",
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
      }}
    >
      {value}
      {copied ? <Check size={10} /> : <Copy size={10} />}
    </span>
  );
}

function SubagentDetail({ sa }: { sa: SubagentInfo }) {
  const isRunning = !sa.completedAt;

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "10px 14px",
        fontSize: "0.8rem",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Type + Status */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <Bot size={14} color="var(--status-info)" />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--foreground)",
            fontWeight: 500,
          }}
        >
          {sa.subagentType}
        </span>
        <CopyBadge value={sa.subagentId} />
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: "0.75rem",
            color: isRunning
              ? "var(--primary)"
              : "var(--status-success)",
          }}
        >
          {isRunning ? (
            <>
              <Loader2
                size={11}
                style={{ animation: "spin 1s linear infinite" }}
              />
              Running
            </>
          ) : (
            <>
              <CheckCircle size={11} />
              Completed
            </>
          )}
        </span>
      </div>

      {/* Description */}
      {sa.description && (
        <div
          style={{
            color: "var(--foreground-muted)",
            lineHeight: 1.4,
          }}
        >
          {sa.description}
        </div>
      )}

      {/* Timestamps */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: "0.75rem",
          fontFamily: "var(--font-mono)",
          color: "var(--foreground-dim)",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Clock size={10} />
          {formatTime(sa.startedAt)}
          {sa.completedAt && ` → ${formatTime(sa.completedAt)}`}
        </span>
        <span style={{ color: "var(--primary)", opacity: 0.8 }}>
          {formatDuration(sa.startedAt, sa.completedAt)}
        </span>
      </div>
    </div>
  );
}

export function SubagentList({ subagents, isParentRunning = true, onSubagentClick }: SubagentListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (subagents.length === 0) return null;

  return (
    <div style={{ padding: "8px 12px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
          fontSize: "0.72rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--foreground-dim)",
        }}
      >
        <GitFork size={11} />
        Subagents
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {subagents.map((sa) => {
            const isRunning = isParentRunning && !sa.completedAt;
            const isExpanded = expandedId === sa.id;
            const typeLabel = sa.subagentType === "unknown"
              ? sa.subagentId.slice(0, 8)
              : sa.subagentType;
            const label = sa.description
              ? sa.description.slice(0, 40) +
                (sa.description.length > 40 ? "..." : "")
              : typeLabel;

            return (
              <button
                key={sa.id}
                onClick={() => onSubagentClick ? onSubagentClick(sa) : setExpandedId(isExpanded ? null : sa.id)}
                title={sa.description ?? sa.subagentType}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: `1px solid ${isExpanded ? "var(--primary)" : "var(--border)"}`,
                  background: isExpanded
                    ? "color-mix(in srgb, var(--primary) 10%, var(--surface-elevated))"
                    : "var(--surface-elevated)",
                  fontSize: "0.8rem",
                  color: "var(--foreground-muted)",
                  cursor: "pointer",
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                {isRunning ? (
                  <Loader2
                    size={12}
                    color="var(--primary)"
                    style={{ animation: "spin 1s linear infinite" }}
                  />
                ) : (
                  <CheckCircle size={12} color="var(--status-success)" />
                )}
                <span>{label}</span>
                <span
                  style={{
                    fontSize: "0.68rem",
                    color: "var(--foreground-dim)",
                    fontFamily: "var(--font-mono)",
                    opacity: 0.7,
                  }}
                >
                  {sa.subagentId.slice(0, 8)}
                </span>
                <ChevronDown
                  size={10}
                  color="var(--foreground-dim)"
                  style={{
                    transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* Expanded detail panel */}
        {expandedId && (
          <SubagentDetail
            sa={subagents.find((s) => s.id === expandedId)!}
          />
        )}
      </div>
    </div>
  );
}
