import { useEffect, useState } from "react";
import { CheckpointModal } from "./Modal";
import type { StepType } from "../../../core/types.js";

interface Props {
  projectDir: string;
  branchA: string;
  branchB: string;
  /** If null, compare falls back to git diff --stat. */
  step: StepType | null;
  onClose: () => void;
}

export function AttemptCompareModal({ projectDir, branchA, branchB, step, onClose }: Props) {
  const [state, setState] = useState<{
    loading: boolean;
    diff?: string;
    mode?: string;
    error?: string;
  }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ loading: true });
      try {
        const r = await window.dexAPI.checkpoints.compareAttempts(
          projectDir,
          branchA,
          branchB,
          step,
        );
        if (cancelled) return;
        if (r.ok) {
          setState({ loading: false, diff: r.diff, mode: r.mode });
        } else {
          setState({ loading: false, error: r.error });
        }
      } catch (err) {
        if (cancelled) return;
        setState({ loading: false, error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir, branchA, branchB, step]);

  return (
    <CheckpointModal
      title={`Compare attempts`}
      onClose={onClose}
      wide
      footer={
        <button className="btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div style={{ marginBottom: 8, fontSize: 12, color: "var(--foreground-muted)" }}>
        <div>
          <strong>A:</strong> <code>{branchA}</code>
        </div>
        <div>
          <strong>B:</strong> <code>{branchB}</code>
        </div>
        <div>
          step: {step ?? "—"} · mode: {state.mode ?? "?"}
        </div>
      </div>
      {state.loading && <div>loading diff…</div>}
      {state.error && (
        <div role="alert" style={{ color: "var(--status-error)" }}>
          {state.error}
        </div>
      )}
      {state.diff !== undefined && !state.error && (
        <pre
          style={{
            maxHeight: "60vh",
            overflow: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {state.diff.trim() ? state.diff : "(no changes)"}
        </pre>
      )}
    </CheckpointModal>
  );
}
