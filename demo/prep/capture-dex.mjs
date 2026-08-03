#!/usr/bin/env node
/**
 * Project-local Electron capture for the Dex demo video.
 *
 * The plugin's scripts/capture-electron.mjs cannot be used here. Playwright starts
 * `recordVideo` at launch and offers no way to defer it, and Dex always boots to the
 * welcome screen — there is no CLI flag or session restore that opens a project
 * directly. Sections 02-05 all need a project (and sometimes a finished run) already
 * on screen, so under the plugin script every one of those clips would open with
 * several seconds of welcome-screen navigation. reconcile.mjs only ever trims the
 * TAIL of a clip, so that head cannot be removed later either.
 *
 * This script splits each section's driving into two phases:
 *   setupActions — gets the app into the starting state, recorded but trimmed away
 *   actions      — the content that survives into demo/capture/<id>.mp4
 * plus `prepareCommands`, shell steps run before the app launches (headless mock run,
 * conflict staging) so slow state is built without burning screen time.
 *
 * usage:
 *   node demo/prep/capture-dex.mjs --dry                 rehearse, record nothing
 *   node demo/prep/capture-dex.mjs                       record every electron section
 *   node demo/prep/capture-dex.mjs --section 04-rewind   one section (repeatable)
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const demoDir = join(repoRoot, "demo");
const captureDir = join(demoDir, "capture");
const overlayPath = resolve(
  repoRoot,
  "..",
  "claude-my-marketplace",
  "plugins",
  "demo-video-plugin",
  "assets",
  "cursor-overlay.js",
);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry");
const onlySections = args.flatMap((a, i) =>
  a === "--section" && args[i + 1] ? [args[i + 1]] : [],
);

// The first recorded frame should be a settled one, so trim slightly past the moment
// setup finished rather than exactly on it.
const TRIM_MARGIN_SECONDS = 0.35;

// ── Playwright ─────────────────────────────────────────────────────────────────
async function loadElectron() {
  const candidates = [
    join(repoRoot, "node_modules", "playwright"),
    join(process.env.HOME || "", ".cache", "demo-video-plugin", "node_modules", "playwright"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const require = createRequire(join(dir, "package.json"));
    const mod = await import(`file://${require.resolve(".")}`);
    const electron = mod._electron ?? mod.default?._electron;
    if (electron) return electron;
  }
  throw new Error(
    "Playwright is not importable. Install it once for the plugin:\n" +
      '  npm install --prefix "$HOME/.cache/demo-video-plugin" playwright',
  );
}

// ── Storyboard ─────────────────────────────────────────────────────────────────
const storyboardPath = join(demoDir, "storyboard.json");
if (!existsSync(storyboardPath)) {
  console.error(`demo-video: no storyboard at ${storyboardPath}.`);
  process.exit(1);
}
const sb = JSON.parse(readFileSync(storyboardPath, "utf8"));
const meta = sb.meta ?? {};
const fps = meta.fps || 30;
const [vw, vh] = String(meta.captureSize || "1600x900")
  .split("x")
  .map(Number);
const electronCfg = meta.electron ?? {};

const sections = (sb.sections ?? [])
  .filter((s) => s.surface === "electron")
  .filter((s) => !onlySections.length || onlySections.includes(s.id));

if (!sections.length) {
  console.log("demo-video: no electron-surface sections selected.");
  process.exit(0);
}

mkdirSync(captureDir, { recursive: true });

// ── Human-feeling interaction primitives ───────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ease the pointer over several steps so the cursor overlay animates a real move. */
const glideTo = (page, x, y) => page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 8) });

async function centerOf(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box (hidden or detached)");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// ── Target resolution ──────────────────────────────────────────────────────────
// Storyboard targets are human descriptions. Most resolve through the accessible
// ladder below, but some of this UI has no accessible name at all (the clarification
// toggle is an unlabelled <button>) and the Timeline is an SVG canvas whose nodes are
// keyed by commit sha — unknowable when the storyboard is written. So a target may
// end with one explicit hint, which then wins outright:
//   (data-testid foo)      exact testid, for elements the app already labels
//   (timeline-label ...)   pick a timeline dot by the label rendered beside it
//   (css=… / xpath=…)      raw Playwright selector
// The selector hints must come last in the string: their values contain parentheses.
const TESTID_HINT = /\(?\bdata-testid[=:\s]+([A-Za-z0-9_-]+)\)?/;
const TIMELINE_LABEL_HINT = /\(timeline-label\s+(.+)\)$/;
const SELECTOR_HINT = /\((css|xpath)=(.+)\)$/;
const QUOTED = /['"]([^'"]{2,})['"]/;
const NOISE_SUFFIX = /\s+(button|box|field|input|link|menu|tab|toggle|icon)$/i;

/**
 * Timeline dots carry `timeline-node-<shortSha>` while the readable label
 * ("83266dd  plan · cycle 1") lives in a sibling <text> with pointer events off.
 * The sha is the first token of that label, which is exactly the testid suffix — so
 * one DOM read turns a human label into a stable locator.
 */
async function timelineNodeTestid(page, label) {
  const sha = await page.evaluate((wanted) => {
    const texts = [...document.querySelectorAll('[data-testid="timeline-graph"] svg text')];
    for (const t of texts) {
      const content = (t.textContent || "").replace(/\s+/g, " ").trim();
      if (!content.includes(wanted)) continue;
      const first = content.split(" ")[0];
      if (/^[0-9a-f]{7,40}$/.test(first)) return first;
    }
    return null;
  }, label.replace(/\s+/g, " ").trim());
  if (!sha) throw new Error(`no timeline node labelled "${label}"`);
  return `timeline-node-${sha}`;
}

function accessibleCandidates(page, phrase) {
  const t = phrase.replace(NOISE_SUFFIX, "").trim();
  return [
    page.getByRole("button", { name: t, exact: false }),
    page.getByRole("link", { name: t, exact: false }),
    page.getByRole("textbox", { name: t, exact: false }),
    page.getByLabel(t, { exact: false }),
    page.getByPlaceholder(t, { exact: false }),
    page.getByTestId(t),
    page.getByText(t, { exact: false }).first(),
  ];
}

/**
 * Candidate locators for one target, most specific first. Prose targets are also
 * tried with trailing words dropped ("Pause button in the topbar" -> "Pause"), but
 * never below two words: shorter fragments match half the UI by accident.
 */
async function candidatesFor(page, target) {
  const testid = target.match(TESTID_HINT);
  if (testid) return [page.getByTestId(testid[1])];

  const timelineLabel = target.match(TIMELINE_LABEL_HINT);
  if (timelineLabel) return [page.getByTestId(await timelineNodeTestid(page, timelineLabel[1]))];

  const selector = target.match(SELECTOR_HINT);
  if (selector) return [page.locator(`${selector[1]}=${selector[2]}`).first()];

  const out = [];
  const quoted = target.match(QUOTED);
  if (quoted) out.push(...accessibleCandidates(page, quoted[1]));

  const words = target.split(/\s+/);
  for (let n = words.length; n >= Math.min(2, words.length); n--) {
    out.push(...accessibleCandidates(page, words.slice(0, n).join(" ")));
  }
  return out;
}

async function firstVisible(page, target, timeoutSeconds = 6) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError = null;
  do {
    let candidates;
    try {
      candidates = await candidatesFor(page, target);
    } catch (err) {
      lastError = err;
      await sleep(200);
      continue;
    }
    for (const c of candidates) {
      try {
        if (await c.isVisible({ timeout: 200 })) return c;
      } catch {
        /* next candidate */
      }
    }
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error(`could not find "${target}"${lastError ? ` (${lastError.message})` : ""}`);
}

/** Click a native application menu item by label path, e.g. "File>New Window". */
async function clickNativeMenu(app, path) {
  const labels = path.split(">").map((s) => s.trim());
  const ok = await app.evaluate(async ({ Menu }, wanted) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    let items = menu.items;
    let item = null;
    for (const label of wanted) {
      item = items.find(
        (i) => (i.label || "").replace(/&/g, "").toLowerCase() === label.toLowerCase(),
      );
      if (!item) return false;
      items = item.submenu ? item.submenu.items : [];
    }
    if (!item) return false;
    item.click();
    return true;
  }, labels);
  if (!ok) throw new Error(`native menu item "${path}" not found`);
}

async function pointAt(ctx, target) {
  const el = await firstVisible(ctx.page, target);
  const { x, y } = await centerOf(el);
  await glideTo(ctx.page, x, y);
  return { el, x, y };
}

async function runAction(ctx, action) {
  const { app } = ctx;
  if (action.dwellBefore) await sleep(action.dwellBefore * 1000);
  const page = ctx.page;

  switch (action.kind) {
    case "goto":
      await page.goto(action.path);
      break;

    case "click":
    case "dblclick": {
      const { x, y } = await pointAt(ctx, action.target);
      await sleep(280); // let the pointer settle so the click reads as intentional
      const opts = action.button ? { button: action.button } : {};
      if (action.kind === "dblclick") await page.mouse.dblclick(x, y, opts);
      else await page.mouse.click(x, y, opts);
      break;
    }

    case "hover":
      await pointAt(ctx, action.target);
      break;

    case "type": {
      const { el, x, y } = await pointAt(ctx, action.target);
      await page.mouse.click(x, y);
      // Clear first. Dex's welcome screen preloads its inputs from
      // ~/.dex/app-config.json, so appending produced a spliced path
      // ("~/Projects/Temp" + the typed one) that still looked plausible on
      // screen and silently created a junk project directory.
      await el.fill("").catch(() => {});
      const cps = action.wps ?? 6; // 5-7 chars/sec reads as brisk but human
      await el.pressSequentially(action.text, { delay: 1000 / cps });
      // Same failure mode, caught rather than recorded: a field that did not end
      // up holding exactly what was typed means the next action acts on the
      // wrong state. Elements with no value (contenteditable, spans) are exempt.
      const value = await el.inputValue().catch(() => action.text);
      if (value !== action.text) {
        throw new Error(`field holds "${value}" after typing "${action.text}"`);
      }
      break;
    }

    case "press":
    case "shortcut":
      await page.keyboard.press(action.key ?? action.to);
      break;

    case "scroll": {
      // Several small wheel events, not one jump: the motion is the point.
      const total = action.by ?? 400;
      const steps = Math.max(4, Math.min(20, Math.round(Math.abs(total) / 60)));
      if (action.target) await pointAt(ctx, action.target);
      for (let i = 0; i < steps; i++) {
        await page.mouse.wheel(0, total / steps);
        await sleep(1000 / 45);
      }
      break;
    }

    case "drag": {
      const from = await pointAt(ctx, action.target);
      await page.mouse.down();
      if (action.to) await pointAt(ctx, action.to);
      else await glideTo(page, from.x + (action.byX ?? 0), from.y + (action.byY ?? 0));
      await page.mouse.up();
      break;
    }

    case "waitFor": {
      // Soft on purpose: several storyboard waits name a state ("loop start panel
      // showing the auto-detected GOAL.md") that has no single element. Failing the
      // section on those would be noise, and burning the budget is the same pacing
      // the storyboard asked for either way. Unresolved waits are reported instead.
      const budget = action.idleUpTo ?? 5;
      if (!action.target) {
        await sleep(budget * 1000);
        break;
      }
      try {
        await firstVisible(page, action.target, budget);
      } catch {
        ctx.unresolved.push(`waitFor "${action.target}" (${budget}s elapsed)`);
      }
      break;
    }

    case "dwell":
      await sleep((action.seconds ?? 1) * 1000);
      break;

    case "select": {
      const el = await firstVisible(page, action.target);
      await el.selectOption(action.to ?? action.text);
      break;
    }

    case "upload": {
      const el = await firstVisible(page, action.target);
      await el.setInputFiles(resolve(repoRoot, action.path ?? action.text));
      break;
    }

    case "menu":
      await clickNativeMenu(app, action.to ?? action.target);
      break;

    case "window": {
      const windows = app.windows();
      const idx = Number(action.to ?? 1);
      ctx.page = windows[idx] ?? (await app.waitForEvent("window", { timeout: 5000 }));
      await ctx.page.bringToFront?.();
      break;
    }

    case "eval":
      await page.evaluate(action.text);
      break;

    default:
      throw new Error(`unsupported action kind "${action.kind}"`);
  }

  await sleep((action.dwellAfter ?? 0.5) * 1000); // settle so the next cut is clean
}

// ── Shell prep ─────────────────────────────────────────────────────────────────
function runShell(command, label) {
  const started = Date.now();
  try {
    execFileSync("bash", ["-c", command], { cwd: repoRoot, stdio: "inherit" });
  } catch (err) {
    throw new Error(`${label} failed (exit ${err.status ?? "?"}): ${command}`);
  }
  return (Date.now() - started) / 1000;
}

// ── ffmpeg ─────────────────────────────────────────────────────────────────────
function probe(file, entries, stream = false) {
  const argv = stream
    ? [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        `stream=${entries}`,
        "-of",
        "csv=p=0:s=x",
        file,
      ]
    : ["-v", "error", "-show_entries", `format=${entries}`, "-of", "csv=p=0", file];
  return execFileSync("ffprobe", argv, { encoding: "utf8" }).trim();
}

function trimAndTranscode(src, out, offsetSeconds) {
  const tmp = `${out}.part`;
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      // -ss before -i seeks by demuxing rather than decoding the discarded head,
      // which matters because that head can be half a minute of setup (03-pause).
      "-ss",
      offsetSeconds.toFixed(3),
      "-i",
      src,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-r",
      String(fps),
      "-fps_mode",
      "cfr",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-movflags",
      "+faststart",
      "-an",
      "-f",
      "mp4",
      tmp,
    ],
    { stdio: "inherit" },
  );
  renameSync(tmp, out);
}

// ── Capture one section ────────────────────────────────────────────────────────
const _electron = await loadElectron();
const overlay = readFileSync(overlayPath, "utf8");
const results = [];

for (const section of sections) {
  const result = {
    id: section.id,
    ok: false,
    targetSeconds: section.targetSeconds,
    prepareSeconds: 0,
    setupSeconds: 0,
    contentSeconds: 0,
    trimOffsetSeconds: null,
    clip: null,
    durationSeconds: null,
    unresolved: [],
    error: null,
  };
  results.push(result);
  console.error(`\n── ${section.id} ─────────────────────────────────────────────`);

  const tmpDir = join(captureDir, `.tmp-${section.id}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  let app = null;
  let videoStartedAt = 0;
  let setupEndedAt = 0;
  let closedAt = 0;

  try {
    if (section.resetBefore) {
      result.prepareSeconds += runShell("bash demo/prep/reset.sh", "resetBefore");
    }
    for (const command of section.prepareCommands ?? []) {
      result.prepareSeconds += runShell(command, "prepareCommand");
    }

    app = await _electron.launch({
      args: electronCfg.args ?? ["dist/main/index.js"],
      cwd: electronCfg.cwd ? resolve(repoRoot, electronCfg.cwd) : repoRoot,
      env: { ...process.env, ...(electronCfg.env ?? {}), DEMO_CAPTURE: "1" },
      ...(electronCfg.executablePath ? { executablePath: electronCfg.executablePath } : {}),
      ...(dryRun ? {} : { recordVideo: { dir: tmpDir, size: { width: vw, height: vh } } }),
    });

    const page = await app.firstWindow();
    videoStartedAt = Date.now();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.setViewportSize({ width: vw, height: vh }).catch(() => {});

    // The styled cursor: addInitScript covers later navigations, the direct evaluate
    // covers the window that is already open.
    await page.addInitScript({ content: overlay }).catch(() => {});
    await page.evaluate(overlay).catch(() => {});
    if (electronCfg.freezeClock) {
      await page
        .evaluate((iso) => window.__demoFreezeClock?.(iso), electronCfg.freezeClock)
        .catch(() => {});
    }

    const ctx = { app, page, unresolved: result.unresolved };
    await sleep(700); // settle before the first action so nothing runs mid-paint

    const drive = async (list, phase) => {
      for (const [i, action] of (list ?? []).entries()) {
        try {
          await runAction(ctx, action);
        } catch (err) {
          throw new Error(
            `${phase}[${i}] ${action.kind}${action.target ? ` "${action.target}"` : ""}: ${err.message}`,
          );
        }
      }
    };

    const setupStartedAt = Date.now();
    await drive(section.setupActions, "setupActions");
    setupEndedAt = Date.now();
    result.setupSeconds = Number(((setupEndedAt - setupStartedAt) / 1000).toFixed(2));

    await drive(section.actions, "actions");
    await sleep(600); // hold the final state so the editor has a clean frame to cut on
    result.contentSeconds = Number(((Date.now() - setupEndedAt) / 1000).toFixed(2));
  } catch (err) {
    result.error = err.message;
    console.error(`   ✗ ${err.message}`);
  } finally {
    try {
      await app?.close(); // closing is what flushes the video to disk
    } catch {
      /* already gone */
    }
    closedAt = Date.now(); // after close: the recording runs right up to it
  }

  if (dryRun) {
    result.ok = !result.error;
    // No file to measure against, so the offset is pure wall clock.
    result.trimOffsetSeconds = setupEndedAt
      ? Number(((setupEndedAt - videoStartedAt) / 1000 + TRIM_MARGIN_SECONDS).toFixed(2))
      : null;
    rmSync(tmpDir, { recursive: true, force: true });
    console.error(
      `   prepare ${result.prepareSeconds.toFixed(1)}s · setup ${result.setupSeconds}s · ` +
        `content ${result.contentSeconds}s · trim ${result.trimOffsetSeconds}s (target ${section.targetSeconds}s)`,
    );
    continue;
  }

  // A section that threw part-way through recorded the wrong thing. Transcoding it
  // would leave a plausible-looking clip and sidecar for the reconciler to pick up.
  if (result.error) {
    rmSync(tmpDir, { recursive: true, force: true });
    continue;
  }

  const produced = existsSync(tmpDir) ? readdirSync(tmpDir).filter((n) => n.endsWith(".webm")) : [];
  if (!produced.length || statSync(join(tmpDir, produced[0])).size < 4096) {
    result.error = (result.error ? `${result.error}; ` : "") + "no usable WebM was produced";
    rmSync(tmpDir, { recursive: true, force: true });
    continue;
  }

  const raw = join(tmpDir, produced[0]);
  const rawDuration = Number(probe(raw, "duration"));

  // Anchor the trim to the file rather than to wall clock. The recording spans
  // roughly [page created, app closed], so `rawDuration - (close - setupEnd)` is the
  // head length, self-correcting for however long Playwright took to start writing
  // frames. Wall clock is the fallback when the WebM has no usable duration.
  const wallClockOffset = (setupEndedAt - videoStartedAt) / 1000;
  const durationOffset = rawDuration - (closedAt - setupEndedAt) / 1000;
  const offset =
    Number.isFinite(durationOffset) && durationOffset > 0 ? durationOffset : wallClockOffset;
  result.trimOffsetSeconds = Number(Math.max(0, offset + TRIM_MARGIN_SECONDS).toFixed(3));

  const out = join(captureDir, `${section.id}.mp4`);
  try {
    trimAndTranscode(raw, out, result.trimOffsetSeconds);
  } catch (err) {
    result.error = (result.error ? `${result.error}; ` : "") + `transcode failed: ${err.message}`;
    rmSync(tmpDir, { recursive: true, force: true });
    continue;
  }
  rmSync(tmpDir, { recursive: true, force: true });

  const duration = Number(probe(out, "duration"));
  const [width, height] = probe(out, "width,height", true).split("x").map(Number);
  if (!Number.isFinite(duration) || duration <= 0) {
    result.error =
      (result.error ? `${result.error}; ` : "") + "ffprobe found no duration on the final mp4";
    continue;
  }

  result.clip = `capture/${section.id}.mp4`;
  result.durationSeconds = Number(duration.toFixed(3));
  result.ok = !result.error;
  writeFileSync(
    join(captureDir, `${section.id}.json`),
    `${JSON.stringify(
      {
        id: section.id,
        file: result.clip,
        durationSeconds: result.durationSeconds,
        width,
        height,
        fps,
      },
      null,
      2,
    )}\n`,
  );

  console.error(
    `   raw ${rawDuration.toFixed(2)}s · setup ${result.setupSeconds}s · content ${result.contentSeconds}s · ` +
      `trim ${result.trimOffsetSeconds}s (wall clock said ${wallClockOffset.toFixed(2)}s) → ` +
      `${result.durationSeconds}s (target ${section.targetSeconds}s)`,
  );
}

// ── Report ─────────────────────────────────────────────────────────────────────
console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "record", results }, null, 2));

for (const r of results.filter((x) => x.unresolved.length)) {
  console.error(`\ndemo-video: ${r.id} had unresolved waits (they burned their full budget):`);
  for (const u of r.unresolved) console.error(`  ${u}`);
}

const failures = results.filter((r) => !r.ok);
if (failures.length) {
  console.error(
    `\ndemo-video: ${failures.length}/${results.length} section(s) failed. ` +
      "Fix the actions or the app state and re-run with --dry until every section passes.",
  );
  process.exit(1);
}
