import { Clock, DollarSign } from "lucide-react";
import type { StepType } from "../../../../core/types.js";
import type { LatestAction, UiLoopCycle, UiLoopStage } from "../../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../../hooks/useProject.js";
import type { QueueProgress } from "../../../hooks/useRunSnapshot.js";
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
  latestAction?: LatestAction | null;
  /** The queue's entry counts; null without a queue (the counts then come from the cycles seen). */
  progress?: QueueProgress | null;
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
  latestAction,
  progress = null,
}: LoopPhaseProps) {
  const done = progress?.done ?? cycles.filter((c) => c.status === "completed").length;
  const total = progress?.total ?? cycles.length;
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
        {total > 0 && (
          <span data-testid="loop-cycle-count" style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <Clock size={10} />
            {done}/{total} cycles
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
          latestAction={latestAction}
          upcoming={progress?.pending}
        />
      </div>
    </div>
  );
}
