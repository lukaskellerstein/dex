import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { Copy, Check, Bot, Clock } from "lucide-react";
import type { AgentStep, SubagentInfo } from "../../../core/types.js";
import { AgentStepItem } from "./AgentStepItem.js";
import { SubagentList } from "./SubagentList.js";
import { computeStats } from "../../utils/computeStats.js";
import { StatsBar } from "../shared/StatsBar.js";

const LINE_LEFT = 20; // center of the vertical line
const DOT_SIZE = 9;
const CONTENT_LEFT = 42; // padding-left for step content

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDelta(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  return `+${(ms / 60_000).toFixed(1)}m`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

interface AgentStepListProps {
  steps: AgentStep[];
  isRunning: boolean;
  agentId?: string;
  startedAt?: string;
  durationMs?: number;
  subagents?: SubagentInfo[];
  onSubagentClick?: (subagentId: string) => void;
  onSubagentBadgeClick?: (subagent: SubagentInfo) => void;
  /** When true, show all steps including those tagged as belonging to a subagent */
  showSubagentSteps?: boolean;
}

function CopyIdBadge({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(`AgentID: ${value}`);
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
        textTransform: "none",
        letterSpacing: "normal",
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

interface GroupedStep {
  step: AgentStep;
  resultSteps: AgentStep[];
}

type TimelineRow =
  | { kind: "single"; entry: GroupedStep; idx: number }
  | { kind: "parallel-spawns"; entries: GroupedStep[]; startIdx: number };

export function AgentStepList({ steps, isRunning, agentId, startedAt, durationMs, subagents, onSubagentClick, onSubagentBadgeClick, showSubagentSteps }: AgentStepListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Build the display steps: strip all raw subagent_result steps (unreliable IDs
  // in legacy data, and noise from session-init subagents) and inject synthetic
  // completed steps from the SubagentInfo metadata which has correct data.
  const processedSteps = useMemo(() => {
    // Remove all subagent_result steps — we'll synthesize them from SubagentInfo.
    // Also remove steps that belong to a subagent (tagged with belongsToSubagent
    // metadata) — those should only appear in the subagent detail view.
    const filtered = steps.filter((s) =>
      s.type !== "subagent_result" && (showSubagentSteps || !s.metadata?.belongsToSubagent)
    );

    if (!subagents || subagents.length === 0) return filtered;

    // Build a map of subagentId → spawn step index for positioning
    const spawnIndices = new Map<string, number>();
    filtered.forEach((s, i) => {
      if (s.type === "subagent_spawn") {
        const id = s.metadata?.subagentId as string;
        if (id) spawnIndices.set(id, i);
      }
    });

    // For each subagent that has a spawn, insert a synthetic completed step
    // right before the next step that has a timestamp after the subagent's end time
    const synthetics: AgentStep[] = [];
    for (const sa of subagents) {
      if (!spawnIndices.has(sa.subagentId)) continue;
      const endTime = sa.completedAt ?? (isRunning ? null : sa.startedAt);
      if (!endTime) continue;
      synthetics.push({
        id: `synth-result-${sa.subagentId}`,
        sequenceIndex: 999990,
        type: "subagent_result",
        content: null,
        metadata: {
          subagentId: sa.subagentId,
          subagentType: sa.subagentType,
        },
        durationMs: null,
        tokenCount: null,
        createdAt: endTime,
      });
    }

    if (synthetics.length === 0) return filtered;

    // Merge synthetics into the filtered steps by timestamp
    const merged = [...filtered, ...synthetics];
    merged.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ta - tb;
    });
    return merged;
  }, [steps, subagents, isRunning, showSubagentSteps]);

  // Group steps: pair tool_result/tool_error with their originating tool_call
  // using toolUseId from metadata. This handles parallel tool calls correctly
  // where results may arrive in any order after multiple calls.
  const grouped = useMemo<GroupedStep[]>(() => {
    const result: GroupedStep[] = [];
    const callsByToolUseId = new Map<string, GroupedStep>();

    for (const step of processedSteps) {
      if (step.type === "tool_result" || step.type === "tool_error" || step.type === "skill_result") {
        const toolUseId = step.metadata?.toolUseId as string | undefined;
        const matchingCall = toolUseId ? callsByToolUseId.get(toolUseId) : null;
        if (matchingCall) {
          matchingCall.resultSteps.push(step);
          continue;
        }
      }

      const grouped: GroupedStep = { step, resultSteps: [] };
      result.push(grouped);

      if (step.type === "tool_call" || step.type === "skill_invoke") {
        const toolUseId = step.metadata?.toolUseId as string | undefined;
        if (toolUseId) {
          callsByToolUseId.set(toolUseId, grouped);
        }
      }
    }
    return result;
  }, [processedSteps]);

  // Group consecutive subagent_spawn steps (within 2s) into parallel rows
  const timelineRows = useMemo<TimelineRow[]>(() => {
    const rows: TimelineRow[] = [];
    let i = 0;
    while (i < grouped.length) {
      const entry = grouped[i];
      if (entry.step.type === "subagent_spawn" && entry.step.createdAt) {
        const t0 = new Date(entry.step.createdAt).getTime();
        const batch: GroupedStep[] = [entry];
        let j = i + 1;
        while (j < grouped.length) {
          const next = grouped[j];
          if (next.step.type !== "subagent_spawn" || !next.step.createdAt) break;
          if (Math.abs(new Date(next.step.createdAt).getTime() - t0) > 2000) break;
          batch.push(next);
          j++;
        }
        if (batch.length > 1) {
          rows.push({ kind: "parallel-spawns", entries: batch, startIdx: i });
          i = j;
          continue;
        }
      }
      rows.push({ kind: "single", entry, idx: i });
      i++;
    }
    return rows;
  }, [grouped]);

  // Auto-scroll to bottom when new steps arrive
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isRunning || !autoScrollRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [grouped.length, isRunning]);

  // Auto-scroll tracking
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  const stats = useMemo(
    () => computeStats(steps, { durationMs }),
    [steps, durationMs]
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.77rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--foreground-dim)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        Agent Detail
        {agentId && (
          <>
            <Bot size={13} color="var(--primary)" />
            <CopyIdBadge value={agentId} />
          </>
        )}
        {startedAt && (
          <span
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: "0.75rem",
              fontFamily: "var(--font-mono)",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--foreground-dim)" }}>
              <Clock size={10} />
              {formatTime(startedAt)}
            </span>
            {durationMs != null && durationMs > 0 && (
              <span style={{ color: "var(--primary)", opacity: 0.8 }}>
                {formatDuration(durationMs)}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Stats */}
      {steps.length > 0 && <StatsBar stats={stats} />}

      {/* Subagents bar */}
      {subagents && subagents.length > 0 && onSubagentBadgeClick && (
        <SubagentList subagents={subagents} isParentRunning={isRunning} onSubagentClick={onSubagentBadgeClick} />
      )}

      {/* Timeline */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 14px",
        }}
      >
        {/* Content wrapper — line lives here so it spans full content height */}
        <div style={{ position: "relative" }}>
          {/* Vertical line — spans the full height of content */}
          {grouped.length > 0 && (
            <div
              style={{
                position: "absolute",
                left: LINE_LEFT - 1,
                top: 0,
                bottom: 0,
                width: 2,
                background: "var(--foreground-dim)",
                opacity: 0.4,
                borderRadius: 1,
              }}
            />
          )}

          {/* Steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {timelineRows.map((row) => {
              if (row.kind === "single") {
                const { entry: { step, resultSteps }, idx } = row;
                const prevStep = idx > 0 ? grouped[idx - 1].step : null;
                const deltaMs =
                  prevStep && step.createdAt && prevStep.createdAt
                    ? new Date(step.createdAt).getTime() -
                      new Date(prevStep.createdAt).getTime()
                    : null;

                return (
                  <div
                    key={step.id}
                    className="step-item"
                    style={{
                      paddingLeft: CONTENT_LEFT,
                      position: "relative",
                    }}
                  >
                    {/* Node dot */}
                    <div
                      style={{
                        position: "absolute",
                        left: LINE_LEFT - DOT_SIZE / 2,
                        top: 4,
                        width: DOT_SIZE,
                        height: DOT_SIZE,
                        borderRadius: "50%",
                        border: "2px solid var(--foreground-dim)",
                        background: "var(--surface)",
                        zIndex: 1,
                      }}
                    />

                    <AgentStepItem
                      step={step}
                      resultSteps={resultSteps}
                      timestamp={step.createdAt ? formatTime(step.createdAt) : undefined}
                      delta={deltaMs != null && deltaMs > 0 ? formatDelta(deltaMs) : undefined}
                      onSubagentClick={onSubagentClick}
                    />
                  </div>
                );
              }

              // Parallel spawns group
              const { entries, startIdx } = row;
              const firstStep = entries[0].step;
              const prevStep = startIdx > 0 ? grouped[startIdx - 1].step : null;
              const deltaMs =
                prevStep && firstStep.createdAt && prevStep.createdAt
                  ? new Date(firstStep.createdAt).getTime() -
                    new Date(prevStep.createdAt).getTime()
                  : null;

              return (
                <div
                  key={`parallel-${firstStep.id}`}
                  style={{
                    paddingLeft: CONTENT_LEFT,
                    position: "relative",
                  }}
                >
                  {/* Node dot */}
                  <div
                    style={{
                      position: "absolute",
                      left: LINE_LEFT - DOT_SIZE / 2,
                      top: 4,
                      width: DOT_SIZE,
                      height: DOT_SIZE,
                      borderRadius: "50%",
                      border: "2px solid var(--foreground-dim)",
                      background: "var(--surface)",
                      zIndex: 1,
                    }}
                  />
                  {/* Timestamp row */}
                  {firstStep.createdAt && (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginBottom: 8,
                      fontSize: "0.7rem",
                      fontFamily: "var(--font-mono)",
                      color: "var(--foreground-dim)",
                    }}>
                      <Bot size={11} style={{ color: "hsl(263, 82%, 58%)" }} />
                      <span style={{ color: "var(--foreground-muted)", fontWeight: 500 }}>
                        {entries.length} parallel subagents
                      </span>
                      <span>{formatTime(firstStep.createdAt)}</span>
                      {deltaMs != null && deltaMs > 0 && (
                        <span style={{ color: "var(--primary)", opacity: 0.8 }}>
                          {formatDelta(deltaMs)}
                        </span>
                      )}
                    </div>
                  )}
                  {/* Grid of spawn cards */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                    gap: 8,
                  }}>
                    {entries.map(({ step, resultSteps }) => (
                      <AgentStepItem
                        key={step.id}
                        step={step}
                        resultSteps={resultSteps}
                        onSubagentClick={onSubagentClick}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Running indicator */}
          {isRunning && (
            <div
              style={{
                paddingLeft: CONTENT_LEFT,
                paddingTop: 12,
                position: "relative",
              }}
            >
              {/* Pulsing dot on timeline */}
              <div
                style={{
                  position: "absolute",
                  left: LINE_LEFT - DOT_SIZE / 2,
                  top: 16,
                  width: DOT_SIZE,
                  height: DOT_SIZE,
                  borderRadius: "50%",
                  background: "var(--primary)",
                  animation: "status-pulse 1.5s ease-out infinite",
                  zIndex: 1,
                }}
              />
              {/* Shimmer bar with text — full width */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 14px",
                  borderRadius: "var(--radius)",
                  background: `linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--primary) 6%, transparent) 0%,
                    color-mix(in srgb, var(--primary) 14%, transparent) 40%,
                    color-mix(in srgb, var(--primary) 6%, transparent) 60%,
                    color-mix(in srgb, var(--primary) 14%, transparent) 100%
                  )`,
                  backgroundSize: "200% 100%",
                  animation: "shimmer-bar 2.5s ease-in-out infinite",
                  border: "1px solid color-mix(in srgb, var(--primary) 15%, transparent)",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color: "var(--foreground-dim)",
                  }}
                >
                  Agent is working…
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Empty state */}
        {grouped.length === 0 && !isRunning && (
          <div
            style={{
              textAlign: "center",
              paddingTop: 60,
              color: "var(--foreground-dim)",
              fontSize: "0.85rem",
            }}
          >
            Agent trace will appear here when a run starts.
          </div>
        )}
      </div>
    </div>
  );
}
