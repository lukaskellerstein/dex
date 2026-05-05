import { CheckpointModal } from "./Modal";
import {
  LOST_WORK_TITLE,
  LOST_WORK_BODY,
  LOST_WORK_REMOVE,
  LOST_WORK_CANCEL,
} from "./branchOps/copy";
import type { LostStep } from "../../../core/checkpoints.js";

interface Props {
  /** Steps the user is about to lose. Caller short-circuits when empty. */
  lostSteps: LostStep[];
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shown when `deleteBranch` returns `{ error: "would_lose_work" }` —
 * lists each at-risk step in plain English with its short-SHA so the user
 * can decide whether the loss is acceptable.
 */
export function DeleteBranchConfirm({ lostSteps, onConfirm, onCancel }: Props) {
  return (
    <CheckpointModal
      title={LOST_WORK_TITLE}
      onClose={onCancel}
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onCancel}
            data-testid="delete-branch-cancel"
          >
            {LOST_WORK_CANCEL}
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            data-testid="delete-branch-confirm"
          >
            {LOST_WORK_REMOVE}
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 10 }}>{LOST_WORK_BODY}</p>
      <div
        data-testid="delete-branch-lost-steps"
        style={{
          maxHeight: 220,
          overflow: "auto",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 8,
          fontSize: 12,
          background: "var(--surface-elevated)",
        }}
      >
        {lostSteps.map((s) => (
          <div
            key={s.shortSha}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "3px 0",
              borderBottom: "1px solid var(--border-subtle, transparent)",
            }}
          >
            <span>{s.label}</span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--foreground-dim)",
              }}
            >
              {s.shortSha}
            </span>
          </div>
        ))}
      </div>
    </CheckpointModal>
  );
}
