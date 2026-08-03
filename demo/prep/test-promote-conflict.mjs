#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Prove the section-05 conflict beat works before recording it.
 *
 * Calls mergeToMain the same way src/main/ipc/checkpoints.ts does — same
 * resolver dependency bundle, same agent runner from .dex/dex-config.json —
 * but headlessly, printing the conflict-resolver:* event stream the progress
 * modal renders.
 *
 * Expected sequence, and what section 05 must show on camera:
 *   file-start → iteration → file-done(ok) → done(ok)
 *
 * Run after demo/prep/stage-conflict.sh. Destructive: it actually promotes.
 *
 * usage: node demo/prep/test-promote-conflict.mjs [projectDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectDir =
  process.argv[2] ?? path.join(process.env.HOME, "Projects/Github/lukaskellerstein/dex-ecommerce");

const distDir = path.join(repoRoot, "dist", "core");
for (const f of ["checkpoints/index.js", "dexConfig.js", "agent/index.js"]) {
  if (!fs.existsSync(path.join(distDir, f))) {
    console.error(`missing dist/core/${f} — run 'npx tsc' first`);
    process.exit(2);
  }
}

const load = (rel) => import(pathToFileURL(path.join(distDir, rel)).href);
const { mergeToMain } = await load("checkpoints/index.js");
const { loadDexConfig } = await load("dexConfig.js");
const { createAgentRunner } = await load("agent/index.js");

const git = (...args) =>
  execFileSync("git", ["-C", projectDir, ...args], { encoding: "utf8" }).trim();

const runBranch = git("for-each-ref", "--format=%(refname:short)", "refs/heads/dex/*").split(
  "\n",
)[0];
if (!runBranch) {
  console.error("no dex/* run branch — run the loop first");
  process.exit(1);
}

// mergeToMain refuses to promote a branch that is checked out mid-run; and the
// working tree must be clean or it returns dirty_working_tree. Mirror what the
// UI does before promoting: sit on main's side of the world.
git("checkout", "-q", "-f", runBranch);
execFileSync("git", ["-C", projectDir, "clean", "-qfd"], { stdio: "pipe" });

const dexConfig = loadDexConfig(projectDir);
console.log(`agent=${dexConfig.agent}  branch=${runBranch}`);
console.log(
  `resolver caps: maxIterations=${dexConfig.conflictResolver.maxIterations} ` +
    `costCap=$${dexConfig.conflictResolver.costCapUsd} ` +
    `verify=${dexConfig.conflictResolver.verifyCommand ?? "none"}`,
);

const runConfig = {
  projectDir,
  specDir: "",
  mode: "loop",
  model: dexConfig.conflictResolver.model ?? "claude-opus-4-7",
  maxIterations: dexConfig.conflictResolver.maxIterations,
  maxTurns: dexConfig.conflictResolver.maxTurnsPerIteration,
  taskPhases: "all",
  autoClarification: false,
};

const seen = [];
const emit = (event) => {
  if (!String(event.type).startsWith("conflict-resolver:")) return;
  seen.push(event.type);
  console.log(`  ${event.type}`, JSON.stringify(event));
};

const noop = () => {};
const rlog = { run: noop, agentRun: noop, subagentEvent: noop };

const result = await mergeToMain(projectDir, runBranch, { force: "discard" }, rlog, {
  runner: createAgentRunner(dexConfig.agent, runConfig, projectDir),
  config: dexConfig.conflictResolver,
  runConfig,
  emit,
  abortController: null,
  rlog,
});

console.log("\nmergeToMain →", JSON.stringify(result, null, 2));

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

check("merge succeeded", result.ok === true);
check("took the resolver path, not a clean merge", result.mode === "resolved");
check("the resolver reported the file it fixed", result.resolvedFiles?.includes("README.md"));
check("resolver emitted file-start", seen.includes("conflict-resolver:file-start"));
check("resolver emitted an iteration", seen.includes("conflict-resolver:iteration"));
check("resolver emitted done", seen.includes("conflict-resolver:done"));

const readme = path.join(projectDir, "README.md");
const merged = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : "";
check("no conflict markers survive", !/<{7}|={7}\n|>{7}/.test(merged));
check("kept the run's catalogue modules", merged.includes("src/catalog/search.ts"));
check("kept main's admin entry", merged.includes("src/admin/"));
check("kept main's Contributing section", merged.includes("## Contributing"));
check("main now contains the merge", git("rev-parse", "--abbrev-ref", "HEAD") === "main");

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
