import { CheckCircle, Circle, Loader, Minus, Pause, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { StepType } from "../../../core/types.js";
import type { UiLoopStage, ImplementSubPhase } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { SpecCard } from "../project-overview/SpecCard.js";

const CYCLE_STAGES: StepType[] = [
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "implement",
  "verify",
  "learnings",
];

const STEP_LABELS: Record<StepType, string> = {
  prerequisites: "Prerequisites",
  create_branch: "Create Branch",
  clarification: "Clarification",
  clarification_product: "Clarification (Product)",
  clarification_technical: "Clarification (Technical)",
  clarification_synthesis: "Clarification (Synthesis)",
  constitution: "Constitution",
  manifest_extraction: "Manifest Extraction",
  gap_analysis: "Gap Analysis",
  specify: "Specify",
  plan: "Plan",
  tasks: "Tasks",
  implement: "Implement",
  implement_fix: "Implement Fix",
  verify: "Verify",
  learnings: "Learnings",
  commit: "Commit",
};

type StageStatus = "pending" | "running" | "completed" | "skipped" | "failed" | "paused";

function getStageVisibility(
  stageType: StepType,
  decision: string | null
): "show" | "skip" {
  if (!decision) return "show";
  switch (stageType) {
    case "specify":
      return decision === "NEXT_FEATURE" ? "show" : "skip";
    case "plan":
    case "tasks":
      return decision === "NEXT_FEATURE" || decision === "REPLAN_FEATURE"
        ? "show"
        : "skip";
    default:
      return "show";
  }
}

function deriveStageStatus(
  stageType: StepType,
  actual: UiLoopStage | undefined,
  currentStage: StepType | null,
  isActiveCycle: boolean,
  decision: string | null,
  hasVerifyOrLater: boolean,
  implementPhases: ImplementSubPhase[],
  isRunning: boolean,
  isPausedCycle: boolean
): StageStatus {
  // For implement, derive from currentStage and implementPhases
  if (stageType === "implement") {
    if (actual) {
      if (actual.status === "stopped") return "paused";
      // In a paused cycle, implement was the last real work — mark as paused
      if (actual.status === "completed" && isPausedCycle) return "paused";
      if (actual.status === "completed") return "completed";
      if (actual.status === "failed") return isRunning ? "failed" : "paused";
      return "running";
    }
    if (isActiveCycle && currentStage === "implement") return "running";
    if (hasVerifyOrLater && !isPausedCycle) return "completed";
    if (implementPhases.length > 0) {
      const allDone = implementPhases.every((ip) => ip.status === "completed");
      // Even if all sub-phases that ran are done, if verify never ran and
      // the orchestrator isn't running, the implementation was interrupted
      if (allDone && !isRunning && !hasVerifyOrLater) return "paused";
      if (isPausedCycle) return "paused";
      if (allDone) return "completed";
      return isRunning ? "running" : "paused";
    }
    if (!isActiveCycle && decision) return "pending";
    return "pending";
  }

  // In a paused cycle, verify/learnings that ran as abort artifacts should show as skipped
  if (isPausedCycle && (stageType === "verify" || stageType === "learnings")) {
    if (actual && actual.status === "completed" && actual.durationMs < 5000) {
      return "skipped";
    }
  }

  if (actual) {
    if (actual.status === "completed") return "completed";
    if (actual.status === "stopped") return "paused";
    if (actual.status === "failed") return isRunning ? "failed" : "paused";
    return "running";
  }

  if (getStageVisibility(stageType, decision) === "skip") return "skipped";

  return "pending";
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function StatusDot({ status }: { status: StageStatus }) {
  const base: React.CSSProperties = {
    width: 18,
    height: 18,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "all 0.2s",
  };

  switch (status) {
    case "completed":
      return (
        <div style={{ ...base, background: "var(--status-success)", color: "#fff" }}>
          <CheckCircle size={11} strokeWidth={2.5} />
        </div>
      );
    case "running":
      return (
        <div style={{
          ...base,
          background: "color-mix(in srgb, var(--status-info) 15%, var(--surface-elevated))",
          border: "2px solid var(--status-info)",
          color: "var(--status-info)",
          boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-info) 10%, transparent)",
        }}>
          <Loader size={10} style={{ animation: "spin 1.5s linear infinite" }} />
        </div>
      );
    case "skipped":
      return (
        <div style={{ ...base, background: "var(--surface-elevated)", border: "2px solid var(--border)", color: "var(--foreground-dim)" }}>
          <Minus size={10} />
        </div>
      );
    case "paused":
      return (
        <div style={{
          ...base,
          background: "color-mix(in srgb, var(--status-warning, #f59e0b) 15%, var(--surface-elevated))",
          border: "2px solid var(--status-warning, #f59e0b)",
          color: "var(--status-warning, #f59e0b)",
        }}>
          <Pause size={10} fill="currentColor" />
        </div>
      );
    case "failed":
      return (
        <div style={{ ...base, background: "color-mix(in srgb, var(--status-error) 15%, var(--surface-elevated))", border: "2px solid var(--status-error)", color: "var(--status-error)" }}>
          <Circle size={10} />
        </div>
      );
    default:
      return (
        <div style={{ ...base, background: "var(--surface-elevated)", border: "2px solid var(--border-bright)" }} />
      );
  }
}

function StageRow({
  stageType,
  status,
  costUsd,
  durationMs,
  isLast,
  hasTrace,
  onClick,
  children,
}: {
  stageType: StepType;
  status: StageStatus;
  costUsd: number;
  durationMs: number;
  isLast: boolean;
  hasTrace: boolean;
  onClick: () => void;
  children?: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isSkipped = status === "skipped";
  const isPaused = status === "paused";

  return (
    <div>
      <div
        onClick={hasTrace ? onClick : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 8px",
          borderRadius: "var(--radius)",
          cursor: hasTrace ? "pointer" : "default",
          background: hovered && hasTrace
            ? "color-mix(in srgb, var(--status-info) 8%, transparent)"
            : isRunning
              ? "color-mix(in srgb, var(--status-info) 5%, transparent)"
              : isPaused
                ? "color-mix(in srgb, var(--status-warning, #f59e0b) 5%, transparent)"
                : "transparent",
          transition: "background 0.15s",
        }}
      >
        {/* Dot */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 18, flexShrink: 0 }}>
          <StatusDot status={status} />
        </div>

        {/* Label */}
        <span
          style={{
            fontSize: "0.8rem",
            fontWeight: isRunning || isPaused ? 600 : 400,
            color: hovered && hasTrace
              ? "var(--status-info)"
              : isSkipped
                ? "var(--foreground-dim)"
                : isRunning
                  ? "var(--status-info)"
                  : isPaused
                    ? "var(--status-warning, #f59e0b)"
                    : isCompleted
                      ? "var(--foreground-muted)"
                      : "var(--foreground-dim)",
            textDecoration: isSkipped ? "line-through" : "none",
            flex: 1,
            transition: "color 0.15s",
          }}
        >
          {STEP_LABELS[stageType]}
        </span>

        {/* Cost + Duration */}
        {(isCompleted || isPaused) && (costUsd > 0 || durationMs > 0) && (
          <div style={{ display: "flex", gap: 8, fontSize: "0.7rem", fontFamily: "var(--font-mono)", color: "var(--foreground-dim)" }}>
            {costUsd > 0 && <span>${costUsd.toFixed(2)}</span>}
            {durationMs > 0 && <span>{formatDuration(durationMs)}</span>}
          </div>
        )}

        {isRunning && (
          <span style={{ fontSize: "0.68rem", color: "var(--status-info)", fontStyle: "italic" }}>
            running...
          </span>
        )}

        {isPaused && (
          <span style={{ fontSize: "0.68rem", color: "var(--status-warning, #f59e0b)", fontWeight: 500 }}>
            paused
          </span>
        )}

        {/* Hover reveal: open icon */}
        {hasTrace && (
          <ExternalLink
            size={12}
            style={{
              color: "var(--status-info)",
              opacity: hovered ? 1 : 0,
              transition: "opacity 0.15s",
              flexShrink: 0,
              marginLeft: 8,
            }}
          />
        )}
      </div>

      {/* Nested content (implement sub-phases) */}
      {children}

      {/* Connector line to next step */}
      {!isLast && (
        <div style={{
          marginLeft: 17,
          width: 2,
          height: 6,
          background: isCompleted ? "color-mix(in srgb, var(--status-success) 40%, var(--border))" : "var(--border)",
          borderRadius: 1,
        }} />
      )}
    </div>
  );
}

function ImplementSpecView({
  specSummary,
  onSelectSpec,
}: {
  specSummary: SpecSummary | undefined;
  onSelectSpec: (specName: string) => void;
}) {
  if (!specSummary) return null;

  return (
    <div style={{ marginLeft: 24, paddingLeft: 10, paddingTop: 6, paddingBottom: 4 }}>
      <SpecCard
        summary={specSummary}
        onClick={() => onSelectSpec(specSummary.name)}
        onStart={() => {}}
        isRunning={false}
      />
    </div>
  );
}

export interface StageListProps {
  stages: UiLoopStage[];
  implementPhases: ImplementSubPhase[];
  currentStage: StepType | null;
  isActiveCycle: boolean;
  isRunning: boolean;
  isPausedCycle: boolean;
  decision: string | null;
  specSummary: SpecSummary | undefined;
  onStageClick: (step: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
}

export function StageList({
  stages,
  implementPhases,
  currentStage,
  isActiveCycle,
  isRunning,
  isPausedCycle,
  decision,
  specSummary,
  onStageClick,
  onImplPhaseClick,
  onSelectSpec,
}: StageListProps) {
  const hasVerifyOrLater = stages.some(
    (s) => (s.type === "verify" || s.type === "learnings") && s.status === "completed"
  );

  const visibleStages = CYCLE_STAGES.filter(
    (st) => getStageVisibility(st, decision) === "show" || stages.some((s) => s.type === st)
  );

  return (
    <div style={{ padding: "4px 0 4px 8px" }}>
      {visibleStages.map((stageType, i) => {
        const actual = stages.find((s) => s.type === stageType);
        const status = deriveStageStatus(
          stageType,
          actual,
          currentStage,
          isActiveCycle,
          decision,
          hasVerifyOrLater,
          implementPhases,
          isRunning,
          isPausedCycle
        );

        const implCost = stageType === "implement"
          ? implementPhases.reduce((sum, ip) => sum + ip.costUsd, 0)
          : 0;
        const implDuration = stageType === "implement"
          ? implementPhases.reduce((sum, ip) => sum + ip.durationMs, 0)
          : 0;

        return (
          <StageRow
            key={stageType}
            stageType={stageType}
            status={status}
            costUsd={actual?.costUsd ?? implCost}
            durationMs={actual?.durationMs ?? implDuration}
            isLast={i === visibleStages.length - 1}
            hasTrace={!!actual?.agentRunId || (stageType === "implement" && (implementPhases.length > 0 || !!specSummary))}
            onClick={() => {
              if (stageType === "implement" && specSummary) {
                onSelectSpec(specSummary.name);
              } else if (actual) {
                onStageClick(actual);
              }
            }}
          >
            {stageType === "implement" && (status === "running" || status === "completed" || status === "paused") && (
              <ImplementSpecView
                specSummary={specSummary}
                onSelectSpec={onSelectSpec}
              />
            )}
          </StageRow>
        );
      })}
    </div>
  );
}
