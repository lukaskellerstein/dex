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
} from "../dexConfig.ts";

function mkTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dex-config-"));
}

function writeConfig(projectDir: string, contents: string): void {
  const configPath = dexConfigPath(projectDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, contents);
}

test("dexConfig: absent file returns default { agent: 'claude' }", () => {
  const dir = mkTmpProject();
  try {
    const cfg = loadDexConfig(dir);
    assert.deepEqual(cfg, { agent: "claude" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: valid file returns parsed agent", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": "mock" }');
    const cfg = loadDexConfig(dir);
    assert.deepEqual(cfg, { agent: "mock" });
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

test("dexConfig: missing 'agent' throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, "{}");
    assert.throws(() => loadDexConfig(dir), (err: unknown) => {
      assert.ok(err instanceof DexConfigInvalidError);
      assert.match((err as Error).message, /'agent' field is required/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("dexConfig: non-string 'agent' throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '{ "agent": 42 }');
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
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

test("dexConfig: non-object root throws DexConfigInvalidError", () => {
  const dir = mkTmpProject();
  try {
    writeConfig(dir, '["agent"]');
    assert.throws(() => loadDexConfig(dir), DexConfigInvalidError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
