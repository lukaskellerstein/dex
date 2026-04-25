import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadMockConfig,
  mockConfigPath,
  MockConfigParseError,
  MockConfigInvalidError,
  PHASE_OF_STEP,
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
  enabled: true,
  fixtureDir: "/abs/fixtures",
  prerequisites: { prerequisites: { delay: 0 } },
  clarification: {
    clarification_product: { delay: 0 },
    clarification_technical: { delay: 0 },
    clarification_synthesis: { delay: 0 },
    constitution: { delay: 0 },
    manifest_extraction: { delay: 0 },
  },
  dex_loop: {
    cycles: [
      {
        feature: { id: "f-001", title: "F1" },
        stages: {
          gap_analysis: { delay: 0, structured_output: { decision: "GAPS_COMPLETE" } },
          specify: { delay: 0 },
          plan: { delay: 0 },
          tasks: { delay: 0 },
          implement: { delay: 0 },
          verify: { delay: 0, structured_output: { ok: true, issues: [] } },
          learnings: { delay: 0 },
        },
      },
    ],
  },
  completion: {},
};

test("MockConfig: loads a valid minimal config", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify(VALID_CONFIG));
    const cfg = loadMockConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.fixtureDir, "/abs/fixtures");
    assert.equal(cfg.dex_loop.cycles.length, 1);
    assert.equal(cfg.dex_loop.cycles[0].feature.id, "f-001");
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

test("MockConfig: missing 'enabled' throws MockConfigInvalidError", () => {
  const dir = mkProject();
  try {
    const bad = { ...VALID_CONFIG };
    delete (bad as Record<string, unknown>).enabled;
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /missing required top-level key 'enabled'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: non-boolean 'enabled' throws", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify({ ...VALID_CONFIG, enabled: "yes" }));
    assert.throws(() => loadMockConfig(dir), /'enabled' must be a boolean/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: empty cycles array throws", () => {
  const dir = mkProject();
  try {
    writeConfig(dir, JSON.stringify({ ...VALID_CONFIG, dex_loop: { cycles: [] } }));
    assert.throws(() => loadMockConfig(dir), /non-empty array/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: cycle missing required stage throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    delete (bad.dex_loop.cycles[0].stages as Record<string, unknown>).verify;
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /stages\.verify is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: writes entry with both 'from' and 'content' throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    (bad.dex_loop.cycles[0].stages.specify as Record<string, unknown>).writes = [
      { path: "x.md", from: "y.md", content: "z" },
    ];
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /exactly one of 'from' or 'content'/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MockConfig: writes entry with neither 'from' nor 'content' throws", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    (bad.dex_loop.cycles[0].stages.specify as Record<string, unknown>).writes = [
      { path: "x.md" },
    ];
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /exactly one of 'from' or 'content'/);
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

test("MockConfig: feature.id must be a non-empty string", () => {
  const dir = mkProject();
  try {
    const bad = structuredClone(VALID_CONFIG);
    (bad.dex_loop.cycles[0].feature as Record<string, unknown>).id = "";
    writeConfig(dir, JSON.stringify(bad));
    assert.throws(() => loadMockConfig(dir), /feature\.id must be a non-empty string/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("PHASE_OF_STEP: every StepType maps to exactly one phase", () => {
  assert.equal(PHASE_OF_STEP.prerequisites, "prerequisites");
  assert.equal(PHASE_OF_STEP.manifest_extraction, "clarification");
  assert.equal(PHASE_OF_STEP.gap_analysis, "dex_loop");
  assert.equal(PHASE_OF_STEP.implement, "dex_loop");
  assert.equal(PHASE_OF_STEP.learnings, "dex_loop");
});
