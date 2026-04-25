#!/usr/bin/env node
/**
 * Drive a full mock run against a project without the Electron UI.
 *
 * Usage: node --experimental-strip-types scripts/run-mock-headless.mjs <projectDir>
 *
 * Useful when MCP is disconnected or dev-setup.sh is down — exercises the
 * orchestrator end-to-end so we can validate the resulting git tree.
 */
import { run } from "../src/core/orchestrator.ts";

const projectDir = process.argv[2];
if (!projectDir) {
  console.error("Usage: run-mock-headless.mjs <projectDir>");
  process.exit(2);
}

const events = [];
const emit = (ev) => {
  events.push(ev);
  const brief =
    ev.type === "stage_started" ? `  ${ev.cycleNumber}/${ev.stage}` :
    ev.type === "stage_completed" ? `✓ ${ev.cycleNumber}/${ev.stage} (${ev.durationMs}ms)` :
    ev.type === "loop_cycle_started" ? `── cycle ${ev.cycleNumber} ──` :
    ev.type === "loop_terminated" ? `■ terminated (${ev.termination?.reason})` :
    ev.type === "error" ? `✗ ERROR: ${ev.message}` :
    ev.type === "stage_candidate" ? `  → candidate ${ev.checkpointTag} ${ev.candidateSha.slice(0, 7)}` :
    ev.type === "run_started" ? `▶ run ${ev.runId.slice(0, 8)} on ${ev.branchName}` :
    ev.type === "run_completed" ? `■ completed (${ev.phasesCompleted} phases, $${ev.totalCost})` :
    null;
  if (brief) console.log(brief);
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
};

const start = Date.now();
try {
  await run(config, emit);
  console.log(`\n━━ run done in ${Date.now() - start}ms, ${events.length} events ━━`);
} catch (err) {
  console.error(`\n━━ run threw: ${err.message} ━━`);
  console.error(err.stack);
  process.exit(1);
}
