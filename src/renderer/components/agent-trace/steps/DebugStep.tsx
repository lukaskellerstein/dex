import { Bot, Bug, Package, Server, Zap } from "lucide-react";
import type { CSSProperties } from "react";
import type { AgentStep } from "../../../../core/types.js";
import { StepTimestamp } from "../primitives/StepTimestamp.js";

interface DebugStepProps {
  step: AgentStep;
  timestamp?: string;
  delta?: string;
}

const DEBUG_COLOR = "hsl(35, 90%, 55%)";

const sectionStyle: CSSProperties = { marginBottom: 10 };

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
  color: DEBUG_COLOR,
  marginLeft: 4,
  opacity: 0.8,
};

export function DebugStep({ step, timestamp, delta }: DebugStepProps) {
  const meta = step.metadata ?? {};
  const mcpServers = (meta.mcpServers ?? {}) as Record<string, string[]>;
  const skills = (meta.skills ?? []) as Array<Record<string, unknown>>;
  const agents = (meta.agents ?? []) as Array<Record<string, unknown>>;
  const plugins = (meta.plugins ?? []) as Array<Record<string, unknown>>;
  const model = meta.model as string | undefined;
  const toolCount = (meta.toolCount ?? 0) as number;

  const mcpEntries = Object.entries(mcpServers);

  return (
    <div
      style={{
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
        border: `1.5px solid color-mix(in srgb, ${DEBUG_COLOR} 30%, transparent)`,
        boxShadow: `0 2px 12px color-mix(in srgb, ${DEBUG_COLOR} 8%, transparent)`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 16px",
          background: `linear-gradient(135deg, color-mix(in srgb, ${DEBUG_COLOR} 15%, transparent) 0%, color-mix(in srgb, ${DEBUG_COLOR} 8%, transparent) 100%)`,
          borderBottom: `1px solid color-mix(in srgb, ${DEBUG_COLOR} 18%, transparent)`,
        }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: `color-mix(in srgb, ${DEBUG_COLOR} 20%, transparent)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Bug size={14} style={{ color: DEBUG_COLOR }} />
        </div>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: DEBUG_COLOR,
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
        <span style={{ ...countBadgeStyle, marginLeft: "auto" }}>{toolCount} tools</span>
        <StepTimestamp timestamp={timestamp} delta={delta} />
      </div>
      <div
        style={{
          padding: "12px 16px",
          background: `color-mix(in srgb, ${DEBUG_COLOR} 4%, var(--background))`,
          fontSize: "0.82rem",
        }}
      >
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

        {mcpEntries.length === 0 &&
          skills.length === 0 &&
          agents.length === 0 &&
          plugins.length === 0 && (
            <div
              style={{
                color: "var(--foreground-dim)",
                fontStyle: "italic",
                fontSize: "0.8rem",
              }}
            >
              No capabilities reported by agent SDK
            </div>
          )}
      </div>
    </div>
  );
}
