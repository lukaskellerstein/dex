import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrateIfNeeded } from "./paths.js";

// ── Types ──

type ManifestFeatureStatus = "pending" | "active" | "completed" | "skipped";

interface FeatureManifestEntry {
  id: number;
  title: string;
  description: string;
  status: ManifestFeatureStatus;
  specDir: string | null;
}

export interface FeatureManifest {
  version: 1;
  sourceHash: string;
  features: FeatureManifestEntry[];
}

// ── Constants ──

const STATE_DIR = ".dex";
const MANIFEST_FILE = "feature-manifest.json";
const MANIFEST_TMP = "feature-manifest.json.tmp";

// ── File Hashing ──

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ── Load / Save ──

export function loadManifest(projectDir: string): FeatureManifest | null {
  const filePath = path.join(projectDir, STATE_DIR, MANIFEST_FILE);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as FeatureManifest;
}

export function saveManifest(projectDir: string, manifest: FeatureManifest): void {
  const dir = path.join(projectDir, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, MANIFEST_TMP);
  const finalPath = path.join(dir, MANIFEST_FILE);
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), "utf-8");
  fs.renameSync(tmpPath, finalPath);
}

// ── Query ──

export function getNextFeature(manifest: FeatureManifest): FeatureManifestEntry | null {
  return manifest.features.find((f) => f.status === "pending") ?? null;
}

export function getActiveFeature(manifest: FeatureManifest): FeatureManifestEntry | null {
  return manifest.features.find((f) => f.status === "active") ?? null;
}

// ── Update ──

export function updateFeatureStatus(
  projectDir: string,
  featureId: number,
  status: ManifestFeatureStatus
): void {
  const manifest = loadManifest(projectDir);
  if (!manifest) throw new Error("Cannot update feature status: manifest not found");
  const entry = manifest.features.find((f) => f.id === featureId);
  if (!entry) throw new Error(`Cannot update feature status: featureId ${featureId} not found`);
  entry.status = status;
  saveManifest(projectDir, manifest);
}

export function updateFeatureSpecDir(
  projectDir: string,
  featureId: number,
  specDir: string
): void {
  const manifest = loadManifest(projectDir);
  if (!manifest) throw new Error("Cannot update specDir: manifest not found");
  const entry = manifest.features.find((f) => f.id === featureId);
  if (!entry) throw new Error(`Cannot update specDir: featureId ${featureId} not found`);
  entry.specDir = specDir;
  saveManifest(projectDir, manifest);
}

// ── Drift Detection ──

export function checkSourceDrift(
  projectDir: string,
  manifest: FeatureManifest,
  goalPath: string
): boolean {
  const currentHash = hashFile(goalPath);
  return currentHash !== manifest.sourceHash;
}

// ── Learnings ──

function normalizeInsight(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

interface LearningEntry {
  category: string;
  insight: string;
  context: string;
}

export function appendLearnings(
  projectDir: string,
  insights: LearningEntry[],
  maxPerCategory = 20
): void {
  const filePath = path.join(projectDir, ".dex", "learnings.md");
  migrateIfNeeded(
    path.join(projectDir, ".claude", "rules", "learnings.md"),
    filePath,
  );

  let existingContent = "";
  if (fs.existsSync(filePath)) {
    existingContent = fs.readFileSync(filePath, "utf-8");
  }

  // Parse existing entries
  const existingEntries: LearningEntry[] = [];
  const existingNormalized = new Set<string>();

  for (const line of existingContent.split("\n")) {
    const match = line.match(/^- \*\*(\w+)\*\*: (.+?) \| (.+)$/);
    if (match) {
      existingEntries.push({ category: match[1], insight: match[2], context: match[3] });
      existingNormalized.add(normalizeInsight(match[2]));
    }
  }

  // Deduplicate and add new entries
  const newEntries: LearningEntry[] = [];
  for (const entry of insights) {
    if (!existingNormalized.has(normalizeInsight(entry.insight))) {
      newEntries.push(entry);
      existingNormalized.add(normalizeInsight(entry.insight));
    }
  }

  if (newEntries.length === 0) return;

  // Merge and enforce per-category cap
  const allEntries = [...existingEntries, ...newEntries];
  const byCategory = new Map<string, LearningEntry[]>();
  for (const entry of allEntries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }

  // Cap each category, keeping newest
  const finalEntries: LearningEntry[] = [];
  for (const [, entries] of byCategory) {
    const capped = entries.length > maxPerCategory
      ? entries.slice(entries.length - maxPerCategory)
      : entries;
    finalEntries.push(...capped);
  }

  // Write
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const lines = ["# Learnings", ""];
  for (const entry of finalEntries) {
    lines.push(`- **${entry.category}**: ${entry.insight} | ${entry.context}`);
  }
  lines.push("");

  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}
