/**
 * What: Which sensors an entry has (data-model.md § Sensor) and the acceptance record the tests stage leaves (contracts/acceptance-json.md, research R3). `fastChecksFor` merges the policy's fast checks with the entry's own `checks`; `acceptanceSensorsFor` puts the recorded acceptance command first, then the queue's `acceptance`; `parseAcceptance` validates `<specDir>/acceptance.json` (every listed test file exists in the tree and matches `testGlobs`), `readAcceptance` reads it from the entry's tree and `acceptanceHash` keys the red-first records; `validateEntrySensors` and `assertEntrySensors` report an entry check whose name repeats a policy fast check, so a run refuses to start rather than mix two checks up in the evidence.
 * Not: Runs nothing and decides no gate. Never writes acceptance.json: the tests agent does.
 * Deps: node:crypto, node:path; policy.Policy, queue.{QueueV3, ResolvedEntry, resolveEntries, QueueInvalidError}, sensors.SensorSpec, tree-reader.TreeReader.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { Policy } from "./policy.js";
import { QueueInvalidError, type QueueV3, type ResolvedEntry, resolveEntries } from "./queue.js";
import type { SensorSpec } from "./sensors.js";
import { type TreeReader, workingTree } from "./tree-reader.js";

/** `<specDir>/acceptance.json` (contracts/acceptance-json.md), as Dex reads it. */
export interface AcceptanceRecord {
  version: 1;
  command: string;
  failExitCodes: number[];
  timeoutSec: number;
  files: string[];
  covers: Array<{ test: string; criterion: string }>;
}

/** The sensor name of the recorded acceptance command. */
export const RECORDED_ACCEPTANCE = "acceptance";

const ACCEPTANCE_FIELDS = ["version", "command", "failExitCodes", "timeoutSec", "files", "covers"];
const DEFAULT_TIMEOUT_SEC = 1800;

export class AcceptanceInvalidError extends Error {
  constructor(detail: string) {
    super(`acceptance.json: ${detail}`);
    this.name = "AcceptanceInvalidError";
  }
}

/** The project-relative path of the entry's acceptance record. */
export function acceptancePath(entry: Pick<ResolvedEntry, "specDir">): string {
  return `${entry.specDir}/acceptance.json`;
}

/** sha256 of the file's text: the key of its red-first records. */
export function acceptanceHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function testFiles(raw: unknown, policy: Policy, tree: Pick<TreeReader, "exists">): string[] {
  const fail = (d: string): never => {
    throw new AcceptanceInvalidError(d);
  };
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(nonEmpty))
    fail(`"files" must be a non-empty list of project-relative paths`);
  for (const file of raw as string[]) {
    const rel = path.posix.normalize(file);
    if (path.isAbsolute(file) || rel.startsWith(".."))
      fail(`"files" entry ${file} must be project-relative`);
    if (!policy.testGlobs.some((g) => path.matchesGlob(rel, g)))
      fail(`"files" entry ${file} matches no testGlobs pattern (${policy.testGlobs.join(", ")})`);
    if (!tree.exists(rel)) fail(`"files" entry ${file} does not exist`);
  }
  return raw as string[];
}

function covers(raw: unknown): AcceptanceRecord["covers"] {
  if (!Array.isArray(raw) || raw.length === 0)
    throw new AcceptanceInvalidError(`"covers" must be a non-empty list of {test, criterion}`);
  return raw.map((c, i) => {
    if (!isObject(c) || !nonEmpty(c.test) || !nonEmpty(c.criterion))
      throw new AcceptanceInvalidError(`"covers[${i}]" must have a non-empty "test" and "criterion"`);
    return { test: c.test, criterion: c.criterion };
  });
}

/** Validates a parsed acceptance.json against the contract; every listed file is checked in `tree`. */
export function parseAcceptance(
  raw: unknown,
  policy: Policy,
  tree: Pick<TreeReader, "exists">,
): AcceptanceRecord {
  const fail = (d: string): never => {
    throw new AcceptanceInvalidError(d);
  };
  if (!isObject(raw)) fail("root must be a JSON object");
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !ACCEPTANCE_FIELDS.includes(k));
  if (extra) fail(`unknown field "${extra}"`);
  if (r.version !== 1) fail(`"version" must be 1`);
  if (!nonEmpty(r.command)) fail(`"command" must be a non-empty string`);
  const codes = r.failExitCodes ?? [1];
  if (
    !Array.isArray(codes) ||
    codes.length === 0 ||
    !codes.every((c) => Number.isInteger(c) && c !== 0)
  )
    fail(`"failExitCodes" must be a non-empty list of non-zero integers`);
  const timeout = r.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(timeout) || (timeout as number) < 1)
    fail(`"timeoutSec" must be an integer of at least 1`);
  return {
    version: 1,
    command: r.command as string,
    failExitCodes: codes as number[],
    timeoutSec: timeout as number,
    files: testFiles(r.files, policy, tree),
    covers: covers(r.covers),
  };
}

export type AcceptanceRead =
  | { kind: "missing" }
  | { kind: "invalid"; hash: string; message: string }
  | { kind: "ok"; hash: string; record: AcceptanceRecord };

/**
 * The entry's frozen test set (FR-012, FR-014): the recorded test files, and
 * the record itself, so no agent but the test author changes what the gates run.
 */
export function frozenTestSet(entry: Pick<ResolvedEntry, "specDir">, record: AcceptanceRecord | null): string[] {
  return record ? [...record.files, acceptancePath(entry)] : [];
}

/** The entry's valid acceptance record in the working tree now, or null. */
export function currentAcceptance(projectDir: string, entry: ResolvedEntry, policy: Policy): AcceptanceRecord | null {
  const read = readAcceptance(workingTree(projectDir), entry, policy);
  return read.kind === "ok" ? read.record : null;
}

/** The entry's acceptance.json, read and validated in its own tree. */
export function readAcceptance(tree: TreeReader, entry: ResolvedEntry, policy: Policy): AcceptanceRead {
  const text = tree.read(acceptancePath(entry));
  if (text === null) return { kind: "missing" };
  const hash = acceptanceHash(text);
  try {
    return { kind: "ok", hash, record: parseAcceptance(JSON.parse(text), policy, tree) };
  } catch (err) {
    const message = err instanceof SyntaxError ? `acceptance.json: not valid JSON (${err.message})` : (err as Error).message;
    return { kind: "invalid", hash, message };
  }
}

/** The policy's fast checks, then the entry's own. A repeated name throws, naming the entry. */
export function fastChecksFor(policy: Policy, entry: ResolvedEntry): SensorSpec[] {
  const policyNames = new Set(policy.checks.fast.map((c) => c.name));
  const clash = entry.checks.find((c) => policyNames.has(c.name));
  if (clash) {
    throw new Error(
      `${entry.id}: the entry check "${clash.name}" repeats a policy.checks.fast name`,
    );
  }
  return [...policy.checks.fast, ...entry.checks];
}

/** The recorded acceptance command (when there is a record), then the queue's `acceptance`. */
export function acceptanceSensorsFor(
  entry: ResolvedEntry,
  record: AcceptanceRecord | null,
): SensorSpec[] {
  const recorded: SensorSpec[] = record
    ? [{ name: RECORDED_ACCEPTANCE, command: record.command, timeoutSec: record.timeoutSec }]
    : [];
  return [...recorded, ...entry.acceptance];
}

/** One message per entry check that repeats a policy fast check; empty when there is none. */
export function validateEntrySensors(queue: QueueV3, policy: Policy): string[] {
  const policyNames = new Set(policy.checks.fast.map((c) => c.name));
  return resolveEntries(queue, "", null).flatMap((entry) =>
    entry.checks
      .filter((c) => policyNames.has(c.name))
      .map((c) => `entry "${entry.id}": check "${c.name}" repeats a policy.checks.fast name`),
  );
}

/** Throws a QueueInvalidError listing every clash, so Dex refuses the queue (exit 2). */
export function assertEntrySensors(queue: QueueV3, policy: Policy, file: string): void {
  const clashes = validateEntrySensors(queue, policy);
  if (clashes.length > 0) throw new QueueInvalidError(file, "checks", clashes.join("; "));
}
