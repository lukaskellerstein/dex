/**
 * What: One queue for everything that waits on a human (research R7) — agent questions (AskUserQuestion), tool approvals (a policy or settings `ask` rule) and run pauses (bad input, no progress, gates, limits). Every request is persisted to `state.pendingRequests` and rendered to `.dex/questions.md`, so it survives a restart. Before a request waits, the answer book (answers given while no agent waited, `bookAnswers`) answers it if it can; in `recommended-then-review` a question whose every sub-question has a `(Recommended)` option is answered at once and added to `state.reviewList`. A held question or approval is answered through `resolveRequest`; Stop releases every held request (`cancelAll`): questions get no answers, approvals are denied. When no human can answer (`dex run` without a TTY), `parkAll` releases the agents the same way but keeps the requests for the next run, and `WaitingForHuman` is the abort reason that pauses the run. Resume drops every request left over (`clearStaleRequests`): a pause is answered by Resume itself, and a parked request is asked again.
 * Not: Does not decide when to ask, which question mode a stage uses (the session does) or what a pause means.
 * Deps: state.{mutateState, readState}, events.EmitFn, policy.QuestionMode, node:fs, node:crypto.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmitFn } from "./events.js";
import type { Policy, QuestionMode } from "./policy.js";
import { mutateState, type PauseReason, readState } from "./state.js";
import type { StepType, UserInputQuestion } from "./types.js";

// ── Types (data-model.md § Pending request) ──

export interface ToolApprovalBody {
  toolName: string;
  subject: string;
  input: unknown;
  source: "policy" | "settings";
  reason?: string;
}

type RequestBody =
  | { kind: "question"; questions: UserInputQuestion[] }
  | ({ kind: "tool_approval" } & ToolApprovalBody)
  | { kind: "pause"; reason: PauseReason; detail: string; options: string[] };

export type PendingRequest = { id: string; entryId: string | null; askedAt: string } & RequestBody;

export interface ReviewItem {
  question: string;
  answer: string;
  entryId: string | null;
  /** The stage that asked; a new project's clarification steps are not queue stages. */
  stage: StepType;
  at: string;
}

export interface AnswerBookItem {
  key: string;
  answer: string;
  at: string;
}

export type RequestAnswer =
  | { kind: "question"; answers: Record<string, string> }
  | { kind: "tool_approval"; decision: "approve" | "deny"; message?: string }
  | { kind: "pause"; option: string };

export type ToolApprovalAnswer = Omit<Extract<RequestAnswer, { kind: "tool_approval" }>, "kind">;

/** Where a request is persisted and announced. */
export interface HumanIO {
  projectDir: string;
  runId: string;
  emit: EmitFn;
}

// ── In-memory waiters (requests an agent is blocked on) ──

interface Waiter {
  io: HumanIO;
  kind: RequestAnswer["kind"];
  resolve: (a: RequestAnswer) => void;
  /** The answer Stop gives, so the agent can unwind. */
  onStop: RequestAnswer;
}

const waiting = new Map<string, Waiter>();

function persist(projectDir: string, update: (list: PendingRequest[]) => PendingRequest[]): void {
  mutateState(projectDir, (s) => ({ ...s, pendingRequests: update(s.pendingRequests) }));
  renderQuestionsFile(projectDir);
}

function drop(projectDir: string, id: string): void {
  persist(projectDir, (list) => list.filter((r) => r.id !== id));
}

function newRequest(entryId: string | null, body: RequestBody): PendingRequest {
  return { id: crypto.randomUUID(), entryId, askedAt: new Date().toISOString(), ...body };
}

/** Persists `request` and waits for its answer. `announce` emits the request's event. */
function hold(io: HumanIO, request: PendingRequest, onStop: RequestAnswer, announce: () => void): Promise<RequestAnswer> {
  persist(io.projectDir, (list) => [...list, request]);
  const answered = new Promise<RequestAnswer>((resolve) => {
    waiting.set(request.id, { io, kind: onStop.kind, resolve, onStop });
  });
  announce();
  return answered;
}

// ── Defaults: the answer book and recommended options (research R6, R7) ──

const RECOMMENDED_RE = /\(recommended\)\s*$/i;

/** AskUserQuestion has no `recommended` field: an option is recommended when its label ends in `(Recommended)`. */
export function isRecommended(label: string): boolean {
  return RECOMMENDED_RE.test(label);
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** The answer-book key of a question (data-model.md § Pending request). */
export function questionKey(question: string): string {
  return `q:${normalize(question)}`;
}

/** The answer-book key of a tool approval. */
export function toolKey(toolName: string, subject: string): string {
  return `t:${toolName}:${subject}`;
}

/** The book's answers for every key, removed from the book; null (and no change) when one is missing. */
function takeFromBook(projectDir: string, keys: string[]): string[] | null {
  if (keys.length === 0) return null;
  let found: string[] | null = null;
  mutateState(projectDir, (s) => {
    const book = [...s.answerBook];
    const answers: string[] = [];
    for (const key of keys) {
      const i = book.findIndex((b) => b.key === key);
      if (i < 0) return s;
      answers.push(book[i].answer);
      book.splice(i, 1);
    }
    found = answers;
    return { ...s, answerBook: book };
  });
  return found;
}

/** The recommended answer to every sub-question (all recommended labels for a multi-select), or null. */
function recommendedAnswers(questions: UserInputQuestion[]): Record<string, string> | null {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const picks = q.options.filter((o) => isRecommended(o.label)).map((o) => o.label);
    if (picks.length === 0) return null;
    answers[q.question] = q.multiSelect ? picks.join(", ") : picks[0];
  }
  return answers;
}

/** A question answered without a human: announced and resolved in one go, so the trace shows it. */
function answeredAtOnce(
  io: HumanIO,
  questions: UserInputQuestion[],
  answers: Record<string, string>,
  by: "default" | "answer_book",
): Record<string, string> {
  const requestId = crypto.randomUUID();
  io.emit({ type: "user_input_request", runId: io.runId, requestId, questions });
  io.emit({ type: "user_input_response", requestId, answers });
  io.emit({ type: "request_resolved", requestId, by });
  return answers;
}

function addToReview(projectDir: string, entryId: string | null, stage: StepType, answers: Record<string, string>): void {
  const at = new Date().toISOString();
  const items = Object.entries(answers).map(([question, answer]) => ({ question, answer, entryId, stage, at }));
  mutateState(projectDir, (s) => ({ ...s, reviewList: [...s.reviewList, ...items] }));
  renderQuestionsFile(projectDir);
}

/** A new project's clarification steps: the only ones `autoClarification` applies to (FR-035). */
const NEW_PROJECT_CLARIFICATION: ReadonlySet<StepType> = new Set([
  "clarification",
  "clarification_product",
  "clarification_technical",
  "clarification_synthesis",
  "constitution",
  "manifest_extraction",
]);

/** The question mode for a session: autoClarification for clarification, else the policy (research R7). */
export function questionModeFor(step: StepType, autoClarification: boolean, policy: Policy): QuestionMode {
  if (NEW_PROJECT_CLARIFICATION.has(step)) return autoClarification ? "recommended-then-review" : "wait";
  return policy.questions;
}

/** How a stage's questions are answered: its mode, and the stage named in the review list. */
export interface QuestionOptions {
  mode: QuestionMode;
  step: StepType;
}

/**
 * Answers an agent's questions: from the answer book, else (in
 * `recommended-then-review`) with the recommended options, else by holding
 * the agent until a human answers. Resolves with the answers, or `{}` on Stop.
 * Without options every question waits.
 */
export async function askQuestions(
  io: HumanIO,
  entryId: string | null,
  questions: UserInputQuestion[],
  opts?: QuestionOptions,
): Promise<Record<string, string>> {
  const fromBook = takeFromBook(io.projectDir, questions.map((q) => questionKey(q.question)));
  if (fromBook) {
    const answers = Object.fromEntries(questions.map((q, i) => [q.question, fromBook[i]]));
    return answeredAtOnce(io, questions, answers, "answer_book");
  }
  const defaults = opts?.mode === "recommended-then-review" ? recommendedAnswers(questions) : null;
  if (defaults && opts) {
    addToReview(io.projectDir, entryId, opts.step, defaults);
    return answeredAtOnce(io, questions, defaults, "default");
  }
  const request = newRequest(entryId, { kind: "question", questions });
  const answer = await hold(io, request, { kind: "question", answers: {} }, () =>
    io.emit({ type: "user_input_request", runId: io.runId, requestId: request.id, questions }),
  );
  return answer.kind === "question" ? answer.answers : {};
}

/** Holds a tool call until a human approves or denies it. Stop denies it. */
export async function requestToolApproval(
  io: HumanIO,
  entryId: string | null,
  body: ToolApprovalBody,
): Promise<ToolApprovalAnswer> {
  const [booked] = takeFromBook(io.projectDir, [toolKey(body.toolName, body.subject)]) ?? [];
  if (booked !== undefined) {
    const requestId = crypto.randomUUID();
    io.emit({ type: "tool_approval_request", runId: io.runId, requestId, ...body });
    io.emit({ type: "request_resolved", requestId, by: "answer_book" });
    if (booked === "approve") return { decision: "approve" };
    return { decision: "deny", ...(booked !== "deny" ? { message: booked } : {}) };
  }
  const request = newRequest(entryId, { kind: "tool_approval", ...body });
  const stop: RequestAnswer = { kind: "tool_approval", decision: "deny", message: "Run stopped by user" };
  const answer = await hold(io, request, stop, () =>
    io.emit({ type: "tool_approval_request", runId: io.runId, requestId: request.id, ...body }),
  );
  return answer.kind === "tool_approval"
    ? { decision: answer.decision, ...(answer.message ? { message: answer.message } : {}) }
    : { decision: "deny", message: "Answered with the wrong kind of answer" };
}

/** Records why the run stopped and what the human can choose. The run ends; Resume answers it. */
export function recordPause(
  io: HumanIO,
  entryId: string | null,
  reason: PauseReason,
  detail: string,
  options: string[] = ["Continue", "Stop"],
): PendingRequest {
  const request = newRequest(entryId, { kind: "pause", reason, detail, options });
  persist(io.projectDir, (list) => [...list, request]);
  return request;
}

/**
 * Answers a held request. False when nothing waits on `requestId` in this
 * process, or when the answer is for another kind of request.
 */
export function resolveRequest(requestId: string, answer: RequestAnswer): boolean {
  const w = waiting.get(requestId);
  if (!w || w.kind !== answer.kind) return false;
  waiting.delete(requestId);
  drop(w.io.projectDir, requestId);
  w.io.emit({ type: "request_resolved", requestId, by: "human" });
  w.resolve(answer);
  return true;
}

/** True while an agent in this process waits on `requestId`. */
export function isWaiting(requestId: string): boolean {
  return waiting.has(requestId);
}

/** Stop: every held request gets its stop answer so its agent can unwind, and leaves the state. */
export function cancelAll(): void {
  for (const [id, w] of [...waiting]) {
    waiting.delete(id);
    drop(w.io.projectDir, id);
    w.io.emit({ type: "request_resolved", requestId: id, by: "stop" });
    w.resolve(w.onStop);
  }
}

/**
 * Resume: no agent waits when a run starts, so every pending request is
 * stale. A pause is answered by Resume itself; a parked question or approval
 * is asked again by the stage that re-runs, or answered from the answer book.
 */
export function clearStaleRequests(projectDir: string): void {
  persist(projectDir, () => []);
}

// ── No human present (`dex run` without a TTY; contracts/cli.md) ──

export type HeldKind = "question" | "tool_approval";

/** The abort reason of a run that pauses because no human can answer its request now. */
export class WaitingForHuman extends Error {
  readonly waitFor: HeldKind;

  constructor(waitFor: HeldKind) {
    super(`the run waits for a human (${waitFor})`);
    this.name = "WaitingForHuman";
    this.waitFor = waitFor;
  }
}

/** What the run waits for when `signal` aborted because no human can answer; else null. */
export function waitingFor(signal: AbortSignal | null | undefined): HeldKind | null {
  return signal?.aborted && signal.reason instanceof WaitingForHuman ? signal.reason.waitFor : null;
}

/**
 * No human can answer now: every held request stays in the state and in
 * `.dex/questions.md` for the next `dex run`, and its agent gets the stop
 * answer so the stage can unwind.
 */
export function parkAll(): void {
  for (const [id, w] of [...waiting]) {
    waiting.delete(id);
    w.resolve(w.onStop);
  }
}

function bookItems(request: PendingRequest, answer: RequestAnswer, at: string): AnswerBookItem[] {
  if (request.kind === "question" && answer.kind === "question") {
    return request.questions.flatMap((q) =>
      q.question in answer.answers ? [{ key: questionKey(q.question), answer: answer.answers[q.question], at }] : [],
    );
  }
  if (request.kind === "tool_approval" && answer.kind === "tool_approval") {
    const booked = answer.decision === "approve" ? "approve" : (answer.message ?? "deny");
    return [{ key: toolKey(request.toolName, request.subject), answer: booked, at }];
  }
  return [];
}

/**
 * Answers given while no agent waits (a TTY `dex run` after a parked run):
 * they go to the answer book, and their requests leave the state. The stage
 * that re-runs asks again and gets the answer from the book.
 */
export function bookAnswers(projectDir: string, answered: Array<{ request: PendingRequest; answer: RequestAnswer }>): void {
  const at = new Date().toISOString();
  const items = answered.flatMap(({ request, answer }) => bookItems(request, answer, at));
  const ids = new Set(answered.map((a) => a.request.id));
  mutateState(projectDir, (s) => ({
    ...s,
    answerBook: [...s.answerBook, ...items],
    pendingRequests: s.pendingRequests.filter((r) => !ids.has(r.id)),
  }));
  renderQuestionsFile(projectDir);
}

// ── .dex/questions.md (contracts/cli.md) ──

function renderRequest(r: PendingRequest, n: number): string {
  const where = r.entryId ? ` (${r.entryId})` : "";
  if (r.kind === "pause") {
    return `## ${n} · Paused: ${r.reason}${where}\n\n${r.detail}\n\nOptions: ${r.options.join(" / ")}\n`;
  }
  if (r.kind === "tool_approval") {
    const why = r.reason ? ` — ${r.reason}` : "";
    return `## ${n} · Approve a tool call${where}\n\n**${r.toolName}** (${r.source}${why})\n\n\`\`\`text\n${r.subject}\n\`\`\`\n\nOptions: Approve / Deny\n`;
  }
  const body = r.questions
    .map((q) => {
      const opts = q.options.map((o, i) => `${i + 1}. ${o.label} — ${o.description}`).join("\n");
      return `**${q.header || "Question"}**: ${q.question}\n\n${opts}`;
    })
    .join("\n\n");
  return `## ${n} · Question${where}\n\n${body}\n`;
}

function renderReview(items: ReviewItem[]): string {
  const lines = items.map((r) => {
    const answer = r.answer.replace(RECOMMENDED_RE, "").trim();
    return `- (${r.entryId ?? "project"} · ${r.stage}) "${r.question}" → **${answer}** (recommended)`;
  });
  return `## Answered by default — review (recommended-then-review)\n\n${lines.join("\n")}\n`;
}

/**
 * Regenerates `.dex/questions.md` from the state: what waits, then what was
 * answered by default. Removes the file when there is neither.
 */
export function renderQuestionsFile(projectDir: string): void {
  const file = path.join(projectDir, ".dex", "questions.md");
  const state = readState(projectDir);
  const pending = state?.pendingRequests ?? [];
  const review = state?.reviewList ?? [];
  if (!state || (pending.length === 0 && review.length === 0)) {
    fs.rmSync(file, { force: true });
    return;
  }
  const head =
    state.status === "paused"
      ? `Run: ${state.runId} · paused ${state.pausedAt ?? ""} · reason: ${state.pauseReason ?? "?"}`
      : `Run: ${state.runId} · ${state.status}`;
  const waiting =
    pending.length > 0
      ? `${pending.map((r, i) => renderRequest(r, i + 1)).join("\n")}\nAnswer in the Dex app, or with \`dex run ${projectDir}\` in a terminal.\n`
      : "Nothing waits for you right now.\n";
  const reviewed = review.length > 0 ? `\n${renderReview(review)}` : "";
  fs.writeFileSync(file, `# Dex — waiting for you\n\n${head}\n\n${waiting}${reviewed}`);
}
