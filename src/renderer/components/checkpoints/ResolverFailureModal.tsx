import { CheckpointModal } from "./Modal";
import {
  RESOLVER_FAILURE_TITLE,
  ACCEPT_AI_RESULT,
  ROLLBACK_MERGE,
  OPEN_IN_EDITOR,
} from "./branchOps/copy";

interface Props {
  /** The resolver's terminal reason — surfaces in the modal body for context. */
  reason: string;
  /** Files the resolver failed to (or didn't get to) resolve — passed to the editor on Open-in-editor. */
  failedFiles: string[];
  onAccept: () => void;
  onRollback: () => void;
  onOpenInEditor: () => void;
}

/**
 * Three-button escape modal for when the resolver gives up. Layout:
 *   • Accept what AI did   — primary, takes whatever resolved state the agent reached
 *   • Roll back the merge entirely — secondary, runs `git merge --abort`
 *   • Open in editor       — small, bottom-right; the only intentional power-user gesture
 */
export function ResolverFailureModal({
  reason,
  failedFiles,
  onAccept,
  onRollback,
  onOpenInEditor,
}: Props) {
  return (
    <CheckpointModal
      title={RESOLVER_FAILURE_TITLE}
      onClose={onRollback}
      footer={
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          <button
            type="button"
            data-testid="resolver-failure-open-editor"
            onClick={onOpenInEditor}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--foreground-dim)",
              fontSize: 11,
              padding: "4px 6px",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            {OPEN_IN_EDITOR}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn-secondary"
              data-testid="resolver-failure-rollback"
              onClick={onRollback}
            >
              {ROLLBACK_MERGE}
            </button>
            <button
              className="btn-primary"
              data-testid="resolver-failure-accept"
              onClick={onAccept}
            >
              {ACCEPT_AI_RESULT}
            </button>
          </div>
        </div>
      }
    >
      <p style={{ marginBottom: 10 }}>
        The AI couldn't fully reconcile the disagreement{" "}
        <code style={{ color: "var(--foreground-dim)" }}>({reason})</code>.
      </p>
      <p style={{ marginBottom: 10, fontSize: 12, color: "var(--foreground-muted)" }}>
        Pick one:
      </p>
      <ul
        style={{
          fontSize: 12,
          color: "var(--foreground-muted)",
          marginBottom: 10,
          paddingLeft: 18,
          lineHeight: 1.5,
        }}
      >
        <li>
          <strong>{ACCEPT_AI_RESULT}</strong> — finalize with whatever the AI
          produced. Use this when you're willing to inspect the result yourself.
        </li>
        <li>
          <strong>{ROLLBACK_MERGE}</strong> — undo the entire attempt. Main and
          this version both return to where they were.
        </li>
      </ul>
      {failedFiles.length > 0 && (
        <div
          data-testid="resolver-failure-files"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {failedFiles.map((f) => (
            <div key={f} style={{ padding: "1px 0" }}>
              {f}
            </div>
          ))}
        </div>
      )}
    </CheckpointModal>
  );
}
