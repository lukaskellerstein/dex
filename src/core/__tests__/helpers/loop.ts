/**
 * Loop fixtures for core tests: a temp repo that `run()` can drive end to end
 * with the mock agent, with no network and no real CLI. `HOME` must point at a
 * temp folder before the orchestrator is imported, so the run log tree
 * (`~/.dex/logs`) stays out of the real home.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNTIME_IGNORE_ENTRIES } from "../../state.ts";
import { mkTmpRepo } from "./git.ts";

/** npm runs the test scripts from the package root. */
const REPO_ROOT = process.cwd();

/** A fixture from `fixtures/mock/`, with every delay set to 0. */
export function mockFixture(name: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "fixtures", "mock", name), "utf8");
  return JSON.parse(raw, (key, value) => (key === "delay" ? 0 : value));
}

/**
 * Stub `claude` and `specify` (exit 0) and `gh` (exit 1) on PATH, so the
 * prerequisite checks pass without the real tools and GitHub setup is skipped.
 * Returns a function that restores PATH.
 */
export function stubCliTools(): () => void {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "dex-bin-"));
  for (const [name, code] of [
    ["claude", 0],
    ["specify", 0],
    ["gh", 1],
  ] as const) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexit ${code}\n`);
    fs.chmodSync(file, 0o755);
  }
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  return () => {
    process.env.PATH = before;
    fs.rmSync(bin, { recursive: true, force: true });
  };
}

export interface LoopProjectOptions {
  queue: Record<string, unknown>;
  mock: Record<string, unknown>;
  files?: Record<string, string>;
}

/** A committed repo on `main` with GOAL.md, a v3 queue, the mock agent and spec-kit marked as set up. */
export function mkLoopProject(opts: LoopProjectOptions): string {
  const dir = mkTmpRepo("dex-loop-");
  const files: Record<string, string> = {
    "GOAL.md": "# Goal\n\nA small shop.\n",
    ".dex/queue.json": `${JSON.stringify(opts.queue, null, 2)}\n`,
    ".dex/dex-config.json": '{ "agent": "mock" }\n',
    ".dex/mock-config.json": `${JSON.stringify(opts.mock, null, 2)}\n`,
    ".specify/integration.json": "{}\n",
    ...opts.files,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "setup"', { cwd: dir });
  return dir;
}

/** `.specify/feature.json` as the existing-project fixture commits it. */
export const FIXTURE_FEATURE_JSON = '{ "feature_directory": "specs/900-fixture-a" }\n';

/** Writes `content` to `dir/rel`, creating the folders. */
export function writeFile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * main: a project already set up with spec-kit. 900-fixture-a: feature A half
 * done, plus the human's queue and policy, committed by the human. `mock`
 * replaces `fixtures/mock/existing-project.json`.
 */
export function mkExistingProject(
  mock: Record<string, unknown> = mockFixture("existing-project.json"),
): string {
  const dir = mkTmpRepo("dex-existing-");
  writeFile(dir, ".specify/integration.json", "{}\n");
  writeFile(
    dir,
    ".specify/scripts/bash/common.sh",
    '# spec-kit\nFEATURE_DIR="$SPECIFY_FEATURE_DIRECTORY"\n',
  );
  writeFile(dir, ".specify/feature.json", FIXTURE_FEATURE_JSON);
  execSync("git add -A && git commit -q -m 'spec-kit setup'", { cwd: dir });
  execSync("git switch -q -c 900-fixture-a", { cwd: dir });
  const fixture = path.join(REPO_ROOT, "fixtures", "existing-project");
  fs.cpSync(path.join(fixture, "specs"), path.join(dir, "specs"), { recursive: true });
  for (const f of ["queue.json", "policy.json"]) {
    writeFile(dir, `.dex/${f}`, fs.readFileSync(path.join(fixture, f), "utf-8"));
  }
  writeFile(dir, ".dex/mock-config.json", `${JSON.stringify(mock, null, 2)}\n`);
  writeFile(dir, ".dex/dex-config.json", '{ "agent": "mock" }\n');
  writeFile(dir, ".dex/.gitignore", `${RUNTIME_IGNORE_ENTRIES.join("\n")}\n`);
  execSync("git add -A && git commit -q -m 'fixture: queue + policy'", { cwd: dir });
  return dir;
}
