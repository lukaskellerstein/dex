import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadAppConfig,
  appConfigPath,
  expandNameTemplate,
  getWelcomeDefaults,
  DEFAULT_APP_CONFIG,
} from "../appConfig.ts";

function mkTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dex-app-config-"));
}

function writeConfig(home: string, contents: string): void {
  const file = appConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

test("appConfig: missing file seeds defaults to disk and returns them", () => {
  const home = mkTmpHome();
  try {
    const cfg = loadAppConfig(home);
    assert.deepEqual(cfg, DEFAULT_APP_CONFIG);
    // Seeded file should now exist with the same contents.
    const seeded = JSON.parse(fs.readFileSync(appConfigPath(home), "utf8"));
    assert.deepEqual(seeded, DEFAULT_APP_CONFIG);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("appConfig: valid file is parsed", () => {
  const home = mkTmpHome();
  try {
    writeConfig(home, JSON.stringify({
      welcome: { defaultLocation: "/tmp/x", defaultName: "alpha-{random:4}" },
    }));
    const cfg = loadAppConfig(home);
    assert.equal(cfg.welcome.defaultLocation, "/tmp/x");
    assert.equal(cfg.welcome.defaultName, "alpha-{random:4}");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("appConfig: malformed JSON falls back to defaults (no throw)", () => {
  const home = mkTmpHome();
  try {
    writeConfig(home, "{ not valid json");
    const cfg = loadAppConfig(home);
    assert.deepEqual(cfg, DEFAULT_APP_CONFIG);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("appConfig: schema violation falls back to defaults (no throw)", () => {
  const home = mkTmpHome();
  try {
    writeConfig(home, JSON.stringify({ welcome: { defaultLocation: 42 } }));
    const cfg = loadAppConfig(home);
    assert.deepEqual(cfg, DEFAULT_APP_CONFIG);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("appConfig: missing welcome key falls back to defaults", () => {
  const home = mkTmpHome();
  try {
    writeConfig(home, JSON.stringify({}));
    const cfg = loadAppConfig(home);
    assert.deepEqual(cfg, DEFAULT_APP_CONFIG);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("expandNameTemplate: replaces {random:N} with base36 of length N", () => {
  const out = expandNameTemplate("project-{random:8}");
  assert.match(out, /^project-[a-z0-9]{8}$/);
});

test("expandNameTemplate: multiple placeholders get independent values", () => {
  const out = expandNameTemplate("{random:6}-{random:6}");
  const m = out.match(/^([a-z0-9]{6})-([a-z0-9]{6})$/);
  assert.ok(m, `unexpected output: ${out}`);
  // Independence isn't guaranteed each run, but values must each be 6 chars.
  assert.equal(m![1].length, 6);
  assert.equal(m![2].length, 6);
});

test("expandNameTemplate: literal name without placeholder is returned as-is", () => {
  assert.equal(expandNameTemplate("my-fixed-project"), "my-fixed-project");
});

test("expandNameTemplate: unrecognized placeholder is left untouched", () => {
  assert.equal(expandNameTemplate("p-{date}"), "p-{date}");
});

test("expandNameTemplate: clamps absurd N values", () => {
  // N=0 → clamped to 1; very large N → clamped to 64.
  assert.match(expandNameTemplate("{random:0}"), /^[a-z0-9]{1}$/);
  assert.match(expandNameTemplate("{random:1000}"), /^[a-z0-9]{64}$/);
});

test("getWelcomeDefaults: returns expanded random postfix", () => {
  const home = mkTmpHome();
  try {
    const a = getWelcomeDefaults(home);
    const b = getWelcomeDefaults(home);
    assert.equal(a.defaultLocation, DEFAULT_APP_CONFIG.welcome.defaultLocation);
    assert.match(a.defaultName, /^project-[a-z0-9]{8}$/);
    // Two consecutive calls should usually differ — Math.random collisions
    // at 8 base36 chars are vanishingly rare.
    assert.notEqual(a.defaultName, b.defaultName);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
