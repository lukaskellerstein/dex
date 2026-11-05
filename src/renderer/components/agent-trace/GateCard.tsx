/**
 * What: One of Dex's own gate decisions in the trace (016 FR-038, contracts/ipc-events.md § UI) — the gate, pass / fail / pause, the reason, and each sensor run with its result and duration; a run's output tail is folded until clicked.
 * Not: Decides nothing and fetches nothing: everything comes from the `gate` step GateTracker built from the events.
 * Deps: GateCard.logic (GateStepMeta), lucide-react.
 */
import { ChevronDown, ChevronRight, CircleCheck, CirclePause, CircleX, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { SensorRun } from "../../../core/sensors.js";
import type { GateStepMeta } from "./GateCard.logic.js";

const OUTCOME = {
  pass: { Icon: CircleCheck, color: "var(--status-success)" },
  fail: { Icon: CircleX, color: "var(--status-error)" },
  pause: { Icon: CirclePause, color: "var(--status-warning)" },
} as const;

const green = (r: SensorRun) => r.result === "pass" || r.result === "flaky";
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function RunRow({ run }: { run: SensorRun }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  const code = run.exitCode === null ? run.result : `exit ${run.exitCode}`;
  return (
    <div data-testid="gate-run">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={run.tail.length === 0}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "2px 0",
          background: "none",
          border: "none",
          cursor: run.tail.length === 0 ? "default" : "pointer",
          fontSize: "0.78rem",
          color: "var(--foreground)",
          textAlign: "left",
        }}
      >
        <Chevron size={12} style={{ color: "var(--foreground-dim)", opacity: run.tail.length === 0 ? 0 : 1 }} />
        <span style={{ fontFamily: "var(--font-mono)" }}>{run.name}</span>
        <span
          data-testid="gate-run-result"
          style={{ color: green(run) ? "var(--status-success)" : "var(--status-error)" }}
        >
          {run.result}
        </span>
        <span style={{ color: "var(--foreground-dim)" }}>
          {code} · {secs(run.durationMs)}
          {run.reruns > 0 ? ` · ${run.reruns} re-run${run.reruns > 1 ? "s" : ""}` : ""}
        </span>
      </button>
      {open && (
        <pre
          data-testid="gate-run-tail"
          style={{
            margin: "4px 0 6px 18px",
            padding: 8,
            maxHeight: 240,
            overflow: "auto",
            fontSize: "0.72rem",
            background: "var(--surface-elevated)",
            borderRadius: "var(--radius)",
            color: "var(--foreground-muted)",
            whiteSpace: "pre-wrap",
          }}
        >
          {run.tail.join("\n")}
        </pre>
      )}
    </div>
  );
}

export function GateCard({ meta }: { meta: GateStepMeta }) {
  const { decision, runs } = meta;
  const { Icon, color } = OUTCOME[decision.outcome];
  return (
    <div
      data-testid="gate-card"
      style={{
        margin: "6px 0",
        padding: "8px 12px",
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${color}`,
        borderRadius: "var(--radius)",
        background: "var(--surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.8rem" }}>
        <ShieldCheck size={14} style={{ color: "var(--foreground-muted)" }} />
        <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{decision.gate} gate</span>
        <Icon size={14} style={{ color }} />
        <span data-testid="gate-outcome" style={{ color }}>
          {decision.outcome}
        </span>
      </div>
      <div data-testid="gate-reason" style={{ margin: "4px 0", fontSize: "0.78rem", color: "var(--foreground-muted)" }}>
        {decision.reason}
      </div>
      {runs.map((run, i) => (
        <RunRow key={`${run.name}-${i}`} run={run} />
      ))}
    </div>
  );
}
