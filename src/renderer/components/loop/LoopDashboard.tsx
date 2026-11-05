import { useCallback, useEffect, useState } from "react";
import type { RunSnapshot } from "../../../core/run-snapshot.js";
import type { LoopTermination, PrerequisiteCheck, StepType } from "../../../core/types.js";
import type { LatestAction, UiLoopCycle, UiLoopStage } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { queueProgress } from "../../hooks/useRunSnapshot.js";
import { QueuePanel } from "../queue/QueuePanel.js";
import { ProcessStepper } from "./ProcessStepper.js";
import { ClarificationPhase } from "./phases/ClarificationPhase.js";
import { CompletionPhase } from "./phases/CompletionPhase.js";
import { LoopPhase } from "./phases/LoopPhase.js";
import { PrerequisitesPhase } from "./phases/PrerequisitesPhase.js";

type MacroPhase = "prerequisites" | "clarification" | "loop" | "completion";
type PhaseStatus = "pending" | "active" | "done";

export interface LoopDashboardProps {
  cycles: UiLoopCycle[];
  preCycleStages: UiLoopStage[];
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  currentCycle: number | null;
  currentStage: StepType | null;
  isClarifying: boolean;
  isRunning: boolean;
  totalCost: number;
  loopTermination: LoopTermination | null;
  specSummaries: SpecSummary[];
  onStageClick: (step: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  debugBadge?: React.ReactNode;
  /** Latest "interesting" agent step in the running stage — used for the live indicator. */
  latestAction?: LatestAction | null;
  /** The queue view from the files; the queue panel shows it as it is. */
  snapshot?: RunSnapshot | null;
  /** The open project; the queue panel opens its digests (016). */
  projectDir?: string | null;
}

const CLARIFICATION_STAGE_TYPES = [
  "clarification",
  "clarification_product",
  "clarification_technical",
  "clarification_synthesis",
  "constitution",
  "manifest_extraction",
];

function deriveActivePhase(
  isCheckingPrerequisites: boolean,
  isClarifying: boolean,
  preCycleStages: UiLoopStage[],
  cycles: UiLoopCycle[],
  loopTermination: LoopTermination | null,
  isRunning: boolean,
): MacroPhase {
  // Only advance to "completion" for genuine termination — not user aborts or budget stops
  if (loopTermination && !isRunning && loopTermination.reason === "queue_complete")
    return "completion";
  const prerequisitesStage = preCycleStages.find((s) => s.type === "prerequisites");
  if (isCheckingPrerequisites || prerequisitesStage?.status === "running") return "prerequisites";
  if (!prerequisitesStage && isRunning && preCycleStages.length === 0) return "prerequisites";
  const anyClarificationRunning = preCycleStages.some(
    (s) => CLARIFICATION_STAGE_TYPES.includes(s.type) && s.status === "running",
  );
  if (isClarifying || anyClarificationRunning) return "clarification";
  if (cycles.length > 0) return "loop";
  const clarificationStages = preCycleStages.filter((s) =>
    CLARIFICATION_STAGE_TYPES.includes(s.type),
  );
  const anyClarificationDone = clarificationStages.some((s) => s.status === "completed");
  // All 5 expected stages must be completed to advance past clarification:
  // clarification_product, clarification_technical, clarification_synthesis,
  // constitution, manifest_extraction
  const allClarificationDone =
    clarificationStages.length >= 5 && clarificationStages.every((s) => s.status === "completed");
  if (allClarificationDone && !isClarifying) return "loop";
  // Some done but not all — clarification is still active (paused mid-way)
  if (anyClarificationDone) return "clarification";
  if (prerequisitesStage?.status === "completed") return "clarification";
  return "prerequisites";
}

function derivePhaseStatus(phase: MacroPhase, activePhase: MacroPhase): PhaseStatus {
  const order: MacroPhase[] = ["prerequisites", "clarification", "loop", "completion"];
  const activeIdx = order.indexOf(activePhase);
  const phaseIdx = order.indexOf(phase);
  if (phaseIdx < activeIdx) return "done";
  if (phaseIdx === activeIdx) return "active";
  return "pending";
}

// ── Main Dashboard ──

export function LoopDashboard({
  cycles,
  preCycleStages,
  prerequisitesChecks,
  isCheckingPrerequisites,
  currentCycle,
  currentStage,
  isClarifying,
  isRunning,
  totalCost,
  loopTermination,
  specSummaries,
  onStageClick,
  onImplPhaseClick,
  onSelectSpec,
  debugBadge,
  latestAction,
  snapshot = null,
  projectDir = null,
}: LoopDashboardProps) {
  // Orchestrator "current" pointers belong to the live run only.
  const liveStage = isRunning ? currentStage : null;
  const liveCycle = isRunning ? currentCycle : null;

  const activePhase = deriveActivePhase(
    isCheckingPrerequisites,
    isClarifying,
    preCycleStages,
    cycles,
    loopTermination,
    isRunning,
  );
  const [selectedPhase, setSelectedPhase] = useState<MacroPhase>(activePhase);

  useEffect(() => {
    setSelectedPhase(activePhase);
  }, [activePhase]);

  const prerequisitesStatus = derivePhaseStatus("prerequisites", activePhase);
  const clarificationStatus = derivePhaseStatus("clarification", activePhase);
  const loopStatus = derivePhaseStatus("loop", activePhase);
  const completionStatus = derivePhaseStatus("completion", activePhase);
  const finalCompletionStatus: PhaseStatus =
    loopTermination?.reason === "queue_complete" ? "done" : completionStatus;

  const handleSelect = useCallback((phase: MacroPhase) => {
    setSelectedPhase(phase);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ProcessStepper
        activePhase={activePhase}
        selectedPhase={selectedPhase}
        prerequisitesStatus={prerequisitesStatus}
        clarificationStatus={clarificationStatus}
        loopStatus={loopStatus}
        completionStatus={finalCompletionStatus}
        isRunning={isRunning}
        onSelect={handleSelect}
      />

      <QueuePanel snapshot={snapshot} projectDir={projectDir} />

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {selectedPhase === "prerequisites" && (
          <PrerequisitesPhase
            checks={prerequisitesChecks}
            isActive={activePhase === "prerequisites"}
            step={preCycleStages.find((s) => s.type === "prerequisites")}
          />
        )}

        {selectedPhase === "clarification" && (
          <ClarificationPhase
            preCycleStages={preCycleStages}
            isClarifying={isClarifying}
            isRunning={isRunning}
            onStageClick={onStageClick}
          />
        )}

        {selectedPhase === "loop" && (
          <LoopPhase
            cycles={cycles}
            currentCycle={liveCycle}
            currentStage={liveStage}
            isRunning={isRunning}
            totalCost={totalCost}
            specSummaries={specSummaries}
            onStageClick={onStageClick}
            onImplPhaseClick={onImplPhaseClick}
            onSelectSpec={onSelectSpec}
            debugBadge={debugBadge}
            latestAction={latestAction}
            progress={queueProgress(snapshot)}
          />
        )}

        {selectedPhase === "completion" && loopTermination && (
          <CompletionPhase termination={loopTermination} />
        )}

        {selectedPhase === "completion" && !loopTermination && (
          <div
            style={{
              textAlign: "center",
              paddingTop: 60,
              color: "var(--foreground-dim)",
              fontSize: "0.82rem",
            }}
          >
            Loop has not completed yet
          </div>
        )}
      </div>
    </div>
  );
}
