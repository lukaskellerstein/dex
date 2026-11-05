/**
 * What: The per-entry stage prompts (015 research R11), moved out of prompts.ts in 016 (research R18) — brief, specify, clarify, plan, tasks, tests (create and amend mode), implement, restore and verify (diagnose and review mode), and `buildStagePrompt` for the five file stages. The tests, implement, restore and verify prompts end with "Earlier attempts", the newest sections of the entry's attempt log (R14), which the caller reads and passes in. Each builder is a pure function of (entry, projectDir, extras), so `dex run --dry-run` prints exactly what an agent receives.
 * Not: Reads no file and runs nothing. The project-level prompts and `stageEnv` stay in prompts.ts.
 * Deps: node:path; evidence.AMENDMENT_HEADER; queue.{isFixPhase, isInScope}; sensors.isGreen; types.
 */

import path from "node:path";
import { AMENDMENT_HEADER } from "./evidence.js";
import {
  isFixPhase,
  isInScope,
  type QueueV3,
  type ResolvedEntry,
  type StageName,
} from "./queue.js";
import { isGreen, type SensorRun } from "./sensors.js";
import type { TaskPhase } from "./types.js";

/** A project-relative path as an absolute one. */
function absPath(projectDir: string, rel: string): string {
  return path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
}

/** Replaces Dex's old fixed commit command: the project's own rules decide. */
function commitRule(entry: ResolvedEntry): string {
  return `- Commit your changes as this project's rules say (CLAUDE.md, AGENTS.md, CONTRIBUTING). If the rules say nothing about commits, make one commit for this stage with a short message that names ${entry.id}.`;
}

function rules(lines: string[]): string {
  return `## Dex rules for this stage\n\n${lines.join("\n")}`;
}

export interface BriefExtras {
  /** The previous entry's brief, as the format example; null when there is none. */
  previousBrief: string | null;
}

export function buildBriefPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: BriefExtras,
): string {
  const target = absPath(projectDir, entry.brief ?? `docs/${entry.id}.md`);
  const sources = (entry.generate?.sources ?? []).map((s) => `- ${absPath(projectDir, s)}`);
  const example = extras.previousBrief
    ? `Use ${absPath(projectDir, extras.previousBrief)} as the format example.`
    : "State the goal, the scope (in and out) and the acceptance criteria.";
  const instructions = entry.generate?.instructions
    ? `\n\n## Instructions\n\n${entry.generate.instructions}`
    : "";
  return `Write the brief for "${entry.title}" (${entry.id}) to ${target}.

## Sources

${sources.join("\n")}${instructions}

${rules([
  `- ${example}`,
  '- The brief must have an acceptance section ("## Acceptance" or "Definition of Done"): the verify stage checks the work against it.',
  "- Write only this one file.",
  commitRule(entry),
])}`;
}

export function buildSpecifyPrompt(entry: ResolvedEntry, projectDir: string): string {
  const specPath = absPath(projectDir, entry.specDir);
  const head = entry.brief
    ? `/speckit-specify Implement the feature described in the brief at ${absPath(projectDir, entry.brief)}.`
    : `/speckit-specify ${entry.title}: ${entry.description ?? entry.title}`;
  const lines = [
    `- The spec folder is ${specPath} and the branch is ${entry.branch}. Use exactly these names.`,
    ...(entry.brief
      ? [
          "- The brief is the source of truth. Do not add scope it does not have; mark open points [NEEDS CLARIFICATION].",
        ]
      : []),
    commitRule(entry),
  ];
  return `${head}\n\n${rules(lines)}`;
}

export function buildClarifyPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: { date: string },
): string {
  const specPath = absPath(projectDir, entry.specDir);
  const sources = entry.brief ? `the brief (${absPath(projectDir, entry.brief)}), ` : "";
  return `/speckit-clarify ${specPath}

${rules([
  "- Run autonomously. Do not wait for a human unless the last question rule below applies.",
  `- Answer each question yourself from ${sources}the repository and its docs.`,
  "- Record every question and its answer in spec.md.",
  `- Always write a \`## Clarifications\` section with a \`### Session ${extras.date}\` heading. When there are no critical ambiguities, write "No critical ambiguities" under it. Dex reads this section to know the stage is done.`,
  '- Ask the human (AskUserQuestion) only when nothing in the repository answers the question and a wrong guess would cost more than a day of rework. End the label of the option you recommend with "(Recommended)".',
  commitRule(entry),
])}`;
}

export function buildPlanPrompt(entry: ResolvedEntry, projectDir: string): string {
  return `/speckit-plan ${absPath(projectDir, entry.specDir)}\n\n${rules([commitRule(entry)])}`;
}

export function buildTasksPrompt(entry: ResolvedEntry, projectDir: string): string {
  return `/speckit-tasks ${absPath(projectDir, entry.specDir)}\n\n${rules([commitRule(entry)])}`;
}

/** Why the entry's last progress gate failed, with the red checks (FR-018). */
export interface GateEvidence {
  reason: string;
  failing: SensorRun[];
}

export interface ImplementExtras {
  phase: TaskPhase;
  /** The project goal, read-only context for new projects; null when there is none. */
  goalPath: string | null;
  /** The entry's last progress gate, when it failed; Dex's evidence, not the agent's. */
  lastGate?: GateEvidence | null;
  /** The entry's frozen test set (FR-014): the implementer may not touch it. */
  frozen?: string[];
  /** The newest sections of the entry's attempt log (`attemptSlice`, R14). */
  attempts?: string;
}

/** An implement run's structured output: input to the attempt log, never to a gate (R8, R14). */
export const ATTEMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "notes"],
  properties: {
    summary: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

/** The frozen tests, and how to ask for a change to one (R10). Empty when nothing is frozen yet. */
function frozenRules(frozen: string[] | undefined): string[] {
  if (!frozen || frozen.length === 0) return [];
  return [
    `- These files are the entry's frozen acceptance tests and their record: ${frozen.join(", ")}. Never edit, move or delete them; Dex denies it.`,
    `- If one of these tests is wrong, ask with AskUserQuestion: header "${AMENDMENT_HEADER}", question "Amend <path>: <reason>". If the human approves, the test author changes it later: go on with the other tasks.`,
  ];
}

const ATTEMPT_RULE =
  "- Your structured output is `summary` (what you did) and `notes` (failures, errors, anything the next agent needs). Write failures there, not in tasks.md.";

/** Each red check as Dex ran it: name, command, result and output tail. */
function sensorEvidence(runs: SensorRun[]): string {
  return runs
    .map((r) => {
      const code = r.exitCode === null ? r.result : `exit ${r.exitCode}`;
      const tail = r.tail.length > 0 ? r.tail.join("\n") : "(no output)";
      return `### ${r.name} — ${r.result} (${code})\n\n\`${r.command}\`\n\n\`\`\`text\n${tail}\n\`\`\``;
    })
    .join("\n\n");
}

/**
 * The newest sections of the entry's attempt log (R14), under one heading.
 * Their own `##` headings move one level down so the prompt keeps one outline.
 */
function attemptsSection(slice: string | undefined): string {
  if (!slice?.trim()) return "";
  return `\n\n## Earlier attempts\n\nDex's log of this entry's earlier stages, newest last. Build on it, and do not repeat what failed.\n\n${slice.trim().replace(/^## /gm, "### ")}`;
}

function gateSection(gate: GateEvidence | null | undefined): string {
  if (!gate) return "";
  const failing = gate.failing.length > 0 ? `\n\n${sensorEvidence(gate.failing)}` : "";
  return `\n\n## Evidence from Dex's last check\n\nThe last implement run did not pass Dex's progress gate: ${gate.reason}.${failing}`;
}

/** A "restore green first" run (research R7): no task phase, the red checks' evidence. */
export function buildRestorePrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: { failing: SensorRun[]; frozen?: string[]; attempts?: string },
): string {
  const specPath = absPath(projectDir, entry.specDir);
  return `${restoreBody(entry, specPath, extras)}${attemptsSection(extras.attempts)}`;
}

function restoreBody(entry: ResolvedEntry, specPath: string, extras: { failing: SensorRun[]; frozen?: string[] }): string {
  return `Dex ran this project's checks for ${entry.id} ("${entry.title}"), and the checks below are red. Restore green first.

${sensorEvidence(extras.failing)}

${rules([
  "- Make every check above green. Dex runs them again after you finish, and only that run counts.",
  "- Add no feature work.",
  `- Tick no task in ${specPath}/tasks.md, and change nothing else in it.`,
  "- Do not weaken, skip or delete a test to make it pass; fix the code or the setup.",
  ...frozenRules(extras.frozen),
  ATTEMPT_RULE,
  commitRule(entry),
])}`;
}

/** In-scope task ids of `phase`, or null when the whole phase is in scope. */
function scopeOf(entry: ResolvedEntry, phase: TaskPhase): string[] | null {
  if (!entry.tasks || isFixPhase(phase)) return null;
  return phase.tasks.filter((t) => isInScope(entry, phase, t)).map((t) => t.id);
}

export function buildImplementPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: ImplementExtras,
): string {
  const specPath = absPath(projectDir, entry.specDir);
  const { phase, goalPath } = extras;
  const scope = scopeOf(entry, phase);
  const lines = [
    `- You are implementing task phase ${phase.number}: ${phase.name}.`,
    ...(scope
      ? [
          `- Only these tasks are in scope: ${scope.join(", ")}. Leave every other unchecked task alone.`,
        ]
      : []),
    `- After completing EACH task, mark it [X] in ${specPath}/tasks.md before you start the next one. Dex reads the ticks to decide what runs next.`,
    `- Change nothing else in ${specPath}/tasks.md: no new, removed, reworded or reordered task and no changed phase heading. Dex pauses the run on any of them.`,
    "- Run the build, the typecheck and the tests after each logical group of changes.",
    "- If a task fails, say so in your structured output's `notes` and move to the next task.",
    ...frozenRules(extras.frozen),
    ATTEMPT_RULE,
    ...(goalPath ? [`- Read ${goalPath} for project context. Do not change it.`] : []),
    "- If you learned something the next agent needs (a build quirk, a gotcha), add it to the project's agent instructions (CLAUDE.md or AGENTS.md).",
    "- Do not run more than 3 subagents at the same time.",
    commitRule(entry),
  ];
  return `/speckit-implement ${specPath} --phase ${phase.number}\n\n${rules(lines)}${gateSection(extras.lastGate)}${attemptsSection(extras.attempts)}`;
}

/** The tests stage's structured output: a summary for the attempt log, never a gate input (research R3). */
export const TESTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
} as const;

export interface TestsExtras {
  testGlobs: string[];
  testSupport: string[];
  /** Why the last red-first run crashed, with its run, when it did (R20). */
  lastCrash: { reason: string; run: SensorRun | null } | null;
  /** Amend mode (R10): the one frozen test the human approved a change to. */
  amendment?: { file: string; reason: string } | null;
  /** The newest sections of the entry's attempt log (R14). */
  attempts?: string;
}

/** Amend mode (FR-016): change one frozen test, for the approved reason; no red-first run follows. */
function buildAmendPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  amendment: { file: string; reason: string },
): string {
  const specPath = absPath(projectDir, entry.specDir);
  const file = absPath(projectDir, amendment.file);
  return `You are the test author for ${entry.id} ("${entry.title}"). The implementer asked to change one of the acceptance tests, and the human approved it.

## The amendment

- File: ${file}
- Reason: ${amendment.reason}

## Do

1. Read ${specPath}/spec.md, ${specPath}/plan.md and the test.
2. Change ${file} so that it matches the spec and the plan. Change only what the reason needs.
3. If a test name changes, update its \`covers\` line in ${specPath}/acceptance.json. Keep \`command\` and \`files\` as they are.

Your structured output is a short summary of what you changed.

${rules([
  `- Write only ${file} and files in ${specPath}. Dex denies every other write.`,
  "- Do not implement the feature, and do not tick tasks in tasks.md.",
  commitRule(entry),
])}`;
}

const ACCEPTANCE_EXAMPLE = `{
  "version": 1,
  "command": "<runs only this entry's acceptance tests>",
  "failExitCodes": [1],
  "timeoutSec": 1800,
  "files": ["<each test file you wrote, project-relative>"],
  "covers": [{ "test": "<file › test name>", "criterion": "SC-001" }]
}`;

function crashSection(crash: TestsExtras["lastCrash"]): string {
  if (!crash) return "";
  const evidence = crash.run ? `\n\n${sensorEvidence([crash.run])}` : "";
  return `\n\n## Your last attempt crashed\n\nDex ran your acceptance command, and it did not fail by an assertion: ${crash.reason}. Fix the tests or their setup so they run and fail by an assertion.${evidence}`;
}

/** The tests stage (FR-009–FR-013): acceptance tests at the feature's boundary, written before any code; or one approved amendment. */
export function buildTestsPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: TestsExtras,
): string {
  const body = extras.amendment
    ? buildAmendPrompt(entry, projectDir, extras.amendment)
    : createTestsPrompt(entry, projectDir, extras);
  return `${body}${attemptsSection(extras.attempts)}`;
}

function createTestsPrompt(entry: ResolvedEntry, projectDir: string, extras: TestsExtras): string {
  const specPath = absPath(projectDir, entry.specDir);
  const brief = entry.brief
    ? `- the brief ${absPath(projectDir, entry.brief)}: its acceptance section\n`
    : "";
  return `You are the test author for ${entry.id} ("${entry.title}"). You do not implement this feature: another agent does, after you, and it may not change the tests you write.

## Read

${brief}- ${specPath}/spec.md: its success criteria
- ${specPath}/plan.md and ${specPath}/contracts/ (when present): the feature's boundaries
- ${specPath}/tasks.md

## Write the acceptance tests

1. Test at the feature's boundary, as a user or a client sees it: the command line, the HTTP API, the UI in a browser (Playwright), or the project's own evidence tool.
2. Cover every success criterion. Do not unit-test code that does not exist yet.
3. The tests must fail now, by an assertion, because the feature does not exist yet. Dex runs them as soon as you finish.
4. If the project has no test runner that can run them, set one up. You may change the test-support files for that.

## Record them

Write ${specPath}/acceptance.json in exactly this shape; Dex validates it and rejects unknown fields:

\`\`\`json
${ACCEPTANCE_EXAMPLE}
\`\`\`

- \`command\` runs only this entry's acceptance tests, from the project folder.
- \`failExitCodes\` are the exit codes that mean "the tests ran and some failed" for this runner (pytest: 1; Playwright, vitest and jest: 1). Never 0.
- \`files\` lists every test file you wrote. They become frozen for the implementer.
- \`covers\` names the success criterion each test covers.

Your structured output is a short summary of what you wrote.${crashSection(extras.lastCrash)}

${rules([
  `- Write only files that match the test patterns (${extras.testGlobs.join(", ")}), the test-support files (${extras.testSupport.join(", ")}), and files in ${specPath}. Dex denies every other write.`,
  "- Do not implement the feature, and do not tick tasks in tasks.md.",
  commitRule(entry),
])}`;
}

/** Where a fix phase goes in tasks.md (015), and what Dex saw before the verifier ran (016 R13). */
export interface VerifyExtras {
  /** The round number k of the fix phase this run would append. */
  round: number;
  nextPhaseNumber: number;
  nextTaskId: string;
  /** `diagnose` when Dex's acceptance run is red, `review` when it is green. */
  mode: "diagnose" | "review";
  /** Dex's acceptance runs, just before the verifier started. */
  acceptance: SensorRun[];
  /** `git diff --stat` of the entry's work so far; diagnose mode. */
  diffStat: string | null;
  /** `policy.verify.browser`: a headless browser is attached to the session. */
  browser: boolean;
  /** The newest sections of the entry's attempt log (R14). */
  attempts?: string;
}

function fixPhaseBlock(specPath: string, x: VerifyExtras, oneTaskPer: string): string {
  return `Append this phase to the end of ${specPath}/tasks.md, with one task per ${oneTaskPer}:

\`\`\`markdown
## Phase ${x.nextPhaseNumber}: Verify fixes V${x.round}

**Purpose**: Fix what verification round ${x.round} found.

- [ ] ${x.nextTaskId} <a concrete fix, with the file and the criterion it fixes>
\`\`\`

Number further tasks on from ${x.nextTaskId}. Change nothing else in tasks.md.`;
}

function readList(entry: ResolvedEntry, projectDir: string, specPath: string): string {
  const brief = entry.brief
    ? `- the brief ${absPath(projectDir, entry.brief)}: its acceptance criteria\n`
    : "";
  return `${brief}- ${specPath}/spec.md: its success criteria\n- ${specPath}/tasks.md`;
}

function diagnoseBody(entry: ResolvedEntry, projectDir: string, x: VerifyExtras): string {
  const specPath = absPath(projectDir, entry.specDir);
  const red = x.acceptance.filter((r) => !isGreen(r));
  const diff = x.diffStat ? `\n\n## What changed so far\n\n\`\`\`text\n${x.diffStat}\n\`\`\`` : "";
  return `Dex ran the acceptance tests, and they are red. The work is not done.

${sensorEvidence(red)}${diff}

## Read

${readList(entry, projectDir, specPath)}

## Do

1. Find why the acceptance tests fail: read the output above, the spec, the tasks and the code that changed.
2. Never edit code, tests or configuration.
3. ${fixPhaseBlock(specPath, x, "cause to fix")}

## Return

Your structured output is \`summary\` (one or two sentences) and \`hypotheses\` (the likely causes, most likely first). Dex decides done itself, from its own acceptance run.`;
}

function reviewBody(entry: ResolvedEntry, projectDir: string, x: VerifyExtras): string {
  const specPath = absPath(projectDir, entry.specDir);
  const names = x.acceptance.map((r) => `"${r.name}"`).join(", ");
  const ran = names ? ` (${names})` : "";
  const browser = x.browser
    ? "\n2. Use the browser tools (a headless, isolated browser) to check the UI as a user sees it."
    : "";
  return `Dex ran the acceptance tests${ran}, and they are green. Now check the work against what was asked.

## Read

${readList(entry, projectDir, specPath)}

## Do

1. Check every success criterion against the code and the behaviour.${browser}
${x.browser ? "3" : "2"}. Report each problem as a finding. \`blocking\`: a criterion is not met, or the work is wrong for a user. \`minor\`: anything else.
${x.browser ? "4" : "3"}. Never edit code, tests or configuration. With no blocking finding, change no file and make no commit.

## Return

Your structured output is \`summary\`, \`criteria\` (each criterion, whether it is met, and a short note) and \`findings\` (\`severity\`, \`summary\`, \`criterion\`, \`where\`). Dex decides done itself: only its own green acceptance run and no blocking finding count.

## For blocking findings

${fixPhaseBlock(specPath, x, "blocking finding")}`;
}

/** The verify stage in one of its two modes (R13). Neither asks for a verdict. */
export function buildVerifyPrompt(
  entry: ResolvedEntry,
  projectDir: string,
  extras: VerifyExtras,
): string {
  const body =
    extras.mode === "diagnose"
      ? diagnoseBody(entry, projectDir, extras)
      : reviewBody(entry, projectDir, extras);
  return `You are the verification agent for ${entry.id} ("${entry.title}") — ${extras.mode} mode. You did not implement this work.

${body}

${rules([commitRule(entry)])}${attemptsSection(extras.attempts)}`;
}

/** The prompt for one of the five file stages (brief → tasks); implement and verify have their own builders. */
export function buildStagePrompt(
  queue: QueueV3,
  entry: ResolvedEntry,
  projectDir: string,
  stage: StageName,
): string {
  switch (stage) {
    case "brief":
      return buildBriefPrompt(entry, projectDir, {
        previousBrief: queue.entries[entry.index - 1]?.brief ?? null,
      });
    case "specify":
      return buildSpecifyPrompt(entry, projectDir);
    case "clarify":
      return buildClarifyPrompt(entry, projectDir, { date: new Date().toISOString().slice(0, 10) });
    case "plan":
      return buildPlanPrompt(entry, projectDir);
    case "tasks":
      return buildTasksPrompt(entry, projectDir);
    default:
      throw new Error(`stage ${stage} has its own prompt builder`);
  }
}
