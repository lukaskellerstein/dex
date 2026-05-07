import type { UiLoopStage } from "../../../hooks/useOrchestrator.js";
import { VerticalStepper, type StepItem } from "../VerticalStepper.js";
import { MetaBadge } from "../../shared/MetaBadge.js";

interface ClarificationPhaseProps {
  preCycleStages: UiLoopStage[];
  isClarifying: boolean;
  isRunning: boolean;
  onStageClick: (step: UiLoopStage) => void;
}

export function ClarificationPhase({
  preCycleStages,
  isClarifying,
  isRunning,
  onStageClick,
}: ClarificationPhaseProps) {
  const productStage = preCycleStages.find((s) => s.type === "clarification_product");
  const technicalStage = preCycleStages.find((s) => s.type === "clarification_technical");
  const synthesisStage = preCycleStages.find((s) => s.type === "clarification_synthesis");
  const constitutionStage = preCycleStages.find((s) => s.type === "constitution");
  const manifestExtractionStage = preCycleStages.find((s) => s.type === "manifest_extraction");
  // Backward compat: old-style single clarification step
  const legacyClarificationStage = preCycleStages.find((s) => s.type === "clarification");

  function stageToStatus(step: UiLoopStage | undefined, prevDone: boolean): StepItem["status"] {
    if (step?.status === "completed") return "completed";
    if (step?.status === "running") return "active";
    if (step?.status === "failed" && !isRunning) return "paused";
    if (step) return "pending";
    if (prevDone && isClarifying) return "active";
    if (prevDone && !isRunning && !isClarifying) return "paused";
    return "pending";
  }

  function stageMeta(step: UiLoopStage | undefined): React.ReactNode {
    if (step?.status === "completed") {
      return <MetaBadge costUsd={step.costUsd} durationMs={step.durationMs} />;
    }
    return undefined;
  }

  // Legacy single-step clarification — show as one combined step.
  if (legacyClarificationStage && !productStage && !technicalStage) {
    const status =
      legacyClarificationStage.status === "completed"
        ? "completed"
        : legacyClarificationStage.status === "running"
          ? "active"
          : "pending";
    return (
      <div style={{ padding: "20px 24px", overflow: "auto", flex: 1 }}>
        <VerticalStepper
          steps={[
            {
              id: "legacy-clarification",
              title: "Interactive Clarification",
              description:
                status === "completed"
                  ? "All requirements clarified."
                  : "Clarifying requirements, tech stack, and constraints...",
              status: status as StepItem["status"],
              onClick: () => onStageClick(legacyClarificationStage),
              meta: stageMeta(legacyClarificationStage),
            },
          ]}
        />
      </div>
    );
  }

  const steps: StepItem[] = [
    {
      id: "product-domain",
      title: "Product Clarification",
      description:
        productStage?.status === "completed"
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
      description:
        technicalStage?.status === "completed"
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
      description:
        synthesisStage?.status === "completed"
          ? "Clarified plan and CLAUDE.md generated."
          : synthesisStage?.status === "running"
            ? "Synthesizing domain outputs into the clarified plan and CLAUDE.md..."
            : "Produce the clarified plan and CLAUDE.md from domain outputs.",
      status: stageToStatus(synthesisStage, technicalStage?.status === "completed"),
      onClick: synthesisStage ? () => onStageClick(synthesisStage) : undefined,
      meta: stageMeta(synthesisStage),
    },
    {
      id: "constitution",
      title: "Generate Constitution",
      description:
        constitutionStage?.status === "completed"
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
      description:
        manifestExtractionStage?.status === "completed"
          ? "Ordered list of MVP features extracted from the clarified plan."
          : manifestExtractionStage?.status === "running"
            ? "Extracting MVP features and descriptions from the clarified plan..."
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
