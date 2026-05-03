/**
 * What: Naming + classification for checkpoint tags, selected branches, and step parallelism.
 * Not: Does not touch git or filesystem; pure functions only. Jumps live in jumpTo.ts.
 * Deps: ../types.js (StepType).
 */

import type { StepType } from "../types.js";

// ── Constants ────────────────────────────────────────────

export const CHECKPOINT_MESSAGE_PREFIX = "[checkpoint:";

const PARALLELIZABLE_STEPS: StepType[] = [
  "gap_analysis",
  "specify",
  "plan",
  "tasks",
  "learnings",
];

/**
 * Files that materially change in each step — used for path-filtered diffs
 * when comparing two checkpoints ("show me what changed at the spec level vs.
 * everywhere"). Steps absent from this map fall through to a `--stat` diff.
 */
export const PATHS_BY_STEP: Partial<Record<StepType, string[]>> = {
  gap_analysis: [".dex/feature-manifest.json"],
  manifest_extraction: [".dex/feature-manifest.json"],
  specify: ["specs/"],
  plan: ["specs/"],
  tasks: ["specs/"],
  learnings: [".dex/learnings.md"],
  verify: [".dex/verify-output/"],
};

const PRETTY_LABELS: Record<StepType, string> = {
  prerequisites: "prerequisites done",
  create_branch: "branch created",
  clarification: "clarifications done",
  clarification_product: "product questions answered",
  clarification_technical: "technical questions answered",
  clarification_synthesis: "requirements synthesized",
  constitution: "constitution drafted",
  manifest_extraction: "features identified",
  gap_analysis: "gap analysis done",
  specify: "spec written",
  plan: "plan written",
  tasks: "tasks generated",
  implement: "implementation done",
  implement_fix: "fixes applied",
  verify: "verification done",
  learnings: "learnings captured",
  completion: "run completed",
  commit: "checkpoint saved",
};

const TAG_RE_CYCLE = /^checkpoint\/cycle-(\d+)-after-(.+)$/;
const TAG_RE_BARE = /^checkpoint\/after-(.+)$/;

// ── Naming ───────────────────────────────────────────────

const slug = (s: string): string => s.replaceAll("_", "-");

export function checkpointTagFor(step: StepType, cycleNumber: number): string {
  if (cycleNumber === 0) return `checkpoint/after-${slug(step)}`;
  return `checkpoint/cycle-${cycleNumber}-after-${slug(step)}`;
}

/**
 * 010 — name for a transient navigation fork created by click-to-jump.
 * The auto-prune logic in jumpTo.ts specifically targets this prefix so
 * navigation forks don't accumulate.
 */
export function selectedBranchName(date: Date = new Date()): string {
  const stamp = date.toISOString().replaceAll(/[:.-]/g, "").slice(0, 15);
  return `selected-${stamp}`;
}

export function labelFor(
  step: StepType,
  cycleNumber: number,
  featureSlug?: string | null
): string {
  const pretty = PRETTY_LABELS[step] ?? step;
  if (cycleNumber === 0) return pretty;
  const feature = featureSlug ? ` · ${featureSlug}` : "";
  return `cycle ${cycleNumber}${feature} · ${pretty}`;
}

export function isParallelizable(step: StepType): boolean {
  return PARALLELIZABLE_STEPS.includes(step);
}

export function parseCheckpointTag(
  tag: string
): { step: StepType; cycleNumber: number } | null {
  const cycleMatch = tag.match(TAG_RE_CYCLE);
  if (cycleMatch) {
    const cycleNumber = Number(cycleMatch[1]);
    const step = cycleMatch[2].replaceAll("-", "_") as StepType;
    return { step, cycleNumber };
  }
  const bareMatch = tag.match(TAG_RE_BARE);
  if (bareMatch) {
    const step = bareMatch[1].replaceAll("-", "_") as StepType;
    return { step, cycleNumber: 0 };
  }
  return null;
}
