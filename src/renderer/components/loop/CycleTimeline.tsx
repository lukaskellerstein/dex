import { useState, useCallback } from "react";
import { CheckCircle, ChevronDown, ChevronRight, Circle, DollarSign, SkipForward, Loader, Pause } from "lucide-react";
import type { StepType } from "../../../core/types.js";
import type { UiLoopCycle, UiLoopStage, LatestAction } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { StageList } from "./StageList.js";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function CycleTimelineItem({
  cycle,
  isActive,
  currentStage,
  isExpanded,
  isRunning,
  onToggle,
  onStageClick,
  onImplPhaseClick,
  onSelectSpec,
  specSummaries,
  isLast,
  pathStages,
  latestAction,
}: {
  cycle: UiLoopCycle;
  isActive: boolean;
  currentStage: StepType | null;
  isExpanded: boolean;
  isRunning: boolean;
  isLast: boolean;
  onToggle: () => void;
  onStageClick: (step: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  specSummaries: SpecSummary[];
  pathStages?: ReadonlySet<StepType>;
  latestAction?: LatestAction | null;
}) {
  const isCycleRunning = cycle.status === "running" && isRunning;
  // "paused" = cycle was mid-flight when the run was stopped. In the DB it may
  // appear as either "running" (never updated due to crash) or "stopped" (clean stop).
  // When the loop isn't running, both states mean the user can resume it.
  const isCyclePaused =
    (cycle.status === "running" && !isRunning) ||
    (cycle.status === "stopped" && !isRunning);
  const isCompleted = cycle.status === "completed";
  const isFailed = cycle.status === "failed";
  const isSkipped = cycle.status === "skipped";

  const totalDuration = cycle.stages.reduce((sum, s) => sum + s.durationMs, 0)
    + cycle.implementPhases.reduce((sum, ip) => sum + ip.durationMs, 0);

  return (
    <div style={{ display: "flex", gap: 0 }}>
      {/* Timeline dot and line */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: 36,
        flexShrink: 0,
      }}>
        {/* Dot — centered in a box matching the header button height (6px padding top/bottom + ~18px content ≈ 30px) */}
        <div style={{
          height: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}>
          {isCycleRunning ? (
            <div style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--status-info) 12%, var(--surface-elevated))",
              border: "2.5px solid var(--status-info)",
              boxShadow: "0 0 0 4px color-mix(in srgb, var(--status-info) 10%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              position: "relative",
            }}>
              <Loader size={11} style={{ color: "var(--status-info)", animation: "spin 1.5s linear infinite" }} />
              <div style={{
                position: "absolute",
                inset: -5,
                borderRadius: "50%",
                border: "2px solid var(--status-info)",
                opacity: 0.2,
                animation: "pulse-ring 2s ease-out infinite",
              }} />
            </div>
          ) : isCyclePaused ? (
            <div style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--status-warning, #f59e0b) 15%, var(--surface-elevated))",
              border: "2px solid var(--status-warning, #f59e0b)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}>
              <Pause size={10} fill="var(--status-warning, #f59e0b)" style={{ color: "var(--status-warning, #f59e0b)" }} />
            </div>
          ) : isFailed ? (
            <div style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--status-error) 15%, var(--surface-elevated))",
              border: "2px solid var(--status-error)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              color: "var(--status-error)",
            }}>
              <Circle size={10} fill="currentColor" />
            </div>
          ) : (
            <div style={{
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: isCompleted
                ? "var(--status-success)"
                : isSkipped
                  ? "var(--foreground-dim)"
                  : "var(--border)",
              flexShrink: 0,
            }} />
          )}
        </div>
        {/* Line down */}
        <div style={{
          width: 2,
          flex: 1,
          background: isCompleted ? "var(--status-success)" : isFailed ? "var(--status-error)" : isCyclePaused ? "var(--status-warning, #f59e0b)" : "var(--border)",
          ...(isLast && !isCompleted && !isCyclePaused && !isFailed ? {
            background: "none",
            backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0px, var(--border) 4px, transparent 4px, transparent 8px)`,
          } : {}),
        }} />
      </div>

      {/* Cycle content */}
      <div style={{ flex: 1, paddingBottom: 12 }}>
        {/* Header — always visible, clickable to toggle */}
        <button
          onClick={onToggle}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            borderRadius: "var(--radius)",
            background: isActive && isCycleRunning
              ? "color-mix(in srgb, var(--status-info) 6%, var(--surface-elevated))"
              : isCyclePaused
                ? "color-mix(in srgb, var(--status-warning, #f59e0b) 6%, var(--surface-elevated))"
                : isFailed
                  ? "color-mix(in srgb, var(--status-error) 6%, var(--surface-elevated))"
                  : "var(--surface-elevated)",
            border: isActive && isCycleRunning
              ? "1px solid var(--status-info)"
              : isCyclePaused
                ? "1px solid var(--status-warning, #f59e0b)"
                : isFailed
                  ? "1px solid var(--status-error)"
                  : "1px solid var(--border)",
            cursor: "pointer",
            transition: "background 0.15s, border-color 0.15s",
            textAlign: "left",
          }}
          onMouseEnter={(e) => {
            if (!isActive) e.currentTarget.style.borderColor = "color-mix(in srgb, var(--status-info) 50%, var(--border))";
          }}
          onMouseLeave={(e) => {
            if (!isActive) e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          {/* Expand/collapse chevron */}
          {isExpanded
            ? <ChevronDown size={12} style={{ color: "var(--foreground-dim)", flexShrink: 0 }} />
            : <ChevronRight size={12} style={{ color: "var(--foreground-dim)", flexShrink: 0 }} />}

          {/* Cycle number */}
          <span style={{
            fontSize: "0.78rem",
            fontWeight: 600,
            color: "var(--foreground)",
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
          }}>
            Cycle {cycle.cycleNumber}
          </span>

          {/* Status icon */}
          {isCompleted && (
            <CheckCircle size={11} style={{ color: "var(--status-success)", flexShrink: 0 }} />
          )}
          {isSkipped && (
            <SkipForward size={11} style={{ color: "var(--foreground-dim)", flexShrink: 0 }} />
          )}

          {/* Feature name */}
          {cycle.featureName && (
            <span style={{
              fontSize: "0.74rem",
              color: "var(--foreground-muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}>
              {cycle.featureName}
            </span>
          )}
          {!cycle.featureName && <span style={{ flex: 1 }} />}

          {/* Decision badge */}
          {cycle.decision && isCompleted && (
            <span style={{
              fontSize: "0.62rem",
              padding: "1px 5px",
              borderRadius: "var(--radius)",
              background: cycle.decision === "GAPS_COMPLETE"
                ? "color-mix(in srgb, var(--status-success) 15%, transparent)"
                : "var(--surface)",
              color: cycle.decision === "GAPS_COMPLETE"
                ? "var(--status-success)"
                : "var(--foreground-dim)",
              flexShrink: 0,
              textTransform: "lowercase",
            }}>
              {cycle.decision.replace(/_/g, " ")}
            </span>
          )}

          {/* Cost + Duration */}
          {(cycle.costUsd > 0 || totalDuration > 0) && (
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: "0.68rem",
              fontFamily: "var(--font-mono)",
              color: "var(--foreground-dim)",
              flexShrink: 0,
            }}>
              {cycle.costUsd > 0 && (
                <span style={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <DollarSign size={9} />
                  {cycle.costUsd.toFixed(2)}
                </span>
              )}
              {totalDuration > 0 && <span>{formatDuration(totalDuration)}</span>}
            </div>
          )}
        </button>

        {/* Expanded step list */}
        {isExpanded && (
          <StageList
            stages={cycle.stages}
            implementPhases={cycle.implementPhases}
            currentStage={isActive ? currentStage : null}
            isActiveCycle={isActive}
            isRunning={isRunning}
            isPausedCycle={!isRunning && cycle.status === "running"}
            decision={cycle.decision}
            specSummary={specSummaries.find((s) => cycle.specDir && (s.name === cycle.specDir || cycle.specDir.endsWith(`/${s.name}`) || s.name.endsWith(`/${cycle.specDir}`)))}
            onStageClick={onStageClick}
            onImplPhaseClick={onImplPhaseClick}
            onSelectSpec={onSelectSpec}
            pathStages={pathStages}
            latestAction={isActive ? latestAction : null}
          />
        )}
      </div>
    </div>
  );
}

export interface CycleTimelineProps {
  cycles: UiLoopCycle[];
  currentCycle: number | null;
  currentStage: StepType | null;
  isRunning: boolean;
  specSummaries: SpecSummary[];
  onStageClick: (step: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  /** 010 — per-cycle map of stages whose step-commits live on the active path. */
  pathStagesByCycle?: ReadonlyMap<number, ReadonlySet<StepType>>;
  /** Latest "interesting" agent step in the running stage — used for the live indicator. */
  latestAction?: LatestAction | null;
}

export function CycleTimeline({
  cycles,
  currentCycle,
  currentStage,
  isRunning,
  specSummaries,
  onStageClick,
  onImplPhaseClick,
  onSelectSpec,
  pathStagesByCycle,
  latestAction,
}: CycleTimelineProps) {
  // Active cycle expanded by default, completed ones collapsed
  const [manualExpanded, setManualExpanded] = useState<Set<number>>(new Set());
  const [manualCollapsed, setManualCollapsed] = useState<Set<number>>(new Set());

  // When not running and no active cycle, auto-expand the last (paused) cycle
  const lastCycle = cycles.length > 0 ? cycles[cycles.length - 1].cycleNumber : null;
  const autoExpandCycle = currentCycle ?? (!isRunning ? lastCycle : null);

  const isExpanded = useCallback(
    (cycleNumber: number) => {
      if (manualExpanded.has(cycleNumber)) return true;
      if (manualCollapsed.has(cycleNumber)) return false;
      return cycleNumber === autoExpandCycle;
    },
    [manualExpanded, manualCollapsed, autoExpandCycle]
  );

  const handleToggle = useCallback((cycleNumber: number) => {
    const currentlyExpanded = isExpanded(cycleNumber);
    if (currentlyExpanded) {
      setManualExpanded((prev) => { const next = new Set(prev); next.delete(cycleNumber); return next; });
      setManualCollapsed((prev) => new Set(prev).add(cycleNumber));
    } else {
      setManualCollapsed((prev) => { const next = new Set(prev); next.delete(cycleNumber); return next; });
      setManualExpanded((prev) => new Set(prev).add(cycleNumber));
    }
  }, [isExpanded]);

  if (cycles.length === 0) {
    return (
      <div style={{
        textAlign: "center",
        padding: "24px 0",
        color: "var(--foreground-dim)",
        fontSize: "0.78rem",
        fontStyle: "italic",
      }}>
        {isRunning ? "Starting first cycle..." : "No cycles yet"}
      </div>
    );
  }

  // Show ghost skeletons when running or paused (loop isn't finished)
  const lastCycleNumber = cycles.length > 0 ? cycles[cycles.length - 1].cycleNumber : 0;
  const hasPausedCycle = !isRunning && cycles.some((c) => c.status === "running");
  const ghostCount = isRunning || hasPausedCycle ? 3 : 0;
  const ghostOpacities = [0.35, 0.2, 0.1];

  return (
    <div>
      {cycles.map((cycle, i) => (
        <CycleTimelineItem
          key={cycle.cycleNumber}
          cycle={cycle}
          isActive={currentCycle === cycle.cycleNumber}
          currentStage={currentStage}
          isExpanded={isExpanded(cycle.cycleNumber)}
          isRunning={isRunning}
          isLast={i === cycles.length - 1}
          onToggle={() => handleToggle(cycle.cycleNumber)}
          onStageClick={onStageClick}
          onImplPhaseClick={onImplPhaseClick}
          onSelectSpec={onSelectSpec}
          specSummaries={specSummaries}
          pathStages={pathStagesByCycle?.get(cycle.cycleNumber)}
          latestAction={currentCycle === cycle.cycleNumber ? latestAction : null}
        />
      ))}

      {/* Ghost skeleton cycles — visual hint at future iterations */}
      {Array.from({ length: ghostCount }, (_, i) => (
        <div key={`ghost-${i}`} style={{
          display: "flex",
          gap: 0,
          opacity: ghostOpacities[i],
          animation: "ghost-breathe 3s ease-in-out infinite",
          animationDelay: `${i * 0.4}s`,
        }}>
          {/* Timeline dot and dashed line */}
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: 36,
            flexShrink: 0,
            paddingTop: 12,
          }}>
            <div style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: "none",
              border: "1.5px dashed var(--border-bright)",
              flexShrink: 0,
            }} />
            {i < ghostCount - 1 && (
              <div style={{
                width: 0,
                flex: 1,
                borderLeft: "1.5px dashed var(--border)",
                marginTop: 4,
              }} />
            )}
          </div>

          {/* Skeleton bar */}
          <div style={{ flex: 1, paddingBottom: 12 }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 10px",
              borderRadius: "var(--radius)",
              background: "var(--surface-elevated)",
              border: "1px dashed var(--border)",
            }}>
              <div style={{
                width: 12,
                height: 12,
                borderRadius: 2,
                background: "var(--border)",
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: "0.78rem",
                fontWeight: 600,
                color: "var(--foreground-dim)",
                fontFamily: "var(--font-mono)",
              }}>
                Cycle {lastCycleNumber + i + 1}
              </span>
              <span style={{ flex: 1 }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
