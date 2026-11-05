import {
  AlertTriangle,
  Brain,
  CheckCircle,
  CornerDownRight,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import type { AgentStep } from "../../../core/types.js";
import { GateCard } from "./GateCard.js";
import { gateMeta } from "./GateCard.logic.js";
import { CollapsibleText } from "./primitives/CollapsibleText.js";
import { StepTimestamp } from "./primitives/StepTimestamp.js";
import { DebugStep } from "./steps/DebugStep.js";
import { SubagentLifecycleStep } from "./steps/SubagentLifecycleStep.js";
import { ToolCard } from "./ToolCard.js";

interface AgentStepItemProps {
  step: AgentStep;
  resultSteps: AgentStep[];
  timestamp?: string;
  delta?: string;
  onSubagentClick?: (subagentId: string) => void;
}

export function AgentStepItem({
  step,
  resultSteps,
  timestamp,
  delta,
  onSubagentClick,
}: AgentStepItemProps) {
  const content = step.content ?? "";

  switch (step.type) {
    case "debug":
      return <DebugStep step={step} timestamp={timestamp} delta={delta} />;
    case "gate": {
      const meta = gateMeta(step);
      return meta ? <GateCard meta={meta} /> : null;
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
              step.type === "tool_error" ? "var(--status-error)" : "var(--border)"
            }`,
            paddingLeft: 10,
            fontSize: "0.85rem",
            color: step.type === "tool_error" ? "var(--status-error)" : "var(--foreground-dim)",
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
          <span style={{ fontWeight: 500, color: "var(--status-success)" }}>Completed</span>
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
          <span style={{ color: "var(--status-error)" }}>{content || "Unknown error"}</span>
          <StepTimestamp timestamp={timestamp} delta={delta} />
        </div>
      );

    case "subagent_spawn":
    case "subagent_result":
      return (
        <SubagentLifecycleStep
          step={step}
          timestamp={timestamp}
          delta={delta}
          onSubagentClick={onSubagentClick}
        />
      );

    default:
      return null;
  }
}
