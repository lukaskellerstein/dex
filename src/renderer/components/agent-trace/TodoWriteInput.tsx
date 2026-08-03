import { CheckCircle2, Circle, Loader } from "lucide-react";

interface Todo {
  id?: string;
  content: string;
  status: "in_progress" | "completed" | "pending";
  priority?: "high" | "medium" | "low";
}

interface TodoWriteInputProps {
  input: Record<string, unknown>;
}

const STATUS_CONFIG = {
  completed: {
    icon: CheckCircle2,
    color: "var(--status-success)",
    textDecoration: "line-through" as const,
    textOpacity: 0.6,
  },
  in_progress: {
    icon: Loader,
    color: "var(--status-info)",
    textDecoration: "none" as const,
    textOpacity: 1,
  },
  pending: {
    icon: Circle,
    color: "var(--foreground-dim)",
    textDecoration: "none" as const,
    textOpacity: 0.8,
  },
};

const PRIORITY_COLORS: Record<string, string> = {
  high: "var(--status-error)",
  medium: "var(--status-warning)",
};

export function TodoWriteInput({ input }: TodoWriteInputProps) {
  const todos = (input.todos ?? []) as Todo[];

  if (todos.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--surface)",
        borderRadius: "var(--radius)",
        padding: "6px 0",
        fontSize: "0.82rem",
      }}
    >
      {todos.map((todo, i) => {
        const cfg = STATUS_CONFIG[todo.status] ?? STATUS_CONFIG.pending;
        const Icon = cfg.icon;
        const priority = todo.priority && PRIORITY_COLORS[todo.priority];

        return (
          <div
            key={todo.id ?? i}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "3px 10px",
            }}
          >
            <span
              style={{
                color: cfg.color,
                display: "flex",
                flexShrink: 0,
                marginTop: 2,
                animation: todo.status === "in_progress" ? "spin 2s linear infinite" : undefined,
              }}
            >
              <Icon size={14} />
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--foreground-muted)",
                opacity: cfg.textOpacity,
                textDecoration: cfg.textDecoration,
                lineHeight: 1.4,
              }}
            >
              {todo.content}
            </span>
            {priority && (
              <span
                style={{
                  marginLeft: "auto",
                  flexShrink: 0,
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: priority,
                  marginTop: 5,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
