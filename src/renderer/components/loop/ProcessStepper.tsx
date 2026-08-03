import { Check, Flag, MessageCircleQuestion, Pause, RotateCw, Wrench } from "lucide-react";

type MacroPhase = "prerequisites" | "clarification" | "loop" | "completion";
type PhaseStatus = "pending" | "active" | "done";

export interface ProcessStepperProps {
  activePhase: MacroPhase;
  selectedPhase: MacroPhase;
  prerequisitesStatus: PhaseStatus;
  clarificationStatus: PhaseStatus;
  loopStatus: PhaseStatus;
  completionStatus: PhaseStatus;
  isRunning: boolean;
  onSelect: (phase: MacroPhase) => void;
}

const STEPS: { phase: MacroPhase; label: string }[] = [
  { phase: "prerequisites", label: "Prerequisites" },
  { phase: "clarification", label: "Clarification" },
  { phase: "loop", label: "Dex Loop" },
  { phase: "completion", label: "Completion" },
];

function getIcon(phase: MacroPhase, status: PhaseStatus, isPaused: boolean) {
  if (status === "done") return <Check size={18} strokeWidth={2.5} />;
  if (status === "active" && isPaused) return <Pause size={18} fill="currentColor" />;
  switch (phase) {
    case "prerequisites":
      return <Wrench size={18} />;
    case "clarification":
      return <MessageCircleQuestion size={18} />;
    case "loop":
      return <RotateCw size={18} />;
    case "completion":
      return <Flag size={18} />;
  }
}

function getStatusForPhase(phase: MacroPhase, props: ProcessStepperProps): PhaseStatus {
  switch (phase) {
    case "prerequisites":
      return props.prerequisitesStatus;
    case "clarification":
      return props.clarificationStatus;
    case "loop":
      return props.loopStatus;
    case "completion":
      return props.completionStatus;
  }
}

// Colors: teal for active, green for done, yellow for paused, muted for pending
const CIRCLE_STYLES: Record<
  string,
  {
    bg: string;
    border: string;
    color: string;
    shadow: string;
  }
> = {
  done: {
    bg: "var(--status-success)",
    border: "var(--status-success)",
    color: "#fff",
    shadow: "none",
  },
  active: {
    bg: "color-mix(in srgb, var(--status-info) 15%, var(--surface-elevated))",
    border: "var(--status-info)",
    color: "var(--status-info)",
    shadow: "0 0 0 4px color-mix(in srgb, var(--status-info) 12%, transparent)",
  },
  paused: {
    bg: "color-mix(in srgb, var(--status-warning, #f59e0b) 15%, var(--surface-elevated))",
    border: "var(--status-warning, #f59e0b)",
    color: "var(--status-warning, #f59e0b)",
    shadow: "0 0 0 4px color-mix(in srgb, var(--status-warning, #f59e0b) 12%, transparent)",
  },
  pending: {
    bg: "var(--surface-elevated)",
    border: "var(--border-bright)",
    color: "var(--foreground-dim)",
    shadow: "none",
  },
};

export function ProcessStepper(props: ProcessStepperProps) {
  const { selectedPhase, isRunning, onSelect } = props;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "18px 24px 14px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {STEPS.map((step, i) => {
        const status = getStatusForPhase(step.phase, props);
        const isPaused = status === "active" && !isRunning;
        const isSelected = selectedPhase === step.phase;
        const isClickable = status !== "pending";
        const styles = CIRCLE_STYLES[isPaused ? "paused" : status];

        // Line between steps: filled if the next step is done or active
        const nextStatus =
          i < STEPS.length - 1 ? getStatusForPhase(STEPS[i + 1].phase, props) : null;
        const lineFilled = nextStatus === "done" || nextStatus === "active";

        return (
          <div key={step.phase} style={{ display: "flex", alignItems: "center" }}>
            {/* Step */}
            <button
              onClick={() => isClickable && onSelect(step.phase)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 8,
                padding: 0,
                background: "transparent",
                border: "none",
                cursor: isClickable ? "pointer" : "default",
                opacity: status === "pending" ? 0.5 : 1,
                transition: "opacity 0.2s",
                minWidth: 90,
              }}
            >
              {/* Circle with icon */}
              <div
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: styles.bg,
                  border: `2px solid ${styles.border}`,
                  color: styles.color,
                  boxShadow: styles.shadow,
                  transition: "all 0.25s",
                  position: "relative",
                }}
              >
                {getIcon(step.phase, status, isPaused)}
                {/* Active pulse ring — only when actively running */}
                {status === "active" && isRunning && (
                  <div
                    style={{
                      position: "absolute",
                      inset: -4,
                      borderRadius: "50%",
                      border: "2px solid var(--status-info)",
                      opacity: 0.3,
                      animation: "pulse-ring 2s ease-out infinite",
                    }}
                  />
                )}
              </div>

              {/* Label */}
              <span
                style={{
                  fontSize: "0.72rem",
                  fontWeight: isSelected ? 600 : 400,
                  color:
                    status === "done"
                      ? "var(--status-success)"
                      : isPaused
                        ? "var(--status-warning, #f59e0b)"
                        : status === "active"
                          ? "var(--foreground)"
                          : "var(--foreground-dim)",
                  letterSpacing: "0.01em",
                  transition: "color 0.2s",
                }}
              >
                {step.label}
              </span>
            </button>

            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                style={{
                  width: 60,
                  height: 3,
                  borderRadius: 2,
                  background: lineFilled ? "var(--status-success)" : "var(--border-bright)",
                  margin: "0 4px",
                  marginBottom: 22, // align with circle center, not label
                  transition: "background 0.3s",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
