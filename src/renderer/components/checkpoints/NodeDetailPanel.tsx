import type { SelectedNode } from "./PastAttemptsList";

interface Props {
  selected: SelectedNode | null;
  /** Called when user clicks Go back — parent handles dirty-tree modal flow. */
  onGoBack: (tag: string) => void;
  /** Called when user clicks Try again — parent handles go-back + orchestrator start. */
  onTryAgain: (tag: string) => void;
  /** Called when user clicks Try N ways — opens variant cost estimate modal. */
  onTryNWays?: (tag: string) => void;
  /** Called when user clicks Keep this on a pending candidate. */
  onKeep?: (tag: string, sha: string) => void;
  /** Called when user clicks Compare on an attempt (US6). */
  onCompare?: (branch: string) => void;
  /** Enabled only when US3 step-mode is active and a pending candidate is selected. */
  canPromote?: boolean;
  /** Enabled only when US4 has landed. */
  canTryNWays?: boolean;
}

/**
 * Right-side panel that shows a summary of the selected checkpoint/attempt
 * and the applicable action buttons. In US1, Keep and Try N ways are absent
 * or disabled; US3 + US4 wire them in.
 */
export function NodeDetailPanel({
  selected,
  onGoBack,
  onTryAgain,
  onTryNWays,
  onKeep,
  onCompare,
  canPromote,
  canTryNWays,
}: Props) {
  if (!selected) {
    return (
      <div
        style={{
          padding: 12,
          color: "var(--foreground-dim)",
          fontSize: 12,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
          minHeight: 120,
        }}
      >
        Select a checkpoint or attempt to see details.
      </div>
    );
  }

  const isCheckpoint = selected.kind === "checkpoint";
  const tag = isCheckpoint ? selected.data.tag : null;

  return (
    <div
      style={{
        padding: 14,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>
          {isCheckpoint ? selected.data.label : selected.data.branch}
        </div>
        <div style={{ fontSize: 11, color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
          {isCheckpoint ? selected.data.tag : selected.data.branch}
        </div>
      </div>
      {isCheckpoint && (
        <div style={{ fontSize: 12, color: "var(--foreground-muted)" }}>
          <div>step: {selected.data.step}</div>
          <div>cycle: {selected.data.cycleNumber}</div>
          {selected.data.featureSlug && <div>feature: {selected.data.featureSlug}</div>}
          {selected.data.sha && (
            <div style={{ fontFamily: "var(--font-mono)" }}>sha: {selected.data.sha.slice(0, 7)}</div>
          )}
        </div>
      )}
      {!isCheckpoint && (
        <div style={{ fontSize: 12, color: "var(--foreground-muted)" }}>
          <div>base: {selected.data.baseCheckpoint ?? "—"}</div>
          <div>
            {selected.data.stepsAhead} step{selected.data.stepsAhead === 1 ? "" : "s"} ahead
          </div>
          {selected.data.isCurrent && (
            <div style={{ color: "var(--status-success)" }}>current attempt</div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isCheckpoint && tag && !selected.data.unavailable && (
          <>
            <button className="btn-secondary" onClick={() => onGoBack(tag)}>
              Go back
            </button>
            <button className="btn-primary" onClick={() => onTryAgain(tag)}>
              Try again
            </button>
            {onTryNWays && (
              <button
                className="btn-secondary"
                onClick={() => onTryNWays(tag)}
                disabled={!canTryNWays}
                title={canTryNWays ? "Fork N variants of the next step" : "Available after US4 lands"}
              >
                Try N ways
              </button>
            )}
            {onKeep && canPromote && selected.data.sha && (
              <button className="btn-primary" onClick={() => onKeep(tag, selected.data.sha)}>
                Keep this
              </button>
            )}
          </>
        )}
        {!isCheckpoint && onCompare && (
          <button className="btn-secondary" onClick={() => onCompare(selected.data.branch)}>
            Compare…
          </button>
        )}
      </div>
    </div>
  );
}
