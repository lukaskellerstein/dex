import crypto from "node:crypto";
import { updateState } from "./state.js";
import type { EmitFn, UserInputQuestion } from "./types.js";
import { fallbackLog } from "./log.js";

/** Pending question resolvers — keyed by requestId */
const pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();

/**
 * Called from IPC when the user submits answers to a clarification question.
 */
export function submitUserAnswer(requestId: string, answers: Record<string, string>): void {
  const resolver = pendingQuestions.get(requestId);
  if (resolver) {
    resolver(answers);
    pendingQuestions.delete(requestId);
  } else {
    fallbackLog("WARN", `submitUserAnswer: no pending question for requestId=${requestId}`);
  }
}

/**
 * Waits for user input. Emits the question event, then blocks until the user responds.
 * Persists the pending question to state.json so it survives renderer crashes.
 */
export function waitForUserInput(
  projectDir: string,
  emit: EmitFn,
  runId: string,
  questions: UserInputQuestion[]
): Promise<Record<string, string>> {
  const requestId = crypto.randomUUID();

  // Persist pending question to state file so it survives crashes
  updateState(projectDir, {
    pendingQuestion: {
      id: requestId,
      question: questions.map((q) => q.question).join("; "),
      context: `runId:${runId}`,
      askedAt: new Date().toISOString(),
    },
  }).catch(() => {});

  emit({ type: "user_input_request", runId, requestId, questions });
  return new Promise<Record<string, string>>((resolve) => {
    pendingQuestions.set(requestId, (answers) => {
      // Clear pending question from state file on answer
      updateState(projectDir, { pendingQuestion: null }).catch(() => {});
      resolve(answers);
    });
  });
}
