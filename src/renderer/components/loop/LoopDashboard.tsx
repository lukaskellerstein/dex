import { useState, useEffect, useCallback, useMemo } from "react";
import { GitBranch } from "lucide-react";
import type { StepType, LoopTermination, PrerequisiteCheck } from "../../../core/types.js";
import type { UiLoopCycle, UiLoopStage, LatestAction } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { ProcessStepper } from "./ProcessStepper.js";
import { useTimeline } from "../checkpoints/hooks/useTimeline.js";
import { PrerequisitesPhase } from "./phases/PrerequisitesPhase.js";
import { ClarificationPhase } from "./phases/ClarificationPhase.js";
import { LoopPhase } from "./phases/LoopPhase.js";
import { CompletionPhase } from "./phases/CompletionPhase.js";
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
  projectDir: string | null;
  /** Latest "interesting" agent step in the running stage — used for the live indicator. */
  latestAction?: LatestAction | null;
}

const CLARIFICATION_STAGE_TYPES = [
  "clarification", "clarification_product", "clarification_technical",
  "clarification_synthesis", "constitution", "manifest_extraction",
];

function deriveActivePhase(
  isCheckingPrerequisites: boolean,
  isClarifying: boolean,
  preCycleStages: UiLoopStage[],
  cycles: UiLoopCycle[],
  loopTermination: LoopTermination | null,
  isRunning: boolean
): MacroPhase {
  // Only advance to "completion" for genuine termination — not user aborts or budget stops
  if (loopTermination && !isRunning && loopTermination.reason === "gaps_complete") return "completion";
  const prerequisitesStage = preCycleStages.find((s) => s.type === "prerequisites");
  if (isCheckingPrerequisites || (prerequisitesStage?.status === "running")) return "prerequisites";
  if (!prerequisitesStage && isRunning && preCycleStages.length === 0) return "prerequisites";
  const anyClarificationRunning = preCycleStages.some(
    (s) => CLARIFICATION_STAGE_TYPES.includes(s.type) && s.status === "running"
  );
  if (isClarifying || anyClarificationRunning) return "clarification";
  if (cycles.length > 0) return "loop";
  const clarificationStages = preCycleStages.filter(
    (s) => CLARIFICATION_STAGE_TYPES.includes(s.type)
  );
  const anyClarificationDone = clarificationStages.some((s) => s.status === "completed");
  // All 5 expected stages must be completed to advance past clarification:
  // clarification_product, clarification_technical, clarification_synthesis,
  // constitution, manifest_extraction
  const allClarificationDone = clarificationStages.length >= 5
    && clarificationStages.every((s) => s.status === "completed");
  if (allClarificationDone && !isClarifying) return "loop";
  // Some done but not all — clarification is still active (paused mid-way)
  if (anyClarificationDone) return "clarification";
  if (prerequisitesStage?.status === "completed") return "clarification";
  return "prerequisites";
}

function derivePhaseStatus(
  phase: MacroPhase,
  activePhase: MacroPhase,
): PhaseStatus {
  const order: MacroPhase[] = ["prerequisites", "clarification", "loop", "completion"];
  const activeIdx = order.indexOf(activePhase);
  const phaseIdx = order.indexOf(phase);
  if (phaseIdx < activeIdx) return "done";
  if (phaseIdx === activeIdx) return "active";
  return "pending";
}

// Merge a path-derived stage list with the orchestrator's. Same-typed stages
// from the orchestrator win (live status, agentRunId, real cost/duration).
function mergeStages(path: UiLoopStage[], orch: UiLoopStage[]): UiLoopStage[] {
  const byType = new Map<StepType, UiLoopStage>();
  for (const s of path) byType.set(s.type, s);
  for (const s of orch) byType.set(s.type, s);
  return [...byType.values()];
}

// Merge cycle arrays by cycleNumber. For overlapping cycles, the orchestrator
// supplies the live "shell" (status, featureName, decision) while the
// path-derived view backfills committed stages the orchestrator hasn't
// re-emitted in the current run (e.g. cycles already done before Resume).
function mergeCycles(path: UiLoopCycle[], orch: UiLoopCycle[]): UiLoopCycle[] {
  const byCycle = new Map<number, UiLoopCycle>();
  for (const c of path) byCycle.set(c.cycleNumber, c);
  for (const c of orch) {
    const existing = byCycle.get(c.cycleNumber);
    if (!existing) {
      byCycle.set(c.cycleNumber, c);
      continue;
    }
    // Path says "completed" (learnings commit present) → cycle is done. The
    // orchestrator's stale "running"/"stopped" from a prior interrupted run
    // must not override that, otherwise fully-done cycles render as paused.
    const status = existing.status === "completed" ? "completed" : c.status;
    byCycle.set(c.cycleNumber, {
      ...c,
      status,
      stages: mergeStages(existing.stages, c.stages),
      implementPhases:
        c.implementPhases.length > 0 ? c.implementPhases : existing.implementPhases,
    });
  }
  return [...byCycle.values()].sort((a, b) => a.cycleNumber - b.cycleNumber);
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
  projectDir,
  latestAction,
}: LoopDashboardProps) {
  // 010 — timeline snapshot drives the Steps tab projection: which cycles +
  // stages are "done" by virtue of having step-commits on the active path,
  // independent of which run useOrchestrator currently has loaded.
  const { snapshot } = useTimeline(projectDir);

  // Path-derived cycles + pre-cycle stages. When selectedPath is non-empty,
  // these REPLACE the orchestrator-supplied cycles/preCycleStages so the
  // Steps tab follows wherever HEAD is — not whichever run useOrchestrator
  // last cached. When selectedPath is empty (fresh project, HEAD on main with
  // no step-commits), we fall back to the orchestrator's view.
  //
  // Stages are inferred-completed up to the latest stage on the path —
  // some orchestrator stages (e.g. gap_analysis on lightweight projects)
  // don't always create a step-commit even when they run, so we'd otherwise
  // see weird "pending" gaps in the middle of a known-completed cycle.
  const pathDerived = useMemo(() => {
    const onPath = new Set(snapshot.selectedPath);
    const pathCommits = snapshot.commits.filter((c) => onPath.has(c.sha));
    const preCycle: UiLoopStage[] = [];
    const cyclesMap = new Map<number, UiLoopCycle>();
    const synth = (step: StepType, ts: string, key: string): UiLoopStage => ({
      type: step,
      status: "completed",
      agentRunId: key,
      costUsd: 0,
      durationMs: 0,
      startedAt: ts,
      completedAt: ts,
    });
    for (const c of pathCommits) {
      const stage = synth(c.step, c.timestamp, c.sha);
      if (c.cycleNumber === 0) {
        preCycle.push(stage);
      } else {
        let cyc = cyclesMap.get(c.cycleNumber);
        if (!cyc) {
          cyc = {
            cycleNumber: c.cycleNumber,
            featureName: null,
            specDir: null,
            decision: null,
            status: "running", // upgraded to "completed" below if learnings present
            costUsd: 0,
            stages: [],
            implementPhases: [],
            startedAt: c.timestamp,
          };
          cyclesMap.set(c.cycleNumber, cyc);
        }
        cyc.stages.push(stage);
        if (c.step === "learnings") cyc.status = "completed";
      }
    }

    // Fill in earlier stages in canonical order — if cycle N has any of
    // {plan, tasks, implement, verify, learnings} on path, then gap_analysis
    // / specify ran by definition, even if no step-commit was authored.
    const CYCLE_STAGE_ORDER: StepType[] = [
      "gap_analysis",
      "specify",
      "plan",
      "tasks",
      "implement",
      "implement_fix",
      "verify",
      "learnings",
    ];
    for (const cyc of cyclesMap.values()) {
      const present = new Set(cyc.stages.map((s) => s.type));
      let lastIdx = -1;
      for (let i = CYCLE_STAGE_ORDER.length - 1; i >= 0; i--) {
        if (present.has(CYCLE_STAGE_ORDER[i])) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx === -1) continue;
      // Inject synthetic completed stages for any earlier stage not present.
      const startedAt = cyc.startedAt;
      for (let i = 0; i < lastIdx; i++) {
        const st = CYCLE_STAGE_ORDER[i];
        if (!present.has(st)) {
          cyc.stages.unshift(synth(st, startedAt, `synth:${cyc.cycleNumber}:${st}`));
          present.add(st);
        }
      }
      // Re-sort cycle stages into canonical order.
      cyc.stages.sort(
        (a, b) => CYCLE_STAGE_ORDER.indexOf(a.type) - CYCLE_STAGE_ORDER.indexOf(b.type),
      );
    }

    const derivedCycles = [...cyclesMap.values()].sort((a, b) => a.cycleNumber - b.cycleNumber);
    return { preCycle, cycles: derivedCycles };
  }, [snapshot.selectedPath, snapshot.commits]);

  // Path + orchestrator views are merged when HEAD has step-commit history.
  // Path-derived covers stages already on HEAD's first-parent chain (committed
  // history); the orchestrator covers the in-flight stage of the active run
  // (status="running", per-stage agentRunIds, implementPhases). Merging both
  // — instead of switching between them — keeps the resumed run's prior
  // cycles visible across the gap between `run_started` (which clears
  // loopCycles) and the orchestrator's first `loop_cycle_started` for the
  // resumed cycle. Without the merge the dashboard briefly snaps to "no
  // cycles → Clarification phase" right after Resume. Orchestrator wins
  // per-stage where both have data so live status/agentRunIds aren't shadowed.
  const hasPath = snapshot.selectedPath.length > 0;
  const effectiveCycles = useMemo(
    () => (hasPath ? mergeCycles(pathDerived.cycles, cycles) : cycles),
    [hasPath, pathDerived.cycles, cycles],
  );
  const effectivePreCycleStages = useMemo(
    () => (hasPath ? mergeStages(pathDerived.preCycle, preCycleStages) : preCycleStages),
    [hasPath, pathDerived.preCycle, preCycleStages],
  );
  // Orchestrator's "current" pointers belong to its loaded run only — they
  // are meaningful when isRunning, otherwise they leak into navigated state.
  const effectiveCurrentStage = isRunning ? currentStage : null;
  // During resume warmup the orchestrator hasn't emitted `loop_cycle_started`
  // yet, so its `currentCycle` is null. Fall back to the most recent path-
  // derived cycle so the StageList can mark the about-to-resume stage as
  // paused instead of leaving every row plain "pending".
  const effectiveCurrentCycle = useMemo(() => {
    if (!isRunning) return null;
    if (currentCycle != null) return currentCycle;
    if (hasPath && pathDerived.cycles.length > 0) {
      return pathDerived.cycles[pathDerived.cycles.length - 1].cycleNumber;
    }
    return null;
  }, [isRunning, currentCycle, hasPath, pathDerived.cycles]);
  const effectiveIsRunning = isRunning;
  // Suppress `isClarifying` / `isCheckingPrerequisites` when path-derived data
  // shows the run is already past those phases. On resume from a navigated
  // mid-cycle commit, the orchestrator emits a brief `clarification_started`
  // (skip path in stages/clarification.ts:61) which would otherwise drag the
  // ProcessStepper back to the Clarification node despite Cycle 1+ commits
  // sitting on the active path. Same posture for prerequisites.
  const pathHasCycleWork = pathDerived.cycles.length > 0;
  const pathHasClarification = pathDerived.preCycle.length > 0;
  const effectiveIsClarifying = isRunning && !pathHasCycleWork ? isClarifying : false;
  const effectiveIsCheckingPrerequisites =
    isRunning && !pathHasCycleWork && !pathHasClarification ? isCheckingPrerequisites : false;

  const pathStagesByCycle = useMemo(() => {
    const m = new Map<number, Set<StepType>>();
    for (const c of effectiveCycles) {
      m.set(c.cycleNumber, new Set(c.stages.map((s) => s.type)));
    }
    return m;
  }, [effectiveCycles]);

  // Termination state belongs to the run that produced it. When the user
  // navigates to a historical commit (hasPath && !isRunning), it only still
  // applies if the current path actually reaches that run's terminated tip —
  // i.e. the path-derived view contains at least as many completed cycles as
  // the termination claims. Otherwise the Steps tab would falsely advertise
  // "All Features Implemented" while HEAD sits mid-cycle on a fork.
  const effectiveLoopTermination = useMemo(() => {
    if (!loopTermination) return null;
    if (!hasPath || isRunning) return loopTermination;
    const completed = pathDerived.cycles.filter((c) => c.status === "completed").length;
    return completed >= loopTermination.cyclesCompleted ? loopTermination : null;
  }, [hasPath, isRunning, loopTermination, pathDerived.cycles]);

  const activePhase = deriveActivePhase(
    effectiveIsCheckingPrerequisites,
    effectiveIsClarifying,
    effectivePreCycleStages,
    effectiveCycles,
    effectiveLoopTermination,
    effectiveIsRunning,
  );
  const [selectedPhase, setSelectedPhase] = useState<MacroPhase>(activePhase);

  useEffect(() => {
    setSelectedPhase(activePhase);
  }, [activePhase]);

  const prerequisitesStatus = derivePhaseStatus("prerequisites", activePhase);
  const clarificationStatus = derivePhaseStatus("clarification", activePhase);
  const loopStatus = derivePhaseStatus("loop", activePhase);
  const completionStatus = derivePhaseStatus("completion", activePhase);
  const finalCompletionStatus: PhaseStatus = effectiveLoopTermination?.reason === "gaps_complete" ? "done" : completionStatus;

  const handleSelect = useCallback((phase: MacroPhase) => {
    setSelectedPhase(phase);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {snapshot.currentBranch && (
        <div
          data-testid="steps-current-branch"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            background: "var(--surface)",
            borderBottom: "1px solid var(--border)",
            color: "var(--foreground-muted)",
            fontSize: "0.78rem",
            fontFamily: "var(--font-mono, monospace)",
          }}
          title="Current git branch"
        >
          <GitBranch size={12} />
          <span>{snapshot.currentBranch}</span>
        </div>
      )}
      <ProcessStepper
        activePhase={activePhase}
        selectedPhase={selectedPhase}
        prerequisitesStatus={prerequisitesStatus}
        clarificationStatus={clarificationStatus}
        loopStatus={loopStatus}
        completionStatus={finalCompletionStatus}
        isRunning={effectiveIsRunning}
        onSelect={handleSelect}
      />

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {selectedPhase === "prerequisites" && (
          <PrerequisitesPhase
            checks={prerequisitesChecks}
            isActive={activePhase === "prerequisites"}
            step={effectivePreCycleStages.find((s) => s.type === "prerequisites")}
          />
        )}

        {selectedPhase === "clarification" && (
          <ClarificationPhase
            preCycleStages={effectivePreCycleStages}
            isClarifying={effectiveIsClarifying}
            isRunning={effectiveIsRunning}
            onStageClick={onStageClick}
          />
        )}

        {selectedPhase === "loop" && (
          <LoopPhase
            cycles={effectiveCycles}
            currentCycle={effectiveCurrentCycle}
            currentStage={effectiveCurrentStage}
            isRunning={effectiveIsRunning}
            totalCost={totalCost}
            specSummaries={specSummaries}
            onStageClick={onStageClick}
            onImplPhaseClick={onImplPhaseClick}
            onSelectSpec={onSelectSpec}
            debugBadge={debugBadge}
            pathStagesByCycle={pathStagesByCycle}
            latestAction={latestAction}
          />
        )}

        {selectedPhase === "completion" && effectiveLoopTermination && (
          <CompletionPhase termination={effectiveLoopTermination} />
        )}

        {selectedPhase === "completion" && !effectiveLoopTermination && (
          <div style={{ textAlign: "center", paddingTop: 60, color: "var(--foreground-dim)", fontSize: "0.82rem" }}>
            Loop has not completed yet
          </div>
        )}
      </div>

    </div>
  );
}
