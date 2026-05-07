/**
 * What: One-time post-clarification feature-manifest extraction — runs the manifest_extraction stage (LLM call with MANIFEST_SCHEMA), persists `<projectDir>/.dex/feature-manifest.json`, and emits manifest_created (or manifest_drift_detected on subsequent runs when GOAL_clarified.md has changed).
 * Not: Does not rebuild an existing manifest unless missing — drift on the source file emits an event but doesn't auto-rewrite. Does not own clarification (that's stages/clarification.ts) or the loop's per-cycle gap analysis (stages/main-loop.ts).
 * Deps: runStage (../stages/run-stage.js — circular-via-orchestrator-but-call-time-safe), prompts.{buildManifestExtractionPrompt, MANIFEST_SCHEMA}, manifest.{loadManifest, saveManifest, checkSourceDrift, hashFile}.
 */

import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import type { RunConfig } from "../types.js";
import type { RunLogger } from "../log.js";
import { buildManifestExtractionPrompt, MANIFEST_SCHEMA } from "../prompts.js";
import {
  loadManifest,
  saveManifest,
  checkSourceDrift,
  hashFile as hashManifestFile,
  type FeatureManifest,
} from "../manifest.js";
import { runStage } from "./run-stage.js";

export async function ensureManifest(
  ctx: OrchestrationContext,
  deps: {
    config: RunConfig;
    runId: string;
    fullPlanPath: string;
    rlog: RunLogger;
    seedCumulativeCost: number;
  },
): Promise<{ manifest: FeatureManifest; cumulativeCost: number }> {
  const { config, runId, fullPlanPath, rlog, seedCumulativeCost } = deps;
  const clarifiedName = path.basename(fullPlanPath);
  let cumulativeCost = seedCumulativeCost;
  const emit = ctx.emit;

  let manifest = loadManifest(config.projectDir);
  if (manifest) {
    if (checkSourceDrift(config.projectDir, manifest, fullPlanPath)) {
      // The clarified-plan file content changed — typically because the
      // user is starting a run for a different spec (e.g. 002-improvement
      // after 001 was promoted to main, leaving the old manifest committed
      // on the trunk). The stale manifest's feature list and statuses don't
      // apply to the new plan; reusing it short-circuits the loop with
      // `gaps_complete` against features that aren't in this spec at all.
      // Re-extract from the new plan and overwrite — completion state for
      // the OLD spec is preserved in `.dex/runs/<runId>.json` audit records.
      rlog.run(
        "WARN",
        `${clarifiedName} has changed since manifest was created — re-extracting`,
      );
      emit({ type: "manifest_drift_detected", runId });
      manifest = null;
    } else {
      return { manifest, cumulativeCost };
    }
  }

  type ManifestExtraction = { features: Array<{ id: number; title: string; description: string }> };
  let extracted: ManifestExtraction | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = buildManifestExtractionPrompt(fullPlanPath);
      const result = await runStage(
        config, prompt, emit, rlog, runId, 0,
        "manifest_extraction", undefined,
        { type: "json_schema", schema: MANIFEST_SCHEMA as unknown as Record<string, unknown> },
      );
      cumulativeCost += result.cost;
      extracted = result.structuredOutput as ManifestExtraction | null;
      if (!extracted) {
        rlog.run("WARN", `Manifest extraction attempt ${attempt}: structured_output was null`);
        if (attempt === 2) throw new Error(`Manifest extraction failed after 2 attempts — structured output was null. Check ${clarifiedName} format.`);
        continue;
      }
      if (!extracted.features?.length) {
        rlog.run("WARN", `Manifest extraction attempt ${attempt}: empty features array`);
        if (attempt === 2) throw new Error(`Manifest extraction failed after 2 attempts — extracted zero features. Check ${clarifiedName} format.`);
        continue;
      }
      break;
    } catch (err) {
      rlog.run("ERROR", `Manifest extraction attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 2) throw new Error(`Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check ${clarifiedName} format.`);
    }
  }

  manifest = {
    version: 2,
    sourceHash: hashManifestFile(fullPlanPath),
    sourcePath: path.relative(config.projectDir, fullPlanPath),
    features: extracted!.features.map((f) => ({
      ...f,
      status: "pending" as const,
      specDir: null,
    })),
  };
  saveManifest(config.projectDir, manifest);
  emit({ type: "manifest_created", runId, featureCount: manifest.features.length });
  rlog.run("INFO", `runLoop: manifest created with ${manifest.features.length} features`);

  return { manifest, cumulativeCost };
}
