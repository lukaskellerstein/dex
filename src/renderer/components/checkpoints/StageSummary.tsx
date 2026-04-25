import type { StepType } from "../../../core/types.js";

interface Props {
  step: StepType;
  cycleNumber: number;
  featureSlug?: string | null;
  cost?: number;
  durationMs?: number;
  commitMessage?: string;
  /** Optional free-form notes or extracted artefact content. */
  extra?: string;
}

const STAGE_HEADLINES: Record<StepType, string> = {
  prerequisites: "Environment checked, tools available.",
  create_branch: "Branch created.",
  clarification: "All clarification rounds completed.",
  clarification_product: "Product domain questions answered.",
  clarification_technical: "Technical domain questions answered.",
  clarification_synthesis: "Requirements synthesized.",
  constitution: "Constitution drafted.",
  manifest_extraction: "Features identified.",
  gap_analysis: "Gap analysis complete — next feature decided.",
  specify: "Spec written.",
  plan: "Plan written.",
  tasks: "Tasks generated.",
  implement: "Implementation pass complete.",
  implement_fix: "Fixes applied.",
  verify: "Verification complete.",
  learnings: "Learnings captured.",
  commit: "Checkpoint committed.",
};

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function StageSummary({
  step,
  cycleNumber,
  featureSlug,
  cost,
  durationMs,
  commitMessage,
  extra,
}: Props) {
  return (
    <div
      style={{
        padding: 10,
        background: "var(--surface-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div>
        <strong>{step}</strong>
        {cycleNumber > 0 && <span style={{ color: "var(--foreground-muted)" }}> · cycle {cycleNumber}</span>}
        {featureSlug && <span style={{ color: "var(--foreground-muted)" }}> · {featureSlug}</span>}
      </div>
      <div style={{ color: "var(--foreground-muted)" }}>{STAGE_HEADLINES[step] ?? step}</div>
      {(cost !== undefined || durationMs !== undefined) && (
        <div style={{ color: "var(--foreground-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {cost !== undefined && <span>cost ${cost.toFixed(2)} · </span>}
          {durationMs !== undefined && <span>duration {formatDuration(durationMs)}</span>}
        </div>
      )}
      {commitMessage && (
        <pre
          style={{
            margin: 0,
            padding: 6,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflow: "auto",
          }}
        >
          {commitMessage}
        </pre>
      )}
      {extra && (
        <div style={{ color: "var(--foreground-muted)", whiteSpace: "pre-wrap" }}>{extra}</div>
      )}
    </div>
  );
}
