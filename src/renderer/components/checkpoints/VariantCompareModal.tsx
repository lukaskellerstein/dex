import { useEffect, useState } from "react";
import { CheckpointModal } from "./Modal";
import { StageSummary } from "./StageSummary";
import type { VariantGroupFile } from "../../../core/checkpoints.js";
import { checkpointService } from "../../services/checkpointService.js";

interface Props {
  projectDir: string;
  group: VariantGroupFile;
  onKeep: (letter: string) => Promise<void>;
  onDiscardAll: () => Promise<void>;
  onClose: () => void;
}

interface DiffState {
  [letter: string]: {
    loading: boolean;
    diff?: string;
    error?: string;
  };
}

/**
 * Opens when variant_group_complete fires for a group. Shows N panes with
 * per-variant step summary + step-aware diff against the fromCheckpoint.
 * User picks one via Keep this, discards all, or dismisses.
 */
export function VariantCompareModal({
  projectDir,
  group,
  onKeep,
  onDiscardAll,
  onClose,
}: Props) {
  const [diffs, setDiffs] = useState<DiffState>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: DiffState = {};
      for (const v of group.variants) {
        next[v.letter] = { loading: true };
      }
      setDiffs(next);
      for (const v of group.variants) {
        try {
          const r = await checkpointService.compareAttempts(
            projectDir,
            group.fromCheckpoint,
            v.branch,
            group.step,
          );
          if (cancelled) return;
          setDiffs((prev) => ({
            ...prev,
            [v.letter]: r.ok
              ? { loading: false, diff: r.diff }
              : { loading: false, error: r.error },
          }));
        } catch (err) {
          if (cancelled) return;
          setDiffs((prev) => ({
            ...prev,
            [v.letter]: { loading: false, error: String(err) },
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir, group]);

  const handleKeep = async (letter: string) => {
    setBusy(true);
    try {
      await onKeep(letter);
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    setBusy(true);
    try {
      await onDiscardAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <CheckpointModal
      title={`Compare ${group.variants.length} variants · ${group.step}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn-secondary" onClick={handleDiscard} disabled={busy}>
            Discard all
          </button>
          <button className="btn-secondary" onClick={onClose} disabled={busy}>
            Close
          </button>
        </>
      }
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${group.variants.length}, minmax(220px, 1fr))`,
          gap: 10,
        }}
      >
        {group.variants.map((v) => {
          const d = diffs[v.letter];
          const failed = v.status === "failed";
          return (
            <div
              key={v.letter}
              style={{
                border: failed ? "1px solid var(--status-error)" : "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: 10,
                background: "var(--surface)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                minHeight: 260,
              }}
            >
              <div style={{ fontWeight: 700 }}>
                Variant {v.letter.toUpperCase()}
                {failed && <span style={{ color: "var(--status-error)" }}> (failed)</span>}
              </div>
              <StageSummary step={group.step} cycleNumber={0} />
              <div style={{ fontSize: 11, color: "var(--foreground-dim)", fontFamily: "var(--font-mono)" }}>
                {v.branch}
              </div>
              <div
                style={{
                  flex: 1,
                  minHeight: 100,
                  maxHeight: 240,
                  overflow: "auto",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius)",
                  padding: 6,
                  background: "var(--surface-elevated)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  whiteSpace: "pre-wrap",
                }}
              >
                {d?.loading && "loading diff…"}
                {d?.error && <span style={{ color: "var(--status-error)" }}>error: {d.error}</span>}
                {d?.diff !== undefined && !d.error && (d.diff.trim() ? d.diff : "(no changes)")}
              </div>
              <button
                className="btn-primary"
                onClick={() => handleKeep(v.letter)}
                disabled={busy || failed || !v.candidateSha}
              >
                Keep this
              </button>
            </div>
          );
        })}
      </div>
    </CheckpointModal>
  );
}
