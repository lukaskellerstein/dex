/**
 * What: New-project feature extraction — when the project has no queue yet, runs the manifest_extraction stage (LLM call with MANIFEST_SCHEMA) over the clarified goal and writes `.dex/queue.json` v3 (`kind: "new"`, ids `NNN-<slug>`). This is one of the three setup moments Dex writes the queue (research R2).
 * Not: Never rewrites an existing queue — a changed goal means the human deletes queue.json, the same as re-planning. Does not own clarification (stages/clarification.ts).
 * Deps: runStage, prompts.{buildManifestExtractionPrompt, MANIFEST_SCHEMA}, queue.{loadQueue, saveQueue, validateQueue, entryIdFor}.
 */

import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import { buildManifestExtractionPrompt, MANIFEST_SCHEMA } from "../prompts.js";
import {
  entryIdFor,
  loadQueue,
  type QueueV3,
  queuePath,
  saveQueue,
  validateQueue,
} from "../queue.js";
import type { RunConfig } from "../types.js";
import { runStage } from "./run-stage.js";

type Extraction = { features: Array<{ id: number; title: string; description: string }> };

async function extract(
  config: RunConfig,
  runId: string,
  fullPlanPath: string,
): Promise<{ extracted: Extraction; cost: number }> {
  const clarifiedName = path.basename(fullPlanPath);
  let cost = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await runStage({
      config,
      prompt: buildManifestExtractionPrompt(fullPlanPath),
      runId,
      cycleNumber: 0,
      step: "manifest_extraction",
      outputFormat: {
        type: "json_schema",
        schema: MANIFEST_SCHEMA as unknown as Record<string, unknown>,
      },
    });
    cost += result.cost;
    const extracted = result.structuredOutput as Extraction | null;
    if (extracted?.features?.length) return { extracted, cost };
  }
  throw new Error(
    `Manifest extraction failed after 2 attempts — no features came back. Check ${clarifiedName} format.`,
  );
}

/** Returns the project's queue, extracting it from the clarified goal when there is none. */
export async function ensureManifest(
  ctx: OrchestrationContext,
  deps: { config: RunConfig; runId: string; fullPlanPath: string },
): Promise<{ queue: QueueV3; cost: number }> {
  const { config, runId, fullPlanPath } = deps;
  const existing = loadQueue(config.projectDir);
  if (existing) return { queue: existing, cost: 0 };

  const { extracted, cost } = await extract(config, runId, fullPlanPath);
  const queue = validateQueue(
    {
      version: 3,
      kind: "new",
      entries: extracted.features.map((f) => ({
        id: entryIdFor(f.id, f.title),
        title: f.title,
        description: f.description,
      })),
    },
    queuePath(config.projectDir),
  );
  saveQueue(config.projectDir, queue);
  ctx.emit({ type: "manifest_created", runId, featureCount: queue.entries.length });
  ctx.rlog.run("INFO", `runLoop: queue created with ${queue.entries.length} entries`);
  return { queue, cost };
}
