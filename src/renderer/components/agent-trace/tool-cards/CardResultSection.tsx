/**
 * What: Collapsible result section for a tool call — shows preview + expand-to-full body. Switches between formatted and raw rendering based on tool support.
 * Not: Does not render the tool input or chrome — ToolCard owns those. Does not handle Agent results — AgentCard renders its own.
 * Deps: AgentStep, ToolFormattedResult / hasFormattedResult.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { AgentStep } from "../../../../core/types.js";
import { ToolFormattedResult, hasFormattedResult } from "../ToolFormattedResult.js";

interface CardResultSectionProps {
  resultSteps: AgentStep[];
  toolName: string;
}

export function CardResultSection({ resultSteps, toolName }: CardResultSectionProps) {
  const [expanded, setExpanded] = useState(false);

  const errors = resultSteps.filter((rs) => rs.type === "tool_error");
  const results = resultSteps.filter((rs) => rs.type !== "tool_error");

  // For tools with formatted results, render them directly when expanded.
  const useFormattedResult = hasFormattedResult(toolName);

  // Build preview text from first result.
  const previewText =
    results[0]?.content?.slice(0, 120) ?? errors[0]?.content?.slice(0, 120) ?? "";
  const hasError = errors.length > 0;
  const resultColor = hasError ? "var(--status-error)" : "var(--foreground-dim)";

  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 12px",
          fontSize: "11px",
          fontWeight: 500,
          color: resultColor,
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        <span style={{ flexShrink: 0 }}>{hasError ? "Error" : "Result"}</span>
        {!expanded && previewText && (
          <span
            style={{
              color: resultColor,
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
            {previewText}
          </span>
        )}
      </button>
      {expanded && (
        <div style={{ padding: "4px 12px 10px" }}>
          {useFormattedResult
            ? resultSteps.map((rs) =>
                rs.type === "tool_error" ? (
                  <pre
                    key={rs.id}
                    style={{
                      fontSize: "11px",
                      fontFamily: "var(--font-mono)",
                      color: "var(--status-error)",
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      margin: 0,
                      background: "color-mix(in srgb, var(--status-error) 8%, transparent)",
                      padding: "8px 12px",
                      borderRadius: "var(--radius)",
                      maxHeight: 400,
                      overflowY: "auto",
                    }}
                  >
                    {rs.content}
                  </pre>
                ) : (
                  <ToolFormattedResult key={rs.id} toolName={toolName} content={rs.content} />
                ),
              )
            : resultSteps.map((rs) => (
                <pre
                  key={rs.id}
                  style={{
                    fontSize: "11px",
                    fontFamily: "var(--font-mono)",
                    color:
                      rs.type === "tool_error"
                        ? "var(--status-error)"
                        : "var(--foreground-muted)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    background:
                      rs.type === "tool_error"
                        ? "color-mix(in srgb, var(--status-error) 8%, transparent)"
                        : "var(--surface)",
                    padding: "8px 12px",
                    borderRadius: "var(--radius)",
                    maxHeight: 400,
                    overflowY: "auto",
                  }}
                >
                  {rs.content}
                </pre>
              ))}
        </div>
      )}
    </div>
  );
}
