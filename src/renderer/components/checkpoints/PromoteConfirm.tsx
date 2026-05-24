import { useState } from "react";
import { CheckpointModal } from "./Modal";
import {
  PROMOTE_CONFIRM_TITLE,
  PROMOTE_CONFIRM_BODY,
  PROMOTE_CONFIRM_VIEW_ALL,
  PROMOTE_CONFIRM_CONFIRM,
  PROMOTE_CONFIRM_CANCEL,
  PROMOTE_SUMMARY_FILES,
  PROMOTE_SUMMARY_PLUS_MINUS,
} from "./branchOps/copy";
import type { PromoteSummary } from "../../../core/checkpoints.js";

interface Props {
  summary: PromoteSummary;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Promote-confirm modal — shown after right-click → "Make this the new main".
 * Renders a compact diff summary (file count, +/- lines, top-5 paths) plus an
 * expandable "View all changes" list.
 */
export function PromoteConfirm({ summary, onConfirm, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <CheckpointModal
      title={PROMOTE_CONFIRM_TITLE}
      onClose={onCancel}
      footer={
        <>
          <button
            className="btn-secondary"
            onClick={onCancel}
            data-testid="promote-cancel"
          >
            {PROMOTE_CONFIRM_CANCEL}
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            data-testid="promote-confirm"
          >
            {PROMOTE_CONFIRM_CONFIRM}
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 12 }}>{PROMOTE_CONFIRM_BODY}</p>

      <div
        data-testid="promote-summary-stats"
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          marginBottom: 10,
          color: "var(--foreground-muted)",
        }}
      >
        {PROMOTE_SUMMARY_FILES(summary.fileCount)} ·{" "}
        <span style={{ color: "var(--status-success, #a6e3a1)" }}>
          +{summary.added}
        </span>{" "}
        <span style={{ color: "var(--status-error, #f38ba8)" }}>
          -{summary.removed}
        </span>
        <span style={{ marginLeft: 6, color: "var(--foreground-dim)" }}>
          ({PROMOTE_SUMMARY_PLUS_MINUS(summary.added, summary.removed)})
        </span>
      </div>

      {summary.topPaths.length > 0 && (
        <div
          data-testid="promote-summary-paths"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            maxHeight: expanded ? 280 : 110,
            overflow: "auto",
          }}
        >
          {(expanded ? summary.fullPaths : summary.topPaths).map((p) => (
            <div key={p} style={{ padding: "1px 0" }}>
              {p}
            </div>
          ))}
        </div>
      )}

      {!expanded && summary.fullPaths.length > summary.topPaths.length && (
        <button
          type="button"
          data-testid="promote-summary-expand"
          onClick={() => setExpanded(true)}
          style={{
            marginTop: 8,
            background: "transparent",
            border: "none",
            color: "var(--foreground-link, #89b4fa)",
            cursor: "pointer",
            fontSize: 12,
            padding: 0,
          }}
        >
          {PROMOTE_CONFIRM_VIEW_ALL} (+{summary.fullPaths.length - summary.topPaths.length})
        </button>
      )}
    </CheckpointModal>
  );
}
