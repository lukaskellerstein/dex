/**
 * What: Verify records (D-015-1, D-015-5) — `.dex/evidence/<id>/verify.json`, untracked. After each verify stage Dex writes one from the agent's structured verdict; the picker counts an entry as done only when a passing record matches the entry as it is now. The match is the record's `key` plus the `tasks.md` hash. The key is the entry branch's HEAD in an existing project, so any later commit sends the entry back to verify. In a new project every entry shares one run branch, so the key is a content hash of the entry's spec folder instead: a later entry's commits do not undo an earlier entry (contracts/evidence.md).
 * Not: Runs no agent and decides no stage. Never writes a tracked file: the evidence folder carries its own `.gitignore` (`*`).
 * Deps: node:child_process (git rev-parse, no shell), node:crypto, node:fs, node:path.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The structured output the verify agent returns (SDK `outputFormat`). */
export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "commands", "criteria"],
  properties: {
    verdict: { type: "string", enum: ["passed", "failed"] },
    summary: { type: "string" },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "exitCode"],
        properties: { command: { type: "string" }, exitCode: { type: "integer" } },
      },
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "met", "note"],
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

export interface VerifyVerdict {
  verdict: "passed" | "failed";
  summary: string;
  commands: Array<{ command: string; exitCode: number }>;
  criteria: Array<{ criterion: string; met: boolean; note: string }>;
}

export interface VerifyRecord extends VerifyVerdict {
  version: 1;
  entryId: string;
  /** Existing project: the entry branch's HEAD. New project: `spec:<sha256 of the spec folder>`. */
  key: string;
  tasksHash: string;
  /** ISO-8601, when Dex wrote the record. */
  checked: string;
}

/** What the picker needs to judge verify for one entry. */
export interface Evidence {
  record: VerifyRecord | null;
  /** The entry's key now; null when it cannot be computed (no branch, no spec folder). */
  key: string | null;
}

const EVIDENCE_DIR = path.join(".dex", "evidence");
const RECORD_FILE = "verify.json";

/** sha256 of tasks.md. */
export function tasksHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Keys ──

function branchHead(projectDir: string, branch: string): string | null {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      {
        cwd: projectDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return null;
  }
}

function filesUnder(dir: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((d) => {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return filesUnder(dir, child);
      return d.isFile() ? [child] : [];
    })
    .sort();
}

/** sha256 over every file of the folder (path, then content), uncommitted changes included. */
function folderHash(dir: string): string | null {
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return null;
  const h = crypto.createHash("sha256");
  for (const rel of filesUnder(dir)) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

/** The entry's key now: its branch HEAD (existing project) or its spec folder's content hash (new project). */
export function evidenceKey(
  projectDir: string,
  kind: "new" | "existing",
  entry: { branch: string; specDir: string },
): string | null {
  if (kind === "existing") return branchHead(projectDir, entry.branch);
  const hash = folderHash(path.join(projectDir, entry.specDir));
  return hash ? `spec:${hash}` : null;
}

// ── Records ──

function recordPath(projectDir: string, entryId: string): string {
  return path.join(projectDir, EVIDENCE_DIR, entryId, RECORD_FILE);
}

/** The structured verdict, or null when the agent's output does not have its shape. */
export function parseVerdict(raw: unknown): VerifyVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.verdict !== "passed" && r.verdict !== "failed") return null;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    verdict: r.verdict,
    summary: typeof r.summary === "string" ? r.summary : "",
    commands: list(r.commands).map((c) => ({
      command: String((c as { command?: unknown }).command ?? ""),
      exitCode: Number((c as { exitCode?: unknown }).exitCode ?? -1),
    })),
    criteria: list(r.criteria).map((c) => ({
      criterion: String((c as { criterion?: unknown }).criterion ?? ""),
      met: (c as { met?: unknown }).met === true,
      note: String((c as { note?: unknown }).note ?? ""),
    })),
  };
}

/** The entry's last record. A missing or unreadable record is null: the picker then verifies again. */
export function readVerifyRecord(projectDir: string, entryId: string): VerifyRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recordPath(projectDir, entryId), "utf-8"));
  } catch {
    return null;
  }
  const verdict = parseVerdict(raw);
  const r = raw as Partial<VerifyRecord>;
  if (!verdict || typeof r.key !== "string" || typeof r.tasksHash !== "string") return null;
  return {
    version: 1,
    entryId,
    key: r.key,
    tasksHash: r.tasksHash,
    checked: typeof r.checked === "string" ? r.checked : "",
    ...verdict,
  };
}

/** Writes the entry's record, replacing the last one. The folder ignores itself, so git never sees it. */
export function writeVerifyRecord(projectDir: string, record: VerifyRecord): void {
  const root = path.join(projectDir, EVIDENCE_DIR);
  fs.mkdirSync(path.join(root, record.entryId), { recursive: true });
  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n", "utf-8");
  const file = recordPath(projectDir, record.entryId);
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  fs.renameSync(`${file}.tmp`, file);
}
