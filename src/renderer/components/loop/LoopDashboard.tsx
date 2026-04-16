import { useState, useEffect, useCallback } from "react";
import { DollarSign, Clock, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import type { LoopStageType, LoopTermination, PrerequisiteCheck } from "../../../core/types.js";
import type { UiLoopCycle, UiLoopStage } from "../../hooks/useOrchestrator.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { ProcessStepper } from "./ProcessStepper.js";
import { CycleTimeline } from "./CycleTimeline.js";
import { VerticalStepper, type StepItem } from "./VerticalStepper.js";

type MacroPhase = "prerequisites" | "clarification" | "loop" | "completion";
type PhaseStatus = "pending" | "active" | "done";

export interface LoopDashboardProps {
  cycles: UiLoopCycle[];
  preCycleStages: UiLoopStage[];
  prerequisitesChecks: PrerequisiteCheck[];
  isCheckingPrerequisites: boolean;
  currentCycle: number | null;
  currentStage: LoopStageType | null;
  isClarifying: boolean;
  isRunning: boolean;
  totalCost: number;
  loopTermination: LoopTermination | null;
  specSummaries: SpecSummary[];
  onStageClick: (stage: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  debugBadge?: React.ReactNode;
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

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function MetaBadge({ costUsd, durationMs }: { costUsd: number; durationMs: number }) {
  if (costUsd <= 0 && durationMs <= 0) return null;
  return (
    <span style={{
      display: "flex",
      gap: 8,
      fontSize: "0.68rem",
      fontFamily: "var(--font-mono)",
      color: "var(--foreground-dim)",
    }}>
      {costUsd > 0 && <span>${costUsd.toFixed(2)}</span>}
      {durationMs > 0 && <span>{formatDuration(durationMs)}</span>}
    </span>
  );
}


// ── Prerequisites Phase View ──

const CHECK_LABELS: Record<string, { title: string; description: string; failDescription: string }> = {
  claude_cli: {
    title: "Claude Code CLI",
    description: "Verify that the Claude Code CLI is available on your system PATH.",
    failDescription: "Claude Code CLI not found. Install it to proceed.",
  },
  specify_cli: {
    title: "Spec-Kit CLI",
    description: "Verify that the Spec-Kit CLI (specify) is available on your system PATH.",
    failDescription: "Spec-Kit CLI not found. Install with: uv tool install specify-cli --from git+https://github.com/github/spec-kit.git",
  },
  git_init: {
    title: "Git Repository",
    description: "Ensure the project folder is a git repository (run git init if missing).",
    failDescription: "Failed to initialize git repository.",
  },
  github_repo: {
    title: "GitHub Repository",
    description: "Optionally create a GitHub remote for the project.",
    failDescription: "Failed to create GitHub repository.",
  },
  speckit_init: {
    title: "Initialize Spec-Kit",
    description: "Ensure the project has been initialized with Spec-Kit (.specify/ directory).",
    failDescription: "Spec-Kit not initialized in this project.",
  },
};

function checkToStepStatus(check: PrerequisiteCheck | undefined): StepItem["status"] {
  if (!check) return "pending";
  switch (check.status) {
    case "pass":
    case "fixed":
      return "completed";
    case "running":
      return "active";
    case "fail":
      return "failed";
  }
}

function PrerequisitesView({
  checks,
  isActive,
  stage,
}: {
  checks: PrerequisiteCheck[];
  isActive: boolean;
  stage: UiLoopStage | undefined;
}) {
  const stageCompleted = stage?.status === "completed";
  const checkMap = new Map(checks.map((c) => [c.name, c]));

  const steps: StepItem[] = (["claude_cli", "specify_cli", "git_init", "speckit_init", "github_repo"] as const).map((name) => {
    const check = checkMap.get(name);
    const labels = CHECK_LABELS[name];
    const isFailed = check?.status === "fail";

    // When stage is done, derive step status from the final check result
    let stepStatus: StepItem["status"];
    if (stageCompleted) {
      stepStatus = isFailed ? "failed" : "completed";
    } else {
      stepStatus = checkToStepStatus(check);
    }

    return {
      id: name,
      title: labels.title,
      description: isFailed
        ? (check?.message ?? labels.failDescription)
        : check?.status === "fixed"
          ? (check.message ?? "Skipped.")
          : check?.status === "pass"
            ? `${labels.title} verified.`
            : labels.description,
      status: stepStatus,
    };
  });

  return (
    <div style={{ padding: "20px 24px", overflow: "auto", flex: 1 }}>
      <VerticalStepper steps={steps} />
    </div>
  );
}

// ── Clarification Phase View ──

function ClarificationView({
  preCycleStages,
  isClarifying,
  isRunning,
  onStageClick,
}: {
  preCycleStages: UiLoopStage[];
  isClarifying: boolean;
  isRunning: boolean;
  onStageClick: (stage: UiLoopStage) => void;
}) {
  const productStage = preCycleStages.find((s) => s.type === "clarification_product");
  const technicalStage = preCycleStages.find((s) => s.type === "clarification_technical");
  const synthesisStage = preCycleStages.find((s) => s.type === "clarification_synthesis");
  const constitutionStage = preCycleStages.find((s) => s.type === "constitution");
  const manifestExtractionStage = preCycleStages.find((s) => s.type === "manifest_extraction");
  // Backward compat: old-style single clarification stage
  const legacyClarificationStage = preCycleStages.find((s) => s.type === "clarification");

  function stageToStatus(stage: UiLoopStage | undefined, prevDone: boolean): StepItem["status"] {
    if (stage?.status === "completed") return "completed";
    if (stage?.status === "running") return "active";
    if (stage?.status === "failed" && !isRunning) return "paused";
    if (stage) return "pending";
    if (prevDone && isClarifying) return "active";
    // If previous step is done but run is paused, this is where it stopped
    if (prevDone && !isRunning && !isClarifying) return "paused";
    return "pending";
  }

  function stageMeta(stage: UiLoopStage | undefined): React.ReactNode {
    if (stage?.status === "completed") return <MetaBadge costUsd={stage.costUsd} durationMs={stage.durationMs} />;
    return undefined;
  }

  // If we have a legacy single-stage clarification, show it as one combined step
  if (legacyClarificationStage && !productStage && !technicalStage) {
    const status = legacyClarificationStage.status === "completed" ? "completed"
      : legacyClarificationStage.status === "running" ? "active" : "pending";
    return (
      <div style={{ padding: "20px 24px", overflow: "auto", flex: 1 }}>
        <VerticalStepper steps={[{
          id: "legacy-clarification",
          title: "Interactive Clarification",
          description: status === "completed"
            ? "All requirements clarified."
            : "Clarifying requirements, tech stack, and constraints...",
          status: status as StepItem["status"],
          onClick: () => onStageClick(legacyClarificationStage),
          meta: stageMeta(legacyClarificationStage),
        }]} />
      </div>
    );
  }

  const steps: StepItem[] = [
    {
      id: "product-domain",
      title: "Product Clarification",
      description: productStage?.status === "completed"
        ? "Product requirements, user stories, and scope boundaries defined."
        : productStage?.status === "running"
          ? "Asking questions about user stories, features, and acceptance criteria..."
          : "User stories, features, acceptance criteria, scope boundaries, and data model.",
      status: stageToStatus(productStage, true),
      onClick: productStage ? () => onStageClick(productStage) : undefined,
      meta: stageMeta(productStage),
    },
    {
      id: "technical-domain",
      title: "Technical Clarification",
      description: technicalStage?.status === "completed"
        ? "Tech stack, architecture, and deployment decisions finalized."
        : technicalStage?.status === "running"
          ? "Asking questions about tech stack, deployment, and architecture..."
          : "Tech stack, build commands, deployment, testing strategy, and architecture.",
      status: stageToStatus(technicalStage, productStage?.status === "completed"),
      onClick: technicalStage ? () => onStageClick(technicalStage) : undefined,
      meta: stageMeta(technicalStage),
    },
    {
      id: "synthesis",
      title: "Generate Plan & Project Rules",
      description: synthesisStage?.status === "completed"
        ? "GOAL_clarified.md and CLAUDE.md generated."
        : synthesisStage?.status === "running"
          ? "Synthesizing domain outputs into GOAL_clarified.md and CLAUDE.md..."
          : "Produce GOAL_clarified.md and CLAUDE.md from domain outputs.",
      status: stageToStatus(synthesisStage, technicalStage?.status === "completed"),
      onClick: synthesisStage ? () => onStageClick(synthesisStage) : undefined,
      meta: stageMeta(synthesisStage),
    },
    {
      id: "constitution",
      title: "Generate Constitution",
      description: constitutionStage?.status === "completed"
        ? "Project rules and conventions established."
        : constitutionStage?.status === "running"
          ? "Generating project constitution from clarified plan..."
          : "Establish project conventions and rules from the clarified plan.",
      status: stageToStatus(constitutionStage, synthesisStage?.status === "completed"),
      onClick: constitutionStage ? () => onStageClick(constitutionStage) : undefined,
      meta: stageMeta(constitutionStage),
    },
    {
      id: "manifest-extraction",
      title: "Feature Manifest Extraction",
      description: manifestExtractionStage?.status === "completed"
        ? "Ordered list of MVP features extracted from the clarified plan."
        : manifestExtractionStage?.status === "running"
          ? "Extracting MVP features and descriptions from GOAL_clarified.md..."
          : "Extract the ordered list of MVP features from the clarified plan.",
      status: stageToStatus(manifestExtractionStage, constitutionStage?.status === "completed"),
      onClick: manifestExtractionStage ? () => onStageClick(manifestExtractionStage) : undefined,
      meta: stageMeta(manifestExtractionStage),
    },
  ];

  return (
    <div style={{ padding: "20px 24px", overflow: "auto", flex: 1 }}>
      <VerticalStepper steps={steps} />
    </div>
  );
}

// ── Dex Loop Phase View ──

function LoopPhaseView({
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
}: {
  cycles: UiLoopCycle[];
  currentCycle: number | null;
  currentStage: LoopStageType | null;
  isRunning: boolean;
  totalCost: number;
  specSummaries: SpecSummary[];
  onStageClick: (stage: UiLoopStage) => void;
  onImplPhaseClick: (phaseTraceId: string) => void;
  onSelectSpec: (specName: string) => void;
  debugBadge?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Stats bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        borderBottom: "1px solid var(--border)",
        fontSize: "0.75rem",
        color: "var(--foreground-dim)",
      }}>
        {cycles.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <Clock size={10} />
            {cycles.filter((c) => c.status === "completed").length}/{cycles.length} cycles
          </span>
        )}
        {totalCost > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 2, fontFamily: "var(--font-mono)" }}>
            <DollarSign size={10} />
            {totalCost.toFixed(2)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {debugBadge}
      </div>

      {/* Scrollable content — cycles directly */}
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
        />
      </div>
    </div>
  );
}

// ── Completion Phase View ──

const REASON_CONFIG: Record<string, { label: string; heading: string; icon: React.ReactNode; color: string }> = {
  gaps_complete: {
    heading: "All Features Implemented",
    label: "The loop completed successfully — all planned features were implemented.",
    icon: <CheckCircle size={28} style={{ color: "var(--status-success)" }} />,
    color: "var(--status-success)",
  },
  budget_exceeded: {
    heading: "Budget Limit Reached",
    label: "The loop stopped because the configured budget limit was exceeded.",
    icon: <AlertCircle size={28} style={{ color: "var(--status-warning, #f59e0b)" }} />,
    color: "var(--status-warning, #f59e0b)",
  },
  max_cycles_reached: {
    heading: "Max Cycles Reached",
    label: "The loop stopped after reaching the maximum number of configured cycles.",
    icon: <AlertCircle size={28} style={{ color: "var(--status-warning, #f59e0b)" }} />,
    color: "var(--status-warning, #f59e0b)",
  },
  user_abort: {
    heading: "Stopped by User",
    label: "The loop was stopped manually before completion.",
    icon: <XCircle size={28} style={{ color: "var(--foreground-muted)" }} />,
    color: "var(--foreground-muted)",
  },
};

function StatCard({ value, label, color }: { value: string | number; label: string; color?: string }) {
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      padding: "16px 20px",
      flex: 1,
      minWidth: 120,
    }}>
      <div style={{
        fontSize: "1.5rem",
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        color: color ?? "var(--foreground)",
        lineHeight: 1.2,
      }}>
        {value}
      </div>
      <div style={{
        fontSize: "0.72rem",
        color: "var(--foreground-dim)",
        marginTop: 4,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}>
        {label}
      </div>
    </div>
  );
}

function CompletionView({ termination }: { termination: LoopTermination }) {
  const reason = REASON_CONFIG[termination.reason] ?? REASON_CONFIG.user_abort;
  const totalFeatures = termination.featuresCompleted.length + termination.featuresSkipped.length;

  return (
    <div style={{ padding: "28px 32px", overflow: "auto", flex: 1, maxWidth: 640 }}>
      {/* Header — reason icon + heading + description */}
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 28 }}>
        <div style={{ flexShrink: 0, marginTop: 2 }}>{reason.icon}</div>
        <div>
          <h3 style={{
            fontSize: "1.15rem",
            fontWeight: 600,
            color: "var(--foreground)",
            marginBottom: 4,
          }}>
            {reason.heading}
          </h3>
          <p style={{
            fontSize: "0.84rem",
            color: "var(--foreground-muted)",
            lineHeight: 1.5,
            margin: 0,
          }}>
            {reason.label}
          </p>
        </div>
      </div>

      {/* Stat cards row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        <StatCard value={termination.cyclesCompleted} label="Cycles" />
        <StatCard
          value={termination.featuresCompleted.length}
          label="Completed"
          color={termination.featuresCompleted.length > 0 ? "var(--status-success)" : undefined}
        />
        <StatCard
          value={termination.featuresSkipped.length}
          label="Skipped"
          color={termination.featuresSkipped.length > 0 ? "var(--status-error)" : undefined}
        />
        {termination.totalCostUsd > 0 && (
          <StatCard value={`$${termination.totalCostUsd.toFixed(2)}`} label="Total Cost" />
        )}
      </div>

      {/* Feature lists */}
      {totalFeatures > 0 && (
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "16px 20px",
          marginBottom: 24,
        }}>
          {termination.featuresCompleted.length > 0 && (
            <div style={{ marginBottom: termination.featuresSkipped.length > 0 ? 16 : 0 }}>
              <div style={{
                fontSize: "0.7rem",
                fontWeight: 600,
                color: "var(--status-success)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 8,
              }}>
                Completed Features
              </div>
              {termination.featuresCompleted.map((f) => (
                <div key={f} style={{
                  fontSize: "0.82rem",
                  color: "var(--foreground)",
                  padding: "4px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <CheckCircle size={12} style={{ color: "var(--status-success)", flexShrink: 0 }} />
                  {f}
                </div>
              ))}
            </div>
          )}
          {termination.featuresSkipped.length > 0 && (
            <div>
              {termination.featuresCompleted.length > 0 && (
                <div style={{
                  borderTop: "1px solid var(--border)",
                  marginBottom: 12,
                }} />
              )}
              <div style={{
                fontSize: "0.7rem",
                fontWeight: 600,
                color: "var(--status-error)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 8,
              }}>
                Skipped Features
              </div>
              {termination.featuresSkipped.map((f) => (
                <div key={f} style={{
                  fontSize: "0.82rem",
                  color: "var(--foreground-muted)",
                  padding: "4px 0",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}>
                  <XCircle size={12} style={{ color: "var(--status-error)", flexShrink: 0 }} />
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Next steps callout */}
      <div style={{
        background: "var(--primary-muted)",
        border: "1px solid rgba(124, 58, 237, 0.25)",
        borderRadius: "var(--radius-lg)",
        padding: "14px 18px",
        fontSize: "0.82rem",
        color: "var(--foreground-muted)",
        lineHeight: 1.5,
      }}>
        <span style={{ fontWeight: 600, color: "var(--foreground)", marginRight: 6 }}>Next:</span>
        {termination.reason === "gaps_complete"
          ? "All features are implemented. Review the code and create a PR."
          : "Review completed features and decide whether to continue with another loop."}
      </div>
    </div>
  );
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
}: LoopDashboardProps) {
  const activePhase = deriveActivePhase(isCheckingPrerequisites, isClarifying, preCycleStages, cycles, loopTermination, isRunning);
  const [selectedPhase, setSelectedPhase] = useState<MacroPhase>(activePhase);

  useEffect(() => {
    setSelectedPhase(activePhase);
  }, [activePhase]);

  const prerequisitesStatus = derivePhaseStatus("prerequisites", activePhase);
  const clarificationStatus = derivePhaseStatus("clarification", activePhase);
  const loopStatus = derivePhaseStatus("loop", activePhase);
  const completionStatus = derivePhaseStatus("completion", activePhase);
  const finalCompletionStatus: PhaseStatus = loopTermination?.reason === "gaps_complete" ? "done" : completionStatus;

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

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {selectedPhase === "prerequisites" && (
          <PrerequisitesView
            checks={prerequisitesChecks}
            isActive={activePhase === "prerequisites"}
            stage={preCycleStages.find((s) => s.type === "prerequisites")}
          />
        )}

        {selectedPhase === "clarification" && (
          <ClarificationView
            preCycleStages={preCycleStages}
            isClarifying={isClarifying}
            isRunning={isRunning}
            onStageClick={onStageClick}
          />
        )}

        {selectedPhase === "loop" && (
          <LoopPhaseView
            cycles={cycles}
            currentCycle={currentCycle}
            currentStage={currentStage}
            isRunning={isRunning}
            totalCost={totalCost}
            specSummaries={specSummaries}
            onStageClick={onStageClick}
            onImplPhaseClick={onImplPhaseClick}
            onSelectSpec={onSelectSpec}
            debugBadge={debugBadge}
          />
        )}

        {selectedPhase === "completion" && loopTermination && (
          <CompletionView termination={loopTermination} />
        )}

        {selectedPhase === "completion" && !loopTermination && (
          <div style={{ textAlign: "center", paddingTop: 60, color: "var(--foreground-dim)", fontSize: "0.82rem" }}>
            Loop has not completed yet
          </div>
        )}
      </div>
    </div>
  );
}
