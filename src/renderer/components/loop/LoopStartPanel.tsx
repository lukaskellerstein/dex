import { useState, useEffect, useRef, useCallback } from "react";
import { Play, FileText, Bold, Italic, Heading1, Heading2, List, ListOrdered, Code, Minus } from "lucide-react";
import { projectService } from "../../services/projectService.js";

interface LoopStartPanelProps {
  projectDir: string;
  isRunning: boolean;
  onStart: (config: {
    descriptionFile?: string;
    maxLoopCycles?: number;
    maxBudgetUsd?: number;
    autoClarification?: boolean;
  }) => void;
}

// ── Markdown Toolbar ──

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
  setText: (val: string) => void
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const selected = value.slice(selectionStart, selectionEnd);

  let newText: string;
  let cursorPos: number;

  if (action.block) {
    // Insert prefix at start of line
    const beforeCursor = value.slice(0, selectionStart);
    const lineStart = beforeCursor.lastIndexOf("\n") + 1;
    newText = value.slice(0, lineStart) + action.prefix + value.slice(lineStart);
    cursorPos = selectionStart + action.prefix.length;
  } else {
    const suffix = action.suffix ?? "";
    if (selected) {
      newText = value.slice(0, selectionStart) + action.prefix + selected + suffix + value.slice(selectionEnd);
      cursorPos = selectionEnd + action.prefix.length + suffix.length;
    } else {
      newText = value.slice(0, selectionStart) + action.prefix + suffix + value.slice(selectionEnd);
      cursorPos = selectionStart + action.prefix.length;
    }
  }

  setText(newText);
  // Restore cursor after React re-render
  requestAnimationFrame(() => {
    textarea.selectionStart = cursorPos;
    textarea.selectionEnd = cursorPos;
    textarea.focus();
  });
}

const GOAL_TEMPLATE = `# Project Goal

## Overview
Describe what you want to build at a high level.

## Key Features
- Feature 1
- Feature 2
- Feature 3

## Technical Constraints
- Any specific technologies, frameworks, or requirements

## Success Criteria
- What does "done" look like?
`;

export function LoopStartPanel({ projectDir, isRunning, onStart }: LoopStartPanelProps) {
  const [goalPath, setGoalPath] = useState("");
  const [maxCycles, setMaxCycles] = useState("");
  const [maxBudget, setMaxBudget] = useState("");
  const [autoClarification, setAutoClarification] = useState(false);
  const [goalDetected, setGoalDetected] = useState(false);
  const [goalContent, setGoalContent] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-detect GOAL.md in project root
  useEffect(() => {
    const defaultPath = `${projectDir}/GOAL.md`;
    projectService.readFile(defaultPath).then((content) => {
      if (content !== null) {
        setGoalPath(defaultPath);
        setGoalDetected(true);
        setGoalContent(content);
        setShowEditor(false);
      } else {
        setGoalDetected(false);
        setGoalPath("");
        setGoalContent(GOAL_TEMPLATE);
        setShowEditor(true);
      }
    });
  }, [projectDir]);

  const handleSaveGoal = useCallback(async () => {
    const filePath = `${projectDir}/GOAL.md`;
    setSaving(true);
    const ok = await projectService.writeFile(filePath, goalContent);
    setSaving(false);
    if (ok) {
      setGoalPath(filePath);
      setGoalDetected(true);
    }
  }, [projectDir, goalContent]);

  const handleToolbarAction = useCallback((action: ToolbarAction) => {
    if (!textareaRef.current) return;
    applyToolbarAction(textareaRef.current, action, setGoalContent);
  }, []);

  const canStart = !isRunning && goalPath.trim().length > 0;

  const handleStart = () => {
    if (!canStart) return;
    onStart({
      descriptionFile: goalPath.trim() || undefined,
      maxLoopCycles: maxCycles ? parseInt(maxCycles, 10) : undefined,
      maxBudgetUsd: maxBudget ? parseFloat(maxBudget) : undefined,
      autoClarification: autoClarification || undefined,
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h2 style={{
        fontSize: "1.1rem",
        fontWeight: 600,
        color: "var(--foreground)",
        marginBottom: 16,
      }}>
        Autonomous Loop
      </h2>

      <p style={{
        fontSize: "0.82rem",
        color: "var(--foreground-muted)",
        marginBottom: 20,
        lineHeight: 1.5,
      }}>
        Provide a GOAL.md describing what you want to build. Dex will conduct an
        interactive clarification session, produce a refined plan (GOAL_clarified.md),
        then autonomously implement each feature in cycles.
      </p>

      {/* GOAL.md section */}
      {showEditor ? (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}>
            <label style={{
              fontSize: "0.78rem",
              fontWeight: 500,
              color: "var(--foreground-muted)",
            }}>
              GOAL.md — describe your project
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
          <div style={{
            display: "flex",
            gap: 2,
            padding: "4px 6px",
            borderRadius: "var(--radius) var(--radius) 0 0",
            border: "1px solid var(--border)",
            borderBottom: "none",
            background: "var(--surface)",
          }}>
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
                const newVal = goalContent.slice(0, selectionStart) + "  " + goalContent.slice(selectionEnd);
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
              onClick={handleSaveGoal}
              disabled={saving || !goalContent.trim()}
              style={{
                padding: "6px 14px",
                borderRadius: "var(--radius)",
                fontSize: "0.8rem",
                fontWeight: 600,
                background: goalContent.trim() && !saving ? "var(--primary)" : "var(--surface-elevated)",
                color: goalContent.trim() && !saving ? "#fff" : "var(--foreground-disabled)",
                border: "none",
                cursor: goalContent.trim() && !saving ? "pointer" : "not-allowed",
              }}
            >
              {saving ? "Saving..." : goalDetected ? "Update GOAL.md" : "Save GOAL.md"}
            </button>
            {goalDetected && (
              <span style={{ fontSize: "0.72rem", color: "var(--status-success)", display: "flex", alignItems: "center", gap: 3 }}>
                <FileText size={10} />
                Saved to {goalPath}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: "0.78rem",
            fontWeight: 500,
            color: "var(--foreground-muted)",
            marginBottom: 6,
          }}>
            GOAL.md Path
            {goalDetected && (
              <span style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: "0.7rem",
                color: "var(--status-success)",
                fontWeight: 400,
              }}>
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
              onClick={() => {
                setShowEditor(true);
                if (!goalContent && goalPath) {
                  projectService.readFile(goalPath).then((c) => {
                    if (c) setGoalContent(c);
                  });
                }
              }}
              style={{
                padding: "6px 10px",
                borderRadius: "var(--radius)",
                fontSize: "0.78rem",
                fontWeight: 500,
                background: "var(--surface-elevated)",
                color: "var(--foreground-muted)",
                border: "1px solid var(--border)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Edit
            </button>
          </div>
        </div>
      )}

      {/* Budget controls */}
      <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
        <div style={{ flex: 1 }}>
          <label style={{
            display: "block",
            fontSize: "0.78rem",
            fontWeight: 500,
            color: "var(--foreground-muted)",
            marginBottom: 6,
          }}>
            Max Cycles
          </label>
          <input
            type="number"
            min="1"
            value={maxCycles}
            onChange={(e) => setMaxCycles(e.target.value)}
            placeholder="unlimited"
            disabled={isRunning}
            style={{
              width: "100%",
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
        </div>
        <div style={{ flex: 1 }}>
          <label style={{
            display: "block",
            fontSize: "0.78rem",
            fontWeight: 500,
            color: "var(--foreground-muted)",
            marginBottom: 6,
          }}>
            Max Budget (USD)
          </label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={maxBudget}
            onChange={(e) => setMaxBudget(e.target.value)}
            placeholder="unlimited"
            disabled={isRunning}
            style={{
              width: "100%",
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
        </div>
      </div>

      {/* Auto clarification toggle */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 24,
        padding: "10px 12px",
        borderRadius: "var(--radius)",
        border: "1px solid var(--border)",
        background: "var(--surface-elevated)",
      }}>
        <button
          onClick={() => setAutoClarification((v) => !v)}
          disabled={isRunning}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: "none",
            background: autoClarification ? "var(--primary)" : "var(--border)",
            cursor: isRunning ? "not-allowed" : "pointer",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
        >
          <span style={{
            position: "absolute",
            top: 2,
            left: autoClarification ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.2s",
          }} />
        </button>
        <div>
          <div style={{
            fontSize: "0.8rem",
            fontWeight: 500,
            color: "var(--foreground)",
          }}>
            Automatic Clarification
          </div>
          <div style={{
            fontSize: "0.72rem",
            color: "var(--foreground-dim)",
            marginTop: 2,
          }}>
            Skip interactive Q&A — agent auto-selects recommended options based on GOAL.md context
          </div>
        </div>
      </div>

      {/* Start button */}
      <button
        onClick={handleStart}
        disabled={!canStart}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          width: "100%",
          padding: "10px 16px",
          borderRadius: "var(--radius)",
          fontSize: "0.88rem",
          fontWeight: 600,
          background: canStart ? "var(--primary)" : "var(--surface-elevated)",
          color: canStart ? "#fff" : "var(--foreground-disabled)",
          cursor: canStart ? "pointer" : "not-allowed",
          border: "none",
          transition: "background 0.15s",
        }}
      >
        <Play size={14} />
        Start Autonomous Loop
      </button>
    </div>
  );
}
