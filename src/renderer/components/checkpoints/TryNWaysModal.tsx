import { useEffect, useState } from "react";
import { CheckpointModal } from "./Modal";
import type { StepType } from "../../../core/types.js";

interface Props {
  projectDir: string;
  tag: string;
  /** Stage of the next-after-tag — used for cost estimate and parallel classification. */
  nextStage: StepType;
  onCancel: () => void;
  onConfirm: (n: number) => Promise<void>;
}

interface Estimate {
  perVariantMedian: number | null;
  perVariantP75: number | null;
  totalMedian: number | null;
  totalP75: number | null;
  sampleSize: number;
}

export function TryNWaysModal({ projectDir, tag, nextStage, onCancel, onConfirm }: Props) {
  const [n, setN] = useState(3);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.dexAPI.checkpoints
      .estimateVariantCost(projectDir, nextStage, n)
      .then((e) => {
        if (!cancelled) setEstimate(e as Estimate);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir, nextStage, n]);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(n);
    } finally {
      setBusy(false);
    }
  };

  return (
    <CheckpointModal
      title={`Try N ways — next step: ${nextStage}`}
      onClose={onCancel}
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleConfirm} disabled={busy}>
            Spawn {n} variants
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 10, fontSize: 13 }}>
        Fork <code>{tag}</code> into <strong>{n}</strong> parallel attempts of{" "}
        <code>{nextStage}</code>.
      </p>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span>Variants:</span>
        <input
          type="number"
          min={2}
          max={5}
          value={n}
          onChange={(e) => setN(Math.max(2, Math.min(5, Number(e.target.value) || 3)))}
          style={{
            width: 56,
            padding: "4px 6px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        />
      </label>
      <div
        style={{
          padding: 10,
          background: "var(--surface-elevated)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          fontSize: 12,
        }}
      >
        {estimate && estimate.sampleSize > 0 ? (
          <>
            <div>
              Estimated cost per variant: <strong>${estimate.perVariantMedian?.toFixed(2)}</strong> (median)
              {" · "}${estimate.perVariantP75?.toFixed(2)} (p75)
            </div>
            <div>
              Total: <strong>${estimate.totalMedian?.toFixed(2)}</strong> – ${estimate.totalP75?.toFixed(2)}
            </div>
            <div style={{ color: "var(--foreground-dim)", marginTop: 4 }}>
              from {estimate.sampleSize} recent run{estimate.sampleSize === 1 ? "" : "s"} of {nextStage}
            </div>
          </>
        ) : (
          <div style={{ color: "var(--foreground-muted)" }}>
            No cost history yet — estimate unavailable.
          </div>
        )}
      </div>
    </CheckpointModal>
  );
}
