/**
 * What: The queue as the files say it is (research R17, FR-043) — one row per entry with its title, derived status, next stage, task phase and cost; the queue or policy errors that make Dex refuse to start; and the answers Dex gave by default (recommended-then-review) for the human to review.
 * Not: Derives nothing: every value comes from the run snapshot (core picker.describeQueue + state.json). Does not start or answer anything.
 * Deps: RunSnapshot / ReviewItem types, lucide-react.
 */
import { Circle, CircleCheck, CircleDot, ListChecks, SkipForward, TriangleAlert } from "lucide-react";
import type { ReviewItem } from "../../../core/humanInput.js";
import type { QueueViewEntry } from "../../../core/picker.js";
import type { RunSnapshot } from "../../../core/run-snapshot.js";

const STATUS_ICON = {
  done: { Icon: CircleCheck, color: "var(--status-success)" },
  active: { Icon: CircleDot, color: "var(--primary)" },
  pending: { Icon: Circle, color: "var(--foreground-dim)" },
  skipped: { Icon: SkipForward, color: "var(--foreground-dim)" },
} as const;

const heading = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "0.72rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--foreground-muted)",
  marginBottom: 6,
} as const;

const usd = (n: number) => `$${n.toFixed(2)}`;

function nextOf(e: QueueViewEntry): string {
  if (!e.nextStage) return "—";
  return e.taskPhase === null ? e.nextStage : `${e.nextStage} · phase ${e.taskPhase}`;
}

function EntryRow({ entry }: { entry: QueueViewEntry }) {
  const { Icon, color } = STATUS_ICON[entry.status];
  return (
    <div
      data-testid="queue-row"
      title={entry.reason}
      style={{
        display: "grid",
        gridTemplateColumns: "16px minmax(0, 1fr) 72px 150px 64px",
        alignItems: "center",
        gap: 10,
        padding: "5px 8px",
        borderRadius: "var(--radius)",
        background: entry.status === "active" ? "var(--primary-muted)" : "transparent",
        fontSize: "0.78rem",
      }}
    >
      <Icon size={14} style={{ color }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--foreground)" }}>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--foreground-muted)", marginRight: 8 }}>{entry.id}</span>
        {entry.title}
      </span>
      <span data-testid="queue-row-status" style={{ color }}>
        {entry.status}
      </span>
      <span data-testid="queue-row-next" style={{ color: "var(--foreground-muted)" }}>
        {nextOf(entry)}
      </span>
      <span style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--foreground-muted)" }}>
        {usd(entry.costUsd)}
      </span>
    </div>
  );
}

function Errors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div data-testid="queue-errors" style={{ marginBottom: 10 }}>
      {errors.map((e) => (
        <div key={e} style={{ display: "flex", gap: 6, fontSize: "0.78rem", color: "var(--status-error)" }}>
          <TriangleAlert size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{e}</span>
        </div>
      ))}
    </div>
  );
}

function ReviewList({ items }: { items: ReviewItem[] }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="review-list" style={{ marginTop: 12 }}>
      <div style={heading}>
        <ListChecks size={13} />
        Answered by default — review
      </div>
      {items.map((r) => (
        <div key={`${r.at}-${r.question}`} style={{ fontSize: "0.76rem", color: "var(--foreground-muted)", padding: "2px 8px" }}>
          ({r.entryId ?? "project"} · {r.stage}) “{r.question}” → <strong style={{ color: "var(--foreground)" }}>{r.answer}</strong>
        </div>
      ))}
    </div>
  );
}

export function QueuePanel({ snapshot }: { snapshot: RunSnapshot | null }) {
  if (!snapshot || (!snapshot.queue && snapshot.errors.length === 0)) return null;
  const { queue, errors, state } = snapshot;
  const total = queue?.entries.reduce((sum, e) => sum + e.costUsd, 0) ?? 0;
  return (
    <div
      data-testid="queue-panel"
      style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
    >
      <div style={{ ...heading, justifyContent: "space-between" }}>
        <span>Queue{queue ? ` · ${queue.kind} project` : ""}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>{usd(total)}</span>
      </div>
      <Errors errors={errors} />
      {queue?.entries.map((e) => (
        <EntryRow key={e.id} entry={e} />
      ))}
      <ReviewList items={state?.reviewList ?? []} />
    </div>
  );
}
