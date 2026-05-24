import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadDexConfig,
  DexConfigParseError,
  DexConfigInvalidError,
  dexConfigPath,
  DEFAULT_CONFLICT_RESOLVER_CONFIG,
} from "../dexConfig.ts";

function mkTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dex-config-"));
}

function writeConfig(projectDir: string, contents: string): void {
  const configPath = dexConfigPath(projectDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, contents);
}

test("dexConfig: absent file returns default { agent: 'claude', conflictResolver }", () => {
  const dir = mkTmpProject();
  try {
    const cfg = loadDexConfig(dir);
    assert.deepEqual(cfg, {
      agent: "claude",
      conflictResolver: { ...DEFAULT_CONFLICT_RESOLVER_CONFIG },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: empty object defaults agent to 'claude'", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, "{}");
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.agent, "claude");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: agent:'mock' is preserved", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": "mock" }');
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.agent, "mock");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: future agent names pass through unchanged (validated downstream)", () => {
  // The loader doesn't gate the value against a known-runners list — that
  // belongs to createAgentRunner so the message can list valid names. This
  // also lets builds add new runners without changing the loader.
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": "codex" }');
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.agent, "codex");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: non-string 'agent' throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": 42 }');
    assert.throws(() => loadDexConfig(dir), (err: unknown) => {
      assert.ok(err instanceof DexConfigInvalidError);
      assert.match((err as Error).message, /'agent' must be a non-empty string/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: empty-string 'agent' throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": "" }');
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver overrides merge field-by-field over defaults", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(
      dir,
      '{ "agent": "claude", "conflictResolver": { "maxIterations": 2, "costCapUsd": 0.05 } }',
    );
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.conflictResolver.maxIterations, 2);
    assert.equal(cfg.conflictResolver.costCapUsd, 0.05);
    // Other fields stay at defaults.
    assert.equal(cfg.conflictResolver.model, DEFAULT_CONFLICT_RESOLVER_CONFIG.model);
    assert.equal(cfg.conflictResolver.maxTurnsPerIteration, DEFAULT_CONFLICT_RESOLVER_CONFIG.maxTurnsPerIteration);
    assert.equal(cfg.conflictResolver.verifyCommand, DEFAULT_CONFLICT_RESOLVER_CONFIG.verifyCommand);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver verifyCommand:null skips verification", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(
      dir,
      '{ "conflictResolver": { "verifyCommand": null } }',
    );
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.conflictResolver.verifyCommand, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver empty-string verifyCommand normalises to null", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(
      dir,
      '{ "conflictResolver": { "verifyCommand": "" } }',
    );
    const cfg = loadDexConfig(dir);
    assert.equal(cfg.conflictResolver.verifyCommand, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver invalid maxIterations throws", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(
      dir,
      '{ "conflictResolver": { "maxIterations": 0 } }',
    );
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver negative costCapUsd throws", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(
      dir,
      '{ "conflictResolver": { "costCapUsd": -1 } }',
    );
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: conflictResolver non-object throws", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "conflictResolver": [] }');
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: parse error throws DexConfigParseError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, "{ not valid json");
    assert.throws(() => loadDexConfig(dir), (err: unknown) => {
      assert.ok(err instanceof DexConfigParseError);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: non-object root throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '["agent"]');
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
