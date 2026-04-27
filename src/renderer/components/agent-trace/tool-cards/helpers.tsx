/**
 * What: Pure helpers for ToolCard rendering — tool-name → icon, tool-name → color, MCP tool-name parse.
 * Not: Does not render. Does not own any React state. Tool-input rendering lives in the per-tool *Input components.
 * Deps: lucide-react icons; no React state.
 */
import type { ReactNode } from "react";
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
} from "lucide-react";

export function getToolIcon(toolName: string): ReactNode {
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

export function getToolColor(toolName: string): string {
  if (toolName === "Bash") return "hsl(120, 60%, 60%)";
  if (["Read", "Write", "Edit"].includes(toolName)) return "hsl(220, 70%, 60%)";
  if (["Grep", "Glob"].includes(toolName)) return "hsl(280, 60%, 60%)";
  if (toolName === "Agent") return "hsl(195, 85%, 55%)";
  if (toolName === "TodoWrite") return "hsl(38, 80%, 55%)";
  if (toolName === "Task" || toolName.startsWith("Task")) return "hsl(38, 80%, 55%)";
  if (toolName.startsWith("mcp__")) return "hsl(174, 72%, 46%)";
  return "var(--foreground-dim)";
}

export function parseMcpToolName(toolName: string): {
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
