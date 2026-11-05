#!/usr/bin/env node
/**
 * Run ONE real agent stage against a project, with no orchestrator around it.
 *
 * Usage: node scripts/smoke-stage.mjs <projectDir> <step> <prompt>
 *   e.g. node scripts/smoke-stage.mjs /tmp/clone specify "/speckit-specify Add a cart"
 *
 * It spends real money: it starts a real Claude Code session through the
 * Agent SDK. Use it to check that an SDK upgrade or an option change still
 * gives a working stage, before the change is buried under other work.
 *
 * Reads the COMPILED runner from dist/ (run `npx tsc` first). Prints every
 * trace step as one line, then the cost, the duration and the result subtype.
 * The full trace lands in the usual log tree: ~/.dex/logs/<project>/<runId>/.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [projectArg, step, prompt] = process.argv.slice(2);

if (!projectArg || !step || !prompt) {
  console.error("Usage: smoke-stage.mjs <projectDir> <step> <prompt>");
  process.exit(2);
}
const projectDir = path.resolve(projectArg);
if (!fs.existsSync(projectDir)) {
  console.error(`No such project directory: ${projectDir}`);
  process.exit(2);
}

const dist = (rel) => pathToFileURL(path.join(repoRoot, "dist", "core", rel)).href;
if (!fs.existsSync(path.join(repoRoot, "dist", "core", "agent", "ClaudeAgentRunner.js"))) {
  console.error("dist/ is missing — run `npx tsc` first.");
  process.exit(1);
}
const { ClaudeAgentRunner } = await import(dist("agent/ClaudeAgentRunner.js"));
const { RunLogger } = await import(dist("log.js"));

const runId = crypto.randomUUID();
const agentRunId = crypto.randomUUID();
const rlog = new RunLogger(path.basename(projectDir), runId);
rlog.startAgentRun(1, `smoke:${step}`, agentRunId);

const emit = (ev) => {
  if (ev.type !== "agent_step") return;
  const s = ev.agentStep;
  const what = s.metadata?.toolName ?? s.metadata?.skillName ?? "";
  const text = (s.content ?? "").replace(/\s+/g, " ").slice(0, 120);
  console.log(`  ${String(s.sequenceIndex).padStart(3)} ${s.type.padEnd(14)} ${what} ${text}`);
};

const abortController = new AbortController();
process.on("SIGINT", () => abortController.abort());

const result = await new ClaudeAgentRunner().runStep({
  config: {
    projectDir,
    specDir: "",
    mode: "loop",
    model: process.env.DEX_MODEL ?? "claude-opus-4-6",
    maxIterations: 1,
    maxTurns: 75,
    taskPhases: "all",
    autoClarification: true,
  },
  prompt,
  runId,
  cycleNumber: 1,
  step,
  agentRunId,
  specDir: null,
  abortController,
  emit,
  rlog,
});

console.log(`\nsubtype  : ${result.subtype ?? "(no result frame)"}`);
console.log(`cost     : $${result.cost.toFixed(4)}`);
console.log(`duration : ${(result.durationMs / 1000).toFixed(1)}s`);
console.log(`tokens   : in ${result.inputTokens}, out ${result.outputTokens}`);
console.log(`session  : ${result.sessionId ?? "(none)"}`);
console.log(`logs     : ~/.dex/logs/${path.basename(projectDir)}/${runId}/`);
console.log(`result   : ${result.result.slice(0, 300)}`);
