import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { deriveGoalPaths, type GoalPaths } from "../goal-paths.js";
import { askQuestions, questionModeFor } from "../humanInput.js";
import type { Policy } from "../policy.js";
import { loadQueue, type StageName } from "../queue.js";
import type { AgentStep, EmitFn, RunConfig, StepType, UserInputQuestion } from "../types.js";
import type {
  AgentRunner,
  StepContext,
  StepResult,
  TaskPhaseContext,
  TaskPhaseResult,
} from "./AgentRunner.js";
import {
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

/** What the verify prompt tells the agent (contracts/verify-md.md). */
interface VerifyPromptFacts {
  hash: string;
  round: number;
  phaseNumber: number;
  firstTaskId: string;
}

function parseVerifyPrompt(prompt: string): VerifyPromptFacts {
  const hash = /^\*\*Tasks-SHA256\*\*: ([0-9a-f]{64})\s*$/m.exec(prompt)?.[1];
  const phase = /^## Phase (\d+): Verify fixes V(\d+)\s*$/m.exec(prompt);
  const task = /^- \[ \] (T\d+) /m.exec(prompt)?.[1];
  if (!hash || !phase || !task) {
    throw new Error(
      "mock verify: the prompt lacks the Tasks-SHA256 line, the fix-phase header or the first fix task id",
    );
  }
  return { hash, round: Number(phase[2]), phaseNumber: Number(phase[1]), firstTaskId: task };
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
 * ticks the phase's in-scope tasks, and `verify` writes verify.md with the
 * fingerprint it reads from the prompt — so the mock follows the same file
 * contracts the real agent does (research R15).
 *
 * Failure modes are loud by design: missing script entries and unknown
 * substitution tokens throw typed errors that name the offending coordinates.
 */
export class MockAgentRunner implements AgentRunner {
  private readonly config: MockConfig;
  private readonly projectDir: string;
  private readonly goalPaths: GoalPaths;

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
    const descriptor = this.lookup(phase, step, entryId);

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
      await this.ask(descriptor.asks, {
        ...ctx,
        entryId,
        step,
        autoClarification: ctx.config.autoClarification ?? false,
      });
    }
    // A stopped agent leaves nothing behind, like a real session aborted mid-stream.
    const stopped = aborted();
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
      this.applySideEffects(descriptor, tctx);
      if (step === "verify") this.writeVerify(descriptor as VerifyDescriptor, tctx, prompt);
      this.commitAsAgent(step, entryId);
    }

    emitStep("completed", `Step ${step} ${stopped ? "stopped" : "completed"} (mock)`);
    return {
      result: "",
      structuredOutput: stopped ? null : (descriptor.structured_output ?? null),
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
    const descriptor = this.lookup("entries", "implement", entryId);

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
      await this.ask(descriptor.asks, {
        ...ctx,
        entryId,
        step: "implement",
        autoClarification: false,
      });
    }
    const stopped = aborted();
    if (!stopped) {
      this.applySideEffects(descriptor, { cycleNumber: 0, featureId: entryId, specDir, runId });
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
    return { cost: 0, durationMs: Date.now() - start, inputTokens: 0, outputTokens: 0 };
  }

  /** Asks the scripted questions the way canUseTool answers AskUserQuestion: the stage's mode decides. */
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
  ): Promise<void> {
    const questions: UserInputQuestion[] = asks.map((q) => ({
      question: q.question,
      header: q.header ?? "",
      multiSelect: q.multiSelect ?? false,
      options: q.options.map((o) => ({ label: o.label, description: o.description ?? "" })),
    }));
    await askQuestions(
      { projectDir: this.projectDir, runId: c.runId, emit: c.emit },
      c.entryId,
      questions,
      {
        mode: questionModeFor(c.step, c.autoClarification, c.policy),
        step: c.step,
      },
    );
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

  private applySideEffects(descriptor: StepDescriptor, ctx: TemplateCtx): void {
    for (const w of descriptor.writes ?? []) {
      const dest = this.resolveProjectPath(w.path, ctx);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, this.renderTemplate(w.content, ctx), "utf8");
    }
    for (const a of descriptor.appends ?? []) {
      const dest = this.resolveProjectPath(a.path, ctx);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let line = this.renderTemplate(a.line, ctx);
      if (!line.endsWith("\n")) line += "\n";
      fs.appendFileSync(dest, line, "utf8");
    }
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
   * Writes verify.md with the fingerprint from the prompt and the verdict for
   * this round. On failure, appends the fix phase the prompt names to tasks.md.
   */
  private writeVerify(descriptor: VerifyDescriptor, ctx: TemplateCtx, prompt: string): void {
    if (!ctx.specDir) throw new Error("mock verify: no specDir");
    const facts = parseVerifyPrompt(prompt);
    const rounds = descriptor.rounds ?? [];
    const round: VerifyRound = rounds[facts.round - 1] ?? rounds.at(-1) ?? { verdict: "passed" };
    const dir = path.join(this.projectDir, ctx.specDir);
    const verify = [
      `# Verification: ${ctx.featureId ?? path.basename(ctx.specDir)}`,
      "",
      `**Verdict**: ${round.verdict}`,
      `**Tasks-SHA256**: ${facts.hash}`,
      `**Checked**: ${new Date().toISOString()}`,
      "",
      "## Commands",
      "",
      "| Command | Exit code |",
      "|---|---|",
      `| \`mock verify round ${facts.round}\` | ${round.verdict === "passed" ? 0 : 1} |`,
      "",
    ];
    fs.writeFileSync(path.join(dir, "verify.md"), verify.join("\n"), "utf8");
    if (round.verdict === "passed") return;

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

  /**
   * What spec-kit's git extension does for `specify` when `GIT_BRANCH_NAME` is
   * set: create the feature branch from the current one and switch to it, or
   * switch to it when it already exists.
   */
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
