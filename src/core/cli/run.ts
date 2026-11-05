/**
 * What: `dex run <projectDir>` (contracts/cli.md): resumes the run in `.dex/state.json`, or starts one, and drives the same `run()` the app does, with a compact event printer. Human input: with a TTY, the requests a parked run left behind are answered first, into the answer book, and every request the run holds is asked in the terminal; without one, a held request is parked and the run pauses (exit 3). `--once` stops after one stage; Ctrl-C is Stop.
 * Not: No Electron. Does not parse arguments (cli/args.ts), validate the queue or policy (cli.ts), or render the dry run (cli/describe.ts).
 * Deps: orchestrator.{run, stopRun, pauseForHuman}, humanInput.{isWaiting, resolveRequest, bookAnswers}, state.readState, config.LOOP_DEFAULTS, cli/terminal.
 */

import { LOOP_DEFAULTS } from "../config.js";
import type { OrchestratorEvent } from "../events.js";
import {
  bookAnswers,
  isWaiting,
  type PendingRequest,
  type RequestAnswer,
  resolveRequest,
} from "../humanInput.js";
import { pauseForHuman, run, stopRun } from "../orchestrator.js";
import { type DexState, readState } from "../state.js";
import type { RunConfig } from "../types.js";
import { type AskableRequest, askInTerminal, type Terminal } from "./terminal.js";

export interface RunOptions {
  once: boolean;
  agent: string | null;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One line per event that matters on a terminal. Counts `error` events: any of them fails the run. */
class EventPrinter {
  started = false;
  errors = 0;
  private readonly answers = new Map<string, Record<string, string>>();
  private readonly term: Terminal;

  constructor(term: Terminal) {
    this.term = term;
  }

  print(ev: OrchestratorEvent): void {
    if (ev.type === "run_started") this.started = true;
    if (ev.type === "user_input_response") this.answers.set(ev.requestId, ev.answers);
    if (ev.type === "error") {
      this.errors++;
      this.term.err(`✗ ${ev.message}`);
      return;
    }
    for (const line of this.lines(ev)) this.term.out(line);
  }

  private lines(ev: OrchestratorEvent): string[] {
    switch (ev.type) {
      case "run_started":
        return [`▶ run ${ev.runId.slice(0, 8)}${ev.branchName ? ` on ${ev.branchName}` : ""}`];
      case "loop_cycle_started":
        return [`── entry ${ev.cycleNumber} ──`];
      case "stage_decision":
        if (ev.decision === "stage") return [`→ ${ev.entryId} · ${ev.stage}: ${ev.reason}`];
        return ev.decision === "pause" ? [`⏸ ${ev.entryId}: ${ev.reason}`] : [];
      case "step_started":
        return [
          `   ▸ ${ev.step}${ev.taskPhaseNumber ? ` (task phase ${ev.taskPhaseNumber})` : ""}`,
        ];
      case "step_completed":
        return [
          `   ${ev.stopped ? "■" : "✓"} ${ev.step} ${secs(ev.durationMs)} · $${ev.costUsd.toFixed(2)}`,
        ];
      case "request_resolved":
        return this.defaulted(ev.requestId, ev.by);
      case "tree_dirty":
        return [`   ⚠ left uncommitted: ${ev.files.join(", ")}`];
      case "paused":
        return [`⏸ paused (${ev.reason})${ev.detail ? ` — ${ev.detail}` : ""}`];
      case "loop_terminated":
        return [`■ ${ev.termination.reason} · $${ev.termination.totalCostUsd.toFixed(2)}`];
      default:
        return [];
    }
  }

  /** A question answered without a prompt: by its recommended option, or from the answer book. */
  private defaulted(requestId: string, by: string): string[] {
    const answers = this.answers.get(requestId);
    this.answers.delete(requestId);
    if (!answers || (by !== "default" && by !== "answer_book")) return [];
    const how = by === "default" ? "recommended, listed for review" : "answer book";
    return Object.entries(answers).map(([q, a]) => `   ? ${q} → ${a} (${how})`);
  }
}

/** The body of a request the run holds, as its event carries it; null for any other event. */
function heldRequest(ev: OrchestratorEvent): AskableRequest | null {
  if (ev.type === "user_input_request") return { kind: "question", questions: ev.questions };
  if (ev.type === "tool_approval_request") {
    const { type: _type, runId: _runId, requestId: _requestId, ...body } = ev;
    return { kind: "tool_approval", ...body };
  }
  return null;
}

/**
 * A request an agent now waits on: asked in the terminal (one at a time,
 * after `chain`), or parked when there is no TTY or the answer cannot be read.
 */
function onHeldRequest(ev: OrchestratorEvent, term: Terminal, chain: Promise<void>): Promise<void> {
  const request = heldRequest(ev);
  if (!request || !("requestId" in ev) || !isWaiting(ev.requestId)) return chain;
  const { requestId } = ev;
  if (!term.ask) {
    term.out(
      `⏸ ${request.kind === "question" ? "a question" : "a tool approval"} waits for a human, and there is no TTY`,
    );
    pauseForHuman(request.kind);
    return chain;
  }
  return chain
    .then(async () => {
      if (isWaiting(requestId)) resolveRequest(requestId, await askInTerminal(term, request));
    })
    .catch((err) => {
      term.err(`dex: cannot read the answer — ${message(err)}`);
      pauseForHuman(request.kind);
    });
}

type HeldRequest = Exclude<PendingRequest, { kind: "pause" }>;

/** The requests a parked run left behind go to the answer book first, when a human is here to answer them. */
async function answerParked(
  projectDir: string,
  state: DexState | null,
  term: Terminal,
): Promise<void> {
  const pending = state?.pendingRequests ?? [];
  for (const p of pending)
    if (p.kind === "pause") term.out(`⏸ the last run paused (${p.reason}): ${p.detail}`);
  const parked = pending.filter((r): r is HeldRequest => r.kind !== "pause");
  if (parked.length === 0 || !term.ask) return;
  term.out(
    `The last run left ${parked.length} request(s). Your answers go to the answer book; the stage reads them when it asks again.`,
  );
  const answered: Array<{ request: PendingRequest; answer: RequestAnswer }> = [];
  for (const request of parked)
    answered.push({ request, answer: await askInTerminal(term, request) });
  bookAnswers(projectDir, answered);
}

/**
 * Any state file means resume, even a completed run: a new project has one
 * run branch (research R4), and Resume follows the checkout, so a reset to an
 * earlier commit continues there instead of cutting a second run branch.
 */
function runConfig(projectDir: string, state: DexState | null, opts: RunOptions): RunConfig {
  const resume = state !== null;
  return {
    projectDir,
    specDir: "",
    mode: "loop",
    taskPhases: "all",
    ...LOOP_DEFAULTS,
    // A new run asks the clarification questions; a resumed one keeps its setting.
    autoClarification: resume ? (state.config.autoClarification ?? false) : false,
    ...(resume ? { resume: true } : {}),
    ...(opts.once ? { once: true } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
}

/**
 * contracts/cli.md § Exit codes, from the state the run left behind. An
 * `error` event fails the run even when the loop carried on (a failed push,
 * a broken mock config), so a clean exit 0 means nothing went wrong.
 */
function exitCode(
  projectDir: string,
  printer: EventPrinter,
  once: boolean,
  interrupted: boolean,
): number {
  const end = readState(projectDir);
  if (!printer.started || !end || printer.errors > 0) return 1;
  if (end.status === "completed") return 0;
  if (end.status !== "paused") return 1;
  return once && !interrupted && end.pauseReason === "user_abort" ? 0 : 3;
}

/** Runs the project's queue from the terminal; resolves with the exit code. */
export async function runCommand(
  projectDir: string,
  opts: RunOptions,
  term: Terminal,
): Promise<number> {
  const state = readState(projectDir);
  const printer = new EventPrinter(term);
  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
    term.err("■ Ctrl-C: stopping — `dex run` resumes");
    stopRun();
  };
  process.on("SIGINT", onSigint);
  try {
    await answerParked(projectDir, state, term);
    let chain = Promise.resolve();
    await run(runConfig(projectDir, state, opts), (ev) => {
      printer.print(ev);
      chain = onHeldRequest(ev, term, chain);
    });
  } catch (err) {
    term.err(`dex: the run failed — ${message(err)}`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    term.close();
  }
  return exitCode(projectDir, printer, opts.once, interrupted);
}
