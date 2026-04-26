import { CheckpointModal } from "./Modal";
import { StageSummary } from "./StageSummary";
import type { StepType } from "../../../core/types.js";

interface Props {
  step: StepType;
  cycleNumber: number;
  checkpointTag: string;
  candidateSha: string;
  onKeep: () => void;
  onTryAgain: () => void;
  onDismiss: () => void;
}

/**
 * Opens after a step-mode pause. Shows the step summary + the three primary
 * actions. Dismiss resumes the run as-is (equivalent to Keep at this step in
 * the spec, but without writing a new tag — useful for read-through).
 */
export function CandidatePrompt({
  step,
  cycleNumber,
  checkpointTag,
  candidateSha,
  onKeep,
  onTryAgain,
  onDismiss,
}: Props) {
  return (
    <CheckpointModal
      title={`Stage complete: ${step}`}
      onClose={onDismiss}
      footer={
        <>
          <button className="btn-secondary" onClick={onTryAgain}>
            Try again
          </button>
          <button className="btn-primary" onClick={onKeep}>
            Keep this
          </button>
        </>
      }
    >
      <StageSummary step={step} cycleNumber={cycleNumber} />
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
        candidate: {checkpointTag}
        <br />
        sha: {candidateSha.slice(0, 7)}
      </div>
    </CheckpointModal>
  );
}
