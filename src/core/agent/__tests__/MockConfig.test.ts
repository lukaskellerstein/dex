import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadMockConfig,
  MockConfigInvalidError,
  MockConfigParseError,
  mockConfigPath,
  PHASE_OF_STEP,
  stageScript,
} from "../MockConfig.ts";

function mkProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dex-mock-config-"));
}

function writeConfig(projectDir: string, contents: string): void {
  const p = mockConfigPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contents);
}

const VALID_CONFIG = {
  prerequisites: { prerequisites: { delay: 0 } },
  clarification: {
    clarification_product: { delay: 0 },
    clarification_technical: { delay: 0 },
    clarification_synthesis: { delay: 0 },
    constitution: { delay: 0 },
    manifest_extraction: { delay: 0 },
  },
  entries: {
    "*": {
      specify: { delay: 0 },
      clarify: { delay: 0 },
      plan: { delay: 0 },
      tasks: { delay: 0 },
      implement: { delay: 0 },
      verify: { delay: 0 },
    } as Record<string, Record<string, unknown>>,
    "002-b": {
      verify: {
        delay: 5,
        rounds: [{ verdict: "failed", fixTasks: ["fix it"] }, { verdict: "passed" }],
      },
    } as Record<string, Record<string, unknown>>,
  },
};

test("MockConfig: loads a valid minimal config", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify(VALID_CONFIG));
    const cfg = loadMockConfig(dir);
    assert.deepEqual(Object.keys(cfg.entries), ["*", "002-b"]);
    assert.deepEqual(cfg.completion, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: missing file throws MockConfigInvalidError (not parse error)", () => {
  const dir = mkProject();
  try {
    assert.throws(() => loadMockConfig(dir), MockConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: invalid JSON throws MockConfigParseError", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, "{ not json");
    assert.throws(() => loadMockConfig(dir), MockConfigParseError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: empty entries throws", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify({ ...VALID_CONFIG, entries: {} }));
    assert.throws(() => loadMockConfig(dir), /non-empty object keyed by entry id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: a pre-015 dex_loop config throws with the migration hint", () => {
  const dir = mkProject();
  try {
    const { entries: _entries, ...rest } = VALID_CONFIG;
    writeConfig(dir, JSON.stringify({ ...rest, dex_loop: { cycles: [] } }));
    assert.throws(() => loadMockConfig(dir), /'dex_loop\.cycles' was replaced by 'entries'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: an unknown stage name throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    bad.entries["*"].gap_analysis = { delay: 0 };
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /gap_analysis is not a stage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: a verify round needs a passed/failed verdict", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    bad.entries["002-b"].verify = { delay: 0, rounds: [{ verdict: "maybe" }] };
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /rounds\[0\]\.verdict must be "passed" or "failed"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stageScript: the entry\'s own stage wins, else the "*" one, else null', () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify(VALID_CONFIG));
    const cfg = loadMockConfig(dir);
    assert.equal(stageScript(cfg, "002-b", "verify")?.delay, 5);
    assert.equal(stageScript(cfg, "002-b", "plan")?.delay, 0);
    assert.equal(stageScript(cfg, "001-a", "verify")?.delay, 0);
    assert.equal(stageScript(cfg, null, "implement")?.delay, 0);
    assert.equal(stageScript(cfg, "001-a", "brief"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: writes entry without 'content' throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    bad.entries["*"].specify.writes = [{ path: "x.md" }];
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /\.content must be a string/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: non-finite delay throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    (bad.prerequisites.prerequisites as Record<string, unknown>).delay = -5;
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /delay must be a non-negative finite number/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PHASE_OF_STEP: every StepType maps to exactly one phase", () => {
  assert.equal(PHASE_OF_STEP.prerequisites, "prerequisites");
  assert.equal(PHASE_OF_STEP.manifest_extraction, "clarification");
  assert.equal(PHASE_OF_STEP.brief, "entries");
  assert.equal(PHASE_OF_STEP.implement, "entries");
  assert.equal(PHASE_OF_STEP.verify, "entries");
});
