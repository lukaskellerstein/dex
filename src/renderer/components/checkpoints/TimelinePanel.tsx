import { useCallback, useState } from "react";
import { useTimeline } from "./hooks/useTimeline";
import { PastAttemptsList, type SelectedNode } from "./PastAttemptsList";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { GoBackConfirm } from "./GoBackConfirm";
import { TimelineGraph } from "./TimelineGraph";

interface Props {
  projectDir: string;
  /** Disabled: no git repo / no identity. */
  disabled?: boolean;
  disabledReason?: string;
  /** When US4 lands, parent opens the variant spawn flow. */
  onTryNWays?: (tag: string) => void;
  /** When US6 lands, parent opens the attempt compare modal. */
  onCompareStart?: (branch: string) => void;
  /** Called after the user takes an action that may require an orchestrator nudge. */
  onAttemptSwitched?: () => void;
  /** When true, the "Keep this" action is enabled (step mode + pending candidate selected). */
  canPromote?: boolean;
  canTryNWays?: boolean;
}

interface DirtyEnvelope {
  tag: string;
  files: string[];
}

/**
 * Container for the checkpoint UX. Composes the graph (above) + past-attempts
 * list (below) + detail panel (side) + dirty-tree modal.
 */
export function TimelinePanel({
  projectDir,
  disabled,
  disabledReason,
  onTryNWays,
  onCompareStart,
  onAttemptSwitched,
  canPromote,
  canTryNWays,
}: Props) {
  const { snapshot, refresh } = useTimeline(projectDir);
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [dirty, setDirty] = useState<DirtyEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);

  const performGoBack = useCallback(
    async (tag: string, force?: "save" | "discard") => {
      setError(null);
      const r = await window.dexAPI.checkpoints.goBack(projectDir, tag, force ? { force } : undefined);
      if (r.ok) {
        await refresh();
        onAttemptSwitched?.();
        return true;
      }
      if (r.error === "dirty_working_tree") {
        setDirty({ tag, files: (r as { files: string[] }).files });
        return false;
      }
      setError(`Go back failed: ${r.error}`);
      return false;
    },
    [projectDir, refresh, onAttemptSwitched],
  );

  const handleGoBack = useCallback((tag: string) => performGoBack(tag), [performGoBack]);

  const handleTryAgain = useCallback(
    async (tag: string) => {
      const ok = await performGoBack(tag);
      if (!ok) return;
      // Caller (LoopDashboard) can pick up the "re-run the step" from onAttemptSwitched
      // — we don't automatically start the orchestrator here; that's a cross-cutting decision.
    },
    [performGoBack],
  );

  const handleKeep = useCallback(
    async (tag: string, sha: string) => {
      setError(null);
      const r = await window.dexAPI.checkpoints.promote(projectDir, tag, sha);
      if (!r.ok) setError(`Keep failed: ${r.error}`);
      else await refresh();
    },
    [projectDir, refresh],
  );

  if (disabled) {
    return (
      <div
        style={{
          padding: 12,
          color: "var(--foreground-muted)",
          fontSize: 12,
          border: "1px dashed var(--border)",
          borderRadius: "var(--radius)",
          background: "var(--surface)",
        }}
      >
        {disabledReason ?? "Timeline disabled."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
      {error && (
        <div
          role="alert"
          style={{
            padding: 8,
            color: "var(--status-error)",
            border: "1px solid var(--status-error)",
            borderRadius: "var(--radius)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 300px",
          gap: 8,
          minHeight: 240,
        }}
      >
        <TimelineGraph
          snapshot={snapshot}
          selectedId={
            selected?.kind === "checkpoint"
              ? selected.data.tag
              : selected?.kind === "attempt"
                ? selected.data.branch
                : null
          }
          onSelect={setSelected}
        />
        <NodeDetailPanel
          selected={selected}
          onGoBack={handleGoBack}
          onTryAgain={handleTryAgain}
          onTryNWays={onTryNWays}
          onKeep={handleKeep}
          onCompare={onCompareStart}
          canPromote={canPromote}
          canTryNWays={canTryNWays}
        />
      </div>
      <PastAttemptsList
        snapshot={snapshot}
        onSelect={setSelected}
        selectedId={
          selected?.kind === "checkpoint"
            ? selected.data.tag
            : selected?.kind === "attempt"
              ? selected.data.branch
              : null
        }
      />
      {dirty && (
        <GoBackConfirm
          tag={dirty.tag}
          files={dirty.files}
          onCancel={() => setDirty(null)}
          onChoose={async (action) => {
            const tag = dirty.tag;
            setDirty(null);
            await performGoBack(tag, action);
          }}
        />
      )}
    </div>
  );
}
