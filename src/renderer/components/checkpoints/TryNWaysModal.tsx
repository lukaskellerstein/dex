import { useEffect, useMemo, useState } from "react";
import { CheckpointModal } from "./Modal";
import { AgentProfileForm, DEFAULT_SLOT, type VariantSlotState } from "./AgentProfileForm";
import type { StepType } from "../../../core/types.js";
import type { ProfileEntry } from "../../../core/agent-profile.js";
import { checkpointService } from "../../services/checkpointService.js";
import { profilesService } from "../../services/profilesService.js";

const PARALLELIZABLE_STEPS: ReadonlySet<StepType> = new Set([
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "learnings",
]);

interface Props {
  projectDir: string;
  tag: string;
  /** Stage of the next-after-tag — used for cost estimate, parallel classification, and overlay-applies. */
  nextStage: StepType;
  onCancel: () => void;
  /** Spawn signature: passes through to checkpoints:spawnVariants. */
  onConfirm: (n: number, slots: VariantSlotState[]) => Promise<void>;
}

interface Estimate {
  perVariantMedian: number | null;
  perVariantP75: number | null;
  totalMedian: number | null;
  totalP75: number | null;
  sampleSize: number;
}

const LETTERS = ["A", "B", "C", "D", "E"];

export function TryNWaysModal({ projectDir, tag, nextStage, onCancel, onConfirm }: Props) {
  const [n, setN] = useState(3);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<ProfileEntry[] | null>(null);
  const [slots, setSlots] = useState<VariantSlotState[]>(() =>
    Array.from({ length: 5 }, () => ({ ...DEFAULT_SLOT })),
  );
  const [applySame, setApplySame] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);

  const isParallel = PARALLELIZABLE_STEPS.has(nextStage);

  // Load profile list on open.
  useEffect(() => {
    let cancelled = false;
    profilesService
      .list(projectDir)
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // Cost estimate.
  useEffect(() => {
    let cancelled = false;
    checkpointService
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

  const handleSlotChange = (i: number, next: VariantSlotState) => {
    if (applySame) {
      // Propagate slot 0's state to all visible slots.
      setSlots((prev) =>
        prev.map((s, idx) => (idx < n ? next : s)),
      );
      return;
    }
    setSlots((prev) => prev.map((s, idx) => (idx === i ? next : s)));
  };

  const handleApplySameToggle = (on: boolean) => {
    setApplySame(on);
    if (on) {
      // Propagate slot 0 to all visible slots.
      setSlots((prev) => prev.map((s, idx) => (idx < n ? prev[0] : s)));
    }
  };

  const handleSaveBack = async (name: string, slot: VariantSlotState) => {
    setBusyMsg(`Saving ${name}…`);
    const r = await profilesService.saveDexJson(projectDir, name, {
      agentRunner: slot.agentRunner,
      model: slot.model,
      systemPromptAppend: slot.systemPromptAppend || undefined,
      allowedTools: slot.allowedTools.length > 0 ? slot.allowedTools : undefined,
    });
    if (r.ok) {
      // Refresh entries so the chip + dropdown reflect the new state.
      const fresh = await profilesService.list(projectDir);
      setEntries(fresh);
      setBusyMsg(`Saved ${name}.`);
      window.setTimeout(() => setBusyMsg(null), 1500);
    } else {
      setBusyMsg(`Save failed: ${(r as { error?: string }).error ?? "unknown"}`);
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await onConfirm(n, slots.slice(0, n));
    } finally {
      setBusy(false);
    }
  };

  const okCount = useMemo(
    () => (entries ?? []).filter((e) => e.kind === "ok").length,
    [entries],
  );

  return (
    <CheckpointModal
      title={`Try N ways — next step: ${nextStage}`}
      onClose={onCancel}
      footer={
        <>
          {busyMsg && (
            <span style={{ marginRight: "auto", fontSize: 11, color: "var(--foreground-muted)" }}>
              {busyMsg}
            </span>
          )}
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleConfirm} disabled={busy}>
            Run {n} variants
          </button>
        </>
      }
    >
      {/* Header: variant count + apply-same */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
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
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={applySame}
            onChange={(e) => handleApplySameToggle(e.target.checked)}
          />
          Apply same profile to all
        </label>
      </div>

      <p style={{ marginBottom: 10, fontSize: 12, color: "var(--foreground-muted)" }}>
        Fork <code>{tag}</code> into <strong>{n}</strong> parallel attempts of{" "}
        <code>{nextStage}</code>.
      </p>

      {/* Sequential-stage warning */}
      {!isParallel && (
        <div
          style={{
            padding: 8,
            marginBottom: 10,
            background: "color-mix(in srgb, var(--status-warning, #f59e0b) 12%, var(--surface))",
            border: "1px solid var(--status-warning, #f59e0b)",
            borderRadius: "var(--radius)",
            color: "var(--status-warning, #f59e0b)",
            fontSize: 12,
          }}
          data-testid="sequential-warning"
        >
          <strong>Sequential stage.</strong> The <code>.claude/</code> overlay is{" "}
          <em>not applied</em> on <code>{nextStage}</code> in v1 — only the Dex-side knobs
          (model, persona, allowed tools) take effect. Variants run serially on the project
          root, not in parallel worktrees.
        </div>
      )}

      {/* Empty-profiles stub */}
      {entries && okCount === 0 && (
        <div
          style={{
            padding: 10,
            marginBottom: 10,
            background: "var(--surface-elevated)",
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 12,
            color: "var(--foreground-muted)",
          }}
          data-testid="empty-profiles-stub"
        >
          No agent profiles defined for this project. Variants will run with the project
          default. To add profiles, create folders under{" "}
          <code>{`<projectDir>/.dex/agents/<name>/`}</code> with a <code>dex.json</code>{" "}
          file and reopen this modal.
        </div>
      )}

      {/* Per-variant rows */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflow: "auto" }}>
        {Array.from({ length: n }, (_, i) => (
          <AgentProfileForm
            key={i}
            entries={entries ?? []}
            value={slots[i]}
            onChange={(next) => handleSlotChange(i, next)}
            disabledExceptDropdown={applySame && i > 0}
            onSaveBack={handleSaveBack}
            slotLabel={LETTERS[i] ?? String(i)}
            hideSaveBack={okCount === 0}
          />
        ))}
      </div>

      {/* Cost estimate footer */}
      <div
        style={{
          marginTop: 10,
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
              Estimated cost per variant:{" "}
              <strong>${estimate.perVariantMedian?.toFixed(2)}</strong> (median)
              {" · "}${estimate.perVariantP75?.toFixed(2)} (p75)
            </div>
            <div>
              Total: <strong>${estimate.totalMedian?.toFixed(2)}</strong> – $
              {estimate.totalP75?.toFixed(2)}
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
