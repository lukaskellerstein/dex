/**
 * What: The read-only views of `dex run` (contracts/cli.md). `dryRunLines`: the queue and policy summary, then one block per remaining entry — the decision, the branch move, the stage env, the SDK options, the system prompt, the sensors Dex would run (016: fast, standing, acceptance) and the full prompt — each entry evaluated on its own tree, as if every earlier entry were done. `statusLines`: the run snapshot the app reads — the run's state and cost, every entry's derived status and cost, and what waits for a human. Both read files and git only.
 * Not: Starts no agent, switches no branch and writes nothing (a v2 manifest is migrated in memory only). Does not parse arguments or pick exit codes (cli.ts does).
 * Deps: queue.loadQueue, policy.{loadPolicy, policyPath}, picker.{describeEntries, readEntryFile}, entry-prompts.*, acceptance.{currentAcceptance, frozenTestSet, acceptanceSensorsFor}, attempt-log.attemptSlice, evidence.pendingAmendment, prompts.stageEnv, stages/verify-stage.verifyFacts, branching.{stageBranch, dirtyFiles}, git.getCurrentBranch, agent/claudeSession.buildQueryOptions, run-snapshot.runSnapshot, state.readState, config.LOOP_DEFAULTS.
 */

import fs from "node:fs";
import path from "node:path";
import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import {
  acceptanceSensorsFor,
  assertEntrySensors,
  currentAcceptance,
  frozenTestSet,
  RECORDED_ACCEPTANCE,
} from "../acceptance.js";
import { buildQueryOptions } from "../agent/claudeSession.js";
import { attemptSlice } from "../attempt-log.js";
import { dirtyFiles, stageBranch } from "../branching.js";
import { LOOP_DEFAULTS } from "../config.js";
import {
  buildImplementPrompt,
  buildStagePrompt,
  buildTestsPrompt,
  buildVerifyPrompt,
} from "../entry-prompts.js";
import { pendingAmendment } from "../evidence.js";
import { getCurrentBranch } from "../git.js";
import type { PendingRequest } from "../humanInput.js";
import { parseTasksMd } from "../parser.js";
import {
  describeEntries,
  type PickerInput,
  type QueueViewEntry,
  readEntryFile,
} from "../picker.js";
import { loadPolicy, type Policy, policyPath } from "../policy.js";
import { stageEnv } from "../prompts.js";
import {
  loadQueue,
  type QueueV3,
  queuePath,
  type ResolvedEntry,
  type StageName,
} from "../queue.js";
import { runSnapshot } from "../run-snapshot.js";
import type { SensorSpec } from "../sensors.js";
import { verifyFacts } from "../stages/verify-stage.js";
import { type DexState, readState } from "../state.js";
import type { RunConfig } from "../types.js";

const NO_QUEUE =
  "queue    : none — a new project builds .dex/queue.json in its first run; for an existing project run `dex queue init` first";
const WIDTH = 80;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const indent = (text: string) => text.split("\n").map((l) => `  ${l}`);

function loadInput(
  projectDir: string,
): { queue: QueueV3; policy: Policy; input: PickerInput } | null {
  const queue = loadQueue(projectDir, { persistMigration: false });
  if (!queue) return null;
  const policy = loadPolicy(projectDir, queue.kind);
  assertEntrySensors(queue, policy, queuePath(projectDir));
  return {
    queue,
    policy,
    input: { projectDir, queue, runBranch: readState(projectDir)?.runBranch ?? null, policy },
  };
}

// ── --dry-run ──

function policyLines(projectDir: string, policy: Policy, kind: QueueV3["kind"]): string[] {
  const file = fs.existsSync(policyPath(projectDir))
    ? ".dex/policy.json"
    : "defaults (no .dex/policy.json)";
  const counts = [
    `deny ${policy.deny.length}`,
    `ask ${policy.ask.length}`,
    `frozen ${policy.frozen.length}`,
    `preflight ${policy.preflight.length}`,
    `questions ${policy.questions}`,
    `pull request ${policy.openPullRequest ? "on" : "off"}`,
  ];
  const limits = Object.entries(policy.limits).map(([k, v]) => `${k}=${v}`);
  return [
    `queue    : .dex/queue.json · ${kind} project`,
    `policy   : ${file} · ${counts.join(" · ")}`,
    `limits   : ${limits.join(" ")}`,
  ];
}

/** Where the stage runs: the branch move `prepareBranch` would make, and whether a dirty tree refuses it now. */
function branchMove(input: PickerInput, entry: ResolvedEntry, stage: StageName): string {
  if (input.queue.kind === "new")
    return `the run branch ${input.runBranch ?? "(Dex creates it when the run starts)"}`;
  const current = getCurrentBranch(input.projectDir);
  const target = stageBranch(input.projectDir, entry);
  const base = target === entry.branch ? "" : " (base)";
  const move = `${target === current ? "stay on" : "switch to"} ${target}${base}`;
  const creates =
    stage === "specify" && target !== entry.branch ? `, spec-kit creates ${entry.branch}` : "";
  const dirty = target === current ? [] : dirtyFiles(input.projectDir);
  const refused =
    dirty.length > 0 ? ` — refused now, the tree has uncommitted files: ${dirty.join(", ")}` : "";
  return `${move}${creates}${refused}`;
}

/** A dry run starts no agent, so this is never called; the builder only needs one. */
const neverAsked: CanUseTool = async (_toolName, input) => ({
  behavior: "allow",
  updatedInput: input,
});

function systemLine(sp: Options["systemPrompt"], policy: Policy): string {
  const append = typeof sp === "object" && sp !== null && "append" in sp ? sp.append : undefined;
  if (!append) return "claude_code preset";
  return `claude_code preset + append ${policy.systemPromptAppend} (${append.length.toLocaleString("en-US")} chars)`;
}

/** The SDK options the stage's agent gets, from the same builder the run uses. */
function sdkLines(projectDir: string, policy: Policy, env: Record<string, string>): string[] {
  const config: RunConfig = {
    projectDir,
    specDir: "",
    mode: "loop",
    taskPhases: "all",
    ...LOOP_DEFAULTS,
  };
  let o: Options;
  try {
    o = buildQueryOptions({ config, env, abortController: null, policy }, {}, neverAsked);
  } catch (err) {
    return [`options  : cannot build them — ${message(err)}`];
  }
  const budget = o.maxBudgetUsd === undefined ? "none" : `$${o.maxBudgetUsd.toFixed(2)}`;
  const sources = (o.settingSources ?? []).join(",");
  return [
    `options  : settingSources=${sources} permissionMode=${o.permissionMode} maxTurns=${o.maxTurns} budget/stage=${budget}`,
    `system   : ${systemLine(o.systemPrompt, policy)}`,
  ];
}

/** A new project's implement prompt names the goal; an existing project has none. */
function goalPathOf(projectDir: string, kind: QueueV3["kind"]): string | null {
  const goal = path.join(projectDir, "GOAL.md");
  return kind === "new" && fs.existsSync(goal) ? goal : null;
}

/** A dry run runs no sensor, so the verify prompt is shown in review mode with no acceptance runs. */
const VERIFY_NOTE =
  "(the verify mode follows Dex's own acceptance run, which a dry run does not do: red → diagnose, green → review; shown: review)\n\n";

function promptFor(
  input: PickerInput,
  policy: Policy,
  entry: ResolvedEntry,
  stage: StageName,
  taskPhase: number | null,
): string {
  const { projectDir, queue } = input;
  const tasksMd = () => readEntryFile(input, entry, `${entry.specDir}/tasks.md`) ?? "";
  const attempts = attemptSlice(projectDir, entry.id);
  if (stage === "implement") {
    const phase = parseTasksMd(tasksMd()).find((p) => p.number === taskPhase);
    if (!phase) return `(${entry.specDir}/tasks.md has no phase ${taskPhase})`;
    return buildImplementPrompt(entry, projectDir, {
      phase,
      goalPath: goalPathOf(projectDir, queue.kind),
      frozen: frozenTestSet(entry, currentAcceptance(projectDir, entry, policy)),
      attempts,
    });
  }
  if (stage === "tests") {
    const { testGlobs, testSupport } = policy;
    const amendment = pendingAmendment(projectDir, entry.id);
    return buildTestsPrompt(entry, projectDir, { testGlobs, testSupport, lastCrash: null, amendment, attempts });
  }
  if (stage === "verify") {
    const extras = {
      ...verifyFacts(tasksMd()),
      mode: "review" as const,
      acceptance: [],
      diffStat: null,
      browser: policy.verify.browser,
      attempts,
    };
    return `${VERIFY_NOTE}${buildVerifyPrompt(entry, projectDir, extras)}`;
  }
  return buildStagePrompt(queue, entry, projectDir, stage);
}

/** One sensor row: kind, name, command, timeout, and a note. */
function sensorRow(kind: string, s: SensorSpec, note = ""): string {
  const command = s.command.length < 30 ? s.command.padEnd(30) : `${s.command} `;
  return `  ${kind.padEnd(11)} ${s.name.padEnd(12)} ${command} ${`${s.timeoutSec}s`.padStart(6)}${note}`;
}

/**
 * 016 contracts/cli.md § dry run: every sensor Dex would run for the entry —
 * fast (the policy's, then the entry's), standing, and acceptance (the record's
 * command, or who writes it, then the queue's). Reads files; runs nothing.
 */
function sensorLines(projectDir: string, policy: Policy, entry: ResolvedEntry): string[] {
  const lines = [
    ...policy.checks.fast.map((s) => sensorRow("fast", s)),
    ...entry.checks.map((s) => sensorRow("fast", s, "   (entry)")),
    ...policy.checks.standing.map((s) => sensorRow("standing", s)),
  ];
  const skipsTests = entry.skip.includes("tests");
  const record = skipsTests ? null : currentAcceptance(projectDir, entry, policy);
  if (skipsTests && entry.acceptance.length === 0) {
    lines.push("  acceptance none — the entry will pause before implement");
  } else if (!skipsTests && !record) {
    lines.push("  acceptance (written by the tests stage)");
  }
  for (const s of acceptanceSensorsFor(entry, record)) {
    const recorded = record !== null && s.name === RECORDED_ACCEPTANCE;
    lines.push(sensorRow("acceptance", s, recorded ? "   (acceptance.json)" : ""));
  }
  return lines;
}

function entryBlock(
  input: PickerInput,
  policy: Policy,
  entry: ResolvedEntry,
  view: QueueViewEntry,
): string[] {
  const stage = view.nextStage;
  if (!stage) return [`decision : pause — ${view.reason}`];
  const phase = view.taskPhase === null ? "" : ` phase ${view.taskPhase}`;
  const env = { ...policy.env, ...stageEnv(entry, stage, input.queue.kind) };
  let prompt: string;
  try {
    prompt = promptFor(input, policy, entry, stage, view.taskPhase);
  } catch (err) {
    prompt = `(cannot build the prompt — ${message(err)})`;
  }
  return [
    `decision : ${stage}${phase} — ${view.reason}`,
    `branch   : ${branchMove(input, entry, stage)}`,
    `env      : ${
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "(none)"
    }`,
    ...sdkLines(input.projectDir, policy, env),
    "sensors  :",
    ...sensorLines(input.projectDir, policy, entry),
    "prompt   :",
    ...indent(prompt),
  ];
}

const rule = (id: string) => {
  const head = `━━ ${id} `;
  return head + "━".repeat(Math.max(4, WIDTH - head.length));
};

/** What a run would do now, entry by entry, without starting an agent. */
export function dryRunLines(projectDir: string): string[] {
  const loaded = loadInput(projectDir);
  if (!loaded) return [NO_QUEUE];
  const { queue, policy, input } = loaded;
  const lines = policyLines(projectDir, policy, queue.kind);
  const remaining = describeEntries(input).filter(
    ({ view }) => view.status === "active" || view.status === "pending",
  );
  if (remaining.length === 0)
    lines.push("", "every entry is done or skipped: the run ends queue_complete");
  for (const { entry, view } of remaining)
    lines.push("", rule(entry.id), ...entryBlock(input, policy, entry, view));
  return lines;
}

// ── --status ──

function runLines(state: DexState | null): string[] {
  if (!state) return ["run      : none yet"];
  const why =
    state.status === "paused"
      ? ` · ${state.pauseReason ?? "?"}${state.pausedAt ? ` since ${state.pausedAt}` : ""}`
      : "";
  const lines = [
    `run      : ${state.runId.slice(0, 8)} · ${state.status}${why} · cost $${state.cumulativeCostUsd.toFixed(2)}`,
  ];
  if (state.pauseDetail) lines.push(`detail   : ${state.pauseDetail}`);
  const c = state.current;
  if (c)
    lines.push(
      `last     : ${c.entryId} · ${c.stage}${c.taskPhase === null ? "" : ` phase ${c.taskPhase}`}`,
    );
  return lines;
}

function requestLine(r: PendingRequest): string[] {
  const where = r.entryId ?? "project";
  if (r.kind === "pause") return [`  ⏸ (${where}) ${r.reason}: ${r.detail}`];
  if (r.kind === "tool_approval") return [`  ? (${where}) approve ${r.toolName}: ${r.subject}`];
  return r.questions.map((q) => `  ? (${where}) ${q.question}`);
}

function waitingLines(projectDir: string, state: DexState | null): string[] {
  const pending = state?.pendingRequests ?? [];
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(
      `waiting  : ${pending.length} request(s) — answer with \`dex run ${projectDir}\` in a terminal`,
    );
    lines.push(...pending.flatMap(requestLine));
  }
  const review = state?.reviewList.length ?? 0;
  if (review > 0)
    lines.push(`review   : ${review} answer(s) given by default — listed in .dex/questions.md`);
  return lines;
}

/** The queue with derived status and cost, the run's state, and what waits. */
export function statusLines(projectDir: string): string[] {
  const { state, queue, errors } = runSnapshot(projectDir);
  const lines = runLines(state);
  if (!queue) lines.push(NO_QUEUE);
  else {
    lines.push(`queue    : ${queue.kind} project`);
    const width = Math.max(...queue.entries.map((e) => e.id.length));
    for (const e of queue.entries) {
      const phase = e.taskPhase === null ? "" : ` phase ${e.taskPhase}`;
      const next = e.nextStage ? `${e.nextStage}${phase} — ${e.reason}` : e.reason;
      lines.push(
        `  ${e.id.padEnd(width)}  ${e.status.padEnd(7)}  ${next} · $${e.costUsd.toFixed(2)}`,
      );
    }
  }
  for (const error of errors) lines.push(`error    : ${error}`);
  return [...lines, ...waitingLines(projectDir, state)];
}
