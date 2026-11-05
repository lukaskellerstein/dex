import assert from "node:assert/strict";
import test from "node:test";
import {
  AcceptanceInvalidError,
  type AcceptanceRecord,
  acceptanceHash,
  acceptancePath,
  acceptanceSensorsFor,
  assertEntrySensors,
  fastChecksFor,
  parseAcceptance,
  readAcceptance,
  validateEntrySensors,
} from "../acceptance.ts";
import { DEFAULT_POLICY, type Policy } from "../policy.ts";
import { QueueInvalidError, type QueueV3, resolveEntries } from "../queue.ts";

const POLICY: Policy = {
  ...DEFAULT_POLICY,
  checks: {
    fast: [
      { name: "unit", command: "npm test", timeoutSec: 300 },
      { name: "types", command: "npm run typecheck", timeoutSec: 120 },
    ],
    standing: [],
    rerunOnFail: 1,
  },
};

const QUEUE: QueueV3 = {
  version: 3,
  kind: "existing",
  entries: [
    {
      id: "002-catalog",
      title: "Catalog",
      skip: ["tests"],
      acceptance: [{ name: "catalog api", command: "npm run acc -- catalog", timeoutSec: 600 }],
    },
    {
      id: "003-promo",
      title: "Promo",
      checks: [{ name: "cart unit", command: "npm test -- src/cart" }],
    },
  ],
};

const [catalog, promo] = resolveEntries(QUEUE, "main", null);

const RECORD: AcceptanceRecord = {
  version: 1,
  command: "npx playwright test tests/acceptance/003-promo",
  failExitCodes: [1],
  timeoutSec: 900,
  files: ["tests/acceptance/003-promo/apply.spec.ts"],
  covers: [{ test: "apply.spec.ts › applies", criterion: "SC-001" }],
};

test("fastChecksFor: the policy's fast checks, then the entry's own", () => {
  assert.deepEqual(
    fastChecksFor(POLICY, promo).map((c) => `${c.name}:${c.timeoutSec}`),
    ["unit:300", "types:120", "cart unit:600"],
  );
  assert.deepEqual(fastChecksFor(POLICY, catalog), POLICY.checks.fast);
});

test("fastChecksFor: an entry check that repeats a policy name throws with the entry id", () => {
  const clash = { ...promo, checks: [{ name: "unit", command: "x", timeoutSec: 1 }] };
  assert.throws(() => fastChecksFor(POLICY, clash), /003-promo: the entry check "unit" repeats/);
});

test("acceptanceSensorsFor: the recorded command first (as `acceptance`), then the queue's", () => {
  assert.deepEqual(acceptanceSensorsFor({ ...catalog }, RECORD), [
    { name: "acceptance", command: RECORD.command, timeoutSec: 900 },
    { name: "catalog api", command: "npm run acc -- catalog", timeoutSec: 600 },
  ]);
  assert.deepEqual(acceptanceSensorsFor(catalog, null), catalog.acceptance);
  assert.deepEqual(acceptanceSensorsFor(promo, null), [], "no record, no queue acceptance");
});

test("validateEntrySensors: every clash is reported; assertEntrySensors refuses the queue", () => {
  const queue: QueueV3 = {
    ...QUEUE,
    entries: [
      { id: "a", title: "A", checks: [{ name: "unit", command: "x" }] },
      {
        id: "b",
        title: "B",
        checks: [
          { name: "types", command: "y" },
          { name: "ok", command: "z" },
        ],
      },
    ],
  };
  assert.deepEqual(validateEntrySensors(queue, POLICY), [
    'entry "a": check "unit" repeats a policy.checks.fast name',
    'entry "b": check "types" repeats a policy.checks.fast name',
  ]);
  assert.deepEqual(validateEntrySensors(QUEUE, POLICY), []);
  assert.throws(
    () => assertEntrySensors(queue, POLICY, ".dex/queue.json"),
    (err: unknown) =>
      err instanceof QueueInvalidError && /"a".*"unit".*"b".*"types"/.test(err.message),
  );
});

// ── acceptance.json (contracts/acceptance-json.md) ──

const TREE = { exists: (rel: string) => rel === "tests/acceptance/catalog.spec.ts" };
const VALID = {
  version: 1,
  command: "npx playwright test tests/acceptance/catalog.spec.ts",
  failExitCodes: [1],
  timeoutSec: 900,
  files: ["tests/acceptance/catalog.spec.ts"],
  covers: [{ test: "catalog.spec.ts › lists products", criterion: "SC-001" }],
};

test("parseAcceptance: a valid record; defaults for failExitCodes and timeoutSec", () => {
  assert.deepEqual(parseAcceptance(VALID, POLICY, TREE), VALID);
  const { failExitCodes: _f, timeoutSec: _t, ...bare } = VALID;
  const parsed = parseAcceptance(bare, POLICY, TREE);
  assert.deepEqual(parsed.failExitCodes, [1]);
  assert.equal(parsed.timeoutSec, 1800);
});

test("parseAcceptance: each broken record names the field", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...VALID, version: 2 }, /"version" must be 1/],
    [{ ...VALID, command: undefined }, /"command" must be a non-empty string/],
    [{ ...VALID, files: undefined }, /"files" must be a non-empty list/],
    [{ ...VALID, covers: undefined }, /"covers" must be a non-empty list/],
    [
      { ...VALID, covers: [{ test: "x" }] },
      /"covers\[0\]" must have a non-empty "test" and "criterion"/,
    ],
    [{ ...VALID, failExitCodes: [1, 0] }, /"failExitCodes" must be a non-empty list of non-zero/],
    [{ ...VALID, files: ["tests/acceptance/missing.spec.ts"] }, /missing\.spec\.ts does not exist/],
    [{ ...VALID, files: ["src/catalog.ts"] }, /src\/catalog\.ts matches no testGlobs pattern/],
    [{ ...VALID, files: ["../elsewhere.test.ts"] }, /must be project-relative/],
    [{ ...VALID, note: "hi" }, /unknown field "note"/],
  ];
  for (const [raw, msg] of cases) {
    assert.throws(
      () => parseAcceptance(raw, POLICY, TREE),
      (e: unknown) => e instanceof AcceptanceInvalidError && msg.test(e.message),
      String(msg),
    );
  }
});

test("readAcceptance: missing, not JSON, and ok — the hash is of the file's text", () => {
  const files: Record<string, string> = {};
  const tree = {
    exists: (rel: string) => rel in files || TREE.exists(rel),
    read: (rel: string) => files[rel] ?? null,
  };
  assert.deepEqual(readAcceptance(tree, catalog, POLICY), { kind: "missing" });
  files[acceptancePath(catalog)] = "{ not json";
  const bad = readAcceptance(tree, catalog, POLICY);
  assert.match(bad.kind === "invalid" ? bad.message : "", /not valid JSON/);
  const text = JSON.stringify(VALID);
  files[acceptancePath(catalog)] = text;
  const ok = readAcceptance(tree, catalog, POLICY);
  assert.equal(ok.kind === "ok" && ok.hash, acceptanceHash(text));
  assert.equal(ok.kind === "ok" && ok.record.command, VALID.command);
});
