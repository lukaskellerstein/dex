#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
/**
 * Import generated narration into the pipeline's naming and write the
 * measurement sidecars reconcile.mjs reads.
 *
 * The bundled probe-audio hook only fires for the demo-elevenlabs MCP server.
 * This project's ElevenLabs key is missing the `voices_read` scope, so that
 * server cannot synthesise at all and narration comes from Gemini TTS instead —
 * which writes timestamped .wav files outside the project. This converts them to
 * demo/audio/<id>.mp3 and measures the RESULT, never the planned duration.
 *
 * usage: node demo/prep/import-narration.mjs <id>=<wavPath> [...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// -16 LUFS with 1.5 dB of true-peak headroom: the quieter end of the web-video
// range, which suits a lone speaking voice with no music bed under it.
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = path.join(demoDir, "audio");
const storyboard = JSON.parse(fs.readFileSync(path.join(demoDir, "storyboard.json"), "utf8"));

const pairs = process.argv.slice(2).map((a) => {
  const eq = a.indexOf("=");
  if (eq === -1) {
    console.error(`bad argument "${a}" — expected <id>=<wavPath>`);
    process.exit(2);
  }
  return { id: a.slice(0, eq), src: a.slice(eq + 1) };
});
if (!pairs.length) {
  console.error("usage: import-narration.mjs <id>=<wavPath> [...]");
  process.exit(2);
}

fs.mkdirSync(audioDir, { recursive: true });

const probe = (file) =>
  Number(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      { encoding: "utf8" },
    ).trim(),
  );

let warnings = 0;
const rows = [];

for (const { id, src } of pairs) {
  const section = storyboard.sections.find((s) => s.id === id);
  if (!section) {
    console.error(`no section "${id}" in storyboard.json`);
    process.exit(1);
  }
  if (!fs.existsSync(src)) {
    console.error(`missing source audio for ${id}: ${src}`);
    process.exit(1);
  }

  const dest = path.join(audioDir, `${id}.mp3`);
  // Normalise to broadcast loudness on the way in. Raw Gemini TTS lands around
  // -22 LUFS integrated; web video targets -14 (YouTube) to -16, so unnormalised
  // narration plays 6-8 dB under everything else the viewer watches. At laptop
  // volume with any ambient noise that reads as "this video has no voiceover" —
  // which is exactly how it was first reported.
  //
  // Two-pass: measure, then correct with the measured values. Single-pass
  // loudnorm guesses from a lookahead buffer and drifts by a dB or two, which is
  // enough to make sections audibly uneven against each other.
  // loudnorm prints its measurement JSON on stderr, mixed in with ffmpeg's
  // banner and progress lines — hence spawnSync and a match for the trailing
  // object rather than reading stdout.
  const loudnormPass = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", src, "-af", `${LOUDNORM}:print_format=json`, "-f", "null", "-"],
    { encoding: "utf8" },
  );
  const json = loudnormPass.stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!json) {
    console.error(
      `could not read loudnorm measurement for ${id}:\n${loudnormPass.stderr.slice(-500)}`,
    );
    process.exit(1);
  }
  const measured = JSON.parse(json[0]);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    src,
    "-af",
    `${LOUDNORM}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:linear=true`,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    dest,
  ]);

  const durationSeconds = probe(dest);
  fs.writeFileSync(
    path.join(audioDir, `${id}.json`),
    `${JSON.stringify({ id, file: `audio/${id}.mp3`, durationSeconds }, null, 2)}\n`,
    "utf8",
  );

  const target = section.targetSeconds;
  const driftPct = ((durationSeconds - target) / target) * 100;
  const words = String(section.voiceover ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const wps = words / durationSeconds;
  // Over 20% off budget is the point where the reconciler stops being able to
  // hide the difference in playback rate alone.
  const flag = Math.abs(driftPct) > 20 ? "REWRITE" : Math.abs(driftPct) > 10 ? "watch" : "ok";
  if (flag !== "ok") warnings++;
  rows.push({ id, target, measured: durationSeconds, driftPct, wps, flag });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
  `${pad("section", 12)} ${pad("target", 8)} ${pad("measured", 9)} ${pad("drift", 8)} ${pad("w/s", 6)} flag`,
);
for (const r of rows) {
  console.log(
    `${pad(r.id, 12)} ${pad(`${r.target}s`, 8)} ${pad(`${r.measured.toFixed(2)}s`, 9)} ` +
      `${pad(`${r.driftPct >= 0 ? "+" : ""}${r.driftPct.toFixed(0)}%`, 8)} ${pad(r.wps.toFixed(2), 6)} ${r.flag}`,
  );
}

const totalMeasured = rows.reduce((n, r) => n + r.measured, 0);
// Every section costs ~0.85s of lead-in and tail on top of its narration.
const estimatedVideo = totalMeasured + rows.length * 0.85;
console.log(
  `\nnarration total ${totalMeasured.toFixed(1)}s across ${rows.length} sections ` +
    `→ video roughly ${estimatedVideo.toFixed(0)}s (storyboard target ${storyboard.meta.targetSeconds}s)`,
);
if (warnings) console.log(`${warnings} section(s) off budget — see flags above.`);
