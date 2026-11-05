/**
 * What: The card for a held tool call (contracts/policy-json.md § The chain at runtime) — which tool, the subject the rules matched, the full input, where the `ask` came from (the policy or the project's settings) and why; Approve or Deny, with an optional reason that reaches the agent.
 * Not: Does not decide anything — the human does; the answer goes back through useUserQuestion.answerToolApproval.
 * Deps: HeldRequest (useUserQuestion), lucide-react.
 */
import { Check, ShieldQuestion, X } from "lucide-react";
import { useState } from "react";
import type { HeldRequest } from "../../hooks/useUserQuestion.js";

type ToolApproval = Extract<HeldRequest, { kind: "tool_approval" }>;

const label = {
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--foreground-muted)",
  marginBottom: 4,
} as const;

const codeBlock = {
  margin: 0,
  padding: "8px 10px",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--surface-elevated)",
  color: "var(--foreground)",
  fontSize: "0.78rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 200,
  overflowY: "auto",
} as const;

function button(primary: boolean, enabled: boolean) {
  return {
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
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.6,
  } as const;
}

export function ToolApprovalCard({
  request,
  onAnswer,
}: {
  request: ToolApproval;
  onAnswer: (requestId: string, decision: "approve" | "deny", message?: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const source = request.source === "policy" ? "Dex policy (.dex/policy.json)" : "project settings";

  const answer = (decision: "approve" | "deny") => {
    if (sent) return;
    setSent(true);
    onAnswer(
      request.requestId,
      decision,
      decision === "deny" ? message.trim() || undefined : undefined,
    );
  };

  return (
    <div data-testid="tool-approval-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <ShieldQuestion size={18} style={{ color: "var(--primary)" }} />
        <span style={{ fontSize: "0.88rem", fontWeight: 600, color: "var(--foreground)" }}>
          An agent wants to run {request.toolName}
        </span>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={label}>Asked by</div>
        <div style={{ fontSize: "0.8rem", color: "var(--foreground)" }}>
          {source}
          {request.reason ? ` — ${request.reason}` : ""}
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={label}>Subject</div>
        <pre data-testid="tool-approval-subject" style={codeBlock}>
          {request.subject}
        </pre>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={label}>Full input</div>
        <pre style={codeBlock}>{JSON.stringify(request.input, null, 2)}</pre>
      </div>

      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Reason for a denial (optional, shown to the agent)"
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "6px 10px",
          marginBottom: 12,
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--surface-elevated)",
          color: "var(--foreground)",
          fontSize: "0.82rem",
          fontFamily: "inherit",
          outline: "none",
        }}
      />

      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        <button
          type="button"
          data-testid="tool-approval-deny"
          disabled={sent}
          onClick={() => answer("deny")}
          style={button(false, !sent)}
        >
          <X size={14} />
          Deny
        </button>
        <button
          type="button"
          data-testid="tool-approval-approve"
          disabled={sent}
          onClick={() => answer("approve")}
          style={button(true, !sent)}
        >
          <Check size={14} />
          Approve
        </button>
      </div>
    </div>
  );
}
