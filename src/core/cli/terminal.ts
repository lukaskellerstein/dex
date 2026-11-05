/**
 * What: The terminal side of human input (contracts/cli.md § Human input on the terminal). `processTerminal` wraps stdout and stderr and, with a TTY, a readline prompt. `askInTerminal` asks one request: a question shows numbered options with the recommended one as the Enter default (or takes typed text), a tool approval shows the tool, the subject and who asks, and reads `y` / `n`.
 * Not: Does not decide when to ask, and does not resolve the request (cli/run.ts does both).
 * Deps: humanInput.{isRecommended, RequestAnswer, ToolApprovalBody}, node:readline/promises.
 */

import readline from "node:readline/promises";
import { isRecommended, type RequestAnswer, type ToolApprovalBody } from "../humanInput.js";
import type { UserInputQuestion } from "../types.js";

export interface Terminal {
  out(line: string): void;
  err(line: string): void;
  /** Prints `prompt` and reads one line; null without a TTY. */
  ask: ((prompt: string) => Promise<string>) | null;
  close(): void;
}

/** The real terminal: a prompt only when stdin is a TTY. */
export function processTerminal(): Terminal {
  let rl: readline.Interface | null = null;
  const ask = (prompt: string) => {
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return rl.question(prompt);
  };
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    ask: process.stdin.isTTY ? ask : null,
    close: () => {
      rl?.close();
      rl = null;
    },
  };
}

/** A request a human answers in the terminal, as an event or the state carries it. */
export type AskableRequest =
  | { kind: "question"; questions: UserInputQuestion[] }
  | ({ kind: "tool_approval" } & ToolApprovalBody);

type Ask = (prompt: string) => Promise<string>;

/**
 * The labels for `raw` when it is option numbers ("2", or "1, 3" for a
 * multi-select); `[]` when a number is out of range or too many are given;
 * null when `raw` is typed text, not numbers.
 */
function pickedLabels(q: UserInputQuestion, raw: string): string[] | null {
  const picks = raw.split(",").map((s) => s.trim());
  if (!picks.every((p) => /^\d+$/.test(p))) return null;
  const labels = picks.map((p) => q.options[Number(p) - 1]?.label);
  return labels.every((l): l is string => l !== undefined) && (q.multiSelect || labels.length === 1)
    ? labels
    : [];
}

async function askQuestion(term: Terminal, ask: Ask, q: UserInputQuestion): Promise<string> {
  term.out(`\n? ${q.header ? `[${q.header}] ` : ""}${q.question}`);
  q.options.forEach((o, i) =>
    term.out(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
  );
  const fallback = q.options.findIndex((o) => isRecommended(o.label));
  const pick = q.multiSelect ? "numbers, comma-separated" : "a number";
  const prompt = `  answer (${pick}${fallback >= 0 ? `, Enter = ${fallback + 1}` : ""}, or type your own): `;
  for (;;) {
    const raw = (await ask(prompt)).trim();
    if (raw === "" && fallback >= 0) return q.options[fallback].label;
    if (raw === "") continue;
    const labels = pickedLabels(q, raw);
    if (labels === null) return raw;
    if (labels.length > 0) return labels.join(", ");
    term.out(`  pick ${q.multiSelect ? "numbers" : "one number"} from 1 to ${q.options.length}`);
  }
}

async function askApproval(term: Terminal, ask: Ask, r: ToolApprovalBody): Promise<RequestAnswer> {
  const who = r.source === "policy" ? "Dex policy (.dex/policy.json)" : "project settings (ask)";
  term.out(`\n? Approve tool call? ${r.toolName}: ${r.subject}`);
  term.out(`  Asked by: ${who}${r.reason ? ` — ${r.reason}` : ""}`);
  for (;;) {
    const raw = (await ask("  approve? (y/n): ")).trim().toLowerCase();
    if (raw === "y" || raw === "yes") return { kind: "tool_approval", decision: "approve" };
    if (raw === "n" || raw === "no")
      return { kind: "tool_approval", decision: "deny", message: "Denied in the terminal" };
  }
}

/** Asks one request in the terminal and returns its answer. The terminal must have a prompt. */
export async function askInTerminal(
  term: Terminal,
  request: AskableRequest,
): Promise<RequestAnswer> {
  const ask = term.ask;
  if (!ask) throw new Error("askInTerminal needs a terminal with a prompt (a TTY)");
  if (request.kind === "tool_approval") return askApproval(term, ask, request);
  const answers: Record<string, string> = {};
  for (const q of request.questions) answers[q.question] = await askQuestion(term, ask, q);
  return { kind: "question", answers };
}
