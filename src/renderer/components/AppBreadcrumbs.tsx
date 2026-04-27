/**
 * What: Renders the trace-view breadcrumb (Loop / Cycle | Spec / TaskPhase) plus the centred live-loop indicator and the right-aligned debug badge.
 * Not: Does not own breadcrumb state; pulls everything from props. Does not render the trace itself — App composes both.
 * Deps: useOrchestrator types (UiLoopCycle), TaskPhase / StepType from core/types, lucide-react.
 */
import { RotateCw } from "lucide-react";
import type { TaskPhase, StepType } from "../../core/types.js";
import type { UiLoopCycle } from "../hooks/useOrchestrator.js";
import type { ReactNode } from "react";

export interface AppBreadcrumbsProps {
  mode: string | null;
  currentCycle: number | null;
  currentStage: StepType | null;
  loopCycles: UiLoopCycle[];
  selectedSpec: string | null;
  currentPhase: TaskPhase | null;
  isLiveTrace: boolean;
  isClarifying: boolean;
  totalCost: number;
  debugBadge: ReactNode;
  onLoopDashboardClick: () => void;
  onSpecClick: (spec: string) => void;
  onTasksClick: () => void;
}

export function AppBreadcrumbs({
  mode,
  currentCycle,
  currentStage,
  loopCycles,
  selectedSpec,
  currentPhase,
  isLiveTrace,
  isClarifying,
  totalCost,
  debugBadge,
  onLoopDashboardClick,
  onSpecClick,
  onTasksClick,
}: AppBreadcrumbsProps) {
  const stripSpecs = (s: string) => s.replace(/^specs\//, "");

  // Resolve the spec name for the middle crumb from: selected spec → current cycle → last cycle with a specDir.
  // Survives pause, which clears currentCycle via run_completed.
  const currentCycleObj = currentCycle != null ? loopCycles.find((c) => c.cycleNumber === currentCycle) : null;
  const fallbackCycle = [...loopCycles].reverse().find((c) => !!c.specDir);
  const specName =
    selectedSpec ??
    (currentCycleObj?.specDir ? stripSpecs(currentCycleObj.specDir) : null) ??
    (fallbackCycle?.specDir ? stripSpecs(fallbackCycle.specDir) : null);
  const cycleNumber = currentCycle ?? fallbackCycle?.cycleNumber ?? null;
  const midLabel = cycleNumber != null ? `Cycle ${cycleNumber}` : specName;

  return (
    <div
      style={{
        position: "relative",
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "color-mix(in srgb, var(--primary) 4%, var(--background))",
        fontSize: "0.82rem",
      }}
    >
      {mode === "loop" && (
        <>
          <span
            onClick={onLoopDashboardClick}
            style={{
              color: "var(--foreground-muted)",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-muted)";
            }}
          >
            Loop
          </span>
          <span style={{ color: "var(--foreground-dim)" }}>/</span>
          {midLabel && (
            <>
              <span
                onClick={() => {
                  if (specName) {
                    onSpecClick(specName);
                  } else {
                    onLoopDashboardClick();
                  }
                }}
                style={{
                  color: "var(--foreground-muted)",
                  cursor: "pointer",
                  transition: "color 0.15s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--primary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--foreground-muted)";
                }}
              >
                {midLabel}
              </span>
              <span style={{ color: "var(--foreground-dim)" }}>/</span>
            </>
          )}
        </>
      )}
      {mode !== "loop" && selectedSpec && (
        <>
          <span
            onClick={onTasksClick}
            style={{
              color: "var(--foreground-muted)",
              cursor: "pointer",
              transition: "color 0.15s",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--foreground-muted)";
            }}
          >
            {selectedSpec}
          </span>
          <span style={{ color: "var(--foreground-dim)" }}>/</span>
        </>
      )}
      {currentPhase && (
        <span style={{ fontWeight: 600, color: "var(--foreground)" }}>
          {currentPhase.name.startsWith("loop:")
            ? currentPhase.name.replace("loop:", "").replace("_", " ")
            : `TaskPhase ${currentPhase.number}: ${currentPhase.name}`}
        </span>
      )}
      {/* Center: loop indicators */}
      {isLiveTrace && mode === "loop" && (
        <span
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "0.75rem",
            color: "var(--foreground-muted)",
          }}
        >
          <RotateCw size={11} style={{ animation: "spin 2s linear infinite" }} />
          {isClarifying ? (
            <span style={{ color: "var(--primary)" }}>Clarifying...</span>
          ) : (
            <>
              {currentCycle != null && (
                <span>
                  Cycle{" "}
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--foreground)" }}>
                    {currentCycle}
                  </span>
                </span>
              )}
              {currentStage && (
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: "var(--radius)",
                    background: "var(--primary-muted)",
                    color: "var(--primary)",
                    fontWeight: 500,
                  }}
                >
                  {currentStage.replace("_", " ")}
                </span>
              )}
            </>
          )}
          {totalCost != null && totalCost > 0 && (
            <span style={{ fontFamily: "var(--font-mono)" }}>${totalCost.toFixed(2)}</span>
          )}
        </span>
      )}
      {/* Right: debug context badge */}
      <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>{debugBadge}</span>
    </div>
  );
}
