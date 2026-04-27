/**
 * What: Dispatcher for a tool-call card. Picks AgentCard for Agent steps; otherwise renders the generic chrome (header + per-tool input via *Input components + collapsible result).
 * Not: Does not own per-tool input rendering — those live in BashInput/ReadInput/WriteInput/EditInput/TodoWriteInput/TaskInput. Does not render Agent's full layout — AgentCard owns that.
 * Deps: AgentCard, CardResultSection, helpers (icon/color/MCP parse), per-tool *Input components.
 */
import type { AgentStep } from "../../../core/types.js";
import { BashInput } from "./BashInput.js";
import { ReadInput } from "./ReadInput.js";
import { WriteInput } from "./WriteInput.js";
import { EditInput } from "./EditInput.js";
import { TodoWriteInput } from "./TodoWriteInput.js";
import { TaskInput } from "./TaskInput.js";
import { AgentCard } from "./tool-cards/AgentCard.js";
import { CardResultSection } from "./tool-cards/CardResultSection.js";
import { getToolIcon, getToolColor, parseMcpToolName } from "./tool-cards/helpers.js";

interface ToolCardProps {
  step: AgentStep;
  resultSteps: AgentStep[];
  timestamp?: string;
  delta?: string;
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

export function ToolCard({ step, resultSteps, timestamp, delta }: ToolCardProps) {
  const meta = step.metadata ?? {};
  const toolName = String(meta.toolName ?? "unknown");
  const toolInput = (meta.toolInput ?? {}) as Record<string, unknown>;
  const color = getToolColor(toolName);
  const { display, server } = parseMcpToolName(toolName);

  // Agent tool call — render its dedicated card variant.
  if (toolName === "Agent") {
    return <AgentCard toolInput={toolInput} resultSteps={resultSteps} />;
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
          {delta && <span style={{ color: "var(--primary)", opacity: 0.8 }}>{delta}</span>}
        </span>
      </div>

      {/* Input section */}
      {inputContent && (
        <div style={{ borderBottom: hasResults ? "1px solid var(--border)" : undefined }}>
          {inputContent}
        </div>
      )}

      {/* Result section — collapsible inside the card */}
      {hasResults && <CardResultSection resultSteps={resultSteps} toolName={toolName} />}
    </div>
  );
}
