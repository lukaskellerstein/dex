#!/usr/bin/env node
/**
 * Re-time the captions in demo/timeline.json against the narration audio.
 *
 * reconcile.mjs distributes caption chunks across a section by word count, which
 * assumes the narrator speaks at a constant rate and never pauses. Gemini TTS does
 * neither. In section 02 it puts a beat between each item of "Specify, plan, tasks,
 * implement, verify" — five words over five seconds — so the constant-rate split
 * handed that line three seconds and every caption after it ran up to 3.5s ahead of
 * the voice.
 *
 * The proper fix is forced alignment, which the plugin's align-captions.sh does via
 * ElevenLabs. This machine's API key is missing the `forced_alignment` permission
 * (HTTP 401), and there is no local ASR, so timings are recovered from the audio
 * instead: silence tells you where the pauses are, and pauses are the entire error.
 *
 * Two levels:
 *   1. Sentences are separated by the longest pauses, so the (S-1) widest gaps
 *      between speech runs are taken as the sentence boundaries. Sentence starts
 *      then land on the frame the voice actually starts them.
 *   2. Inside a sentence, chunks are spread across that sentence's speech runs by
 *      character weight — uniform rate *within speech*, with pause time excluded
 *      rather than charged to the words around it.
 *
 * Only start times move. Each caption still runs until the next one begins, so the
 * screen is never briefly empty between chunks.
 *
 * Run after every reconcile.mjs — reconcile rewrites timeline.json from scratch and
 * will put the constant-rate timings back.
 *
 * usage: node demo/prep/align-captions.mjs [section-id …]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(here, "..");
const timelinePath = join(demoDir, "timeline.json");
const storyboardPath = join(demoDir, "storyboard.json");

// Narration is loudness-normalised to -16 LUFS on the way in (import-narration.mjs),
// so -35dB sits well under speech and above the encoder's noise floor. 0.20s is short
// enough to catch a beat between list items, long enough to ignore stop consonants.
const SILENCE_DB = -35;
const MIN_SILENCE = 0.2;

// A sentence whose share of speech time is this far from its share of characters means
// the gap-picking guessed the sentence boundaries wrong. Fall back rather than ship
// captions that are confidently misaligned.
const SHARE_TOLERANCE = 2.5;

const onlyIds = process.argv.slice(2);

for (const p of [timelinePath, storyboardPath]) {
  if (!existsSync(p)) {
    console.error(`demo-video: no ${p}. Run reconcile.mjs first.`);
    process.exit(1);
  }
}

const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
const storyboard = JSON.parse(readFileSync(storyboardPath, "utf8"));
const fps = timeline.fps || 30;
const voiceovers = new Map(
  (storyboard.sections ?? []).map((s) => [s.id, String(s.voiceover || "").trim()]),
);

const norm = (s) => s.replace(/\s+/g, " ").trim();
const weigh = (s) => norm(s).replace(/\s/g, "").length || 1;

// ── Where the voice actually is ────────────────────────────────────────────────
function speechRuns(audioPath) {
  const duration = Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", audioPath],
      { encoding: "utf8" },
    ).trim(),
  );

  // silencedetect reports on stderr, so this needs spawnSync — execFileSync hands back
  // stdout, which for `-f null -` is empty.
  const probe = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      audioPath,
      "-af",
      `silencedetect=noise=${SILENCE_DB}dB:d=${MIN_SILENCE}`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0)
    throw new Error(`ffmpeg silencedetect failed: ${probe.stderr?.slice(-200)}`);
  const log = probe.stderr;

  const silences = [];
  for (const line of log.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    const end = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (start) silences.push({ start: Math.max(0, Number(start[1])), end: duration });
    else if (end && silences.length) silences[silences.length - 1].end = Number(end[1]);
  }

  const runs = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) runs.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) runs.push({ start: cursor, end: duration });

  return { duration, runs: runs.filter((r) => r.end - r.start > 0.01) };
}

/** Convert an offset measured in speech-only time into wall-clock time. */
function speechTimeToWallClock(runs, offset) {
  let remaining = offset;
  for (const run of runs) {
    const span = run.end - run.start;
    if (remaining <= span) return run.start + Math.max(0, remaining);
    remaining -= span;
  }
  return runs[runs.length - 1].end;
}

// ── Chunks back onto the sentences they came from ──────────────────────────────
/** reconcile.mjs never lets a chunk straddle a sentence, so this mapping is exact. */
function groupChunksBySentence(captions, voiceover) {
  const sentences = voiceover
    .split(/(?<=[.!?])\s+/)
    .map(norm)
    .filter(Boolean);
  const groups = [];
  let i = 0;
  for (const sentence of sentences) {
    const taken = [];
    let built = "";
    while (i < captions.length && norm(built) !== sentence) {
      built = `${built} ${captions[i].text}`;
      taken.push(captions[i]);
      i += 1;
    }
    if (norm(built) !== sentence) {
      throw new Error(`caption chunks do not reassemble sentence "${sentence.slice(0, 40)}…"`);
    }
    groups.push(taken);
  }
  if (i !== captions.length) throw new Error("caption chunks left over after the last sentence");
  return groups;
}

const span = (runs) => runs.reduce((n, r) => n + (r.end - r.start), 0);

/**
 * Split the speech runs between sentences.
 *
 * Widest-gap-wins is not enough on its own: in section 02 the pause inside "That is
 * the Ralph loop's insight: | context is the scarce resource" beat the real sentence
 * break by 17ms, which threw a whole sentence onto the wrong runs. So every legal set
 * of cuts is scored on how well the resulting speech shares match the sentences'
 * character shares, with pause width only as a tie-break. The search space is tiny —
 * a dozen runs across a handful of sentences.
 */
function runsPerSentence(runs, charShares) {
  const sentenceCount = charShares.length;
  if (sentenceCount === 1) return [runs];

  const gaps = runs.slice(0, -1).map((run, i) => runs[i + 1].start - run.end);
  if (gaps.length < sentenceCount - 1) return null;

  const durations = runs.map((r) => r.end - r.start);
  const prefix = [0];
  for (const d of durations) prefix.push(prefix[prefix.length - 1] + d);
  const totalSpeech = prefix[prefix.length - 1];

  const cutsToGroups = (cuts) => {
    const groups = [];
    let from = 0;
    for (const cut of [...cuts, runs.length - 1]) {
      groups.push([from, cut]);
      from = cut + 1;
    }
    return groups;
  };

  const score = (cuts) => {
    let mismatch = 0;
    cutsToGroups(cuts).forEach(([from, to], i) => {
      const speechShare = (prefix[to + 1] - prefix[from]) / totalSpeech;
      mismatch += Math.abs(Math.log(Math.max(speechShare, 1e-6) / charShares[i]));
    });
    // Prefer cutting at a wide pause when two splits fit the proportions equally well.
    return mismatch - 0.15 * cuts.reduce((n, c) => n + gaps[c], 0);
  };

  let best = null;
  const combo = [];
  const walk = (from, depth) => {
    if (depth === sentenceCount - 1) {
      const s = score(combo);
      if (!best || s < best.score) best = { score: s, cuts: [...combo] };
      return;
    }
    for (let i = from; i <= gaps.length - (sentenceCount - 1 - depth); i += 1) {
      combo.push(i);
      walk(i + 1, depth + 1);
      combo.pop();
    }
  };
  walk(0, 0);

  return best ? cutsToGroups(best.cuts).map(([from, to]) => runs.slice(from, to + 1)) : null;
}

// ── Align one section ──────────────────────────────────────────────────────────
function alignSection(section) {
  const captions = section.captions ?? [];
  const audioSrc = section.audio?.src;
  if (!captions.length || !audioSrc) return null;

  const audioPath = join(demoDir, audioSrc);
  if (!existsSync(audioPath)) throw new Error(`missing ${audioSrc}`);

  const voiceover = voiceovers.get(section.id);
  if (!voiceover) throw new Error("no voiceover text in the storyboard");

  const { runs } = speechRuns(audioPath);
  if (!runs.length) throw new Error("no speech detected — check the narration file");

  const sentenceChunks = groupChunksBySentence(captions, voiceover);
  const totalSpeech = span(runs);
  const totalChars = sentenceChunks.reduce(
    (n, g) => n + g.reduce((m, c) => m + weigh(c.text), 0),
    0,
  );
  const charShares = sentenceChunks.map(
    (g) => g.reduce((n, c) => n + weigh(c.text), 0) / totalChars,
  );

  let chunkGroups = sentenceChunks;
  let runGroups = runsPerSentence(runs, charShares);
  let note = "";

  // Even the best split can be wrong if the narrator ran two sentences together, which
  // would shift a whole sentence onto the wrong runs. Rather than ship that, drop to a
  // single group — still pause-aware, just not sentence-anchored.
  const misplaced =
    !runGroups ||
    runGroups.some((group, i) => {
      const ratio = span(group) / totalSpeech / charShares[i];
      return ratio > SHARE_TOLERANCE || ratio < 1 / SHARE_TOLERANCE;
    });

  if (misplaced) {
    chunkGroups = [captions];
    runGroups = [runs];
    note = " (sentence anchoring rejected — spread over all speech)";
  }

  const starts = [];
  chunkGroups.forEach((group, g) => {
    const groupRuns = runGroups[g];
    const groupSpeech = span(groupRuns);
    const groupChars = group.reduce((n, c) => n + weigh(c.text), 0);
    let before = 0;
    for (const chunk of group) {
      starts.push(speechTimeToWallClock(groupRuns, (groupSpeech * before) / groupChars));
      before += weigh(chunk.text);
    }
  });

  const delay = section.audio.delayFrames ?? 0;
  const audioSeconds = section.audio.measuredSeconds ?? 0;
  const before = captions.map((c) => c.startFrame);

  let previous = delay;
  captions.forEach((caption, i) => {
    const startFrame = Math.max(previous, delay + Math.round(starts[i] * fps));
    const nextStart = i + 1 < starts.length ? starts[i + 1] : audioSeconds;
    caption.startFrame = startFrame;
    caption.endFrame = Math.max(startFrame + 6, delay + Math.round(nextStart * fps));
    previous = startFrame;
  });
  // Contiguous: a caption holds until the next one takes over, so a pause in the
  // narration never blanks the screen.
  captions.forEach((c, i) => {
    if (i + 1 < captions.length) c.endFrame = captions[i + 1].startFrame;
  });

  const shifts = captions.map((c, i) => (c.startFrame - before[i]) / fps);
  return {
    note,
    maxShift: Math.max(...shifts.map(Math.abs)),
    shifts,
  };
}

// ── Run ────────────────────────────────────────────────────────────────────────
let aligned = 0;
let worst = 0;
for (const section of timeline.sections ?? []) {
  if (onlyIds.length && !onlyIds.includes(section.id)) continue;
  let result;
  try {
    result = alignSection(section);
  } catch (err) {
    console.error(`  FAIL ${section.id} — ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  if (!result) continue;
  aligned += 1;
  worst = Math.max(worst, result.maxShift);
  const moved = result.shifts.map((s) => `${s >= 0 ? "+" : ""}${s.toFixed(2)}`).join(" ");
  console.log(
    `  ${section.id.padEnd(12)} ${result.shifts.length} captions, max ${result.maxShift.toFixed(2)}s${result.note}`,
  );
  console.log(`     shifts: ${moved}`);
}

if (process.exitCode) {
  console.error("demo-video: caption alignment failed — timeline.json left unchanged.");
  process.exit(1);
}

writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
console.log(
  `demo-video: re-timed captions in ${aligned} section(s), largest correction ${worst.toFixed(2)}s -> demo/timeline.json`,
);
