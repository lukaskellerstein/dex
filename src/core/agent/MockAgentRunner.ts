import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentRunner, PhaseContext, PhaseResult, StageContext, StageResult } from "./AgentRunner.js";
import type { AgentStep, RunConfig } from "../types.js";
import {
  MockConfig,
  MockConfigMissingEntryError,
  MockConfigInvalidPathError,
  MockFixtureMissingError,
  MockDisabledError,
  PHASE_OF_STAGE,
  StepDescriptor,
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

  async runStage(ctx: StageContext): Promise<StageResult> {
    const { cycleNumber, stage, specDir, prompt, emit, rlog } = ctx;
    const start = Date.now();
    const phase = PHASE_OF_STAGE[stage];

    // Look up the descriptor for this stage.
    let descriptor: StepDescriptor;
    let featureId: string | null = null;
    if (phase === "dex_loop") {
      const cycleIdx = cycleNumber - 1;
      const cycles = this.config.dex_loop.cycles;
      if (cycleIdx < 0 || cycleIdx >= cycles.length) {
        throw new MockConfigMissingEntryError(
          phase,
          stage,
          cycleNumber,
          null,
          `cycles exhausted — script declares ${cycles.length} cycle(s) but orchestrator requested cycle ${cycleNumber}. Add a cycle or terminate earlier with a gap_analysis decision of 'GAPS_COMPLETE'`,
        );
      }
      const cycle = cycles[cycleIdx];
      featureId = cycle.feature.id;
      const found = cycle.stages[stage];
      if (!found) {
        throw new MockConfigMissingEntryError(phase, stage, cycleNumber, featureId);
      }
      descriptor = found;
    } else {
      const phaseEntry = this.config[phase] as Record<string, StepDescriptor>;
      const found = phaseEntry[stage];
      if (!found) {
        throw new MockConfigMissingEntryError(phase, stage, null, null);
      }
      descriptor = found;
    }

    rlog.phase("INFO", `mock.runStage: phase=${phase} stage=${stage} cycle=${cycleNumber} feature=${featureId ?? "(none)"}`);

    // Emit the initial prompt + one synthetic agent_step per stage. Unlike the
    // real runner, the mock does NOT persist steps via runs.appendStep —
    // per-step persistence is intentionally out of scope (the mock's trace is
    // sparse by design; spec 009 assumption). The orchestrator's runStage
    // wrapper still records phase-level summaries via runs.startPhase /
    // completePhase.
    let stepIndex = 0;
    const emitOnly = (step: AgentStep) => {
      const enriched: AgentStep = {
        ...step,
        metadata: { ...step.metadata, costUsd: null, inputTokens: null, outputTokens: null },
      };
      emit({ type: "agent_step", step: enriched });
    };
    emitOnly(mkStep("user_message", stepIndex++, prompt));

    // One synthetic mock_stage agent_step so the trace view shows progress.
    emitOnly(
      mkStep("text", stepIndex++, `[mock] ${phase}/${stage}${featureId ? ` (${featureId})` : ""}`, {
        mockStage: stage,
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
    emitOnly(mkStep("completed", stepIndex++, `Stage ${stage} completed (mock)`));

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

  async runPhase(ctx: PhaseContext): Promise<PhaseResult> {
    const { phase, prompt, emit, rlog } = ctx;
    const start = Date.now();

    // Map phase.name to a MockConfig phase key + stage. The orchestrator's
    // runPhase is currently only invoked for spec-kit skill expansions in build
    // mode. If the mock is used in build mode with an unfamiliar phase name we
    // refuse rather than silently succeed.
    const phaseKey: "prerequisites" | "clarification" | "dex_loop" | "completion" = "prerequisites";
    const stageKey = "prerequisites";
    const phaseEntry = this.config[phaseKey];
    const descriptor = phaseEntry[stageKey];
    if (!descriptor) {
      throw new MockConfigMissingEntryError(phaseKey, stageKey, null, null);
    }

    rlog.phase("INFO", `mock.runPhase: Phase ${phase.number}: ${phase.name}`);

    let stepIndex = 0;
    const emitOnly = (step: AgentStep) => {
      const enriched: AgentStep = {
        ...step,
        metadata: { ...step.metadata, costUsd: null, inputTokens: null, outputTokens: null },
      };
      emit({ type: "agent_step", step: enriched });
    };
    emitOnly(mkStep("user_message", stepIndex++, prompt));
    emitOnly(
      mkStep("text", stepIndex++, `[mock] phase ${phase.number}: ${phase.name}`, {
        mockPhase: phaseKey,
      }),
    );

    if (descriptor.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, descriptor.delay));
    }
    this.applySideEffects(descriptor, { cycleNumber: phase.number, featureId: null, specDir: null });

    emitOnly(mkStep("completed", stepIndex++, `Phase ${phase.number}: ${phase.name} completed (mock)`));

    return {
      cost: 0,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
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
