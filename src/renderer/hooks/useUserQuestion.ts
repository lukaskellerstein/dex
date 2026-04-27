/**
 * What: Owns user-question state — pendingQuestion, isClarifying — and the answerQuestion action that submits answers via orchestratorService.
 * Not: Does not own clarification flow logic (that's in core/stages/clarification.ts). Does not own loop-cycle state (useLoopState).
 * Deps: orchestratorService.{subscribeEvents, answerQuestion}; UserInputQuestion / OrchestratorEvent types.
 */
import { useState, useEffect, useCallback } from "react";
import type { OrchestratorEvent, UserInputQuestion } from "../../core/types.js";
import { orchestratorService } from "../services/orchestratorService.js";

export interface PendingQuestion {
  requestId: string;
  questions: UserInputQuestion[];
}

export interface UseUserQuestionResult {
  pendingQuestion: PendingQuestion | null;
  isClarifying: boolean;
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
  /** Composer-internal — used by run lifecycle handlers to clear question state outside the event stream. */
  setPendingQuestion: (q: PendingQuestion | null) => void;
  /** Composer-internal — used by run lifecycle handlers to clear isClarifying. */
  setIsClarifying: (b: boolean) => void;
}

export function useUserQuestion(): UseUserQuestionResult {
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [isClarifying, setIsClarifying] = useState(false);

  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) => {
      orchestratorService.answerQuestion(requestId, answers);
      setPendingQuestion(null);
    },
    [],
  );

  useEffect(() => {
    const unsub = orchestratorService.subscribeEvents((event: OrchestratorEvent) => {
      switch (event.type) {
        case "run_started":
          setIsClarifying(false);
          setPendingQuestion(null);
          break;

        case "run_completed":
          setIsClarifying(false);
          setPendingQuestion(null);
          break;

        case "clarification_started":
          setIsClarifying(true);
          break;

        case "clarification_completed":
          setIsClarifying(false);
          break;

        case "clarification_question":
          // No-op today — reserved for surfacing per-question detail.
          break;

        case "user_input_request":
          setPendingQuestion({
            requestId: event.requestId,
            questions: event.questions,
          });
          break;

        case "user_input_response":
          // Auto-answered (autoClarification mode) — clear the pending question.
          setPendingQuestion(null);
          break;
      }
    });
    return unsub;
  }, []);

  return {
    pendingQuestion,
    isClarifying,
    answerQuestion,
    setPendingQuestion,
    setIsClarifying,
  };
}
