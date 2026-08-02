import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

interface ToolResultStepProps {
  content: string | null;
  isError: boolean;
}

export function ToolResultStep({ content, isError }: ToolResultStepProps) {
  const [expanded, setExpanded] = useState(false);
  const raw = content ?? "";
  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const preview = text.slice(0, 120) + (text.length > 120 ? "..." : "");

  if (!text) return null;

  const borderColor = isError ? "var(--status-error)" : "var(--border)";

  return (
    <div
      style={{
        marginLeft: 20,
        borderLeft: `2px solid ${borderColor}`,
        paddingLeft: 10,
        marginTop: 4,
      }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "0.8rem",
          color: isError ? "var(--status-error)" : "var(--foreground-dim)",
          background: "transparent",
          padding: "2px 0",
        }}
      >
        {isError && <AlertTriangle size={11} />}
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 300,
          }}
        >
          {expanded ? (isError ? "Error" : "Result") : preview}
        </span>
      </button>
      {expanded && (
        <pre
          style={{
            fontSize: "0.8rem",
            fontFamily: "var(--font-mono)",
            color: isError ? "var(--status-error)" : "var(--foreground-muted)",
            background: isError ? "rgba(239, 68, 68, 0.05)" : "var(--surface)",
            padding: 8,
            borderRadius: "var(--radius)",
            marginTop: 4,
            maxHeight: 300,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
