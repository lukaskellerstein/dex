import { useState } from "react";
import type { CSSProperties } from "react";
import {
  Brain,
  MessageSquare,
  CheckCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Sparkles,
  Bug,
  Server,
  Zap,
  Bot,
  Package,
  GitBranch,
} from "lucide-react";
import type { AgentStep } from "../../../core/types.js";
import { ToolCard } from "./ToolCard.js";

interface AgentStepItemProps {
  step: AgentStep;
  resultSteps: AgentStep[];
  timestamp?: string;
  delta?: string;
  onSubagentClick?: (subagentId: string) => void;
}

function StepTimestamp({ timestamp, delta }: { timestamp?: string; delta?: string }) {
  if (!timestamp) return null;
  return (
    <span
      style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: "0.7rem",
        fontFamily: "var(--font-mono)",
        color: "var(--foreground-dim)",
        flexShrink: 0,
      }}
    >
      <span>{timestamp}</span>
      {delta && (
        <span style={{ color: "var(--primary)", opacity: 0.8 }}>
          {delta}
        </span>
      )}
    </span>
  );
}

function CollapsibleText({
  text,
  threshold = 300,
  style,
}: {
  text: string;
  threshold?: number;
  style?: CSSProperties;
}) {
  const [expanded, setExpanded] = useState(false);
  const needsCollapse = text.length > threshold;

  return (
    <div>
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: "0.85rem",
          lineHeight: 1.5,
          ...style,
        }}
      >
        {needsCollapse && !expanded ? text.slice(0, threshold) + "..." : text}
      </div>
      {needsCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            marginTop: 4,
            fontSize: "0.77rem",
            color: "var(--primary)",
            background: "transparent",
          }}
        >
          {expanded ? (
            <>
              <ChevronDown size={11} /> Show less
            </>
          ) : (
            <>
              <ChevronRight size={11} /> Show more
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function AgentStepItem({ step, resultSteps, timestamp, delta, onSubagentClick }: AgentStepItemProps) {
  const content = step.content ?? "";

  switch (step.type) {
    case "debug": {
      const debugColor = "hsl(35, 90%, 55%)";
      const meta = step.metadata ?? {};
      const mcpServers = (meta.mcpServers ?? {}) as Record<string, string[]>;
      const skills = (meta.skills ?? []) as Array<Record<string, unknown>>;
      const agents = (meta.agents ?? []) as Array<Record<string, unknown>>;
      const plugins = (meta.plugins ?? []) as Array<Record<string, unknown>>;
      const model = meta.model as string | undefined;
      const toolCount = (meta.toolCount ?? 0) as number;

      const mcpEntries = Object.entries(mcpServers);

      const sectionStyle: CSSProperties = {
        marginBottom: 10,
      };
      const sectionTitleStyle: CSSProperties = {
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: "0.7rem",
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--foreground-dim)",
        marginBottom: 5,
      };
      const pillStyle: CSSProperties = {
        display: "inline-block",
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        padding: "2px 7px",
        borderRadius: "var(--radius)",
        background: "hsla(0, 0%, 100%, 0.06)",
        color: "var(--foreground)",
        marginRight: 4,
        marginBottom: 3,
      };
      const countBadgeStyle: CSSProperties = {
        fontSize: "0.65rem",
        fontWeight: 600,
        color: debugColor,
        marginLeft: 4,
        opacity: 0.8,
      };

      return (
        <div
          style={{
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
            border: `1.5px solid color-mix(in srgb, ${debugColor} 30%, transparent)`,
            boxShadow: `0 2px 12px color-mix(in srgb, ${debugColor} 8%, transparent)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px 16px",
              background: `linear-gradient(135deg, color-mix(in srgb, ${debugColor} 15%, transparent) 0%, color-mix(in srgb, ${debugColor} 8%, transparent) 100%)`,
              borderBottom: `1px solid color-mix(in srgb, ${debugColor} 18%, transparent)`,
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: `color-mix(in srgb, ${debugColor} 20%, transparent)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Bug size={14} style={{ color: debugColor }} />
            </div>
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: debugColor,
              }}
            >
              Agent Debug
            </span>
            {model && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.7rem",
                  color: "var(--foreground-dim)",
                  background: "hsla(0, 0%, 100%, 0.06)",
                  padding: "2px 8px",
                  borderRadius: "var(--radius)",
                }}
              >
                {model}
              </span>
            )}
            <span style={{ ...countBadgeStyle, marginLeft: "auto" }}>
              {toolCount} tools
            </span>
            <StepTimestamp timestamp={timestamp} delta={delta} />
          </div>
          <div
            style={{
              padding: "12px 16px",
              background: `color-mix(in srgb, ${debugColor} 4%, var(--background))`,
              fontSize: "0.82rem",
            }}
          >
            {/* MCP Servers */}
            {mcpEntries.length > 0 && (
              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>
                  <Server size={12} />
                  MCP Servers
                  <span style={countBadgeStyle}>{mcpEntries.length}</span>
                </div>
                {mcpEntries.map(([server, tools]) => (
                  <div key={server} style={{ marginBottom: 4, paddingLeft: 18 }}>
                    <span style={{ ...pillStyle, fontWeight: 600 }}>{server}</span>
                    <span style={{ fontSize: "0.68rem", color: "var(--foreground-dim)" }}>
                      {tools.length} tool{tools.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Skills */}
            {skills.length > 0 && (
              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>
                  <Zap size={12} />
                  Skills
                  <span style={countBadgeStyle}>{skills.length}</span>
                </div>
                <div style={{ paddingLeft: 18, display: "flex", flexWrap: "wrap" }}>
                  {skills.map((s, i) => (
                    <span key={i} style={pillStyle}>
                      {String(s.name ?? s)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Agents / Subagents */}
            {agents.length > 0 && (
              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>
                  <Bot size={12} />
                  Subagents
                  <span style={countBadgeStyle}>{agents.length}</span>
                </div>
                <div style={{ paddingLeft: 18, display: "flex", flexWrap: "wrap" }}>
                  {agents.map((a, i) => (
                    <span key={i} style={pillStyle}>
                      {String(a.name ?? a.type ?? a)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Plugins */}
            {plugins.length > 0 && (
              <div style={sectionStyle}>
                <div style={sectionTitleStyle}>
                  <Package size={12} />
                  Plugins
                  <span style={countBadgeStyle}>{plugins.length}</span>
                </div>
                <div style={{ paddingLeft: 18, display: "flex", flexWrap: "wrap" }}>
                  {plugins.map((p, i) => (
                    <span key={i} style={pillStyle}>
                      {String(p.name ?? p)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {mcpEntries.length === 0 && skills.length === 0 && agents.length === 0 && plugins.length === 0 && (
              <div style={{ color: "var(--foreground-dim)", fontStyle: "italic", fontSize: "0.8rem" }}>
                No capabilities reported by agent SDK
              </div>
            )}
          </div>
        </div>
      );
    }

    case "user_message": {
      const bright = "hsl(142, 69%, 55%)";
      const lines = content.split("\n");
      const isStructured = lines.some((l) => l.startsWith("##") || l.startsWith("**"));
      return (
        <div
          style={{
            borderRadius: "var(--radius-lg)",
            overflow: "hidden",
            border: `1.5px solid color-mix(in srgb, ${bright} 40%, transparent)`,
            boxShadow: `0 2px 16px color-mix(in srgb, ${bright} 10%, transparent)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 16px",
              background: `linear-gradient(135deg, color-mix(in srgb, ${bright} 18%, transparent) 0%, color-mix(in srgb, ${bright} 10%, transparent) 100%)`,
              borderBottom: `1px solid color-mix(in srgb, ${bright} 22%, transparent)`,
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: `color-mix(in srgb, ${bright} 22%, transparent)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <CornerDownRight size={14} style={{ color: bright }} />
            </div>
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                color: bright,
              }}
            >
              Prompt
            </span>
            <StepTimestamp timestamp={timestamp} delta={delta} />
          </div>
          <div
            style={{
              padding: "14px 16px",
              background: `color-mix(in srgb, ${bright} 8%, var(--background))`,
            }}
          >
            <pre
              style={{
                fontSize: isStructured ? "0.8rem" : "0.85rem",
                fontFamily: isStructured ? "var(--font-mono)" : "inherit",
                lineHeight: 1.7,
                margin: 0,
                color: "var(--foreground)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              {content}
            </pre>
          </div>
        </div>
      );
    }

    case "thinking": {
      const thinkGray = "hsl(0, 0%, 55%)";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "14px 18px",
            borderRadius: "var(--radius)",
            border: "1px solid hsl(0, 0%, 20%)",
            borderLeftWidth: 3,
            borderLeftStyle: "solid",
            borderLeftColor: thinkGray,
            background: "hsl(0, 0%, 12%)",
          }}
        >
          <Brain size={18} style={{ color: thinkGray, marginTop: 1, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: thinkGray,
                }}
              >
                Thinking
              </span>
              <StepTimestamp timestamp={timestamp} delta={delta} />
            </div>
            <CollapsibleText
              text={content}
              style={{ color: "hsl(0, 0%, 65%)", fontStyle: "italic", fontSize: "13px" }}
            />
          </div>
        </div>
      );
    }

    case "text": {
      const msgBlue = "hsl(195, 85%, 55%)";
      return (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "16px 20px",
            borderRadius: "var(--radius)",
            border: `1px solid color-mix(in srgb, ${msgBlue} 25%, transparent)`,
            borderLeftWidth: 4,
            borderLeftStyle: "solid",
            borderLeftColor: msgBlue,
            background: `color-mix(in srgb, ${msgBlue} 12%, transparent)`,
            boxShadow: `0 2px 8px color-mix(in srgb, ${msgBlue} 10%, transparent)`,
          }}
        >
          <MessageSquare size={20} style={{ color: msgBlue, marginTop: 1, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: msgBlue,
                }}
              >
                Message
              </span>
              <StepTimestamp timestamp={timestamp} delta={delta} />
            </div>
            <CollapsibleText
              text={content}
              style={{ color: "var(--foreground)", fontSize: "14px", lineHeight: "1.7" }}
            />
          </div>
        </div>
      );
    }

    case "tool_call":
      return <ToolCard step={step} resultSteps={resultSteps} timestamp={timestamp} delta={delta} />;

    case "tool_result":
    case "tool_error":
      // Standalone result (not grouped with tool_call)
      return (
        <div
          style={{
            borderLeft: `2px solid ${
              step.type === "tool_error"
                ? "var(--status-error)"
                : "var(--border)"
            }`,
            paddingLeft: 10,
            fontSize: "0.85rem",
            color:
              step.type === "tool_error"
                ? "var(--status-error)"
                : "var(--foreground-dim)",
          }}
        >
          <CollapsibleText text={content} threshold={120} />
        </div>
      );

    case "skill_invoke": {
      const skillColor = "hsl(330, 70%, 60%)";
      const meta = step.metadata ?? {};
      const skillName = (meta.skillName as string) || "skill";
      const skillArgs = (meta.skillArgs as string) || "";
      return (
        <div
          style={{
            borderLeft: `3px solid ${skillColor}`,
            borderRadius: `0 var(--radius) var(--radius) 0`,
            padding: "10px 12px",
            background: `color-mix(in srgb, ${skillColor} 5%, transparent)`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: skillArgs ? 6 : 0,
            }}
          >
            <Sparkles size={14} style={{ color: skillColor, flexShrink: 0 }} />
            <span
              style={{
                fontSize: "0.72rem",
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: skillColor,
              }}
            >
              Skill
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.77rem",
                color: skillColor,
                background: `color-mix(in srgb, ${skillColor} 12%, transparent)`,
                padding: "2px 8px",
                borderRadius: "var(--radius)",
              }}
            >
              {skillName}
            </span>
            <StepTimestamp timestamp={timestamp} delta={delta} />
          </div>
          {skillArgs && (
            <div
              style={{
                fontSize: "0.8rem",
                color: "var(--foreground-dim)",
                fontFamily: "var(--font-mono)",
                paddingLeft: 22,
              }}
            >
              {skillArgs}
            </div>
          )}
        </div>
      );
    }

    case "skill_result":
      return (
        <div
          style={{
            borderLeft: "3px solid hsl(330, 70%, 60%)",
            borderRadius: "0 0 var(--radius) var(--radius)",
            padding: "8px 12px",
            background: "color-mix(in srgb, hsl(330, 70%, 60%) 3%, transparent)",
          }}
        >
          <div style={{ paddingLeft: 22 }}>
            <CollapsibleText text={content} />
          </div>
        </div>
      );

    case "completed":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "rgba(34, 197, 94, 0.05)",
            borderRadius: "var(--radius)",
            border: "1px solid rgba(34, 197, 94, 0.15)",
          }}
        >
          <CheckCircle size={16} color="var(--status-success)" />
          <span style={{ fontWeight: 500, color: "var(--status-success)" }}>
            Completed
          </span>
          <StepTimestamp timestamp={timestamp} delta={delta} />
        </div>
      );

    case "error":
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "rgba(239, 68, 68, 0.05)",
            borderRadius: "var(--radius)",
            border: "1px solid rgba(239, 68, 68, 0.15)",
          }}
        >
          <AlertTriangle size={16} color="var(--status-error)" />
          <span style={{ color: "var(--status-error)" }}>
            {content || "Unknown error"}
          </span>
          <StepTimestamp timestamp={timestamp} delta={delta} />
        </div>
      );

    case "subagent_spawn": {
      const spawnColor = "hsl(263, 82%, 58%)";
      const meta = step.metadata ?? {};
      const rawType = (meta.subagentType as string) || "subagent";
      const subId = (meta.subagentId as string) || "";
      const subType = rawType === "unknown" && subId ? subId.slice(0, 8) : rawType;
      const desc = (meta.description as string) || null;

      return (
        <div
          onClick={subId && onSubagentClick ? () => onSubagentClick(subId) : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 20px",
            borderRadius: "var(--radius-lg)",
            border: `2px solid color-mix(in srgb, ${spawnColor} 60%, transparent)`,
            background: `linear-gradient(135deg, color-mix(in srgb, ${spawnColor} 22%, transparent) 0%, color-mix(in srgb, ${spawnColor} 10%, transparent) 100%)`,
            boxShadow: `0 4px 24px color-mix(in srgb, ${spawnColor} 18%, transparent), inset 0 1px 0 color-mix(in srgb, ${spawnColor} 15%, transparent)`,
            cursor: onSubagentClick ? "pointer" : undefined,
            transition: "border-color 0.15s, box-shadow 0.15s, transform 0.15s",
          }}
          onMouseEnter={(e) => {
            if (onSubagentClick) {
              e.currentTarget.style.borderColor = spawnColor;
              e.currentTarget.style.boxShadow = `0 6px 32px color-mix(in srgb, ${spawnColor} 28%, transparent), inset 0 1px 0 color-mix(in srgb, ${spawnColor} 20%, transparent)`;
              e.currentTarget.style.transform = "translateY(-1px)";
            }
          }}
          onMouseLeave={(e) => {
            if (onSubagentClick) {
              e.currentTarget.style.borderColor = `color-mix(in srgb, ${spawnColor} 60%, transparent)`;
              e.currentTarget.style.boxShadow = `0 4px 24px color-mix(in srgb, ${spawnColor} 18%, transparent), inset 0 1px 0 color-mix(in srgb, ${spawnColor} 15%, transparent)`;
              e.currentTarget.style.transform = "translateY(0)";
            }
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 9,
              background: `color-mix(in srgb, ${spawnColor} 30%, transparent)`,
              border: `1px solid color-mix(in srgb, ${spawnColor} 40%, transparent)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <GitBranch size={17} style={{ color: spawnColor }} />
          </div>
          <span
            style={{
              fontSize: "0.75rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: spawnColor,
            }}
          >
            Subagent
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.77rem",
              fontWeight: 600,
              color: "var(--foreground)",
              background: `color-mix(in srgb, ${spawnColor} 15%, transparent)`,
              padding: "2px 10px",
              borderRadius: "var(--radius)",
            }}
          >
            {subType}
          </span>
          {subId && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                color: "var(--foreground-dim)",
                padding: "1px 6px",
                borderRadius: "var(--radius)",
                background: "hsla(0, 0%, 100%, 0.06)",
              }}
            >
              {subId}
            </span>
          )}
          {desc && (
            <span
              style={{
                fontSize: "0.77rem",
                color: "var(--foreground-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
              title={desc}
            >
              {desc}
            </span>
          )}
          <StepTimestamp timestamp={timestamp} delta={delta} />
        </div>
      );
    }

    case "subagent_result": {
      const doneColor = "hsl(263, 82%, 58%)";
      const meta = step.metadata ?? {};
      const subId = (meta.subagentId as string) || "";

      return (
        <div
          onClick={subId && onSubagentClick ? () => onSubagentClick(subId) : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            borderRadius: "var(--radius-lg)",
            border: `1.5px solid color-mix(in srgb, var(--status-success) 40%, transparent)`,
            background: `linear-gradient(135deg, color-mix(in srgb, var(--status-success) 12%, transparent) 0%, color-mix(in srgb, var(--status-success) 5%, transparent) 100%)`,
            cursor: onSubagentClick ? "pointer" : undefined,
            transition: "border-color 0.15s",
          }}
          onMouseEnter={(e) => {
            if (onSubagentClick)
              e.currentTarget.style.borderColor = `color-mix(in srgb, var(--status-success) 70%, transparent)`;
          }}
          onMouseLeave={(e) => {
            if (onSubagentClick)
              e.currentTarget.style.borderColor = `color-mix(in srgb, var(--status-success) 40%, transparent)`;
          }}
        >
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: `color-mix(in srgb, var(--status-success) 20%, transparent)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <CheckCircle size={15} style={{ color: "var(--status-success)" }} />
          </div>
          <span
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--status-success)",
            }}
          >
            Subagent Completed
          </span>
          {subId && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.68rem",
                color: "var(--foreground-dim)",
                padding: "1px 6px",
                borderRadius: "var(--radius)",
                background: "hsla(0, 0%, 100%, 0.06)",
              }}
            >
              {subId}
            </span>
          )}
          <StepTimestamp timestamp={timestamp} delta={delta} />
        </div>
      );
    }

    default:
      return null;
  }
}
