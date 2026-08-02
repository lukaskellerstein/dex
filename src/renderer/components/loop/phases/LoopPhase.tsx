import { Clock, DollarSign } from "lucide-react";
import type { StepType } from "../../../../core/types.js";
import type { LatestAction, UiLoopCycle, UiLoopStage } from "../../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../../hooks/useProject.js";
import { CycleTimeline } from "../CycleTimeline.js";

interface LoopPhaseProps {
  cycles: UiLoopCycle[];
  currentCycle: number | null;
  currentStage: StepType | null;
  isRunning: boolean;
  totalCost: number;
  specSummaries: SpecSummary[];
  onStageClick: (step: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  debugBadge?: React.ReactNode;
  pathStagesByCycle?: ReadonlyMap<number, ReadonlySet<StepType>>;
  latestAction?: LatestAction | null;
}

export function LoopPhase({
  cycles,
  currentCycle,
  currentStage,
  isRunning,
  totalCost,
  specSummaries,
  onStageClick,
  onImplPhaseClick,
  onSelectSpec,
  debugBadge,
  pathStagesByCycle,
  latestAction,
}: LoopPhaseProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.75rem",
          color: "var(--foreground-dim)",
        }}
      >
        {cycles.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <Clock size={10} />
            {cycles.filter((c) => c.status === "completed").length}/{cycles.length} cycles
          </span>
        )}
        {totalCost > 0 && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 2,
              fontFamily: "var(--font-mono)",
            }}
          >
            <DollarSign size={10} />
            {totalCost.toFixed(2)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {debugBadge}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "16px 24px" }}>
        <CycleTimeline
          cycles={cycles}
          currentCycle={currentCycle}
          currentStage={currentStage}
          isRunning={isRunning}
          specSummaries={specSummaries}
          onStageClick={onStageClick}
          onImplPhaseClick={onImplPhaseClick}
          onSelectSpec={onSelectSpec}
          pathStagesByCycle={pathStagesByCycle}
          latestAction={latestAction}
        />
      </div>
    </div>
  );
}
