/**
 * What: Phase A clarification — runs the 4-step interactive clarification flow (product → technical → synthesis → constitution) producing the clarified plan and a filled constitution. Caller supplies the four artefact paths (goal + 3 derivatives) so the basename `GOAL` is not hardcoded. Skips entirely when prior specs already exist alongside a clarified plan.
 * Not: Does not run gap-analysis or the per-feature implement loop. Does not own runStage — that lives in orchestrator.ts and is imported. Does not extract clarification questions; auto-clarification is signaled via `config.autoClarification` and consumed by the prompt builders, not here.
 * Deps: OrchestrationContext, RunConfig (for descriptionFile / autoClarification / model), runStage (from ../orchestrator.js — circular but call-time-safe), prompts.ts builders, phase-lifecycle.emitSkippedStep for synthetic skipped-step audit records.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import type { RunConfig, StepType } from "../types.js";
import { emitSkippedStep as phaseEmitSkippedStep } from "../phase-lifecycle.js";
import {
  buildProductClarificationPrompt,
  buildTechnicalClarificationPrompt,
  buildClarificationSynthesisPrompt,
  buildConstitutionPrompt,
  SYNTHESIS_SCHEMA,
} from "../prompts.js";
// Circular: runStage lives in orchestrator.ts and will move into a coordinator
// surface during A8. Both sides export functions only; ESM resolves call-time refs.
import { runStage } from "../orchestrator.js";

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/**
 * Phase A driver. Mutates `ctx.state.isClarifying` for the renderer and
 * accumulates `cumulativeCost` from each agent invocation; the caller seeds
 * the starting cost (e.g., from a resume snapshot).
 */
export async function runClarificationPhase(
  ctx: OrchestrationContext,
  deps: {
    config: RunConfig;
    runId: string;
    goalPath: string;
    clarifiedPath: string;
    productDomainPath: string;
    technicalDomainPath: string;
    existingSpecsAtStart: string[];
    seedCumulativeCost: number;
  },
): Promise<{ fullPlanPath: string; cumulativeCost: number }> {
  const {
    config, runId, goalPath, clarifiedPath,
    productDomainPath, technicalDomainPath,
    existingSpecsAtStart, seedCumulativeCost,
  } = deps;
  const { projectDir, emit, rlog } = ctx;
  const productDomainName = path.basename(productDomainPath);
  const technicalDomainName = path.basename(technicalDomainPath);
  const clarifiedName = path.basename(clarifiedPath);
  let cumulativeCost = seedCumulativeCost;
  let fullPlanPath = "";

  const emitSkippedStep = (step: StepType, cycleNum = 0) => {
    // Delegates to the consolidated helper in phase-lifecycle.ts (T043 wire-in).
    phaseEmitSkippedStep({ ctx, runId, agentRunId: crypto.randomUUID(), step, cycleNumber: cycleNum });
  };

  // ── Skip path: prior specs + clarified plan exist ────────
  if (existingSpecsAtStart.length > 0 && fs.existsSync(clarifiedPath)) {
    fullPlanPath = clarifiedPath;
    rlog.run("INFO", `runLoop: specs exist (${existingSpecsAtStart.length}), skipping clarification, using ${clarifiedPath}`);
    emit({ type: "clarification_started", runId });
    emitSkippedStep("clarification_product");
    emitSkippedStep("clarification_technical");
    emitSkippedStep("clarification_synthesis");
    emitSkippedStep("constitution");
    emit({ type: "clarification_completed", runId, fullPlanPath: clarifiedPath });
    return { fullPlanPath, cumulativeCost };
  }

  // ── Run path: 4 sub-steps ────────────────────────────────
  emit({ type: "clarification_started", runId });
  rlog.run("INFO", "runLoop: starting multi-domain clarification (Phase A)");

  ctx.state.isClarifying = true;

  // Step 1: Product domain clarification
  if (!fs.existsSync(productDomainPath)) {
    rlog.run("INFO", "runLoop: starting product domain clarification");
    const prompt = buildProductClarificationPrompt(goalPath, productDomainPath);
    const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_product");
    cumulativeCost += result.cost;
    if (ctx.abort.signal.aborted) throw new AbortError();
    if (!fs.existsSync(productDomainPath)) {
      throw new Error(`Product clarification completed but ${productDomainName} not found`);
    }
  } else {
    rlog.run("INFO", `runLoop: ${productDomainName} exists, skipping product clarification`);
    emitSkippedStep("clarification_product");
  }

  // Step 2: Technical domain clarification
  if (ctx.abort.signal.aborted) throw new AbortError();
  if (!fs.existsSync(technicalDomainPath)) {
    rlog.run("INFO", "runLoop: starting technical domain clarification");
    const prompt = buildTechnicalClarificationPrompt(goalPath, productDomainPath, technicalDomainPath);
    const result = await runStage(config, prompt, emit, rlog, runId, 0, "clarification_technical");
    cumulativeCost += result.cost;
    if (ctx.abort.signal.aborted) throw new AbortError();
    if (!fs.existsSync(technicalDomainPath)) {
      throw new Error(`Technical clarification completed but ${technicalDomainName} not found`);
    }
  } else {
    rlog.run("INFO", `runLoop: ${technicalDomainName} exists, skipping technical clarification`);
    emitSkippedStep("clarification_technical");
  }

  // Step 3: Synthesis → <stem>_clarified.md (with structured-output confirmation)
  if (ctx.abort.signal.aborted) throw new AbortError();
  if (!fs.existsSync(clarifiedPath)) {
    rlog.run("INFO", "runLoop: starting clarification synthesis");
    const prompt = buildClarificationSynthesisPrompt(
      goalPath, productDomainPath, technicalDomainPath, clarifiedPath,
    );
    const result = await runStage(
      config, prompt, emit, rlog, runId, 0, "clarification_synthesis", undefined,
      { type: "json_schema", schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown> },
    );
    cumulativeCost += result.cost;
    if (ctx.abort.signal.aborted) throw new AbortError();

    // Best-effort structured-output sanity check; falls back to filesystem probing.
    const synthesisOutput = result.structuredOutput as { filesProduced?: string[]; goalClarifiedPath?: string } | null;
    if (synthesisOutput?.goalClarifiedPath) {
      const resolvedPath = path.isAbsolute(synthesisOutput.goalClarifiedPath)
        ? synthesisOutput.goalClarifiedPath
        : path.join(projectDir, synthesisOutput.goalClarifiedPath);
      if (!fs.existsSync(resolvedPath)) {
        rlog.run("WARN", `Synthesis structured output claimed ${synthesisOutput.goalClarifiedPath} but file not found — falling back to filesystem check`);
      }
    }

    if (!fs.existsSync(clarifiedPath)) {
      throw new Error(`Synthesis completed but ${clarifiedName} not found`);
    }
  } else {
    rlog.run("INFO", `runLoop: ${clarifiedName} exists, skipping synthesis`);
    emitSkippedStep("clarification_synthesis");
  }

  fullPlanPath = clarifiedPath;

  // Step 4: Constitution. The file may exist as an unfilled template (with
  // [PLACEHOLDER] tokens) from `specify init` — only skip if it's been filled.
  if (ctx.abort.signal.aborted) throw new AbortError();
  const constitutionPath = path.join(projectDir, ".specify", "memory", "constitution.md");
  const constitutionNeedsGeneration = !fs.existsSync(constitutionPath)
    || fs.readFileSync(constitutionPath, "utf-8").includes("[PROJECT_NAME]");
  if (constitutionNeedsGeneration) {
    rlog.run("INFO", "runLoop: generating constitution");
    const prompt = buildConstitutionPrompt(config, fullPlanPath);
    const result = await runStage(config, prompt, emit, rlog, runId, 0, "constitution");
    cumulativeCost += result.cost;
  } else {
    rlog.run("INFO", "runLoop: constitution already filled, skipping");
    emitSkippedStep("constitution");
  }

  emit({ type: "clarification_completed", runId, fullPlanPath });
  rlog.run("INFO", `runLoop: clarification completed, fullPlanPath=${fullPlanPath}`);

  ctx.state.isClarifying = false;

  return { fullPlanPath, cumulativeCost };
}
