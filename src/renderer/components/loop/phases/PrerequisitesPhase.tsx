import type { PrerequisiteCheck } from "../../../../core/types.js";
import type { UiLoopStage } from "../../../hooks/useOrchestrator.js";
import { type StepItem, VerticalStepper } from "../VerticalStepper.js";

const CHECK_LABELS: Record<
  string,
  { title: string; description: string; failDescription: string }
> = {
  claude_cli: {
    title: "Claude Code CLI",
    description: "Verify that the Claude Code CLI is available on your system PATH.",
    failDescription: "Claude Code CLI not found. Install it to proceed.",
  },
  specify_cli: {
    title: "Spec-Kit CLI",
    description: "Verify that the Spec-Kit CLI (specify) is available on your system PATH.",
    failDescription:
      "Spec-Kit CLI not found. Install with: uv tool install specify-cli --from git+https://github.com/github/spec-kit.git",
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

interface PrerequisitesPhaseProps {
  checks: PrerequisiteCheck[];
  isActive: boolean;
  step: UiLoopStage | undefined;
}

export function PrerequisitesPhase({ checks, step }: PrerequisitesPhaseProps) {
  const stageCompleted = step?.status === "completed";
  const checkMap = new Map(checks.map((c) => [c.name, c]));

  const steps: StepItem[] = (
    ["claude_cli", "specify_cli", "git_init", "speckit_init", "github_repo"] as const
  ).map((name) => {
    const check = checkMap.get(name);
    const labels = CHECK_LABELS[name];
    const isFailed = check?.status === "fail";

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
