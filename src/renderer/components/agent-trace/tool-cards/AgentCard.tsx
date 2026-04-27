/**
 * What: Full-card renderer for the Agent (subagent) tool — agent-type chip + collapsible Prompt + collapsible Result. Distinct chrome from generic tools.
 * Not: Does not handle non-Agent tools — ToolCard's generic chrome owns those. Does not subscribe to events; props-only.
 * Deps: AgentStep, ToolResultStep, lucide-react.
 */
import { useState } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import type { AgentStep } from "../../../../core/types.js";
import { ToolResultStep } from "../ToolResultStep.js";

interface AgentCardProps {
  toolInput: Record<string, unknown>;
  resultSteps: AgentStep[];
}

export function AgentCard({ toolInput, resultSteps }: AgentCardProps) {
  const description = (toolInput.description as string) ?? "";
  const prompt = (toolInput.prompt as string) ?? "";
  const agentType = (toolInput.subagent_type as string) ?? "";

  const resultContent =
    resultSteps
      .filter((rs) => rs.type !== "tool_error")
      .map((rs) => rs.content ?? "")
      .filter(Boolean)
      .join("\n\n") || null;
  const errors = resultSteps.filter((rs) => rs.type === "tool_error");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <AgentBlock
        description={description}
        prompt={prompt}
        agentType={agentType}
        resultContent={resultContent}
      />
      {errors.map((rs) => (
        <ToolResultStep key={rs.id} content={rs.content} isError={true} />
      ))}
    </div>
  );
}

function AgentBlock({
  description,
  prompt,
  agentType,
  resultContent,
}: {
  description: string;
  prompt: string;
  agentType: string;
  resultContent: string | null;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const agentColor = "hsl(210, 80%, 60%)";

  return (
    <div
      style={{
        borderRadius: "var(--radius)",
        overflow: "hidden",
        border: `1px solid color-mix(in srgb, ${agentColor} 35%, transparent)`,
        fontSize: "12px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: `color-mix(in srgb, ${agentColor} 10%, transparent)`,
          borderBottom: `1px solid color-mix(in srgb, ${agentColor} 20%, transparent)`,
        }}
      >
        <Bot size={18} style={{ color: agentColor, flexShrink: 0 }} />
        <span
          style={{
            fontSize: "10px",
            fontWeight: 700,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            padding: "2px 8px",
            borderRadius: "var(--radius)",
            background: `color-mix(in srgb, ${agentColor} 20%, transparent)`,
            color: agentColor,
            border: `1px solid color-mix(in srgb, ${agentColor} 40%, transparent)`,
            flexShrink: 0,
          }}
        >
          Agent
        </span>
        {agentType && (
          <span
            style={{
              fontSize: "10px",
              fontWeight: 500,
              fontFamily: "var(--font-mono)",
              padding: "2px 7px",
              borderRadius: "var(--radius)",
              background: `color-mix(in srgb, ${agentColor} 12%, transparent)`,
              color: `color-mix(in srgb, ${agentColor} 80%, white)`,
              border: `1px solid color-mix(in srgb, ${agentColor} 25%, transparent)`,
              flexShrink: 0,
            }}
          >
            {agentType}
          </span>
        )}
        <span
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--foreground)",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {description || "Subagent"}
        </span>
      </div>

      {/* Prompt — collapsed by default */}
      {prompt && (
        <div
          style={{
            borderBottom: resultContent
              ? `1px solid color-mix(in srgb, ${agentColor} 15%, transparent)`
              : undefined,
          }}
        >
          <button
            onClick={() => setPromptExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              padding: "7px 14px",
              fontSize: "11px",
              fontWeight: 500,
              color: "var(--foreground-dim)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {promptExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Prompt
            {!promptExpanded && (
              <span
                style={{
                  color: "var(--foreground-dim)",
                  opacity: 0.6,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                }}
              >
                {prompt.slice(0, 100)}
              </span>
            )}
          </button>
          {promptExpanded && (
            <div style={{ padding: "8px 14px 12px", maxHeight: 400, overflowY: "auto" }}>
              <pre
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--foreground-muted)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                }}
              >
                {prompt}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Result — collapsed by default */}
      {resultContent && (
        <div>
          <button
            onClick={() => setResultExpanded((v) => !v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              padding: "7px 14px",
              fontSize: "11px",
              fontWeight: 500,
              color: "var(--foreground-dim)",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {resultExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Result
            {!resultExpanded && (
              <span
                style={{
                  color: "var(--foreground-dim)",
                  opacity: 0.6,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1,
                  minWidth: 0,
                  fontFamily: "var(--font-mono)",
                  fontSize: "10px",
                }}
              >
                {resultContent.slice(0, 100)}
              </span>
            )}
          </button>
          {resultExpanded && (
            <div style={{ padding: "8px 14px 12px", maxHeight: 400, overflowY: "auto" }}>
              <pre
                style={{
                  fontSize: "11px",
                  fontFamily: "var(--font-mono)",
                  color: "var(--foreground-muted)",
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                }}
              >
                {resultContent}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
