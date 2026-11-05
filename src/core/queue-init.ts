/**
 * What: `dex queue init` (contracts/queue-json.md § `dex queue init`) — writes a first `kind: "existing"` queue from the project's `specs/*` and `docs/my-specs/*` folders, with `skip` and `status` derived from the files that are already there, plus `.dex/policy.json` with every default spelled out and `.dex/.gitignore`, each only when absent. A folder name that is not a valid id (`001-Initialization`) gets a lowercase id; its `brief` and `specDir` keep the real name.
 * Not: Never overwrites a queue, never runs git and never starts a run — the human reviews and commits what it wrote.
 * Deps: queue.{validateQueue, saveQueue, queuePath}, policy.{DEFAULT_POLICY, policyPath}, state.ensureRuntimeIgnore, parser.parseTasksMd.
 */

import fs from "node:fs";
import path from "node:path";
import { parseTasksMd } from "./parser.js";
import { DEFAULT_POLICY, policyPath } from "./policy.js";
import { type QueueEntry, queuePath, type StageName, saveQueue, validateQueue } from "./queue.js";
import { ensureRuntimeIgnore } from "./state.js";

export class QueueExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists — edit it by hand, or delete it to start over`);
    this.name = "QueueExistsError";
  }
}

const SPECS = "specs";
const BRIEFS = "docs/my-specs";

function subfolders(projectDir: string, rel: string): string[] {
  const abs = path.join(projectDir, rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readOrNull(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

/** The first `# ` heading, without spec-kit's "Feature Specification:" prefix. */
function heading(content: string | null): string | null {
  const line = content?.match(/^# (.+)$/m)?.[1]?.trim();
  return line ? line.replace(/^Feature Specification:\s*/, "") : null;
}

/** A queue id for a folder: lowercase, and `-` for anything an id (a branch name) cannot hold. */
function folderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");
}

/** The spec and brief folders for one id, by their real names. */
interface Folders {
  spec?: string;
  brief?: string;
}

function entryFor(projectDir: string, id: string, folders: Folders): QueueEntry {
  const specFolder = folders.spec ?? id;
  const spec = (f: string) => readOrNull(path.join(projectDir, SPECS, specFolder, f));
  const briefRel = `${BRIEFS}/${folders.brief ?? id}/README.md`;
  const brief = readOrNull(path.join(projectDir, briefRel));
  const specMd = spec("spec.md");
  const tasksMd = spec("tasks.md");
  const skip: StageName[] = [];
  if (specMd !== null) skip.push("specify");
  if (specMd !== null && /^## Clarifications\s*$/m.test(specMd)) skip.push("clarify");
  if (spec("plan.md") !== null) skip.push("plan");
  if (tasksMd !== null) skip.push("tasks");
  const tasks = tasksMd === null ? [] : parseTasksMd(tasksMd).flatMap((p) => p.tasks);
  const done = tasks.length > 0 && tasks.every((t) => t.status === "done");
  return {
    id,
    title: heading(specMd) ?? heading(brief) ?? id,
    ...(brief !== null ? { brief: briefRel } : {}),
    ...(specFolder !== id ? { specDir: `${SPECS}/${specFolder}` } : {}),
    ...(skip.length > 0 ? { skip } : {}),
    ...(done ? { status: "done" as const } : {}),
  };
}

/**
 * Writes the first queue for an existing project. Returns the files it wrote,
 * relative to the project. Throws QueueExistsError when a queue is already there.
 */
export function initQueue(projectDir: string): string[] {
  const file = queuePath(projectDir);
  if (fs.existsSync(file)) throw new QueueExistsError(file);
  const byId = new Map<string, Folders>();
  for (const [kind, root] of [
    ["spec", SPECS],
    ["brief", BRIEFS],
  ] as const) {
    for (const name of subfolders(projectDir, root)) {
      const id = folderId(name);
      byId.set(id, { ...byId.get(id), [kind]: name });
    }
  }
  if (byId.size === 0) {
    throw new Error(
      `no feature folders under ${SPECS}/ or ${BRIEFS}/ in ${projectDir} — nothing to queue`,
    );
  }
  const entries = [...byId.keys()].sort().map((id) => entryFor(projectDir, id, byId.get(id) ?? {}));
  const queue = validateQueue({ version: 3, kind: "existing", entries }, file);
  const written = [".dex/queue.json"];
  saveQueue(projectDir, queue);
  const policy = policyPath(projectDir);
  if (!fs.existsSync(policy)) {
    fs.writeFileSync(policy, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, "utf-8");
    written.push(".dex/policy.json");
  }
  const ignore = path.join(projectDir, ".dex", ".gitignore");
  if (!fs.existsSync(ignore)) {
    ensureRuntimeIgnore(projectDir);
    written.push(".dex/.gitignore");
  }
  return written;
}
