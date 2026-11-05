#!/usr/bin/env node
// A fake sensor for the mock (016 contracts/mock-config.md § Fake sensors).
//
//   node .dex/fake/check.mjs <name>
//
// Reads .dex/fake/<name> — one exit code per line — and exits with the first
// line, removing it unless it is the last. A missing or empty file means 0.
// A mock stage switches the sensor for its next runs by writing that file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
if (!name) {
  console.error("usage: check.mjs <name>");
  process.exit(2);
}
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), name);
let codes = [];
try {
  codes = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
} catch {
  codes = [];
}
const code = codes.length > 0 ? Number(codes[0]) : 0;
if (codes.length > 1) fs.writeFileSync(file, `${codes.slice(1).join("\n")}\n`);
console.log(code === 0 ? `${name}: ok` : `${name}: FAIL (fake exit ${code})`);
process.exit(code);
