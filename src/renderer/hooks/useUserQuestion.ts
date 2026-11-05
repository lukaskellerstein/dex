/**
 * What: Owns the request an agent waits on — a held question (AskUserQuestion) or a held tool approval (a policy or settings `ask` rule) — plus isClarifying, and the answers, which go through `orchestrator:answer-request`. After a reload the request comes back from the live run's `state.pendingRequests`: the main process still holds it.
 * Not: Does not own clarification flow logic (core/stages/clarification.ts) or pauses (a pause ends the run; Resume answers it). Does not own loop-cycle state (useLoopState).
 * Deps: orchestratorService.{subscribeEvents, answerRequest, getRunState, getProjectState}; core humanInput / types.
 */
import { useCallback, useEffect, useState } from "react";
import type { PendingRequest, ToolApprovalBody } from "../../core/humanInput.js";
import type { OrchestratorEvent, UserInputQuestion } from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

export type HeldRequest =
  | { kind: "question"; requestId: string; questions: UserInputQuestion[] }
  | ({ kind: "tool_approval"; requestId: string } & ToolApprovalBody);

export interface UseUserQuestionResult {
  pendingRequest: HeldRequest | null;
  isClarifying: boolean;
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
  answerToolApproval: (requestId: string, decision: "approve" | "deny", message?: string) => void;
  /** Composer-internal — the reload restore in useOrchestrator sets it from the live run state. */
  setIsClarifying: (b: boolean) => void;
}

function toHeld(r: PendingRequest): HeldRequest | null {
  if (r.kind === "question") return { kind: "question", requestId: r.id, questions: r.questions };
  if (r.kind !== "tool_approval") return null;
  const { toolName, subject, input, source, reason } = r;
  return { kind: "tool_approval", requestId: r.id, toolName, subject, input, source, reason };
}

/** The request the live run holds, if any (renderer reload). */
async function restoreHeldRequest(): Promise<HeldRequest | null> {
  const run = await orchestratorService.getRunState();
  if (!run) return null;
  const state = await orchestratorService.getProjectState(run.projectDir);
  for (const r of state?.pendingRequests ?? []) {
    const held = toHeld(r);
    if (held) return held;
  }
  return null;
}

function heldFrom(event: OrchestratorEvent): HeldRequest | null {
  if (event.type === "user_input_request") {
    return { kind: "question", requestId: event.requestId, questions: event.questions };
  }
  if (event.type === "tool_approval_request") {
    const { requestId, toolName, subject, input, source, reason } = event;
    return { kind: "tool_approval", requestId, toolName, subject, input, source, reason };
  }
  return null;
}

export function useUserQuestion(): UseUserQuestionResult {
  const [pendingRequest, setPendingRequest] = useState<HeldRequest | null>(null);
  const [isClarifying, setIsClarifying] = useState(false);

  const answerQuestion = useCallback((requestId: string, answers: Record<string, string>) => {
    orchestratorService.answerRequest(requestId, { kind: "question", answers });
    setPendingRequest(null);
  }, []);

  const answerToolApproval = useCallback(
    (requestId: string, decision: "approve" | "deny", message?: string) => {
      orchestratorService.answerRequest(requestId, {
        kind: "tool_approval",
        decision,
        ...(message ? { message } : {}),
      });
      setPendingRequest(null);
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    restoreHeldRequest()
      .then((held) => {
        if (mounted && held) setPendingRequest((current) => current ?? held);
      })
      .catch(() => {
        // No live run to restore from — nothing waits.
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      const held = heldFrom(event);
      if (held) {
        setPendingRequest(held);
        return;
      }
      switch (event.type) {
        case "run_started":
        case "run_completed":
          setIsClarifying(false);
          setPendingRequest(null);
          break;
        case "clarification_started":
          setIsClarifying(true);
          break;
        case "clarification_completed":
          setIsClarifying(false);
          break;
        // Auto-answered (autoClarification) or answered elsewhere (the CLI, Stop).
        case "user_input_response":
        case "request_resolved":
          setPendingRequest((current) => (current?.requestId === event.requestId ? null : current));
          break;
      }
    });
    return unsub;
  }, []);

  return { pendingRequest, isClarifying, answerQuestion, answerToolApproval, setIsClarifying };
}
