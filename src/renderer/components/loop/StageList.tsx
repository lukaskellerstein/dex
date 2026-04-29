/**
 * What: Renders the per-cycle stage list — one row per CYCLE_STAGES entry, with status dot, label, cost/duration badge, and live-action indicator. Implement rows nest a SpecCard.
 * Not: Does not derive stage status (logic in StageList.logic.ts). Does not own state besides hover/now refresh.
 * Deps: StageList.logic.ts, MetaBadge, SpecCard, useNow, lucide-react icons.
 */
import { CheckCircle, Circle, Loader, Minus, Pause, PauseCircle, ExternalLink } from "lucide-react";
import { useState } from "react";
import type { StepType } from "../../../core/types.js";
import type { UiLoopStage, ImplementSubPhase, LatestAction } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { SpecCard } from "../project-overview/SpecCard.js";
import { useNow, relativeTimeShort } from "../../hooks/useNow.js";
import { MetaBadge } from "../shared/MetaBadge.js";
import {
  CYCLE_STAGES,
  STEP_LABELS,
  type StageStatus,
  deriveStageStatus,
  getStageVisibility,
  resolvePausePendingStage,
  computeImplementMetrics,
} from "./StageList.logic.js";

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
        <div
          style={{
            ...base,
            background: "color-mix(in srgb, var(--status-info) 15%, var(--surface-elevated))",
            border: "2px solid var(--status-info)",
            color: "var(--status-info)",
            boxShadow: "0 0 0 3px color-mix(in srgb, var(--status-info) 10%, transparent)",
          }}
        >
          <Loader size={10} style={{ animation: "spin 1.5s linear infinite" }} />
        </div>
      );
    case "skipped":
      return (
        <div
          style={{
            ...base,
            background: "var(--surface-elevated)",
            border: "2px solid var(--border)",
            color: "var(--foreground-dim)",
          }}
        >
          <Minus size={10} />
        </div>
      );
    case "paused":
      return (
        <div
          style={{
            ...base,
            background: "color-mix(in srgb, var(--status-warning, #f59e0b) 15%, var(--surface-elevated))",
            border: "2px solid var(--status-warning, #f59e0b)",
            color: "var(--status-warning, #f59e0b)",
          }}
        >
          <Pause size={10} fill="currentColor" />
        </div>
      );
    case "pause-pending":
      return (
        <div
          style={{
            ...base,
            background: "transparent",
            border: "2px dashed var(--status-warning, #f59e0b)",
            color: "var(--status-warning, #f59e0b)",
          }}
        >
          <PauseCircle size={11} strokeWidth={2} />
        </div>
      );
    case "failed":
      return (
        <div
          style={{
            ...base,
            background: "color-mix(in srgb, var(--status-error) 15%, var(--surface-elevated))",
            border: "2px solid var(--status-error)",
            color: "var(--status-error)",
          }}
        >
          <Circle size={10} />
        </div>
      );
    default:
      return (
        <div
          style={{
            ...base,
            background: "var(--surface-elevated)",
            border: "2px solid var(--border-bright)",
          }}
        />
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
  latestAction,
}: {
  stageType: StepType;
  status: StageStatus;
  costUsd: number;
  durationMs: number;
  isLast: boolean;
  hasTrace: boolean;
  onClick: () => void;
  children?: React.ReactNode;
  latestAction?: LatestAction | null;
}) {
  const [hovered, setHovered] = useState(false);
  const isRunning = status === "running";
  const isCompleted = status === "completed";
  const isSkipped = status === "skipped";
  const isPaused = status === "paused";
  const isPausePending = status === "pause-pending";

  // Tick once per second only while this row is showing a live indicator.
  const now = useNow(1000, isRunning && !!latestAction);

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
          background:
            hovered && hasTrace
              ? "color-mix(in srgb, var(--status-info) 8%, transparent)"
              : isRunning
                ? "color-mix(in srgb, var(--status-info) 5%, transparent)"
                : isPaused || isPausePending
                  ? "color-mix(in srgb, var(--status-warning, #f59e0b) 5%, transparent)"
                  : "transparent",
          transition: "background 0.15s",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            width: 18,
            flexShrink: 0,
          }}
        >
          <StatusDot status={status} />
        </div>

        <span
          style={{
            fontSize: "0.8rem",
            fontWeight: isRunning || isPaused || isPausePending ? 600 : 400,
            color:
              hovered && hasTrace
                ? "var(--status-info)"
                : isSkipped
                  ? "var(--foreground-dim)"
                  : isRunning
                    ? "var(--status-info)"
                    : isPaused || isPausePending
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

        {(isCompleted || isPaused) && <MetaBadge costUsd={costUsd} durationMs={durationMs} />}

        {isRunning && (
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--status-info)",
              fontStyle: "italic",
              fontFamily: latestAction ? "var(--font-mono)" : undefined,
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={
              latestAction
                ? `${latestAction.label} · ${relativeTimeShort(latestAction.createdAt, now)}`
                : undefined
            }
          >
            {latestAction
              ? `${latestAction.label} · ${relativeTimeShort(latestAction.createdAt, now)}`
              : "running…"}
          </span>
        )}

        {isPaused && (
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--status-warning, #f59e0b)",
              fontWeight: 500,
            }}
          >
            paused
          </span>
        )}

        {isPausePending && (
          <span
            style={{
              fontSize: "0.68rem",
              color: "var(--status-warning, #f59e0b)",
              fontWeight: 500,
              fontStyle: "italic",
            }}
          >
            next on resume
          </span>
        )}

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

      {children}

      {!isLast && (
        <div
          style={{
            marginLeft: 17,
            width: 2,
            height: 6,
            background: isCompleted
              ? "color-mix(in srgb, var(--status-success) 40%, var(--border))"
              : "var(--border)",
            borderRadius: 1,
          }}
        />
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
  pathStages?: ReadonlySet<StepType>;
  latestAction?: LatestAction | null;
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
  onSelectSpec,
  pathStages,
  latestAction,
}: StageListProps) {
  const hasVerifyOrLater = stages.some(
    (s) => (s.type === "verify" || s.type === "learnings") && s.status === "completed",
  );

  const visibleStages = CYCLE_STAGES.filter(
    (st) =>
      getStageVisibility(st, decision) === "show" || stages.some((s) => s.type === st),
  );

  const path = pathStages ?? new Set<StepType>();
  const pausePendingStage = resolvePausePendingStage(
    visibleStages,
    stages,
    path,
    isPausedCycle,
    isActiveCycle,
    isRunning,
    currentStage,
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
          isPausedCycle,
          path,
          pausePendingStage,
        );

        const implMetrics = computeImplementMetrics(stageType, implementPhases);

        return (
          <StageRow
            key={stageType}
            stageType={stageType}
            status={status}
            costUsd={actual?.costUsd ?? implMetrics.cost}
            durationMs={actual?.durationMs ?? implMetrics.durationMs}
            isLast={i === visibleStages.length - 1}
            hasTrace={
              !!actual?.agentRunId ||
              (stageType === "implement" && (implementPhases.length > 0 || !!specSummary))
            }
            onClick={() => {
              if (stageType === "implement" && specSummary) {
                onSelectSpec(specSummary.name);
              } else if (actual) {
                onStageClick(actual);
              }
            }}
            latestAction={status === "running" ? latestAction : null}
          >
            {stageType === "implement" &&
              (status === "running" || status === "completed" || status === "paused") && (
                <ImplementSpecView specSummary={specSummary} onSelectSpec={onSelectSpec} />
              )}
          </StageRow>
        );
      })}
    </div>
  );
}
