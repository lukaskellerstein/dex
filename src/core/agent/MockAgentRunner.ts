import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentRunner,
  TaskPhaseContext,
  TaskPhaseResult,
  StepContext,
  StepResult,
  OneShotContext,
  OneShotResult,
} from "./AgentRunner.js";
import type { AgentStep, RunConfig } from "../types.js";
import {
  MockConfig,
  MockConfigMissingEntryError,
  MockConfigInvalidPathError,
  MockFixtureMissingError,
  MockDisabledError,
  PHASE_OF_STEP,
  StepDescriptor,
  MockOneShotResponse,
  loadMockConfig,
  mockConfigPath,
} from "./MockConfig.js";

/**
 * Inline step constructor. Duplicates the helper in ./steps.ts — importing
 * from there would pull in the shared module chain which node --test
 * --experimental-strip-types cannot currently resolve (ESM .js→.ts). The mock
 * is otherwise self-contained, so the duplication buys testability at the
 * cost of ~10 lines.
 */
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

const ALLOWED_TOKENS = ["specDir", "cycle", "feature"] as const;

/**
 * Deterministic, scripted agent backend (009-testing-checkpointing). Replays a
 * project-local mock-config.json instead of calling the Claude SDK. Each stage
 * sleeps for its configured delay, executes declared filesystem side effects
 * (writes / appends), emits exactly one synthetic agent_step per stage, and
 * returns the structured output (if any) verbatim.
 *
 * Failure modes are loud by design: missing script entries, missing fixtures,
 * and unknown substitution tokens all throw typed errors that name the offending
 * coordinates (spec FR-010, FR-011).
 */
export class MockAgentRunner implements AgentRunner {
  private readonly config: MockConfig;
  private readonly projectDir: string;
  private readonly fixtureDir: string;
  /**
   * Tracks which cycles have already had their `stages.implement` side effects
   * applied. The orchestrator's implement flow bypasses `runStage("implement")`
   * and instead calls `runPhase` once per phase parsed from the fixture tasks.md.
   * To still produce non-empty diffs per cycle (spec SC-004), we apply the
   * cycle's implement writes on the FIRST `runPhase` for a new specDir and
   * no-op on subsequent calls within the same cycle.
   */
  private readonly implementAppliedForSpecDir = new Map<string, number>();
  private nextImplementCycleIndex = 0;

  constructor(_runConfig: RunConfig, projectDir: string) {
    this.config = loadMockConfig(projectDir);
    this.projectDir = projectDir;
    if (!this.config.enabled) {
      throw new MockDisabledError(mockConfigPath(projectDir));
    }
    // Resolve fixtureDir. Must be absolute or relative-to-projectDir. When
    // omitted, we require the user to set it explicitly — resolving a default
    // relative to this module's location is fragile across compiled/source
    // runtimes. Authoring a MockConfig without a fixtureDir is a common enough
    // slip that surfacing it at construction time is better than silent
    // fallback behavior.
    const declared = this.config.fixtureDir;
    if (!declared) {
      throw new Error(
        `MockAgentRunner: ${mockConfigPath(projectDir)} does not declare 'fixtureDir'. Set it to the absolute path of your fixtures directory (e.g. the Dex repo's /path/to/dex/fixtures/mock-run/).`,
      );
    }
    this.fixtureDir = path.isAbsolute(declared) ? declared : path.resolve(projectDir, declared);
  }

  async runStep(ctx: StepContext): Promise<StepResult> {
    const { cycleNumber, step, specDir, prompt, emit, rlog } = ctx;
    const start = Date.now();
    const phase = PHASE_OF_STEP[step];

    // Look up the descriptor for this step.
    let descriptor: StepDescriptor;
    let featureId: string | null = null;
    if (phase === "dex_loop") {
      const cycleIdx = cycleNumber - 1;
      const cycles = this.config.dex_loop.cycles;
      if (cycleIdx < 0 || cycleIdx >= cycles.length) {
        throw new MockConfigMissingEntryError(
          phase,
          step,
          cycleNumber,
          null,
          `cycles exhausted — script declares ${cycles.length} cycle(s) but orchestrator requested cycle ${cycleNumber}. Add a cycle or terminate earlier with a gap_analysis decision of 'GAPS_COMPLETE'`,
        );
      }
      const cycle = cycles[cycleIdx];
      featureId = cycle.feature.id;
      const found = (cycle.stages as Record<string, StepDescriptor>)[step];
      if (!found) {
        throw new MockConfigMissingEntryError(phase, step, cycleNumber, featureId);
      }
      descriptor = found;
    } else {
      const phaseEntry = (this.config as unknown as Record<string, Record<string, StepDescriptor>>)[phase];
      const found = phaseEntry[step];
      if (!found) {
        throw new MockConfigMissingEntryError(phase, step, null, null);
      }
      descriptor = found;
    }

    rlog.agentRun("INFO", `mock.runStep: phase=${phase} step=${step} cycle=${cycleNumber} feature=${featureId ?? "(none)"}`);

    // Emit the initial prompt + one synthetic agent_step per step. Unlike the
    // real runner, the mock does NOT persist steps via runs.appendAgentStep —
    // per-step persistence is intentionally out of scope (the mock's trace is
    // sparse by design; spec 009 assumption). The orchestrator's runStep
    // wrapper still records agent-run-level summaries via runs.startAgentRun /
    // completeAgentRun.
    let stepIndex = 0;
    const emitOnly = (agentStep: AgentStep) => {
      const enriched: AgentStep = {
        ...agentStep,
        metadata: { ...agentStep.metadata, costUsd: null, inputTokens: null, outputTokens: null },
      };
      emit({ type: "agent_step", agentStep: enriched });
    };
    emitOnly(mkStep("user_message", stepIndex++, prompt));

    // One synthetic mock_step agent_step so the trace view shows progress.
    emitOnly(
      mkStep("text", stepIndex++, `[mock] ${phase}/${step}${featureId ? ` (${featureId})` : ""}`, {
        mockStep: step,
        mockPhase: phase,
        cycleNumber,
        featureId,
      }),
    );

    // Sleep for the declared delay.
    if (descriptor.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, descriptor.delay));
    }

    // Execute side effects.
    this.applySideEffects(descriptor, { cycleNumber, featureId, specDir });

    const durationMs = Date.now() - start;

    // Emit completed step (mirrors real runner).
    emitOnly(mkStep("completed", stepIndex++, `Step ${step} completed (mock)`));

    return {
      result: "",
      structuredOutput: descriptor.structured_output ?? null,
      cost: 0,
      durationMs,
      inputTokens: 0,
      outputTokens: 0,
      sessionId: null,
    };
  }

  async runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult> {
    const { taskPhase, prompt, emit, rlog, config: runConfig } = ctx;
    const start = Date.now();

    // The orchestrator invokes runPhase in two places:
    //   (a) build mode (src/core/orchestrator.ts:625) — standalone spec-kit
    //       skill expansion; not the mock's primary target.
    //   (b) loop mode during `implement` (src/core/orchestrator.ts:2002) —
    //       once per phase parsed from fixtures/tasks.md.
    //
    // The loop's `implement` stage bypasses runStage entirely — the orchestrator
    // only emits stage_started/stage_completed itself and delegates per-phase
    // work to runPhase. If the mock no-op'd here, checkpoint commits for the
    // implement stage would be empty (failing spec SC-004). So we apply the
    // cycle's `cycles[i].stages.implement` side effects on the FIRST runPhase
    // call for a given specDir, then no-op on subsequent calls within the same
    // cycle.
    const specDir = runConfig.specDir;
    let descriptor: StepDescriptor | null = null;
    let assignedCycleNumber = 0;
    let assignedFeatureId: string | null = null;
    let isFirstPhaseForSpecDir = false;

    if (specDir && this.nextImplementCycleIndex < this.config.dex_loop.cycles.length) {
      let idx = this.implementAppliedForSpecDir.get(specDir);
      if (idx === undefined) {
        idx = this.nextImplementCycleIndex++;
        this.implementAppliedForSpecDir.set(specDir, idx);
        isFirstPhaseForSpecDir = true;
      }
      if (idx < this.config.dex_loop.cycles.length) {
        const cycle = this.config.dex_loop.cycles[idx];
        descriptor = cycle.stages.implement;
        assignedCycleNumber = idx + 1;
        assignedFeatureId = cycle.feature.id;
      }
    }
    // Fall back to prerequisites descriptor for build mode or out-of-range.
    if (!descriptor) {
      descriptor = this.config.prerequisites.prerequisites;
      if (!descriptor) {
        throw new MockConfigMissingEntryError("prerequisites", "prerequisites", null, null);
      }
    }

    rlog.agentRun("INFO", `mock.runTaskPhase: TaskPhase ${taskPhase.number} (specDir=${specDir}, cycle=${assignedCycleNumber || "?"}, feature=${assignedFeatureId ?? "?"}, firstForSpecDir=${isFirstPhaseForSpecDir})`);

    let stepIndex = 0;
    const emitOnly = (agentStep: AgentStep) => {
      const enriched: AgentStep = {
        ...agentStep,
        metadata: { ...agentStep.metadata, costUsd: null, inputTokens: null, outputTokens: null },
      };
      emit({ type: "agent_step", agentStep: enriched });
    };
    emitOnly(mkStep("user_message", stepIndex++, prompt));
    emitOnly(
      mkStep("text", stepIndex++, `[mock] runTaskPhase ${taskPhase.number}: ${taskPhase.name} (cycle=${assignedCycleNumber || "?"})`, {
        mockPhase: "implement",
        cycleNumber: assignedCycleNumber || null,
        featureId: assignedFeatureId,
      }),
    );

    if (descriptor.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, descriptor.delay));
    }

    // Apply side effects on the FIRST runTaskPhase for a new specDir.
    if (isFirstPhaseForSpecDir && assignedCycleNumber > 0) {
      this.applySideEffects(descriptor, {
        cycleNumber: assignedCycleNumber,
        featureId: assignedFeatureId,
        specDir,
      });
    }

    emitOnly(mkStep("completed", stepIndex++, `TaskPhase ${taskPhase.number}: ${taskPhase.name} completed (mock)`));

    return {
      cost: 0,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /**
   * 014 — scripted runOneShot. Looks up `ctx.prompt` against
   * `MockConfig.oneShotResponses`; honours the optional `editFile` side
   * effect (write content into the resolved cwd before returning); falls
   * back to a permissive default record when no entry matches so tests
   * aren't required to script every prompt the harness might send.
   */
  async runOneShot(ctx: OneShotContext): Promise<OneShotResult> {
    const start = Date.now();
    const cwd = ctx.cwd ?? this.projectDir;
    const responses: MockOneShotResponse[] = this.config.oneShotResponses ?? [];

    let matched: MockOneShotResponse | undefined;
    for (const r of responses) {
      if (r.isRegex) {
        try {
          if (new RegExp(r.matchPrompt).test(ctx.prompt)) {
            matched = r;
            break;
          }
        } catch {
          // Bad regex source — skip silently; surfaces in test by missing match.
          continue;
        }
      } else if (r.matchPrompt === ctx.prompt) {
        matched = r;
        break;
      }
    }

    if (matched?.delayMs && matched.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, matched!.delayMs));
    }

    if (matched?.editFile) {
      const dest = path.isAbsolute(matched.editFile.path)
        ? matched.editFile.path
        : path.resolve(cwd, matched.editFile.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, matched.editFile.content, "utf8");
    }

    if (ctx.abortController?.signal.aborted) {
      return {
        cost: 0,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        finalText: "",
        finishedNormally: false,
      };
    }

    if (!matched) {
      return {
        cost: 0,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        finalText: "(mock default — no oneShotResponses entry matched)",
        finishedNormally: true,
      };
    }

    return {
      cost: matched.cost ?? 0,
      durationMs: Date.now() - start,
      inputTokens: matched.inputTokens ?? 0,
      outputTokens: matched.outputTokens ?? 0,
      finalText: matched.finalText,
      finishedNormally: matched.finishedNormally ?? true,
    };
  }

  // ── Side-effect helpers ──

  private applySideEffects(
    descriptor: StepDescriptor,
    ctx: { cycleNumber: number; featureId: string | null; specDir: string | null },
  ): void {
    if (descriptor.writes) {
      for (const w of descriptor.writes) {
        const dest = this.resolveProjectPath(w.path, ctx);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (w.from !== undefined) {
          const src = path.resolve(this.fixtureDir, w.from);
          if (!fs.existsSync(src)) {
            throw new MockFixtureMissingError(src);
          }
          fs.copyFileSync(src, dest);
        } else if (w.content !== undefined) {
          const rendered = this.renderTemplate(w.content, ctx);
          fs.writeFileSync(dest, rendered, "utf8");
        }
      }
    }
    if (descriptor.appends) {
      for (const a of descriptor.appends) {
        const dest = this.resolveProjectPath(a.path, ctx);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        let line = this.renderTemplate(a.line, ctx);
        if (!line.endsWith("\n")) line += "\n";
        fs.appendFileSync(dest, line, "utf8");
      }
    }

    // Mirror what a real agent does at the end of its work — stage everything
    // so the orchestrator's next commitCheckpoint captures the files the mock
    // just wrote. commitCheckpoint itself only git-adds .dex/feature-manifest.json
    // and .dex/learnings.md, so without this the spec files (spec.md/plan.md/
    // tasks.md) and implement outputs (src/mock/*.ts) would sit uncommitted in
    // the working tree and every checkpoint commit after specify would be empty.
    // gitignored files (.dex/state.json, .dex/state.lock, etc.) are skipped
    // automatically by `git add -A`.
    if ((descriptor.writes && descriptor.writes.length) || (descriptor.appends && descriptor.appends.length)) {
      try {
        execSync("git add -A", { cwd: this.projectDir, stdio: "pipe" });
      } catch {
        // Working tree may not be a git repo (standalone MockAgentRunner tests),
        // or git may have nothing to stage. Either way, not fatal.
      }
    }
  }

  private resolveProjectPath(
    template: string,
    ctx: { cycleNumber: number; featureId: string | null; specDir: string | null },
  ): string {
    const rendered = this.renderTemplate(template, ctx);
    if (path.isAbsolute(rendered)) return rendered;
    return path.resolve(this.projectDir, rendered);
  }

  private renderTemplate(
    template: string,
    ctx: { cycleNumber: number; featureId: string | null; specDir: string | null },
  ): string {
    return template.replace(/\{([a-zA-Z_]+)\}/g, (match, token: string) => {
      switch (token) {
        case "specDir":
          return ctx.specDir ?? "";
        case "cycle":
          return String(ctx.cycleNumber);
        case "feature":
          return ctx.featureId ?? "";
        default:
          throw new MockConfigInvalidPathError(template, token, ALLOWED_TOKENS);
      }
    });
  }
}
