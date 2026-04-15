import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import { Copy, Check, Bot, Clock } from "lucide-react";
import type { AgentStep, SubagentInfo } from "../../../core/types.js";
import { AgentStepItem } from "./AgentStepItem.js";

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
  headerTitle?: string;
  subagents?: SubagentInfo[];
  onSubagentClick?: (subagentId: string) => void;
}

function CopyIdBadge({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
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

export function AgentStepList({ steps, isRunning, agentId, startedAt, durationMs, headerTitle, subagents, onSubagentClick }: AgentStepListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Build the display steps: strip all raw subagent_result steps (unreliable IDs
  // in legacy data, and noise from session-init subagents) and inject synthetic
  // completed steps from the SubagentInfo metadata which has correct data.
  const processedSteps = useMemo(() => {
    // Remove all subagent_result steps — we'll synthesize them from SubagentInfo
    const filtered = steps.filter((s) => s.type !== "subagent_result");

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
  }, [steps, subagents, isRunning]);

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
        {headerTitle ?? "Agent Detail"}
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
            {grouped.map(({ step, resultSteps }, idx) => {
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
                  {/* Node dot — centered on the line */}
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

                  {/* Content */}
                  <AgentStepItem
                    step={step}
                    resultSteps={resultSteps}
                    timestamp={step.createdAt ? formatTime(step.createdAt) : undefined}
                    delta={deltaMs != null && deltaMs > 0 ? formatDelta(deltaMs) : undefined}
                    onSubagentClick={onSubagentClick}
                  />
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
              <span
                style={{
                  fontSize: "0.8rem",
                  color: "var(--foreground-dim)",
                  fontStyle: "italic",
                }}
              >
                Agent is working...
              </span>
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
