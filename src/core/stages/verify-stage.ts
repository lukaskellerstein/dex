/**
 * What: The verify stage (D-016-1, research R13). Dex keys the entry first (015's key and `tasksHash`, taken before the stage), runs the acceptance sensors itself (the recorded acceptance command plus the queue's `acceptance`), then a fresh verifier in one of two modes: `diagnose` when acceptance is red (find why, append a fix phase) or `review` when it is green (findings with a severity, a fix phase per blocking one). `gates.done` decides from Dex's runs and the findings; Dex writes `done.json` and a `verify` stage record (its attempt-log section carries the hypotheses or the findings) and emits `gate_decided`. When the done gate passes, the attempt log moves to the archive and the digest is written (`digest_written`). The pure parts: `REVIEW_SCHEMA`, `DIAGNOSE_SCHEMA`, `parseReview`, `parseDiagnose`, `verifyFacts`.
 * Not: Takes no verdict from the agent: neither schema has one, and a `verdict` field in the output is ignored (FR-005). Picks no stage: a failed done gate leaves the next step to the picker, and the fix phase sends the entry to implement. A stopped stage writes nothing.
 * Deps: runStage, entry-prompts.buildVerifyPrompt, acceptance.{currentAcceptance, acceptanceSensorsFor}, attempt-log.{attemptSlice, archiveAttempts}, digest.publishDigest, scope.stageScope (only tasks.md; the frozen test set protected), gates.done, evidence.{evidenceKey, tasksHash, writeDoneRecord, readStageRecords, Finding}, sensors.isGreen, tree-stamp.{treeStamp, diffStatSince}, parser.parseTasksMd, queue.isFixPhase, gate-runs.{runChecks, writeGateRecord, blankRecord, ctxOrThrow}.
 */

import { acceptanceSensorsFor, currentAcceptance } from "../acceptance.js";
import { archiveAttempts, attemptSlice } from "../attempt-log.js";
import { publishDigest } from "../digest.js";
import { buildVerifyPrompt, type VerifyExtras } from "../entry-prompts.js";
import {
  evidenceKey,
  type Finding,
  readStageRecords,
  tasksHash,
  writeDoneRecord,
} from "../evidence.js";
import { done } from "../gates.js";
import { parseTasksMd } from "../parser.js";
import { stageEnv } from "../prompts.js";
import { isFixPhase, type ResolvedEntry } from "../queue.js";
import { stageScope } from "../scope.js";
import { isGreen } from "../sensors.js";
import { diffStatSince, treeStamp } from "../tree-stamp.js";
import type { TaskPhase } from "../types.js";
import { headOrNull, readTasks, type StageDeps } from "./cycle-stages.js";
import { blankRecord, ctxOrThrow, type GatedRun, runChecks, writeGateRecord } from "./gate-runs.js";
import { runStage } from "./run-stage.js";

// ── Schemas and parsers (R13): no verdict field in either ──

const nullableString = { type: ["string", "null"] } as const;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "criteria", "findings"],
  properties: {
    summary: { type: "string" },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met", "note"],
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "summary", "criterion", "where"],
        properties: {
          severity: { type: "string", enum: ["blocking", "minor"] },
          summary: { type: "string" },
          criterion: nullableString,
          where: nullableString,
        },
      },
    },
  },
} as const;

export const DIAGNOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "hypotheses"],
  properties: {
    summary: { type: "string" },
    hypotheses: { type: "array", items: { type: "string" } },
  },
} as const;

export interface Criterion {
  criterion: string;
  met: boolean;
  note: string;
}

export interface ReviewOutput {
  summary: string;
  criteria: Criterion[];
  findings: Finding[];
}

export interface DiagnoseOutput {
  summary: string;
  hypotheses: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const optString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function parseFinding(raw: unknown): Finding | null {
  if (!isObject(raw)) return null;
  if (raw.severity !== "blocking" && raw.severity !== "minor") return null;
  if (typeof raw.summary !== "string" || raw.summary.trim() === "") return null;
  return {
    severity: raw.severity,
    summary: raw.summary,
    criterion: optString(raw.criterion),
    where: optString(raw.where),
  };
}

/** The review output, or null when it does not have the shape. Unknown fields (a `verdict`) are ignored. */
export function parseReview(raw: unknown): ReviewOutput | null {
  if (!isObject(raw) || typeof raw.summary !== "string" || !Array.isArray(raw.findings)) return null;
  const findings = raw.findings.map(parseFinding);
  if (findings.some((f) => f === null)) return null;
  const criteria = (Array.isArray(raw.criteria) ? raw.criteria : []).flatMap((c) =>
    isObject(c) && typeof c.criterion === "string"
      ? [{ criterion: c.criterion, met: c.met === true, note: String(c.note ?? "") }]
      : [],
  );
  return { summary: raw.summary, criteria, findings: findings as Finding[] };
}

/** The diagnose output, or null when it does not have the shape. Unknown fields are ignored. */
export function parseDiagnose(raw: unknown): DiagnoseOutput | null {
  if (!isObject(raw) || typeof raw.summary !== "string") return null;
  const h = raw.hypotheses;
  if (!Array.isArray(h) || !h.every((x) => typeof x === "string")) return null;
  return { summary: raw.summary, hypotheses: h };
}

// ── Where a fix phase goes (015) ──

/** `T<max+1>`, padded like the file's ids (T009 → T010). */
function nextTaskId(phases: TaskPhase[]): string {
  const ids = phases.flatMap((p) => p.tasks.map((t) => t.id));
  const max = Math.max(0, ...ids.map((id) => Number(id.slice(1))));
  const width = Math.max(3, ...ids.map((id) => id.length - 1));
  return `T${String(max + 1).padStart(width, "0")}`;
}

/** What the verify prompt states about tasks.md: the round, and where a fix phase goes. */
export function verifyFacts(tasksMd: string): Pick<VerifyExtras, "round" | "nextPhaseNumber" | "nextTaskId"> {
  const phases = parseTasksMd(tasksMd);
  return {
    round: phases.filter(isFixPhase).length + 1,
    nextPhaseNumber: Math.max(0, ...phases.map((p) => p.number)) + 1,
    nextTaskId: nextTaskId(phases),
  };
}

// ── The stage ──

/** The entry's work so far: the diff stat from its first recorded stage start. */
function entryDiffStat(projectDir: string, entry: ResolvedEntry): string | null {
  const first = readStageRecords(projectDir, entry.id).find((r) => r.startSha)?.startSha;
  if (!first) return null;
  try {
    return diffStatSince(projectDir, first) || null;
  } catch {
    return null;
  }
}

/**
 * Dex's acceptance run, the verifier in the mode it implies, then the done gate.
 * The record is keyed with what was checked — the entry as it was when the stage
 * started — so a commit during the stage sends the entry back to verify.
 */
export async function runVerify(
  deps: StageDeps,
  entry: ResolvedEntry,
  cycleNumber: number,
): Promise<GatedRun> {
  const ctx = ctxOrThrow();
  const { projectDir } = ctx;
  const key = evidenceKey(projectDir, deps.kind, entry);
  if (key === null) {
    throw new Error(`verify ${entry.id}: cannot key the record (no branch "${entry.branch}" or no ${entry.specDir})`);
  }
  const tasksMd = readTasks(projectDir, entry);
  const startSha = headOrNull(projectDir);
  const record = currentAcceptance(projectDir, entry, ctx.policy);
  const specs = acceptanceSensorsFor(entry, record);
  const acceptance = await runChecks(ctx, deps.runId, entry, "verify", null, specs);
  const out = { ran: "verify" as const, progressPassed: null, guard: null };
  if (ctx.abort.signal.aborted) return { ...out, cost: 0, limitHit: null };

  const mode = acceptance.length > 0 && acceptance.every(isGreen) ? "review" : "diagnose";
  const schema = mode === "review" ? REVIEW_SCHEMA : DIAGNOSE_SCHEMA;
  const r = await runStage({
    outputFormat: { type: "json_schema", schema: schema as unknown as Record<string, unknown> },
    config: deps.config,
    prompt: buildVerifyPrompt(entry, projectDir, {
      ...verifyFacts(tasksMd),
      mode,
      acceptance,
      diffStat: mode === "diagnose" ? entryDiffStat(projectDir, entry) : null,
      browser: ctx.policy.verify.browser,
      attempts: attemptSlice(projectDir, entry.id),
    }),
    runId: deps.runId,
    cycleNumber,
    step: "verify",
    specDir: entry.specDir,
    env: stageEnv(entry, "verify", deps.kind),
    entryId: entry.id,
    scope: stageScope(ctx.policy, entry, "verify", record),
  });
  if (ctx.abort.signal.aborted || r.limitHit) return { ...out, cost: r.cost, limitHit: r.limitHit };

  const review = mode === "review" ? parseReview(r.structuredOutput) : null;
  const diagnose = mode === "diagnose" ? parseDiagnose(r.structuredOutput) : null;
  const decision = done(acceptance, mode === "review" ? (review?.findings ?? null) : []);
  const summary = review?.summary ?? diagnose?.summary ?? "";
  const doneFile = writeDoneRecord(projectDir, {
    version: 2,
    entryId: entry.id,
    key,
    tasksHash: tasksHash(tasksMd),
    checked: new Date().toISOString(),
    acceptance,
    mode,
    findings: review?.findings ?? [],
    hypotheses: diagnose?.hypotheses ?? [],
    summary,
    gate: decision.outcome === "pass" ? "passed" : "failed",
  });
  ctx.rlog.run("INFO", `verify: ${entry.id} · ${mode} · wrote ${doneFile}`);
  writeGateRecord(
    ctx,
    deps.runId,
    {
      ...blankRecord(entry, "verify"),
      mode,
      key,
      tasksHash: tasksHash(tasksMd),
      startSha,
      endSha: headOrNull(projectDir),
      treeStamp: treeStamp(projectDir),
      runs: acceptance,
      gate: decision,
      summary: summary || null,
    },
    r.agentRunId,
    diagnose?.hypotheses ?? (review?.findings ?? []).map((f) => `${f.severity}: ${f.summary}`),
  );
  if (decision.outcome === "pass") entryDone(ctx, deps.runId, entry);
  return { ...out, cost: r.cost, limitHit: r.limitHit };
}

/** The done gate passed (FR-036, FR-037): the attempt log goes to the archive, and the digest is written. */
function entryDone(ctx: ReturnType<typeof ctxOrThrow>, runId: string, entry: ResolvedEntry): void {
  const archived = archiveAttempts(ctx.projectDir, entry.id);
  if (archived) ctx.rlog.run("INFO", `verify: ${entry.id} · archived the attempt log to ${archived}`);
  const file = publishDigest({ ...ctx, runId }, entry, ctx.policy, { status: "done", why: null });
  ctx.rlog.run("INFO", `verify: ${entry.id} · digest ${file}`);
}
