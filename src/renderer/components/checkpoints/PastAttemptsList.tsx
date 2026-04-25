import { useMemo, useState } from "react";
import type {
  CheckpointInfo,
  AttemptInfo,
  TimelineSnapshot,
} from "../../../core/checkpoints.js";

export type SelectedNode =
  | { kind: "checkpoint"; data: CheckpointInfo }
  | { kind: "attempt"; data: AttemptInfo };

interface Props {
  snapshot: TimelineSnapshot;
  onSelect: (node: SelectedNode) => void;
  selectedId: string | null;
}

/**
 * Collapsible searchable list of every checkpoint and attempt in the snapshot.
 * Ships as part of US1 MVP — US2 layers the D3 graph on top of this same data.
 */
export function PastAttemptsList({ snapshot, onSelect, selectedId }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);

  const filteredCheckpoints = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snapshot.checkpoints;
    return snapshot.checkpoints.filter(
      (c) =>
        c.tag.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        c.step.toLowerCase().includes(q),
    );
  }, [snapshot.checkpoints, query]);

  const filteredAttempts = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snapshot.attempts;
    return snapshot.attempts.filter((a) => a.branch.toLowerCase().includes(q));
  }, [snapshot.attempts, query]);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          background: "var(--surface-elevated)",
          color: "var(--foreground)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          cursor: "pointer",
          marginBottom: 6,
        }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>
          Timeline ({snapshot.checkpoints.length} checkpoint
          {snapshot.checkpoints.length === 1 ? "" : "s"},{" "}
          {snapshot.attempts.length} attempt
          {snapshot.attempts.length === 1 ? "" : "s"})
        </span>
      </button>
      {open && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--surface)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <input
            placeholder="Filter…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              margin: 6,
              padding: "5px 8px",
              background: "var(--surface-elevated)",
              color: "var(--foreground)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          />
          <div style={{ padding: "0 6px 6px", fontSize: 12, overflow: "auto", maxHeight: 360 }}>
            <div
              style={{
                fontWeight: 600,
                color: "var(--foreground-muted)",
                margin: "4px 0",
              }}
            >
              Checkpoints
            </div>
            {filteredCheckpoints.length === 0 ? (
              <div style={{ color: "var(--foreground-dim)", padding: "2px 4px" }}>
                none
              </div>
            ) : (
              filteredCheckpoints.map((c) => (
                <button
                  key={c.tag}
                  onClick={() => onSelect({ kind: "checkpoint", data: c })}
                  disabled={c.unavailable}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 8px",
                    background:
                      selectedId === c.tag ? "var(--primary-muted)" : "transparent",
                    color: c.unavailable ? "var(--foreground-dim)" : "var(--foreground)",
                    border: "none",
                    borderRadius: "var(--radius)",
                    cursor: c.unavailable ? "not-allowed" : "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div>{c.label}</div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--foreground-dim)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {c.unavailable ? "(unavailable — refresh)" : c.tag}
                  </div>
                </button>
              ))
            )}
            <div
              style={{
                fontWeight: 600,
                color: "var(--foreground-muted)",
                margin: "10px 0 4px",
              }}
            >
              Attempts
            </div>
            {filteredAttempts.length === 0 ? (
              <div style={{ color: "var(--foreground-dim)", padding: "2px 4px" }}>
                none
              </div>
            ) : (
              filteredAttempts.map((a) => (
                <button
                  key={a.branch}
                  onClick={() => onSelect({ kind: "attempt", data: a })}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "4px 8px",
                    background:
                      selectedId === a.branch ? "var(--primary-muted)" : "transparent",
                    color: "var(--foreground)",
                    border: "none",
                    borderRadius: "var(--radius)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div>
                    {a.branch} {a.isCurrent && <em style={{ color: "var(--status-success)" }}>(current)</em>}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--foreground-dim)" }}>
                    from {a.baseCheckpoint ?? "?"} · {a.stepsAhead} step
                    {a.stepsAhead === 1 ? "" : "s"} ahead
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
