#!/usr/bin/env node
/**
 * Insert a section into the storyboard and renumber everything after it,
 * renaming the media that belongs to the moved sections.
 *
 * Section ids are the join key for the whole pipeline — clip, clip measurement,
 * narration, narration measurement, timeline entry and every review finding all
 * key off `NN-slug`. Renumbering by hand orphans media silently: reconcile just
 * reports "no clip found" for the new name while the old file sits there
 * unreferenced. Hence a script, and hence the dry-run default.
 *
 * usage:
 *   node demo/prep/insert-section.mjs --after 02-loop --id 03-how [--apply]
 *   node demo/prep/insert-section.mjs --first --id 01-intro [--apply]
 *
 * Without --apply it prints the plan and changes nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const afterId = argOf("--after");
const newId = argOf("--id");
const first = args.includes("--first");
const apply = args.includes("--apply");

if ((!afterId && !first) || (afterId && first) || !newId) {
  console.error("usage: insert-section.mjs (--after <id> | --first) --id <newId> [--apply]");
  process.exit(2);
}
if (!/^\d{2}-[a-z0-9][a-z0-9-]*$/.test(newId)) {
  console.error(`--id "${newId}" must look like 03-how`);
  process.exit(2);
}

const storyboardPath = path.join(demoDir, "storyboard.json");
const storyboard = JSON.parse(fs.readFileSync(storyboardPath, "utf8"));

let insertAt = 0;
if (!first) {
  const afterIdx = storyboard.sections.findIndex((s) => s.id === afterId);
  if (afterIdx === -1) {
    console.error(`no section "${afterId}" in storyboard.json`);
    process.exit(1);
  }
  insertAt = afterIdx + 1;
}
const targetOrdinal = Number(newId.slice(0, 2));
if (targetOrdinal !== insertAt + 1) {
  console.error(
    `--id "${newId}" has ordinal ${targetOrdinal} but inserting ${first ? "first" : `after "${afterId}"`} ` +
      `puts it at position ${insertAt + 1}.`,
  );
  process.exit(1);
}

// Sections at or after the insertion point shift down by one. Build the rename
// map before touching anything so a collision is caught up front.
const renames = [];
for (let i = insertAt; i < storyboard.sections.length; i++) {
  const s = storyboard.sections[i];
  const slug = s.id.slice(3);
  const to = `${String(i + 2).padStart(2, "0")}-${slug}`;
  renames.push({ from: s.id, to });
}

// Rename back-to-front so 03→04 does not clobber the existing 04.
const ordered = [...renames].reverse();

const mediaMoves = [];
for (const { from, to } of ordered) {
  for (const [dir, exts] of [
    ["capture", [".mp4", ".json"]],
    ["audio", [".mp3", ".json", ".align.json"]],
  ]) {
    for (const ext of exts) {
      const src = path.join(demoDir, dir, `${from}${ext}`);
      if (fs.existsSync(src)) {
        mediaMoves.push({ src, dest: path.join(demoDir, dir, `${to}${ext}`), dir, ext });
      }
    }
  }
}

console.log(
  `insert "${newId}" ${first ? "first" : `after "${afterId}"`} (position ${insertAt + 1})\n`,
);
console.log("section renumbering:");
for (const { from, to } of renames) console.log(`  ${from} -> ${to}`);
console.log("\nmedia renames:");
for (const m of mediaMoves)
  console.log(`  ${path.relative(demoDir, m.src)} -> ${path.basename(m.dest)}`);
if (!mediaMoves.length) console.log("  (none found)");

if (!apply) {
  console.log("\ndry run — pass --apply to write");
  process.exit(0);
}

for (const { src, dest } of mediaMoves) {
  if (fs.existsSync(dest)) {
    console.error(`refusing to overwrite ${dest}`);
    process.exit(1);
  }
  fs.renameSync(src, dest);
}

// Sidecars embed their own id and relative path; leaving them stale would make
// reconcile trust the wrong duration for the wrong section.
for (const { dest, dir, ext } of mediaMoves) {
  if (!ext.endsWith(".json")) continue;
  const sidecar = JSON.parse(fs.readFileSync(dest, "utf8"));
  const id = path.basename(dest).replace(/\.(align\.)?json$/, "");
  sidecar.id = id;
  if (sidecar.file) sidecar.file = `${dir}/${id}${dir === "capture" ? ".mp4" : ".mp3"}`;
  fs.writeFileSync(dest, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

const renameMap = new Map(renames.map((r) => [r.from, r.to]));
for (const s of storyboard.sections) {
  if (renameMap.has(s.id)) s.id = renameMap.get(s.id);
}

storyboard.sections.splice(insertAt, 0, {
  id: newId,
  beat: "proof",
  title: "PLACEHOLDER — fill in",
  surface: "code",
  targetSeconds: 15,
  voiceover: "PLACEHOLDER",
  code: { file: "PLACEHOLDER", content: "PLACEHOLDER" },
  successCriteria: "PLACEHOLDER",
});

fs.writeFileSync(storyboardPath, `${JSON.stringify(storyboard, null, 2)}\n`, "utf8");
console.log(
  `\napplied. "${newId}" inserted as a placeholder — fill in its fields, then reconcile.`,
);
