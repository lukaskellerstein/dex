/**
 * What: Per-project variant-group state files at `<projectDir>/.dex/variant-groups/<groupId>.json` — atomic write/read/delete plus a "pending or running" filter for resume.
 * Not: Does not spawn variants (variants.ts) or pick winners. Does not touch git. Pure file IO.
 * Deps: node:fs, node:path, ../types.js (StepType).
 */

import fs from "node:fs";
import path from "node:path";
import type { StepType } from "../types.js";

export interface VariantGroupFile {
  groupId: string;
  fromCheckpoint: string;
  step: StepType;
  parallel: boolean;
  createdAt: string;
  variants: Array<{
    letter: string;
    branch: string;
    worktree: string | null;
    status: "pending" | "running" | "completed" | "failed";
    runId: string | null;
    candidateSha: string | null;
    errorMessage: string | null;
    /**
     * 010 — record the profile binding so resume-mid-variant can re-apply the
     * overlay if the worktree is reconstructed. `null` = `(none)` was selected,
     * runner uses orchestrator defaults. Optional on read for backwards
     * compatibility with pre-010 variant groups.
     */
    profile?: { name: string; agentDir: string } | null;
  }>;
  resolved: {
    kind: "keep" | "discard" | null;
    pickedLetter: string | null;
    resolvedAt: string | null;
  };
}

function variantGroupsDir(projectDir: string): string {
  return path.join(projectDir, ".dex", "variant-groups");
}

export function writeVariantGroupFile(projectDir: string, group: VariantGroupFile): void {
  const dir = variantGroupsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${group.groupId}.json`);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(group, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, target);
}

export function readVariantGroupFile(projectDir: string, groupId: string): VariantGroupFile | null {
  const target = path.join(variantGroupsDir(projectDir), `${groupId}.json`);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, "utf-8")) as VariantGroupFile;
  } catch {
    return null;
  }
}

function listAllVariantGroupFiles(projectDir: string): VariantGroupFile[] {
  const dir = variantGroupsDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  const out: VariantGroupFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
    } catch {
      // skip malformed
    }
  }
  return out;
}

export function deleteVariantGroupFile(projectDir: string, groupId: string): void {
  const target = path.join(variantGroupsDir(projectDir), `${groupId}.json`);
  try {
    fs.unlinkSync(target);
  } catch {
    // already gone
  }
}

export function readPendingVariantGroups(projectDir: string): VariantGroupFile[] {
  return listAllVariantGroupFiles(projectDir).filter((g) =>
    g.variants.some((v) => v.status === "pending" || v.status === "running")
  );
}
