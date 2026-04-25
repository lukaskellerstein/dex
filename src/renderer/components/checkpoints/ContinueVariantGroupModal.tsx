import { CheckpointModal } from "./Modal";
import type { VariantGroupFile } from "../../../core/checkpoints.js";

interface Props {
  group: VariantGroupFile;
  onContinue: () => Promise<void>;
  onDiscard: () => Promise<void>;
}

/**
 * Fires at project-open when a variant group has pending/running variants
 * left over from a prior session (app crash or user quit mid-fan-out).
 * User can continue (resume pending / restart running) or discard.
 */
export function ContinueVariantGroupModal({ group, onContinue, onDiscard }: Props) {
  const pending = group.variants.filter((v) => v.status === "pending").length;
  const running = group.variants.filter((v) => v.status === "running").length;

  return (
    <CheckpointModal
      title="Resume variant group?"
      onClose={undefined}
      footer={
        <>
          <button className="btn-secondary" onClick={onDiscard}>
            Discard
          </button>
          <button className="btn-primary" onClick={onContinue}>
            Continue
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 8 }}>
        A previous session left a <code>{group.step}</code> variant group mid-flight.
      </p>
      <ul style={{ marginLeft: 20, fontSize: 13 }}>
        <li>{pending} pending</li>
        <li>{running} running (process likely died — will restart)</li>
        <li>{group.variants.length - pending - running} already completed</li>
      </ul>
      <p style={{ marginTop: 10, color: "var(--foreground-muted)", fontSize: 12 }}>
        Continue to finish the group, or discard to abandon it. No canonical
        checkpoint has been moved yet.
      </p>
    </CheckpointModal>
  );
}
