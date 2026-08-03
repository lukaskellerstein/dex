# Demo brief — Dex

## Audience

Engineers and engineering leads evaluating AI-assisted autonomous development tooling.

The decision they are making while watching: **do I trust an agent to run unsupervised on
my repo, and can I get control back when it goes wrong?** Everything in this demo either
serves that decision or is cut.

They already use supervised chat-based coding (Claude Code, Cursor, aider). They are not
asking "can an AI write code" — that is settled. They are asking what happens over hours,
across many features, when nobody is watching.

## Length

141 seconds as cut. Nine sections: five captured, two code cards, two title cards.

## What the callouts are for

The lower-third must carry what the **voice cannot afford** — an exact number, an identifier,
a source. A callout that restates the line being spoken is wasted screen space and reads as a
duplicated title, because the viewer receives the same sentence twice in two seconds.

The first cut got this wrong in six of eight sections. `07-audit`'s callout was word-for-word
the narration ("every stage is a commit you can grep"); `05`, `06` and `04` were near-verbatim.
Rewritten to:

| Section | Callout | Why it earns the space |
|---|---|---|
| 01-intro | autonomous development you can steer | The card's own tagline, not a callout. See "The bookend cards". |
| 02-problem | *(none)* | The narration is self-sufficient. A clean open. |
| 03-loop | *(none)* | The narration names spec-kit and the Ralph loop; 04 carries their URLs. See "The synthetic backend". |
| 04-how | ghuntley.com/ralph · github.com/github/spec-kit | Sources for the two ideas just named. Attribution the voice would stumble over. |
| 05-pause | Every finished stage is already committed | The narration says stages "stay green"; this says what that *means* on disk. |
| 06-rewind | Fork point: `[checkpoint:plan:1]` | Names the actual commit tag, which is legible in the tooltip on screen. |
| 07-promote | Read + Edit only · 5 iterations · $0.50 cap | The narration says "a fixed iteration and cost ceiling"; this gives the real values from `dex-config.json`. |
| 08-audit | *(none)* | The code card already shows the commands and their output. |
| 09-close | Dex — github.com/lukaskellerstein/dex | Where to go. |

Not every beat needs one. Two sections are better without.

### And how they look

Content was only half the problem. The callout was a 30px semi-bold white pill; the caption is
a 34px bold white pill. Same colour, same weight, same shape, four pixels apart in size — the
viewer received one message twice in two seconds and read it as a duplicated title, whatever
the wording said.

A caption is *speech*. A callout is an *annotation*. They now take different registers:

| | Caption | Callout |
|---|---|---|
| Type | 34px sans, bold | 22px mono, medium |
| Colour | full white | white at 86% |
| Shape | filled pill | outlined, near-transparent, hairline border |
| Accent | none | one 6px accent dot with a soft glow |
| Entrance | rises | slides in from the right |

Monospace is not decoration here — the callouts carry URLs, `[checkpoint:plan:1]` and
`$0.50 cap`, which is exactly the material mono is for, and it echoes the app being
demonstrated. The entrance directions differ deliberately: two overlays rising together at the
same moment merge into one block.

Iterate on this with `npx remotion still src/index.ts Demo out.png --frame=N --public-dir=..`
from `demo/studio` — a single frame renders in seconds, against ~7 minutes for a full pass.

## The bookend cards

`01-intro` and `09-close` are the same component (`studio/src/sections/TitleCard.tsx`) showing
the same mark. That is the point: one logo opening and closing the video is what makes the two
cards read as a pair rather than as two unrelated slides, so the treatment is shared rather
than special-cased per section.

The mark is `demo/brand/logo.png`, copied from `docs/logo/logo.png` — the same file the app
ships as its window icon, so the card and the product cannot drift apart. It lives under
`demo/` because that is the Remotion public dir (`render.sh` passes `--public-dir=..`), and
`staticFile()` cannot reach outside it.

Motion is one overdamped spring (ratio ~1.4, so it eases to rest with no bounce): the mark
fades up while scaling 0.82 → 1 and unwinding −16° → 0°, with a violet bloom behind it that
blooms and settles on the same curve. The wordmark starts 0.38s in and the tagline 0.56s, so
the eye lands on the logo and reads the line second. Overshoot was tried and cut — a bouncing
logo reads as an advert, and this audience distrusts polish.

`theme.color.brand` (`#7C3AED`, Dex's `--primary`) was added for the bloom and the rule under
the title. It is deliberately *not* `theme.color.accent`: the overlay system stays neutral so
it never fights the captured footage, and only the cards carry product colour.

Two things about the intro specifically:

- **It is silent, and that is deliberate.** The first voice in the video is the problem
  statement; a narrated intro delays it. Silence runs ~4.2s (3.5s card plus the lead-in before
  narration starts in `02-problem`). If that reads as broken audio rather than as a beat, the
  fix is a short sting, not narration — `text_to_sound_effects` needs an ElevenLabs key with
  scopes this machine's key does not have.
- **The cut into `02-problem` is hard, not a crossfade.** Not a choice: `reconcile.mjs` cuts
  rather than crossfades whenever the surface changes, and titlecard → electron is a surface
  change. It happens to be the right call — dissolving a logo into a UI muddies both.

## Capture resolution

Capture is 1:1 with the output and must stay that way. `page.setViewportSize` does work on
this Electron page — probed directly: ask for 1600×900 and `innerWidth`/`innerHeight` report
exactly 1600×900, ask for 1920×1080 and they report exactly 1920×1080, at dpr 1. So the app
lays out at whatever `meta.captureSize` says and Playwright records that 1:1.

The first cut captured at **1600×900** against a 1920×1080 output, so Remotion upscaled every
captured frame by 1.20× before the Ken Burns move added up to another 1.10× on top. That is
where the soft text on the UI sections came from — not the encoder, whose CRF 18 at ~1 Mbps
just reflects how static screen content is.

`meta.captureSize` is now `1920x1080`. Nothing else changed: no product code, no capture-script
change. **If the output size ever changes, change the capture size with it and re-record** —
a mismatch is silent, and it costs sharpness on every captured section at once.

The master is rendered at **CRF 14**, not the `render.sh --final` default of 18, because
YouTube re-encodes whatever it is given and the extra headroom survives that pass:

```bash
cd demo/studio
npx remotion render src/index.ts Demo ../out/demo.mp4 --public-dir=.. \
  --crf=14 --codec=h264 --audio-codec=aac --audio-bitrate=320k --enforce-audio-track
```

### Text-only cards take no camera move

`Camera` exists because a static screen recording of a mostly static UI reads as a still
image, so every captured section drifts 5–10% across its length. That reasoning does not
transfer to a card that is nothing but live text: a 6% scale over 6.6s moves the type by a
fraction of a pixel per frame, the browser re-rasterizes it every time, and the result is
visible shimmer on the large weights — reported on `09-close`'s "Point it at a repo" and
present, less obviously, on `08-audit`'s mono. Both are now `static`, which is what `04-how`
already was. Captured video keeps its moves: it is a bitmap being resampled either way.

The rule: **`titlecard` and `code` surfaces get `camera.kind: "static"`.** Nothing enforces
it, so check it when adding a text card.

Adding the intro renumbered every following section (`01-problem` → `02-problem`, and so on).
Do that with `demo/prep/insert-section.mjs --first --id 01-intro`, never by hand: section ids
are the join key for clips, narration, sidecars and timeline entries, and renaming by hand
orphans media silently. The script's `--first` mode was added for this.

## Narration loudness

Raw Gemini TTS lands around **−22 LUFS integrated**. Web video targets −14 (YouTube) to −16,
so unnormalised narration plays 6–8 dB under everything else a viewer watches — at laptop
volume with any ambient noise that reads as *"this video has no voiceover"*, which is exactly
how the first cut was reported.

`demo/prep/import-narration.mjs` now runs two-pass `loudnorm` (`I=-16:TP=-1.5:LRA=11`) on the
way in, landing each file at −16.6 to −17.1 LUFS. Two-pass, not single: single-pass loudnorm
guesses from a lookahead buffer and drifts a dB or two, which is enough to make sections
audibly uneven against each other.

Anything regenerated later must go through the importer, not be copied into `demo/audio/`
by hand, or that section will be quiet against the rest.

## Caption timing

`reconcile.mjs` spreads caption chunks across a section by word count, which assumes a
constant speaking rate and no pauses. Gemini TTS does neither: in section 03 it puts a beat
between each item of "Specify, plan, tasks, implement, verify" — five words over five
seconds — so that line was given three seconds and every caption after it ran ahead of the
voice, by as much as **3.5 seconds** at the worst point.

Forced alignment is the right fix and the plugin ships `align-captions.sh` for it, but this
machine's `ELEVENLABS_API_KEY` is missing the `forced_alignment` permission (HTTP 401,
`missing_permissions`) and there is no local ASR. So `demo/prep/align-captions.mjs` recovers
the timings from the audio instead — silence marks the pauses, and the pauses are the whole
error. Sentences are matched to groups of speech runs by scoring every legal split on how
well its speech shares match the sentences' character shares (pause width is only a
tie-break — the widest gap alone picks wrong, and did, by 17ms in section 03). Chunks inside
a sentence are then spread across that sentence's speech by character weight.

Measured against the audio, sentence starts land within 0.01s and mid-sentence chunks within
0.4s, always early rather than late. Only start times move; each caption still runs until the
next begins, so a pause never blanks the screen.

**It must run after every `reconcile.mjs`** — reconcile rewrites `timeline.json` from
scratch and puts the constant-rate timings back:

```bash
node <plugin>/scripts/reconcile.mjs --project .
node demo/prep/align-captions.mjs          # always, immediately after
```

If narration is regenerated for a section, re-run both. The script is idempotent — it derives
absolute times from the audio, not deltas.

## Naming the two ideas Dex is built on

An early cut described the fresh-agent mechanic without ever naming **the Ralph loop** or
**spec-kit**, so the two ideas the product rests on were invisible. Section 03's narration now
names both. Sourcing, so the claims can be checked:

- **The Ralph loop** — coined by Geoffrey Huntley, ["Ralph Wiggum as a 'software engineer'"](https://ghuntley.com/ralph/)
  (14 July 2025), method repo [ghuntley/how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum).
  In its purest form a bash loop: `while :; do cat PROMPT.md | claude-code; done`. One item per
  iteration, fresh context every time, state on disk and in git. It targets **context
  degradation** — quality collapses well before the advertised window.
- **spec-kit** — [github/spec-kit](https://github.com/github/spec-kit), GitHub's spec-driven
  development toolkit and the `specify` CLI.

Two accuracy rules the narration follows:

1. **Never say Dex *is* a Ralph loop.** Huntley has publicly pushed back on products claiming
   the identity. The line credits the *insight* ("That is the Ralph loop's insight: context is
   the scarce resource"). Dex also diverges from the original — Ralph lets the agent pick the
   next task from a free-form plan and never terminates on its own; Dex runs a fixed staged
   pipeline over spec-kit artefacts with explicit termination conditions.
2. **Only credit spec-kit with what it does.** Dex calls exactly five spec-kit commands —
   `constitution`, `specify`, `plan`, `tasks`, `implement`. `gap_analysis`, `clarification`,
   `manifest_extraction`, `verify` and `learnings` are Dex's own, as is splitting `implement`
   into a fresh agent per task-phase. The narration names only the five stage names that are
   spec-kit's *and* visible on screen, so the picture is the evidence.

Related: the comment in `src/core/stages/prerequisites.ts` says spec-kit 0.14 renamed `--ai` to
`--integration`. The deprecation actually landed in April 2026 ([PR #2218](https://github.com/github/spec-kit/pull/2218)),
well before 0.14; the exact version that removed it is unverified. The runtime behaviour —
probing `--help` — is correct either way, but the version attribution in that comment is wrong.

## The one thing

Every stage is a fresh agent *and* a git commit — so the run is something you can watch,
pause, rewind, and promote.

**Problem beat:** a single long AI session degrades past ~100K tokens, so you babysit it,
and you still end up reviewing a branch nobody can explain.

**Wow beat:** the interactive timeline. Selecting a node in the run graph moves the working
tree back to "after plan, before implement" and forks a new branch to continue from. No git
knowledge required, and nothing comparable exists in the supervised-chat workflow.

## Must show

- Fresh-agent-per-stage loop ticking through a cycle on the Loop dashboard
- Pause mid-cycle, Resume re-entering at the next unfinished stage
- Timeline graph click-to-jump producing a `selected-*` fork
- "Make this the new main" promoting a run branch
- The audit trail being plain git commits and JSON files in the repo

## Do not show

Sourced from `inventory.json`'s avoid list. These are hard exclusions:

- **Agent Trace close-ups.** Under the mock backend each stage emits only three synthetic
  steps, so the trace reads as near-empty next to a real run's. The trace view is the
  prettiest screen in the app, and it stays out of this cut — not because it exposes
  anything, but because there is nothing in it to look at.
- **Narrating cost or token figures.** Everything reads `$0.00` under mock, so no narration
  line mentions spend. The readouts themselves are allowed on screen — they are accurate for
  a scripted run — and section 07 deliberately mentions the configured iteration and cost
  *ceilings*, which are real config values, not measured spend.
- **Live real-Claude run.** Minutes per stage, real money, non-deterministic.
- **The interactive clarification Q&A panel.** Cannot be triggered deterministically under
  mock; Automatic Clarification is left on so it never appears.
- **The native folder-picker button.** Native dialog, opaque to capture automation. The
  path is typed instead.
- **Anything involving `gh` or pushing to a real remote.**

## Honesty constraints

Two places where the recording and the narration could drift apart. Both are resolved
*toward what the picture actually shows*:

1. **Section 07 (promote).** The narration claims agent-driven conflict resolution, and the
   recording must actually show it. `demo/prep/stage-conflict.sh` moves `main` underneath
   the finished run so the promotion genuinely conflicts, and
   `demo/prep/test-promote-conflict.mjs` asserts the resolver path runs before anything is
   recorded. If that test does not pass, the merge is clean, the resolver modal never
   appears, and the narration is a lie — re-record or revert the line.

   The resolver's reply is scripted like every other agent turn in this demo, but the
   resolution is a real merge: it keeps the run's catalogue module list, main's admin entry
   and Contributing section, and reconciles the two Status paragraphs. The progress modal
   shows `cost so far $0.0000`, which is accurate for a scripted run — narration never
   mentions spend, only the configured ceilings, which are real
   (`maxIterations: 5`, `costCapUsd: 0.50`).
2. **Section 08 (audit).** `code.content` must be real output from the run that was actually
   recorded. Every reset mints new SHAs, so regenerate it with
   `demo/prep/capture-audit-card.mjs` after the recorded run and before the final render.

## The synthetic backend

The whole demo runs on Dex's mock agent backend. Everything the video claims — the staged
loop, the pause boundary, the commit graph, the fork, the conflict resolution — is the real
orchestrator doing real work on a real repo; only the agent's replies are scripted. The
narration never claims a live model and never mentions spend.

The loop dashboard renders the running stage's step content inline as a reply preview, and
that content used to carry a literal `[mock]` prefix — visible for roughly 35 of the video's
141 seconds across sections 03 and 05. Two earlier cuts disclosed it in a section 03
lower-third ("Mock backend — a full run, replayable at zero cost"). That is no longer needed:
the prefix was removed from `MockAgentRunner`'s two synthetic `text` steps, so the preview now
reads `replying: dex_loop/verify (001-catalog-and-search)` — an accurate description of the
stage that is running.

This is a change to product code, made deliberately. The marker's purpose was to let a
developer tell a synthetic trace from a real one, and that signal is unchanged everywhere it
is actually consulted: `metadata.mockPhase` / `metadata.mockStep` on every emitted step, the
`mock.runStep` / `mock.runTaskPhase` lines in `~/.dex/logs/<project>/<runId>/`, the
`"agent": "mock"` in `.dex/dex-config.json`, the `$0.00` cost readouts, and the trailing
`(mock)` on each step's completion line in the Agent Trace. The prefix duplicated all of that
in the one place it was also user-facing.

Still off the table: narrating cost or token figures over `$0.00` readouts, and any claim
that the recording shows a live model.

Sections 03 and 05 must be recorded against a `dist/` built after this change. A clip showing
`[mock]` is a stale build, not a defect in the take.

## Tone

Confident, concrete, no hype. Specifics over adjectives. The audience distrusts polish.

## Surfaces

- [ ] Web app — n/a. The Dex renderer is dead in a plain browser; `window.dexAPI` comes
      from the preload, so browser capture is not an option.
- [x] Electron/desktop app — launch: `./dev-setup.sh` (Vite on :5500 + Electron with CDP on
      :9333). Ready when `ready in` appears in `~/.dex/dev-logs/vite.log` and
      `DevTools listening on ws://127.0.0.1:9333` in `~/.dex/dev-logs/electron.log`.
- [x] CLI / code walkthrough — sections 04 and 08 only, rendered as code cards, not captured.

Known risk: Playwright's `recordVideo` is unreliable against Electron. If rehearsal produces
empty clips, fall back to macOS screen capture (tier 3 in `demo-capture`).

First launch on this Mac runs `npm install` and a TypeScript compile before the window
appears. This happens once, before any recording session.

## App state

The demo runs against **dex-ecommerce** ("Eshopy") at
`~/Projects/Github/lukaskellerstein/dex-ecommerce`. `demo/prep/reset.sh` is the single
definition of the zero state and is re-run before every take:

- Working tree forced back to the root commit; every `dex/*` and `selected-*` branch deleted
- `GOAL.md` copied from `docs/my-specs/001-Initialization/README.md`, because the loop start
  panel only auto-detects `<projectDir>/GOAL.md`
- Spec-kit initialised, so the `speckit_init` prerequisite passes
- `.dex/mock-config.json` regenerated by `build-mock-config.mjs`
- Post-conditions assert all of the above, and fail loudly rather than let a half-reset
  project record badly

The whole timeline the video shows is produced by the run the viewer watches — nothing is
pre-generated off camera. A scripted run takes ~80s and produces one `dex/*` branch with
about 25 checkpoint commits and three spec folders (`001-catalog-and-search`,
`002-cart-and-checkout`, `003-customer-accounts`).

### Recording order

```text
demo/prep/reset.sh                  # zero state; run before section 01
  … record 01, 02, 03 …             # 02 and 03 share one live run
  … wait for the run to terminate …
  … record 04 …
demo/prep/stage-conflict.sh         # main moves; run before section 05
node demo/prep/test-promote-conflict.mjs   # optional: proves the resolver fires
  … record 05 …
node demo/prep/capture-audit-card.mjs      # refresh section 06 from the recorded run
```

`test-promote-conflict.mjs` actually promotes, so run it on a throwaway pass — then
`reset.sh` and redo the run before the real take.

### Why the committed mock-config is not used

dex-ecommerce ships its own `.dex/mock-config.json`, but it is a regression fixture: its
features are named "Authentication", "Payments" and "Final feature", and its spec dirs are
`specs/mock-c1-f-001-<sha>`. The literal word "mock" and a feature called "Final feature"
would be on screen in the timeline and task board. `build-mock-config.mjs` writes the same
schema with Eshopy-derived content. Restore the original with
`git checkout -- .dex/mock-config.json` when recording is done; nothing is committed.

### Bugs found and fixed while making this demo

Building the demo exercised paths that normal use does not, and turned up five real defects.
All are fixed in the app or its scripts, not worked around in the video:

1. **Spec-kit flag** — see below.
2. **Headless mock runner on Node 24+** — see below.
3. **Resolver progress modal never showed progress.** `TimelinePanel` mounts
   `ConflictResolverProgress` *in response to* the `conflict-resolver:file-start` event, so the
   modal's own subscription started a tick too late to ever receive it. `totalFiles` stayed 0
   and the modal read "Starting… / Resolved 0 / ?" for the entire resolution, however long it
   took. It is now seeded from the opening event via a `seed` prop.
4. **Camera focus was silently ignored.** `focusToOrigin` in `demo/studio/src/lib/timeline.ts`
   emitted `"22%,45%"` with the comma intact — invalid `transform-origin`, so every
   percentage focus fell back to `50% 50%` and all camera moves were centred zooms.
5. **`capture-audit-card.mjs` read `HEAD`.** Promoting squash-merges the run into one commit
   on main, so after the promote section the card found zero checkpoint commits. It now resolves the
   newest `dex/*` branch and names it in the displayed command.

### The first two, in detail

Both were found while building this demo and fixed in the app rather than worked around:

1. **Dex passed a removed spec-kit flag.** `prerequisites.ts` shelled out to
   `specify init --ai claude`, but spec-kit 0.14 renamed `--ai` to `--integration`, so
   auto-init failed, `speckit_init` failed, and a failed check blocked the run behind the
   "Continue anyway" prompt. It now probes `specify init --help` and uses whichever flag
   that build supports.
2. **`scripts/run-mock-headless.mjs` could not run on Node 24+.** It imported
   `src/core/orchestrator.ts` and relied on `.js` specifiers resolving to `.ts` sources,
   which Node dropped. It now runs the compiled `dist/`, compiles on demand, refuses to run
   against a non-mock backend, and exits non-zero if any error event was emitted.

Prep still initialises spec-kit itself (`reset.sh`), because the demo needs the check green
without depending on Dex's auto-fix path running at all.

## Voice

Narrator: measured, technical, mid-pace. Settings are recorded in `meta.voice`.

**Not ElevenLabs.** This machine's `ELEVENLABS_API_KEY` is missing the `voices_read` and
`user_read` scopes, so the `demo-elevenlabs` MCP server rejects every request — including
`text_to_speech`, because it validates the voice before synthesising. Narration is generated
with Gemini TTS (`mcp__plugin_media-plugin_media-mcp__generate_speech`, model `pro-tts`,
voice `Charon`) using the style instructions in `meta.voice.styleInstructions`.

That tool writes timestamped `.wav` files outside the project and does not trigger the
pipeline's `probe-audio` hook, so `demo/prep/import-narration.mjs` converts them to
`demo/audio/<id>.mp3`, writes the measurement sidecars `reconcile.mjs` reads, and reports
each section's drift against budget. Re-run it after regenerating any line.

If the key is later given the missing scopes, switching back to ElevenLabs means
regenerating all seven lines with one voice and re-running the importer — do not mix
narrators across sections, it is instantly audible.

### Budget reconciliation

Measured narration came to 108.9s against a planned 103s. Rather than rewrite lines that
read well, section targets were set from the measured audio — and for sections 03 and 04 the
rehearsed picture independently ran to the same lengths (25.5s and 15.8s), so the original
estimates were simply low. Final target: 109s of narration; the reconciler's per-section
lead-in, tail and transition overlaps land the cut at 137.7s of video.

| Written | Spoken |
|---|---|
| Dex | "deks" — one syllable, rhymes with "specs" |
| `.dex` | never spoken |
| JSON | "jay-son" |
| git | "git", hard g |
| DAG | never spoken — narration says "graph" |

Listen to the first take of every section containing "Dex".

## Music

None by default. Decide after the draft render.
