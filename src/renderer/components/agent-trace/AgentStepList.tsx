/**
 * What: Renders the agent timeline — header (agent ID + clock + duration), stats bar, subagent list, the per-step timeline, and the running indicator.
 * Not: Does not derive grouping/synthesis (logic in AgentStepList.logic.ts). Does not render individual step bodies — AgentStepItem owns that.
 * Deps: AgentStepList.logic.ts (processSteps/groupToolCalls/buildTimelineRows), AgentStepItem, SubagentList, computeStats, StatsBar, CopyBadge.
 */
import { useRef, useEffect, useMemo } from "react";
import { Copy, Bot, Clock } from "lucide-react";
import type { AgentStep, SubagentInfo } from "../../../core/types.js";
import { AgentStepItem } from "./AgentStepItem.js";
import { SubagentList } from "./SubagentList.js";
import { computeStats } from "../../utils/computeStats.js";
import { StatsBar } from "../shared/StatsBar.js";
import { CopyBadge } from "../shared/CopyBadge.js";
import { formatDurationShort as formatDuration } from "../../utils/formatters.js";
import {
  LINE_LEFT,
  DOT_SIZE,
  CONTENT_LEFT,
  formatTime,
  formatDelta,
  processSteps,
  groupToolCalls,
  buildTimelineRows,
} from "./AgentStepList.logic.js";

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
  return (
    <CopyBadge
      getCopyText={() => `AgentID: ${value}`}
      label={value}
      icon={<Copy size={10} />}
      iconPosition="right"
      title="Click to copy"
    />
  );
}

export function AgentStepList({
  steps,
  isRunning,
  agentId,
  startedAt,
  durationMs,
  subagents,
  onSubagentClick,
  onSubagentBadgeClick,
  showSubagentSteps,
}: AgentStepListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const processedSteps = useMemo(
    () => processSteps(steps, subagents, isRunning, showSubagentSteps),
    [steps, subagents, isRunning, showSubagentSteps],
  );

  const grouped = useMemo(() => groupToolCalls(processedSteps), [processedSteps]);
  const timelineRows = useMemo(() => buildTimelineRows(grouped), [grouped]);

  // Auto-scroll to bottom when new steps arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isRunning || !autoScrollRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [grouped.length, isRunning]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  const stats = useMemo(() => computeStats(steps, { durationMs }), [steps, durationMs]);

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
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                color: "var(--foreground-dim)",
              }}
            >
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
        <SubagentList
          subagents={subagents}
          isParentRunning={isRunning}
          onSubagentClick={onSubagentBadgeClick}
        />
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
        <div style={{ position: "relative" }}>
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

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {timelineRows.map((row) => {
              if (row.kind === "single") {
                const {
                  entry: { step, resultSteps },
                  idx,
                } = row;
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
                  {firstStep.createdAt && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 8,
                        fontSize: "0.7rem",
                        fontFamily: "var(--font-mono)",
                        color: "var(--foreground-dim)",
                      }}
                    >
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
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: 8,
                    }}
                  >
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
