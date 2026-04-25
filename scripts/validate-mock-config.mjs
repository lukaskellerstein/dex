#!/usr/bin/env node
/**
 * Validate a project's .dex/mock-config.json and .dex/dex-config.json
 * without running the orchestrator. Reports:
 *   - agent selected
 *   - mock-config enabled/disabled
 *   - cycle count + per-cycle feature id + stage keys
 *   - fixture resolvability for every writes[].from
 *
 * Usage: node scripts/validate-mock-config.mjs <projectDir>
 */
import fs from "node:fs";
import path from "node:path";

const projectDir = process.argv[2];
if (!projectDir) {
  console.error("Usage: node scripts/validate-mock-config.mjs <projectDir>");
  process.exit(2);
}

const dexCfgPath = path.join(projectDir, ".dex", "dex-config.json");
const mockCfgPath = path.join(projectDir, ".dex", "mock-config.json");

if (!fs.existsSync(dexCfgPath)) {
  console.log(`dex-config.json: (absent → defaults to agent="claude")`);
} else {
  try {
    const cfg = JSON.parse(fs.readFileSync(dexCfgPath, "utf8"));
    console.log(`dex-config.json: agent="${cfg.agent}"`);
  } catch (err) {
    console.error(`dex-config.json: PARSE ERROR — ${err.message}`);
    process.exit(1);
  }
}

if (!fs.existsSync(mockCfgPath)) {
  console.log(`mock-config.json: (absent)`);
  process.exit(0);
}

let mockCfg;
try {
  mockCfg = JSON.parse(fs.readFileSync(mockCfgPath, "utf8"));
} catch (err) {
  console.error(`mock-config.json: PARSE ERROR — ${err.message}`);
  process.exit(1);
}

console.log(`mock-config.json:`);
console.log(`  enabled:    ${mockCfg.enabled}`);
console.log(`  fixtureDir: ${mockCfg.fixtureDir ?? "(not set — MockAgentRunner will refuse to start)"}`);

const fixtureDir = mockCfg.fixtureDir
  ? (path.isAbsolute(mockCfg.fixtureDir) ? mockCfg.fixtureDir : path.resolve(projectDir, mockCfg.fixtureDir))
  : null;

let missingCount = 0;
function checkWrites(where, writes) {
  if (!Array.isArray(writes)) return;
  for (const w of writes) {
    if (w.from && fixtureDir) {
      const src = path.resolve(fixtureDir, w.from);
      if (!fs.existsSync(src)) {
        console.log(`  ✗ ${where} → ${w.from} NOT FOUND (${src})`);
        missingCount++;
      }
    }
  }
}

for (const phaseKey of ["prerequisites", "clarification", "completion"]) {
  const entry = mockCfg[phaseKey];
  if (!entry) continue;
  for (const [stageName, desc] of Object.entries(entry)) {
    checkWrites(`${phaseKey}.${stageName}`, desc.writes);
  }
}

if (mockCfg.dex_loop && Array.isArray(mockCfg.dex_loop.cycles)) {
  console.log(`  cycles:     ${mockCfg.dex_loop.cycles.length}`);
  mockCfg.dex_loop.cycles.forEach((cycle, idx) => {
    const stages = cycle.stages ?? {};
    console.log(`    [${idx + 1}] ${cycle.feature?.id ?? "?"} "${cycle.feature?.title ?? "?"}" — ${Object.keys(stages).join(", ")}`);
    for (const [stageName, desc] of Object.entries(stages)) {
      checkWrites(`dex_loop.cycles[${idx}].stages.${stageName}`, desc.writes);
    }
  });
}

if (missingCount === 0) {
  console.log(`  ✓ all fixture 'from' paths resolve`);
} else {
  console.log(`  ✗ ${missingCount} fixture(s) missing — mock will throw MockFixtureMissingError at runtime`);
  process.exit(1);
}
