import { useState, type ReactNode } from "react";
import type { AgentStep } from "../../../core/types.js";
import {
  Terminal,
  FileText,
  FilePlus,
  FileEdit,
  Search,
  FolderSearch,
  Bot,
  ListTodo,
  ClipboardList,
  Wrench,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { BashInput } from "./BashInput.js";
import { ReadInput } from "./ReadInput.js";
import { WriteInput } from "./WriteInput.js";
import { EditInput } from "./EditInput.js";
import { TodoWriteInput } from "./TodoWriteInput.js";
import { TaskInput } from "./TaskInput.js";
import { ToolResultStep } from "./ToolResultStep.js";
import {
  ToolFormattedResult,
  hasFormattedResult,
} from "./ToolFormattedResult.js";

interface ToolCardProps {
  step: AgentStep;
  resultSteps: AgentStep[];
  timestamp?: string;
  delta?: string;
}

function getToolIcon(toolName: string): ReactNode {
  switch (toolName) {
    case "Bash":
      return <Terminal size={13} />;
    case "Read":
      return <FileText size={13} />;
    case "Write":
      return <FilePlus size={13} />;
    case "Edit":
      return <FileEdit size={13} />;
    case "Grep":
      return <Search size={13} />;
    case "Glob":
      return <FolderSearch size={13} />;
    case "Agent":
      return <Bot size={13} />;
    case "TodoWrite":
      return <ListTodo size={13} />;
    case "Task":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskGet":
    case "TaskList":
      return <ClipboardList size={13} />;
    default:
      return <Wrench size={13} />;
  }
}

function getToolColor(toolName: string): string {
  if (toolName === "Bash") return "hsl(120, 60%, 60%)";
  if (["Read", "Write", "Edit"].includes(toolName))
    return "hsl(220, 70%, 60%)";
  if (["Grep", "Glob"].includes(toolName)) return "hsl(280, 60%, 60%)";
  if (toolName === "Agent") return "hsl(195, 85%, 55%)";
  if (toolName === "TodoWrite") return "hsl(38, 80%, 55%)";
  if (toolName === "Task" || toolName.startsWith("Task")) return "hsl(38, 80%, 55%)";
  if (toolName.startsWith("mcp__")) return "hsl(174, 72%, 46%)";
  return "var(--foreground-dim)";
}

function parseMcpToolName(toolName: string): {
  display: string;
  server?: string;
} {
  if (!toolName.startsWith("mcp__")) return { display: toolName };
  const parts = toolName.split("__");
  if (parts.length >= 3) {
    return { display: parts.slice(2).join("."), server: parts[1] };
  }
  return { display: toolName };
}

function renderInput(toolName: string, input: Record<string, unknown>) {
  switch (toolName) {
    case "Bash":
      return <BashInput input={input} />;
    case "Read":
      return <ReadInput input={input} />;
    case "Write":
      return <WriteInput input={input} />;
    case "Edit":
      return <EditInput input={input} />;
    case "TodoWrite":
      return <TodoWriteInput input={input} />;
    case "Task":
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskGet":
    case "TaskList":
      return <TaskInput input={input} />;
    default:
      return null;
  }
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

export function ToolCard({ step, resultSteps, timestamp, delta }: ToolCardProps) {
  const meta = step.metadata ?? {};
  const toolName = String(meta.toolName ?? "unknown");
  const toolInput = (meta.toolInput ?? {}) as Record<string, unknown>;
  const color = getToolColor(toolName);
  const { display, server } = parseMcpToolName(toolName);

  // Agent tool call — render as AgentBlock card
  if (toolName === "Agent") {
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
          description={(toolInput.description as string) ?? ""}
          prompt={(toolInput.prompt as string) ?? ""}
          agentType={(toolInput.subagent_type as string) ?? ""}
          resultContent={resultContent}
        />
        {errors.map((rs) => (
          <ToolResultStep
            key={rs.id}
            content={rs.content}
            isError={true}
          />
        ))}
      </div>
    );
  }

  const inputContent = renderInput(toolName, toolInput);
  const hasResults = resultSteps.length > 0;

  return (
    <div
      style={{
        borderRadius: "var(--radius)",
        overflow: "hidden",
        border: "1px solid var(--border)",
        fontSize: "12px",
      }}
    >
      {/* Header bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          background: "var(--surface)",
          borderBottom: inputContent || hasResults ? "1px solid var(--border)" : undefined,
        }}
      >
        <span style={{ color, display: "flex", flexShrink: 0 }}>{getToolIcon(toolName)}</span>
        <span
          style={{
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            padding: "2px 8px",
            borderRadius: "var(--radius)",
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
            color,
            fontWeight: 500,
            border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
          }}
        >
          {display}
        </span>
        {server && (
          <span
            style={{
              fontSize: "10px",
              fontFamily: "var(--font-mono)",
              padding: "2px 7px",
              borderRadius: "var(--radius)",
              background: "var(--surface-elevated)",
              color: "var(--foreground-dim)",
              border: "1px solid var(--border)",
            }}
          >
            {server}
          </span>
        )}
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: "11px",
            fontFamily: "var(--font-mono)",
            color: "var(--foreground-dim)",
            flexShrink: 0,
          }}
        >
          {timestamp && <span>{timestamp}</span>}
          {delta && (
            <span style={{ color: "var(--primary)", opacity: 0.8 }}>
              {delta}
            </span>
          )}
        </span>
      </div>

      {/* Input section */}
      {inputContent && (
        <div style={{ borderBottom: hasResults ? "1px solid var(--border)" : undefined }}>
          {inputContent}
        </div>
      )}

      {/* Result section — collapsible inside the card */}
      {hasResults && (
        <CardResultSection
          resultSteps={resultSteps}
          toolName={toolName}
        />
      )}
    </div>
  );
}

function CardResultSection({
  resultSteps,
  toolName,
}: {
  resultSteps: AgentStep[];
  toolName: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // Build result content
  const errors = resultSteps.filter((rs) => rs.type === "tool_error");
  const results = resultSteps.filter((rs) => rs.type !== "tool_error");

  // For tools with formatted results, render them directly when expanded
  const useFormattedResult = hasFormattedResult(toolName);

  // Build preview text from first result
  const previewText = results[0]?.content?.slice(0, 120) ?? errors[0]?.content?.slice(0, 120) ?? "";
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
                  <ToolFormattedResult
                    key={rs.id}
                    toolName={toolName}
                    content={rs.content}
                  />
                )
              )
            : resultSteps.map((rs) => (
                <pre
                  key={rs.id}
                  style={{
                    fontSize: "11px",
                    fontFamily: "var(--font-mono)",
                    color: rs.type === "tool_error" ? "var(--status-error)" : "var(--foreground-muted)",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: 0,
                    background: rs.type === "tool_error"
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
