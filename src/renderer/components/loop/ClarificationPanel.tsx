/**
 * What: The bottom panel for what waits on the human — a question an agent asks (AskUserQuestion, with an "Other" free-text option) or a tool approval (ToolApprovalCard) while a run goes; else, once the run has paused, the pause it ended on (PauseCard, from the run snapshot). One card at a time, keyed by its request id, so picks never carry over.
 * Not: Does not hold or persist requests (core humanInput.ts). The answers Dex gave by default are listed in the queue panel, not here: they wait for nobody.
 * Deps: useUserQuestion, ToolApprovalCard, PauseCard, RunSnapshot, lucide-react.
 */
import { MessageCircleQuestion, Send } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { RunSnapshot } from "../../../core/run-snapshot.js";
import { type HeldRequest, useUserQuestion } from "../../hooks/useUserQuestion.js";
import { PauseCard, type PauseRequest } from "./PauseCard.js";
import { ToolApprovalCard } from "./ToolApprovalCard.js";

/** The pause a paused run ended on, from its state; null while a run goes. */
function pauseOf(snapshot: RunSnapshot | null, isRunning: boolean): PauseRequest | null {
  const state = snapshot?.state;
  if (isRunning || state?.status !== "paused") return null;
  return state.pendingRequests.find((r): r is PauseRequest => r.kind === "pause") ?? null;
}

export function ClarificationPanel({
  snapshot,
  isRunning,
  onResume,
}: {
  snapshot: RunSnapshot | null;
  isRunning: boolean;
  onResume: () => void;
}) {
  const { pendingRequest, answerQuestion, answerToolApproval } = useUserQuestion();
  const [closed, setClosed] = useState<string | null>(null);
  const pause = pauseOf(snapshot, isRunning);
  if (pendingRequest) {
    return (
      <PanelShell>
        {pendingRequest.kind === "question" ? (
          <QuestionCard key={pendingRequest.requestId} request={pendingRequest} onAnswer={answerQuestion} />
        ) : (
          <ToolApprovalCard key={pendingRequest.requestId} request={pendingRequest} onAnswer={answerToolApproval} />
        )}
      </PanelShell>
    );
  }
  if (!pause || closed === pause.id) return null;
  return (
    <PanelShell>
      <PauseCard key={pause.id} request={pause} onContinue={onResume} onStop={() => setClosed(pause.id)} />
    </PanelShell>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        background: "var(--surface)",
        borderTop: "2px solid var(--primary)",
        boxShadow: "0 -4px 24px rgba(0,0,0,0.3)",
        maxHeight: "60vh",
        overflowY: "auto",
      }}
    >
      <div style={{ padding: "16px 24px", maxWidth: 720, margin: "0 auto" }}>{children}</div>
    </div>
  );
}

function QuestionCard({
  request,
  onAnswer,
}: {
  request: Extract<HeldRequest, { kind: "question" }>;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
}) {
  // Track selected option per question (keyed by question text)
  const [selections, setSelections] = useState<Record<string, string>>({});
  // Track free-text input per question (for "Other" option)
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const { requestId, questions } = request;

  const allAnswered = questions.every((q) => {
    const sel = selections[q.question];
    if (!sel) return false;
    if (sel === "__other__") return (freeText[q.question] ?? "").trim().length > 0;
    return true;
  });

  const handleSelect = (questionText: string, label: string) => {
    setSelections((prev) => ({ ...prev, [questionText]: label }));
  };

  const handleSubmit = () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);

    const answers: Record<string, string> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      answers[q.question] = sel === "__other__" ? (freeText[q.question] ?? "").trim() : sel;
    }

    onAnswer(requestId, answers);
  };

  return (
    <>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
          }}
        >
          <MessageCircleQuestion size={18} style={{ color: "var(--primary)" }} />
          <span
            style={{
              fontSize: "0.88rem",
              fontWeight: 600,
              color: "var(--foreground)",
            }}
          >
            Dex needs your input
          </span>
        </div>

        {/* Questions */}
        {questions.map((q) => (
          <div key={q.question} style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: "0.82rem",
                fontWeight: 500,
                color: "var(--foreground)",
                marginBottom: 8,
                lineHeight: 1.5,
              }}
            >
              {q.header && (
                <span
                  style={{
                    display: "inline-block",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: "var(--primary)",
                    marginRight: 8,
                  }}
                >
                  {q.header}
                </span>
              )}
              {q.question}
            </div>

            {/* Options */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {q.options.map((opt) => {
                const isSelected = selections[q.question] === opt.label;
                return (
                  <button
                    key={opt.label}
                    onClick={() => handleSelect(q.question, opt.label)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      padding: "8px 12px",
                      borderRadius: "var(--radius)",
                      border: isSelected ? "1.5px solid var(--primary)" : "1px solid var(--border)",
                      background: isSelected ? "var(--primary-muted)" : "var(--surface-elevated)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.8rem",
                        fontWeight: 500,
                        color: isSelected ? "var(--primary)" : "var(--foreground)",
                      }}
                    >
                      {opt.label}
                    </span>
                    {opt.description && (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          color: "var(--foreground-muted)",
                          marginTop: 2,
                        }}
                      >
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}

              {/* "Other" free-text option */}
              <button
                onClick={() => handleSelect(q.question, "__other__")}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  padding: "8px 12px",
                  borderRadius: "var(--radius)",
                  border:
                    selections[q.question] === "__other__"
                      ? "1.5px solid var(--primary)"
                      : "1px solid var(--border)",
                  background:
                    selections[q.question] === "__other__"
                      ? "var(--primary-muted)"
                      : "var(--surface-elevated)",
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "border-color 0.15s, background 0.15s",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color:
                      selections[q.question] === "__other__"
                        ? "var(--primary)"
                        : "var(--foreground-dim)",
                  }}
                >
                  Other (type your own answer)
                </span>
              </button>

              {selections[q.question] === "__other__" && (
                <input
                  type="text"
                  value={freeText[q.question] ?? ""}
                  onChange={(e) =>
                    setFreeText((prev) => ({
                      ...prev,
                      [q.question]: e.target.value,
                    }))
                  }
                  placeholder="Type your answer..."
                  autoFocus
                  style={{
                    padding: "6px 10px",
                    borderRadius: "var(--radius)",
                    border: "1px solid var(--border)",
                    background: "var(--surface-elevated)",
                    color: "var(--foreground)",
                    fontSize: "0.82rem",
                    fontFamily: "inherit",
                    outline: "none",
                    marginTop: 2,
                  }}
                />
              )}
            </div>
          </div>
        ))}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!allAnswered || submitting}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "10px 16px",
            borderRadius: "var(--radius)",
            fontSize: "0.85rem",
            fontWeight: 600,
            background: allAnswered && !submitting ? "var(--primary)" : "var(--surface-elevated)",
            color: allAnswered && !submitting ? "#fff" : "var(--foreground-disabled)",
            cursor: allAnswered && !submitting ? "pointer" : "not-allowed",
            border: "none",
            transition: "background 0.15s",
            marginBottom: 4,
          }}
        >
          <Send size={14} />
          Submit Answers
        </button>
    </>
  );
}
