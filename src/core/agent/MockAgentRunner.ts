import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deriveGoalPaths, type GoalPaths } from "../goal-paths.js";
import { askQuestions, questionModeFor } from "../humanInput.js";
import type { RunLogger } from "../log.js";
import { decideToolUse, type Policy, subjectOf } from "../policy.js";
import { loadQueue, type StageName } from "../queue.js";
import type { StageScope } from "../scope.js";
import type { AgentStep, EmitFn, RunConfig, StepType, UserInputQuestion } from "../types.js";
import type {
  AgentRunner,
  StepContext,
  StepResult,
  TaskPhaseContext,
  TaskPhaseResult,
} from "./AgentRunner.js";
import {
  type ImplementDescriptor,
  loadMockConfig,
  type MockConfig,
  MockConfigInvalidPathError,
  MockConfigMissingEntryError,
  type MockQuestion,
  PHASE_OF_STEP,
  type StepDescriptor,
  stageScript,
  type VerifyDescriptor,
  type VerifyRound,
} from "./MockConfig.js";
import { policyEnvFor } from "./permissions.js";

/** Inline step constructor, so the mock stays self-contained. */
function mkStep(
  type: AgentStep["type"],
  sequenceIndex: number,
  content: string | null,
  metadata: Record<string, unknown> | null = null,
): AgentStep {
  return {
    id: crypto.randomUUID(),
    sequenceIndex,
    type,
    content,
    metadata,
    durationMs: null,
    tokenCount: null,
    createdAt: new Date().toISOString(),
  };
}

const ALLOWED_TOKENS = [
  "specDir",
  "cycle",
  "feature",
  // Per-run uniqueness: `{runId}` is the full orchestrator runId, `{shortRunId}`
  // its first 6 characters — short enough for a path component.
  "runId",
  "shortRunId",
  // The goal file and its derivatives (014), so a config works for any goal name.
  "goalFile",
  "goalProductDomain",
  "goalTechnicalDomain",
  "goalClarified",
] as const;

interface TemplateCtx {
  cycleNumber: number;
  featureId: string | null;
  specDir: string | null;
  runId: string;
}

/** What the mock's file actions are checked with: the decision a real tool call gets (016 R16). */
interface WriteGuard {
  policy: Policy;
  scope?: StageScope;
  emit: EmitFn;
  runId: string;
  agentRunId: string;
  rlog: Pick<RunLogger, "agentRun">;
}

/** What the verify prompt tells the agent about a fix phase (contracts/evidence.md). */
interface VerifyPromptFacts {
  round: number;
  phaseNumber: number;
  firstTaskId: string;
  mode: "diagnose" | "review";
}

function parseVerifyPrompt(prompt: string): VerifyPromptFacts {
  const phase = /^## Phase (\d+): Verify fixes V(\d+)\s*$/m.exec(prompt);
  const task = /^- \[ \] (T\d+) /m.exec(prompt)?.[1];
  const mode = /— (diagnose|review) mode\./.exec(prompt)?.[1] as
    | VerifyPromptFacts["mode"]
    | undefined;
  if (!phase || !task || !mode) {
    throw new Error(
      "mock verify: the prompt lacks the mode, the fix-phase header or the first fix task id",
    );
  }
  return { round: Number(phase[2]), phaseNumber: Number(phase[1]), firstTaskId: task, mode };
}

/** The ids the implement prompt names as in scope; null when the whole phase is. */
function scopeFromPrompt(prompt: string): Set<string> | null {
  const m = /Only these tasks are in scope: ([^.]+)\./.exec(prompt);
  return m ? new Set(m[1].split(",").map((s) => s.trim())) : null;
}

function nthTaskId(first: string, offset: number): string {
  const width = first.length - 1;
  return `T${String(Number(first.slice(1)) + offset).padStart(width, "0")}`;
}

/**
 * Deterministic, scripted agent backend (009, re-keyed by entry in 015). Replays
 * `.dex/mock-config.json` instead of calling the Claude SDK. Each stage sleeps
 * for its delay, applies its writes and appends, and commits like an agent that
 * follows the project's rules (`mock(<stage>): <entryId>`). `implement` also
 * ticks the phase's in-scope tasks, and `verify` returns the scripted review or
 * diagnose output (by the prompt's mode) and appends the fix phase the prompt
 * names — in diagnose mode, or with a blocking finding — so the mock follows the
 * same contracts the real agent does (015 research R15, 016 R16).
 *
 * Failure modes are loud by design: missing script entries and unknown
 * substitution tokens throw typed errors that name the offending coordinates.
 */
export class MockAgentRunner implements AgentRunner {
  private readonly config: MockConfig;
  private readonly projectDir: string;
  private readonly goalPaths: GoalPaths;
  /** Task-phase runs so far, per entry, for `implement.runs` (in memory: one count per process). */
  private readonly implementRuns = new Map<string | null, number>();

  constructor(runConfig: RunConfig, projectDir: string) {
    this.config = loadMockConfig(projectDir);
    this.projectDir = projectDir;
    const goalPath = runConfig.descriptionFile ?? path.join(projectDir, "GOAL.md");
    this.goalPaths = deriveGoalPaths(goalPath);
  }

  async runStep(ctx: StepContext): Promise<StepResult> {
    const { cycleNumber, step, specDir, prompt, emit, rlog, runId } = ctx;
    const start = Date.now();
    const phase = PHASE_OF_STEP[step];
    const entryId = ctx.entryId ?? null;
    // Implement reaches runStep only as a restore run (016 research R7).
    const descriptor =
      step === "implement" ? this.restoreScript(entryId) : this.lookup(phase, step, entryId);

    rlog.agentRun("INFO", `mock.runStep: phase=${phase} step=${step} entry=${entryId ?? "(none)"}`);
    const emitStep = this.stepEmitter(emit);
    emitStep("user_message", prompt);
    emitStep("text", `${phase}/${step}${entryId ? ` (${entryId})` : ""}`, {
      mockStep: step,
      mockPhase: phase,
      cycleNumber,
      featureId: entryId,
    });

    await sleep(descriptor.delay);
    const aborted = () => ctx.abortController?.signal.aborted ?? false;
    if (descriptor.asks && !aborted()) {
      await this.ask(
        descriptor.asks,
        { ...ctx, entryId, step, autoClarification: ctx.config.autoClarification ?? false },
        emitStep,
      );
    }
    // A stopped agent leaves nothing behind, like a real session aborted mid-stream.
    const stopped = aborted();
    let verifyOutput: Record<string, unknown> | null = null;
    if (!stopped) {
      // spec-kit writes where SPECIFY_FEATURE_DIRECTORY points (research R5).
      const tctx = {
        cycleNumber,
        featureId: entryId,
        specDir: ctx.env?.SPECIFY_FEATURE_DIRECTORY ?? specDir,
        runId,
      };
      if (step === "specify" && ctx.env?.GIT_BRANCH_NAME)
        this.switchToFeatureBranch(ctx.env.GIT_BRANCH_NAME);
      if (step === "brief") this.writeBrief(entryId);
      this.applySideEffects(descriptor, tctx, ctx);
      if (step === "verify")
        verifyOutput = this.verify(descriptor as VerifyDescriptor, tctx, prompt);
      this.commitAsAgent(step, entryId);
    }

    emitStep("completed", `Step ${step} ${stopped ? "stopped" : "completed"} (mock)`);
    return {
      result: "",
      structuredOutput: stopped ? null : (verifyOutput ?? descriptor.structured_output ?? null),
      cost: 0,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      sessionId: null,
    };
  }

  async runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult> {
    const { taskPhase, prompt, emit, rlog, config: runConfig, runId } = ctx;
    const start = Date.now();
    const entryId = ctx.entryId ?? null;
    const specDir = runConfig.specDir ?? null;
    const descriptor = this.implementScript(entryId);

    rlog.agentRun(
      "INFO",
      `mock.runTaskPhase: TaskPhase ${taskPhase.number} (specDir=${specDir}, entry=${entryId ?? "(none)"})`,
    );
    const emitStep = this.stepEmitter(emit);
    emitStep("user_message", prompt);
    emitStep("text", `runTaskPhase ${taskPhase.number}: ${taskPhase.name}`, {
      mockPhase: "implement",
      featureId: entryId,
    });

    await sleep(descriptor.delay);
    const aborted = () => ctx.abortController?.signal.aborted ?? false;
    if (descriptor.asks && !aborted()) {
      await this.ask(
        descriptor.asks,
        { ...ctx, entryId, step: "implement", autoClarification: false },
        emitStep,
      );
    }
    const stopped = aborted();
    if (!stopped) {
      this.applySideEffects(
        descriptor,
        { cycleNumber: 0, featureId: entryId, specDir, runId },
        { ...ctx, runId, agentRunId: ctx.agentRunId },
      );
      if (specDir && descriptor.tick !== false) {
        this.tickPhase(
          specDir,
          taskPhase.tasks.map((t) => t.id),
          scopeFromPrompt(prompt),
        );
      }
      this.commitAsAgent("implement", entryId);
    }

    const outcome = stopped ? "stopped" : "completed";
    emitStep("completed", `TaskPhase ${taskPhase.number}: ${taskPhase.name} ${outcome} (mock)`);
    return {
      cost: 0,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      structuredOutput: stopped ? null : (descriptor.structured_output ?? null),
    };
  }

  /**
   * Asks the scripted questions the way canUseTool answers AskUserQuestion: the
   * stage's mode decides. The answers the agent gets back go to the trace as a
   * `text` step, so a test sees what a real agent would read.
   */
  private async ask(
    asks: MockQuestion[],
    c: {
      runId: string;
      emit: EmitFn;
      entryId: string | null;
      step: StepType;
      autoClarification: boolean;
      policy: Policy;
    },
    emitStep: ReturnType<MockAgentRunner["stepEmitter"]>,
  ): Promise<void> {
    const questions: UserInputQuestion[] = asks.map((q) => ({
      question: q.question,
      header: q.header ?? "",
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
    }));
    const answers = await askQuestions(
      { projectDir: this.projectDir, runId: c.runId, emit: c.emit },
      c.entryId,
      questions,
      {
        mode: questionModeFor(c.step, c.autoClarification, c.policy),
        step: c.step,
      },
    );
    emitStep("text", `answers: ${JSON.stringify(answers)}`, { mockAnswers: answers });
  }

  // ── Lookup ──

  private lookup(phase: string, step: string, entryId: string | null): StepDescriptor {
    const found =
      phase === "entries"
        ? stageScript(this.config, entryId, step as StageName)
        : (this.config as unknown as Record<string, Record<string, StepDescriptor>>)[phase]?.[step];
    if (!found) throw new MockConfigMissingEntryError(phase, step, entryId);
    return found;
  }

  /** The k-th task-phase run of an entry: `implement.runs[k-1]`, else the last one, else `implement`. */
  private implementScript(entryId: string | null): StepDescriptor {
    const implement = this.lookup("entries", "implement", entryId) as ImplementDescriptor;
    const k = (this.implementRuns.get(entryId) ?? 0) + 1;
    this.implementRuns.set(entryId, k);
    const runs = implement.runs;
    return runs ? (runs[k - 1] ?? runs[runs.length - 1]) : implement;
  }

  private restoreScript(entryId: string | null): StepDescriptor {
    const implement = this.lookup("entries", "implement", entryId) as ImplementDescriptor;
    if (!implement.restore) {
      throw new MockConfigMissingEntryError(
        "entries",
        "implement.restore",
        entryId,
        "a red baseline asked for a restore run",
      );
    }
    return implement.restore;
  }

  /** Emits synthetic agent_steps; the mock persists none (spec 009). */
  private stepEmitter(emit: TaskPhaseContext["emit"]) {
    let index = 0;
    return (
      type: AgentStep["type"],
      content: string,
      metadata: Record<string, unknown> | null = null,
    ) => {
      const s = mkStep(type, index++, content, metadata);
      emit({
        type: "agent_step",
        agentStep: {
          ...s,
          metadata: { ...s.metadata, costUsd: null, inputTokens: null, outputTokens: null },
        },
      });
    };
  }

  // ── Side-effect helpers ──

  /**
   * The stage's writes, appends and deletes, each first checked like the real
   * tool call it stands for (016 R16): a denied one is skipped, logged and
   * emitted as `policy_denied`. `.dex/fake/` is the fake sensors' switch, not
   * the agent's work, so it is never checked.
   */
  private applySideEffects(descriptor: StepDescriptor, ctx: TemplateCtx, guard: WriteGuard): void {
    for (const w of descriptor.writes ?? []) {
      const dest = this.resolveProjectPath(w.path, ctx);
      const content = this.renderTemplate(w.content, ctx);
      if (!this.allowed(guard, dest, "Write", { file_path: dest, content })) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, "utf8");
    }
    for (const a of descriptor.appends ?? []) {
      const dest = this.resolveProjectPath(a.path, ctx);
      let line = this.renderTemplate(a.line, ctx);
      if (!line.endsWith("\n")) line += "\n";
      const edit = { file_path: dest, old_string: "", new_string: line };
      if (!this.allowed(guard, dest, "Edit", edit)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.appendFileSync(dest, line, "utf8");
    }
    for (const d of descriptor.deletes ?? []) {
      const dest = this.resolveProjectPath(d, ctx);
      const command = `rm ${path.relative(this.projectDir, dest)}`;
      if (!this.allowed(guard, dest, "Bash", { command })) continue;
      fs.rmSync(dest, { force: true });
    }
  }

  private allowed(
    guard: WriteGuard,
    dest: string,
    toolName: string,
    input: Record<string, unknown>,
  ): boolean {
    if (dest.startsWith(path.join(this.projectDir, ".dex", "fake") + path.sep)) return true;
    const call = { toolName, input };
    const d = decideToolUse(guard.policy, call, policyEnvFor(this.projectDir), guard.scope);
    if (d.kind !== "deny") return true;
    const subject = subjectOf(call, this.projectDir);
    guard.emit({
      type: "policy_denied",
      runId: guard.runId,
      agentRunId: guard.agentRunId,
      toolName,
      subject,
      reason: d.reason,
      rule: d.rule,
    });
    guard.rlog.agentRun("WARN", `mock: denied ${toolName} (${d.rule}) — ${d.reason}`, { subject });
    return false;
  }

  /** Checks every unchecked task of the phase that is in scope, as the prompt asks. */
  private tickPhase(specDir: string, phaseTaskIds: string[], scope: Set<string> | null): void {
    const file = path.join(this.projectDir, specDir, "tasks.md");
    if (!fs.existsSync(file)) return;
    const ids = new Set(phaseTaskIds.filter((id) => !scope || scope.has(id)));
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const ticked = lines.map((line) => {
      const m = /^- \[[ ~]\] (T\d+)\b/.exec(line);
      return m && ids.has(m[1]) ? line.replace(/^- \[[ ~]\]/, "- [X]") : line;
    });
    fs.writeFileSync(file, ticked.join("\n"), "utf8");
  }

  /**
   * The scripted output for this round in the prompt's mode (016 R13): review
   * returns `findings`, diagnose returns `hypotheses`; both still carry the
   * round's old `verdict`, which the done gate ignores. Appends the fix phase the
   * prompt names in diagnose mode, or in review mode with a blocking finding.
   */
  private verify(
    descriptor: VerifyDescriptor,
    ctx: TemplateCtx,
    prompt: string,
  ): Record<string, unknown> {
    if (!ctx.specDir) throw new Error("mock verify: no specDir");
    const facts = parseVerifyPrompt(prompt);
    const rounds = descriptor.rounds ?? [];
    const round: VerifyRound = rounds[facts.round - 1] ?? rounds.at(-1) ?? { verdict: "passed" };
    const summary = `mock verify round ${facts.round} (${facts.mode})`;
    const findings = (round.findings ?? descriptor.findings ?? []).map((f) => ({
      severity: f.severity,
      summary: this.renderTemplate(f.summary, ctx),
      criterion: f.criterion ?? null,
      where: f.where ?? null,
    }));
    const output =
      facts.mode === "review"
        ? { verdict: round.verdict, summary, criteria: [], findings }
        : {
            verdict: round.verdict,
            summary,
            hypotheses: round.hypotheses ?? descriptor.hypotheses ?? [],
          };
    if (facts.mode === "review" && !findings.some((f) => f.severity === "blocking")) return output;
    this.appendFixPhase(round, ctx, facts);
    return output;
  }

  private appendFixPhase(round: VerifyRound, ctx: TemplateCtx, facts: VerifyPromptFacts): void {
    const dir = path.join(this.projectDir, ctx.specDir ?? "");
    const fixes = round.fixTasks?.length
      ? round.fixTasks.map((f) => this.renderTemplate(f, ctx))
      : [`Fix what verify round ${facts.round} found`];
    const tasksFile = path.join(dir, "tasks.md");
    const current = fs.readFileSync(tasksFile, "utf8");
    const phase = [
      `## Phase ${facts.phaseNumber}: Verify fixes V${facts.round}`,
      "",
      `**Purpose**: Fix what verification round ${facts.round} found.`,
      "",
      ...fixes.map((f, i) => `- [ ] ${nthTaskId(facts.firstTaskId, i)} ${f}`),
      "",
    ];
    fs.writeFileSync(tasksFile, `${current.replace(/\n*$/, "\n\n")}${phase.join("\n")}`, "utf8");
  }

  /** The brief stage: a short brief with an acceptance section at the entry's `brief` path (queue.json). */
  private writeBrief(entryId: string | null): void {
    const entry = loadQueue(this.projectDir)?.entries.find((e) => e.id === entryId);
    if (!entry?.brief)
      throw new Error(`mock brief: queue entry ${entryId ?? "(none)"} has no "brief" path`);
    const sources = (entry.generate?.sources ?? []).map((s) => `- ${s}`).join("\n");
    const body = `# Brief: ${entry.title}\n\nWritten by the mock brief stage from:\n\n${sources}\n\n## Goal\n\n${entry.description ?? entry.title}\n\n## Acceptance\n\n- ${entry.title} works as the sources describe.\n`;
    const dest = path.join(this.projectDir, entry.brief);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body, "utf8");
  }

  /**
   * What spec-kit's git extension does for `specify` when `GIT_BRANCH_NAME` is
   * set: create the feature branch from the current one and switch to it, or
   * switch to it when it already exists.
   */
  private switchToFeatureBranch(name: string): void {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: this.projectDir, stdio: "pipe" });
    try {
      git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
      git(["switch", "--quiet", name]);
    } catch {
      git(["switch", "--quiet", "-c", name]);
    }
  }

  /**
   * Commit like an agent following the project's rules would: everything the
   * stage changed, as `mock(<step>): <entry>`. Dex itself never commits, so
   * tests tell agent commits from Dex commits by this prefix. No-op outside a
   * repository or when the stage changed nothing.
   */
  private commitAsAgent(step: string, entryId: string | null): void {
    const run = (args: string[]) =>
      execFileSync("git", args, { cwd: this.projectDir, stdio: "pipe", encoding: "utf8" });
    try {
      run(["rev-parse", "--is-inside-work-tree"]);
    } catch {
      return;
    }
    run(["add", "-A"]);
    if (run(["diff", "--cached", "--name-only"]).trim() === "") return;
    run(["commit", "-q", "-m", `mock(${step}): ${entryId ?? "project"}`]);
  }

  private resolveProjectPath(template: string, ctx: TemplateCtx): string {
    const rendered = this.renderTemplate(template, ctx);
    return path.isAbsolute(rendered) ? rendered : path.resolve(this.projectDir, rendered);
  }

  private renderTemplate(template: string, ctx: TemplateCtx): string {
    return template.replace(/\{([a-zA-Z_]+)\}/g, (_match, token: string) => {
      switch (token) {
        case "specDir":
          return ctx.specDir ?? "";
        case "cycle":
          return String(ctx.cycleNumber);
        case "feature":
          return ctx.featureId ?? "";
        case "runId":
          return ctx.runId;
        case "shortRunId":
          return ctx.runId.slice(0, 6);
        case "goalFile":
          return this.goalPaths.goal;
        case "goalProductDomain":
          return this.goalPaths.productDomain;
        case "goalTechnicalDomain":
          return this.goalPaths.technicalDomain;
        case "goalClarified":
          return this.goalPaths.clarified;
        default:
          throw new MockConfigInvalidPathError(template, token, ALLOWED_TOKENS);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
