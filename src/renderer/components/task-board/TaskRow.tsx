import { CheckCircle, Circle, Cog, Loader2 } from "lucide-react";
import type { Task } from "../../../core/types.js";

interface TaskRowProps {
  task: Task;
}

function StatusIcon({ status }: { status: Task["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle size={14} color="var(--status-success)" />;
    case "in_progress":
      return (
        <Cog size={14} color="var(--primary)" style={{ animation: "spin 2s linear infinite" }} />
      );
    case "code_exists":
      return (
        <Loader2
          size={14}
          color="var(--status-warning)"
          style={{ animation: "spin 2s linear infinite" }}
        />
      );
    case "not_done":
      return <Circle size={14} color="var(--foreground-dim)" />;
  }
}

export function TaskRow({ task }: TaskRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        fontSize: "0.92rem",
        borderRadius: "var(--radius)",
        transition: "background 0.1s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--surface-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <StatusIcon status={task.status} />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.8rem",
          color: "var(--foreground-dim)",
          minWidth: 36,
          flexShrink: 0,
        }}
      >
        {task.id}
      </span>
      {task.priority && (
        <span
          style={{
            fontSize: "0.77rem",
            padding: "1px 6px",
            borderRadius: "var(--radius)",
            background: "var(--primary-muted)",
            color: "var(--primary)",
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {task.priority}
        </span>
      )}
      {task.userStory && (
        <span
          style={{
            fontSize: "0.77rem",
            padding: "1px 6px",
            borderRadius: "var(--radius)",
            background: "rgba(34, 197, 94, 0.15)",
            color: "rgb(74, 222, 128)",
            fontWeight: 500,
            flexShrink: 0,
          }}
        >
          {task.userStory}
        </span>
      )}
      <span
        style={{
          color: task.status === "done" ? "var(--foreground-dim)" : "var(--foreground-muted)",
          textDecoration: task.status === "done" ? "line-through" : "none",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.description}
      </span>
    </div>
  );
}
