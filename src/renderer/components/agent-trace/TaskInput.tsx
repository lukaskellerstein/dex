import { ClipboardList } from "lucide-react";

interface TaskInputProps {
  input: Record<string, unknown>;
}

export function TaskInput({ input }: TaskInputProps) {
  const subject = input.subject as string | undefined;
  const description = input.description as string | undefined;
  const status = input.status as string | undefined;
  const id = input.id as string | undefined;

  // Nothing meaningful to show
  if (!subject && !description && !status && !id) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 14px",
        fontSize: "12px",
      }}
    >
      {/* Subject line — primary display */}
      {subject && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ClipboardList size={12} color="hsl(38, 80%, 55%)" style={{ flexShrink: 0 }} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--foreground)",
              fontWeight: 500,
            }}
          >
            {subject}
          </span>
        </div>
      )}

      {/* Description */}
      {description && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--foreground-dim)",
            fontSize: "11px",
            lineHeight: 1.4,
            paddingLeft: subject ? 20 : 0,
          }}
        >
          {description}
        </span>
      )}

      {/* Status update (for TaskUpdate calls) */}
      {status && !subject && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <ClipboardList size={12} color="hsl(38, 80%, 55%)" style={{ flexShrink: 0 }} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--foreground-muted)",
            }}
          >
            {id ? `#${id.slice(0, 8)}` : "task"} → {status}
          </span>
        </div>
      )}
    </div>
  );
}
