import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  loadQueue,
  parseTaskScope,
  QueueInvalidError,
  type QueueV3,
  queuePath,
  resolveEntries,
  saveQueue,
  validateQueue,
} from "../queue.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

function q(entries: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { version: 3, kind: "existing", entries, ...extra };
}

function assertInvalid(raw: unknown, pattern: RegExp): void {
  assert.throws(
    () => validateQueue(raw, "queue.json"),
    (err: unknown) => {
      assert.ok(err instanceof QueueInvalidError, `expected QueueInvalidError, got ${err}`);
      assert.match((err as Error).message, pattern);
      return true;
    },
  );
}

// ── Validation ──

test("queue: a minimal valid queue passes and keeps its fields", () => {
  const v = validateQueue(q([{ id: "001-a", title: "A" }]), "queue.json");
  assert.equal(v.kind, "existing");
  assert.deepEqual(v.entries, [{ id: "001-a", title: "A" }]);
});

test("queue: version, kind and entries are checked", () => {
  assertInvalid({ version: 2, kind: "existing", entries: [{ id: "a", title: "A" }] }, /version/);
  assertInvalid(q([{ id: "a", title: "A" }], { kind: "old" }), /kind/);
  assertInvalid(q([]), /entries/);
  assertInvalid([], /object/);
});

test("queue: a duplicate id names the entry and the field", () => {
  assertInvalid(
    q([
      { id: "001-a", title: "A" },
      { id: "001-a", title: "B" },
    ]),
    /entries\[1\].*001-a.*id.*duplicate/,
  );
});

test("queue: an id outside the pattern is rejected", () => {
  assertInvalid(q([{ id: "Bad Id", title: "A" }]), /entries\[0\].*id/);
  assertInvalid(q([{ id: "-a", title: "A" }]), /id/);
});

test("queue: an empty title is rejected", () => {
  assertInvalid(q([{ id: "a", title: "  " }]), /entries\[0\].*"a".*title/);
});

test("queue: a bad stage name in skip or gates is rejected", () => {
  assertInvalid(q([{ id: "a", title: "A", skip: ["deploy"] }]), /skip.*deploy/);
  assertInvalid(q([{ id: "a", title: "A", gates: ["brief", "ship"] }]), /gates.*ship/);
});

test("queue: a bad task item or a reversed range is rejected", () => {
  assertInvalid(q([{ id: "a", title: "A", tasks: ["X1"] }]), /tasks.*X1/);
  assertInvalid(q([{ id: "a", title: "A", tasks: ["T20-T10"] }]), /tasks.*T20-T10/);
  validateQueue(q([{ id: "a", title: "A", tasks: ["T110", "T122-T134", "T5-T5"] }]), "q");
});

test("queue: unknown fields are rejected, top level and entry", () => {
  assertInvalid(q([{ id: "a", title: "A", titel: "typo" }]), /entries\[0\].*titel/);
  assertInvalid(q([{ id: "a", title: "A" }], { entires: [] }), /entires/);
  assertInvalid(q([{ id: "a", title: "A", generate: { sources: ["x"], extra: 1 } }]), /extra/);
});

test("queue: generate needs a non-empty sources list and a brief path", () => {
  assertInvalid(
    q([{ id: "a", title: "A", brief: "b.md", generate: { sources: [] } }]),
    /generate\.sources/,
  );
  assertInvalid(q([{ id: "a", title: "A", brief: "b.md", generate: {} }]), /generate\.sources/);
  assertInvalid(
    q([{ id: "a", title: "A", generate: { sources: ["x.md"] } }]),
    /"generate" needs "brief"/,
  );
});

test("queue: status accepts only done and skipped", () => {
  assertInvalid(q([{ id: "a", title: "A", status: "completed" }]), /status/);
  validateQueue(q([{ id: "a", title: "A", status: "skipped" }]), "q");
});

test("queue: string fields must be strings", () => {
  assertInvalid(q([{ id: "a", title: "A", brief: 3 }]), /brief/);
  assertInvalid(q([{ id: "a", title: "A", baseBranch: "" }]), /baseBranch/);
});

// ── Resolution ──

test("resolve: existing entries default specDir, branch and the baseBranch chain", () => {
  const queue = validateQueue(
    q([
      { id: "020-onion", title: "Onion" },
      { id: "021-agent", title: "Agent", branch: "feat/agent" },
      { id: "022-pilot", title: "Pilot" },
      { id: "023-docs", title: "Docs", baseBranch: "main", specDir: "docs/specs/023" },
    ]),
    "q",
  );
  const r = resolveEntries(queue, "main", null);
  assert.deepEqual(
    r.map((e) => [e.id, e.specDir, e.branch, e.baseBranch]),
    [
      ["020-onion", "specs/020-onion", "020-onion", "main"],
      ["021-agent", "specs/021-agent", "feat/agent", "020-onion"],
      ["022-pilot", "specs/022-pilot", "022-pilot", "feat/agent"],
      ["023-docs", "docs/specs/023", "023-docs", "main"],
    ],
  );
  assert.deepEqual(
    r.map((e) => e.index),
    [0, 1, 2, 3],
  );
});

test("resolve: every entry of a new queue uses the run branch", () => {
  const queue = validateQueue(
    {
      version: 3,
      kind: "new",
      entries: [
        { id: "001-a", title: "A" },
        { id: "002-b", title: "B" },
      ],
    },
    "q",
  );
  const r = resolveEntries(queue, "main", "dex/2026-11-05-abc123");
  assert.deepEqual(
    r.map((e) => e.branch),
    ["dex/2026-11-05-abc123", "dex/2026-11-05-abc123"],
  );
});

test("resolve: gates default to brief with generate, else none; explicit gates win", () => {
  const queue = validateQueue(
    q([
      { id: "a", title: "A", brief: "b.md", generate: { sources: ["x.md"] } },
      { id: "b", title: "B" },
      { id: "c", title: "C", brief: "c.md", generate: { sources: ["x.md"] }, gates: ["plan"] },
    ]),
    "q",
  );
  const r = resolveEntries(queue, "main", null);
  assert.deepEqual(
    r.map((e) => e.gates),
    [["brief"], [], ["plan"]],
  );
});

test("resolve: the task scope is expanded, absent means all", () => {
  const queue = validateQueue(
    q([
      { id: "a", title: "A", tasks: ["T110", "T122-T124"] },
      { id: "b", title: "B" },
    ]),
    "q",
  );
  const r = resolveEntries(queue, "main", null);
  assert.deepEqual(r[0].tasks, ["T110", "T122", "T123", "T124"]);
  assert.equal(r[1].tasks, null);
});

test("parseTaskScope expands singles and ranges in order", () => {
  const ids = parseTaskScope(["T110", "T122-T134"]);
  assert.equal(ids.length, 14);
  assert.equal(ids[0], "T110");
  assert.equal(ids[1], "T122");
  assert.equal(ids[13], "T134");
});

// ── Load, migration, save ──

function writeManifest(dir: string, features: unknown[]): void {
  fs.mkdirSync(path.join(dir, ".dex"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".dex", "feature-manifest.json"),
    JSON.stringify({ version: 2, sourceHash: "h", sourcePath: "GOAL_clarified.md", features }),
  );
}

test("loadQueue: no queue and no manifest returns null", () => {
  const dir = mkTmpProject({});
  try {
    assert.equal(loadQueue(dir), null);
  } finally {
    rmTmp(dir);
  }
});

test("loadQueue: migrates a v2 manifest to v3 and writes queue.json once", () => {
  const dir = mkTmpProject({});
  try {
    writeManifest(dir, [
      {
        id: 1,
        title: "Catalog",
        description: "d1",
        status: "completed",
        specDir: "specs/001-catalog",
      },
      { id: 2, title: "Cart & Checkout!", description: "", status: "skipped", specDir: null },
      { id: 3, title: "Admin", description: "d3", status: "pending", specDir: null },
      {
        id: 12,
        title: "Search",
        description: "d12",
        status: "active",
        specDir: path.join(dir, "specs/012-find"),
      },
    ]);
    const queue = loadQueue(dir);
    assert.ok(queue);
    assert.equal(queue.kind, "new");
    assert.deepEqual(queue.entries, [
      {
        id: "001-catalog",
        title: "Catalog",
        description: "d1",
        specDir: "specs/001-catalog",
        status: "done",
      },
      { id: "002-cart-checkout", title: "Cart & Checkout!", status: "skipped" },
      { id: "003-admin", title: "Admin", description: "d3" },
      { id: "012-find", title: "Search", description: "d12", specDir: "specs/012-find" },
    ]);
    assert.ok(fs.existsSync(queuePath(dir)), "queue.json written");
    assert.ok(fs.existsSync(path.join(dir, ".dex", "feature-manifest.json")), "manifest kept");

    // Once written, queue.json wins: a later manifest change is not re-migrated.
    writeManifest(dir, [
      { id: 9, title: "Other", description: "", status: "pending", specDir: null },
    ]);
    assert.deepEqual(
      loadQueue(dir)?.entries.map((e) => e.id),
      ["001-catalog", "002-cart-checkout", "003-admin", "012-find"],
    );
  } finally {
    rmTmp(dir);
  }
});

test("loadQueue: queue.json wins when both files exist", () => {
  const queue: QueueV3 = { version: 3, kind: "existing", entries: [{ id: "x", title: "X" }] };
  const dir = mkTmpProject({ ".dex/queue.json": JSON.stringify(queue) });
  try {
    writeManifest(dir, [{ id: 1, title: "M", description: "", status: "pending", specDir: null }]);
    assert.deepEqual(loadQueue(dir), queue);
  } finally {
    rmTmp(dir);
  }
});

test("loadQueue: bad JSON or a bad queue throws QueueInvalidError with the path", () => {
  const dir = mkTmpProject({ ".dex/queue.json": "{ nope" });
  try {
    assert.throws(
      () => loadQueue(dir),
      (err: unknown) =>
        err instanceof QueueInvalidError && (err as Error).message.includes("queue.json"),
    );
    fs.writeFileSync(queuePath(dir), JSON.stringify({ version: 3, kind: "new", entries: [] }));
    assert.throws(() => loadQueue(dir), QueueInvalidError);
  } finally {
    rmTmp(dir);
  }
});

test("saveQueue: writes through a temp file and round-trips", () => {
  const dir = mkTmpProject({});
  try {
    const queue: QueueV3 = {
      version: 3,
      kind: "existing",
      entries: [{ id: "a", title: "A", skip: ["brief"] }],
    };
    saveQueue(dir, queue);
    assert.deepEqual(loadQueue(dir), queue);
    assert.deepEqual(fs.readdirSync(path.join(dir, ".dex")), ["queue.json"]);
  } finally {
    rmTmp(dir);
  }
});
