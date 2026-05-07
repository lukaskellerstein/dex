/**
 * What: Container for the autonomous-loop start UI — composes LoopStartForm (goal-file editor + file picker) + Automatic Clarification toggle + Start button.
 * Not: Does not own form state — useLoopStartForm does. Does not start the run; calls onStart with the form values. Does not surface budget caps (max cycles / max budget) — they're not part of this UI any more.
 * Deps: useLoopStartForm, LoopStartForm, lucide-react Play icon.
 */
import { Play } from "lucide-react";
import { useLoopStartForm } from "../../hooks/useLoopStartForm.js";
import { LoopStartForm } from "./LoopStartForm.js";
import { cardSurface } from "../../styles/tokens.js";

interface LoopStartPanelProps {
  projectDir: string;
  isRunning: boolean;
  onStart: (config: {
    descriptionFile?: string;
    autoClarification?: boolean;
  }) => void;
}

export function LoopStartPanel({ projectDir, isRunning, onStart }: LoopStartPanelProps) {
  const form = useLoopStartForm(projectDir);
  const canStart = !isRunning && form.goalPath.trim().length > 0;

  const handleStart = () => {
    if (!canStart) return;
    onStart({
      descriptionFile: form.goalPath.trim() || undefined,
      autoClarification: form.autoClarification || undefined,
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h2
        style={{
          fontSize: "1.1rem",
          fontWeight: 600,
          color: "var(--foreground)",
          marginBottom: 16,
        }}
      >
        Autonomous Loop
      </h2>

      <p
        style={{
          fontSize: "0.82rem",
          color: "var(--foreground-muted)",
          marginBottom: 20,
          lineHeight: 1.5,
        }}
      >
        Provide a goal file describing what you want to build (defaults to <code>GOAL.md</code>).
        Dex will conduct an interactive clarification session, produce a refined plan, then
        autonomously implement each feature in cycles.
      </p>

      <LoopStartForm
        isRunning={isRunning}
        goalPath={form.goalPath}
        setGoalPath={form.setGoalPath}
        goalContent={form.goalContent}
        setGoalContent={form.setGoalContent}
        goalDetected={form.goalDetected}
        showEditor={form.showEditor}
        setShowEditor={form.setShowEditor}
        saving={form.saving}
        saveGoal={form.saveGoal}
        loadGoalFromPath={form.loadGoalFromPath}
        pickGoalFile={form.pickGoalFile}
      />

      {/* Auto clarification toggle */}
      <div
        style={{
          ...cardSurface,
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 24,
        }}
      >
        <button
          onClick={() => form.setAutoClarification((v: boolean) => !v)}
          disabled={isRunning}
          style={{
            width: 36,
            height: 20,
            borderRadius: 10,
            border: "none",
            background: form.autoClarification ? "var(--primary)" : "var(--border)",
            cursor: isRunning ? "not-allowed" : "pointer",
            position: "relative",
            transition: "background 0.2s",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: form.autoClarification ? 18 : 2,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 0.2s",
            }}
          />
        </button>
        <div>
          <div
            style={{
              fontSize: "0.8rem",
              fontWeight: 500,
              color: "var(--foreground)",
            }}
          >
            Automatic Clarification
          </div>
          <div
            style={{
              fontSize: "0.72rem",
              color: "var(--foreground-dim)",
              marginTop: 2,
            }}
          >
            Skip interactive Q&A — agent auto-selects recommended options based on the goal-file context
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
