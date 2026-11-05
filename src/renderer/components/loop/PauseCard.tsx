/**
 * What: The card for the pause a run ended on — a gate, a limit, a dirty tree, a frozen file, a failed preflight, no progress or bad input — with its detail, the link to its entry's digest when the pause wrote one (016), and its options. Continue is Resume (research R10: Resume is the approval); Stop leaves the run paused and closes the card.
 * Not: Does not resolve anything through `answer-request`: no agent waits on a pause, the run already ended. Does not show a Stop pause (`user_abort` records no request).
 * Deps: PendingRequest (core humanInput), DigestView, lucide-react.
 */
import { CirclePause, FileText, Play, X } from "lucide-react";
import { useState } from "react";
import type { PendingRequest } from "../../../core/humanInput.js";
import type { PauseReason } from "../../../core/state.js";
import { DigestView } from "../queue/DigestView.js";

export type PauseRequest = Extract<PendingRequest, { kind: "pause" }>;

/** Every reason a pause request can carry; Stop, questions and approvals record none. */
const TITLE: Record<Exclude<PauseReason, "user_abort" | "question" | "tool_approval">, string> = {
  gate: "Review before the next stage",
  limit_reached: "A limit stopped the run",
  no_progress: "The run made no progress",
  dirty_tree: "Uncommitted files block a branch switch",
  frozen_changed: "A stage changed a frozen file",
  preflight_failed: "A preflight check failed",
  invalid_input: "The queue needs a fix",
  red_first_green: "The new tests pass before the feature exists",
  plan_changed: "The implementer changed the plan",
  tests_changed: "The implementer deleted or renamed a test",
  stalled: "The same failure repeats",
  flaky_check: "A check keeps flaking",
};

export function PauseCard({
  request,
  onContinue,
  onStop,
  digestDir = null,
}: {
  request: PauseRequest;
  onContinue: () => void;
  onStop: () => void;
  /** The project dir when the pause wrote a digest for its entry (016); null shows no link. */
  digestDir?: string | null;
}) {
  const [sent, setSent] = useState(false);
  const [showDigest, setShowDigest] = useState(false);
  const choose = (option: string) => {
    if (sent) return;
    setSent(true);
    if (option === "Continue") onContinue();
    else onStop();
  };

  return (
    <div data-testid="pause-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <CirclePause size={18} style={{ color: "var(--status-warning)" }} />
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: "var(--foreground)" }}>
          {TITLE[request.reason as keyof typeof TITLE] ?? `Paused: ${request.reason}`}
        </span>
        {request.entryId && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--foreground-muted)",
            }}
          >
            {request.entryId}
          </span>
        )}
      </div>
      <p
        data-testid="pause-detail"
        style={{
          margin: "0 0 14px",
          fontSize: "0.8rem",
          lineHeight: 1.5,
          color: "var(--foreground)",
          whiteSpace: "pre-wrap",
        }}
      >
        {request.detail}
      </p>
      {digestDir && request.entryId && (
        <button
          type="button"
          data-testid="pause-digest-link"
          onClick={() => setShowDigest(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            margin: "0 0 12px",
            padding: 0,
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: "0.8rem",
            color: "var(--primary)",
          }}
        >
          <FileText size={14} />
          Read the digest for {request.entryId}
        </button>
      )}
      {showDigest && digestDir && request.entryId && (
        <DigestView
          projectDir={digestDir}
          entryId={request.entryId}
          onClose={() => setShowDigest(false)}
        />
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        {request.options.map((option) => {
          const primary = option === "Continue";
          return (
            <button
              key={option}
              type="button"
              data-testid={`pause-option-${option.toLowerCase()}`}
              disabled={sent}
              onClick={() => choose(option)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 16px",
                borderRadius: "var(--radius)",
                fontSize: "0.85rem",
                fontWeight: 600,
                border: primary ? "none" : "1px solid var(--border)",
                background: primary ? "var(--primary)" : "var(--surface-elevated)",
                color: primary ? "#fff" : "var(--foreground)",
                cursor: sent ? "not-allowed" : "pointer",
                opacity: sent ? 0.6 : 1,
              }}
            >
              {primary ? <Play size={14} /> : <X size={14} />}
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}
