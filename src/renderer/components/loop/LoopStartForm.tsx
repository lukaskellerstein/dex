/**
 * What: Markdown editor for the goal file — toolbar (bold/italic/code/H1/H2/lists/HR) + textarea + Save button. Also renders the collapsed input row when the editor is hidden. Labels reflect the current basename (defaults to "GOAL.md").
 * Not: Does not own form state — receives values + setters from useLoopStartForm via props. Does not start the run.
 * Deps: lucide-react icons, useLoopStartForm setters/state.
 */
import { useRef, useCallback } from "react";
import {
  FileText,
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Code,
  Minus,
} from "lucide-react";

interface ToolbarAction {
  icon: React.ReactNode;
  title: string;
  prefix: string;
  suffix?: string;
  block?: boolean; // true = operates on whole lines
}

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { icon: <Bold size={14} />, title: "Bold", prefix: "**", suffix: "**" },
  { icon: <Italic size={14} />, title: "Italic", prefix: "_", suffix: "_" },
  { icon: <Code size={14} />, title: "Inline code", prefix: "`", suffix: "`" },
  { icon: <Heading1 size={14} />, title: "Heading 1", prefix: "# ", block: true },
  { icon: <Heading2 size={14} />, title: "Heading 2", prefix: "## ", block: true },
  { icon: <List size={14} />, title: "Bullet list", prefix: "- ", block: true },
  { icon: <ListOrdered size={14} />, title: "Numbered list", prefix: "1. ", block: true },
  { icon: <Minus size={14} />, title: "Horizontal rule", prefix: "\n---\n", block: true },
];

function applyToolbarAction(
  textarea: HTMLTextAreaElement,
  action: ToolbarAction,
  setText: (val: string) => void,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);

  let newText: string;
  let cursorPos: number;

  if (action.block) {
    const beforeCursor = value.slice(0, selectionStart);
    const lineStart = beforeCursor.lastIndexOf("\n") + 1;
    newText = value.slice(0, lineStart) + action.prefix + value.slice(lineStart);
    cursorPos = selectionStart + action.prefix.length;
  } else {
    const suffix = action.suffix ?? "";
    if (selected) {
      newText =
        value.slice(0, selectionStart) +
        action.prefix +
        selected +
        suffix +
        value.slice(selectionEnd);
      cursorPos = selectionEnd + action.prefix.length + suffix.length;
    } else {
      newText =
        value.slice(0, selectionStart) +
        action.prefix +
        suffix +
        value.slice(selectionEnd);
      cursorPos = selectionStart + action.prefix.length;
    }
  }

  setText(newText);
  requestAnimationFrame(() => {
    textarea.selectionStart = cursorPos;
    textarea.selectionEnd = cursorPos;
    textarea.focus();
  });
}

interface LoopStartFormProps {
  isRunning: boolean;
  goalPath: string;
  setGoalPath: (s: string) => void;
  goalContent: string;
  setGoalContent: (s: string) => void;
  goalDetected: boolean;
  showEditor: boolean;
  setShowEditor: (b: boolean) => void;
  saving: boolean;
  saveGoal: () => Promise<void>;
  loadGoalFromPath: (path: string) => Promise<void>;
  pickGoalFile: () => Promise<void>;
}

function basenameFromPath(p: string, fallback: string): string {
  if (!p) return fallback;
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  return name || fallback;
}

export function LoopStartForm({
  isRunning,
  goalPath,
  setGoalPath,
  goalContent,
  setGoalContent,
  goalDetected,
  showEditor,
  setShowEditor,
  saving,
  saveGoal,
  loadGoalFromPath,
  pickGoalFile,
}: LoopStartFormProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const goalName = basenameFromPath(goalPath, "GOAL.md");

  const handleToolbarAction = useCallback(
    (action: ToolbarAction) => {
      if (!textareaRef.current) return;
      applyToolbarAction(textareaRef.current, action, setGoalContent);
    },
    [setGoalContent],
  );

  if (showEditor) {
    return (
      <div style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <label
            style={{ fontSize: "0.78rem", fontWeight: 500, color: "var(--foreground-muted)" }}
          >
            {goalName} — describe your project
          </label>
          {goalDetected && (
            <button
              onClick={() => setShowEditor(false)}
              style={{
                fontSize: "0.72rem",
                color: "var(--foreground-dim)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Hide editor
            </button>
          )}
        </div>

        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            gap: 2,
            padding: "4px 6px",
            borderRadius: "var(--radius) var(--radius) 0 0",
            border: "1px solid var(--border)",
            borderBottom: "none",
            background: "var(--surface)",
          }}
        >
          {TOOLBAR_ACTIONS.map((action) => (
            <button
              key={action.title}
              title={action.title}
              onClick={() => handleToolbarAction(action)}
              style={{
                padding: "4px 6px",
                borderRadius: 3,
                background: "transparent",
                border: "none",
                color: "var(--foreground-dim)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                transition: "color 0.15s, background 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--foreground)";
                e.currentTarget.style.background = "var(--surface-elevated)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--foreground-dim)";
                e.currentTarget.style.background = "transparent";
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>

        {/* Editor textarea */}
        <textarea
          ref={textareaRef}
          value={goalContent}
          onChange={(e) => setGoalContent(e.target.value)}
          disabled={isRunning}
          onKeyDown={(e) => {
            if (e.key === "Tab") {
              e.preventDefault();
              const { selectionStart, selectionEnd } = e.currentTarget;
              const newVal =
                goalContent.slice(0, selectionStart) + "  " + goalContent.slice(selectionEnd);
              setGoalContent(newVal);
              requestAnimationFrame(() => {
                if (textareaRef.current) {
                  textareaRef.current.selectionStart = selectionStart + 2;
                  textareaRef.current.selectionEnd = selectionStart + 2;
                }
              });
            }
          }}
          style={{
            width: "100%",
            minHeight: 280,
            padding: "10px 12px",
            borderRadius: "0 0 var(--radius) var(--radius)",
            border: "1px solid var(--border)",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            fontSize: "0.82rem",
            fontFamily: "var(--font-mono)",
            lineHeight: 1.6,
            outline: "none",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />

        {/* Save button */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <button
            onClick={saveGoal}
            disabled={saving || !goalContent.trim()}
            style={{
              padding: "6px 14px",
              borderRadius: "var(--radius)",
              fontSize: "0.8rem",
              fontWeight: 600,
              background:
                goalContent.trim() && !saving ? "var(--primary)" : "var(--surface-elevated)",
              color: goalContent.trim() && !saving ? "#fff" : "var(--foreground-disabled)",
              border: "none",
              cursor: goalContent.trim() && !saving ? "pointer" : "not-allowed",
            }}
          >
            {saving ? "Saving..." : goalDetected ? `Update ${goalName}` : `Save ${goalName}`}
          </button>
          {goalDetected && (
            <span
              style={{
                fontSize: "0.72rem",
                color: "var(--status-success)",
                display: "flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              <FileText size={10} />
              Saved to {goalPath}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "0.78rem",
          fontWeight: 500,
          color: "var(--foreground-muted)",
          marginBottom: 6,
        }}
      >
        {goalName} Path
        {goalDetected && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              fontSize: "0.7rem",
              color: "var(--status-success)",
              fontWeight: 400,
            }}
          >
            <FileText size={10} />
            auto-detected
          </span>
        )}
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={goalPath}
          onChange={(e) => setGoalPath(e.target.value)}
          placeholder="path/to/GOAL.md"
          disabled={isRunning}
          style={{
            flex: 1,
            padding: "6px 10px",
            borderRadius: "var(--radius)",
            border: "1px solid var(--border)",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            fontSize: "0.82rem",
            fontFamily: "var(--font-mono)",
            outline: "none",
          }}
        />
        <button
          onClick={() => { void pickGoalFile(); }}
          disabled={isRunning}
          style={secondaryButtonStyle}
        >
          Pick file
        </button>
        <button
          onClick={() => {
            setShowEditor(true);
            if (!goalContent && goalPath) {
              loadGoalFromPath(goalPath);
            }
          }}
          disabled={isRunning}
          style={secondaryButtonStyle}
        >
          {goalDetected ? "Edit" : "Create new"}
        </button>
      </div>
      {!goalDetected && (
        <p
          style={{
            fontSize: "0.72rem",
            color: "var(--foreground-dim)",
            marginTop: 6,
            lineHeight: 1.4,
          }}
        >
          Pick an existing markdown file or create a new one with the editor. Conventional name is <code>GOAL.md</code>.
        </p>
      )}
    </div>
  );
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "var(--radius)",
  fontSize: "0.78rem",
  fontWeight: 500,
  background: "var(--surface-elevated)",
  color: "var(--foreground-muted)",
  border: "1px solid var(--border)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
