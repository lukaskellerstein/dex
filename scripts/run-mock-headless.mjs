#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Drive a full mock run against a project without the Electron UI.
 *
 * Usage: node scripts/run-mock-headless.mjs <projectDir> [--goal <file>]
 *
 * Useful when MCP is disconnected or dev-setup.sh is down — exercises the
 * orchestrator end-to-end so we can validate the resulting git tree, and is the
 * fastest way to prove a project's .dex/mock-config.json is correct before
 * anything depends on it.
 *
 * Reads the COMPILED orchestrator from dist/, not src/. The previous version
 * imported `../src/core/orchestrator.ts` under --experimental-strip-types and
 * relied on `.js` specifiers resolving to their `.ts` sources; Node dropped
 * that resolution, so on Node 24+ the script died with ERR_MODULE_NOT_FOUND on
 * src/core/userInput.js before running anything. Using dist/ removes the
 * Node-version dependency and exercises exactly the code the app ships.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const goalIdx = args.indexOf("--goal");
const goalFile = goalIdx === -1 ? null : args[goalIdx + 1];
const positional = args.filter((_, i) => goalIdx === -1 || (i !== goalIdx && i !== goalIdx + 1));
const projectDir = positional[0];

if (!projectDir) {
  console.error("Usage: run-mock-headless.mjs <projectDir> [--goal <file>]");
  process.exit(2);
}
if (!fs.existsSync(projectDir)) {
  console.error(`No such project directory: ${projectDir}`);
  process.exit(2);
}

// Compile on demand rather than telling the user to remember. tsc is
// incremental, so this is nearly free when dist/ is already current.
const orchestratorPath = path.join(repoRoot, "dist", "core", "orchestrator.js");
if (!fs.existsSync(orchestratorPath)) {
  console.log("dist/ missing — compiling…");
  try {
    execFileSync("npx", ["tsc"], { cwd: repoRoot, stdio: "inherit" });
  } catch {
    console.error("Compile failed. Fix the type errors, or run 'npx tsc' manually.");
    process.exit(1);
  }
}
if (!fs.existsSync(orchestratorPath)) {
  console.error(`Still no compiled orchestrator at ${orchestratorPath}.`);
  process.exit(1);
}

const agentConfigPath = path.join(projectDir, ".dex", "dex-config.json");
const agent = fs.existsSync(agentConfigPath)
  ? JSON.parse(fs.readFileSync(agentConfigPath, "utf8")).agent
  : "claude";
if (agent !== "mock") {
  console.error(`.dex/dex-config.json selects agent "${agent}", not "mock".`);
  console.error("This script drives a scripted run; against a real backend it would");
  console.error('spend money and take minutes per stage. Set {"agent":"mock"} first.');
  process.exit(2);
}

const { run } = await import(pathToFileURL(orchestratorPath).href);

const counts = new Map();
const errors = [];
let stepsCompleted = 0;

const emit = (ev) => {
  counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1);
  switch (ev.type) {
    case "run_started":
      console.log(`▶ run ${ev.runId.slice(0, 8)}${ev.branchName ? ` on ${ev.branchName}` : ""}`);
      break;
    case "loop_cycle_started":
      console.log(`── cycle ${ev.cycleNumber} ──`);
      break;
    case "step_started":
      process.stdout.write(`   ${ev.step}…`);
      break;
    case "step_completed":
      stepsCompleted++;
      console.log(` ${ev.durationMs ?? 0}ms`);
      break;
    case "manifest_created":
      console.log(`   manifest: ${ev.featureCount} features`);
      break;
    case "stage_candidate":
    case "step_candidate":
      if (ev.checkpointTag)
        console.log(`   → ${ev.checkpointTag} ${ev.candidateSha?.slice(0, 7) ?? ""}`);
      break;
    case "loop_terminated":
      console.log(`■ terminated: ${ev.termination?.reason}`);
      break;
    case "error":
      errors.push(ev.message);
      console.error(`✗ ${ev.message}`);
      break;
    default:
      break;
  }
};

const config = {
  projectDir,
  specDir: "",
  mode: "loop",
  model: "claude-opus-4-6",
  maxIterations: 50,
  maxTurns: 75,
  phases: "all",
  autoClarification: true,
  ...(goalFile ? { descriptionFile: path.resolve(goalFile) } : {}),
};

const start = Date.now();
try {
  await run(config, emit);
} catch (err) {
  console.error(`\n━━ run threw: ${err.message} ━━`);
  console.error(err.stack);
  process.exit(1);
}

console.log(
  `\n━━ ${((Date.now() - start) / 1000).toFixed(1)}s, ${stepsCompleted} steps completed ━━`,
);
console.log(Object.fromEntries([...counts].sort()));

// A run can finish while having emitted error events — the loop catches
// per-cycle failures and carries on. Exiting 0 there would let a broken
// mock-config look healthy, which is the whole thing this script exists to
// catch.
if (errors.length) {
  console.error(`\n${errors.length} error event(s) emitted:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
