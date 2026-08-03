# YouTube upload — Dex demo

Fill in anything marked `TODO`. Everything else is ready to paste.

## Assets

| | |
|---|---|
| Video | `demo/out/demo.mp4` — 2:21 (141.2s), 1920×1080, 30fps, CRF 14, 34.3 MB |
| Thumbnail | `demo/out/thumbnail.png` — 1280×720, 0.79 MB (YouTube's limit is 2 MB) |

### Thumbnail provenance

Fully generated, including the type, to match the house style of the other product
thumbnails (VEX, OpenOperator, Real-Time OSINT Map): product name in large white sans
centred at the top, one Title-Case subtitle beneath it, hero visual filling the lower two
thirds, dark ground with neon rim-light.

The 2K original is kept at `demo/brand/thumbnail-2k.jpg`; `demo/out/thumbnail.png` is that
file resized to 1280×720 with Lanczos.

Regenerate with `mcp__media-mcp__generate_image` — `aspect_ratio: "16:9"`, `image_size: "2K"`,
`thinking_level: "high"`, and **both** reference images (`docs/logo/logo.png` for the mark,
the VEX thumbnail for the layout), then resize:

```bash
ffmpeg -i demo/brand/thumbnail-2k.jpg -vf "scale=1280:720:flags=lanczos" demo/out/thumbnail.png
```

<details>
<summary>Prompt used</summary>

```text
A 16:9 YouTube thumbnail for a developer tool, matching the house style of the second
reference image (the "VEX" thumbnail): dark cinematic tech thumbnail, product name in very
large bold white sans-serif centred near the top, one subtitle line directly beneath it in
smaller white semi-bold sans-serif, and a hero visual filling the lower two thirds.

EXACT TEXT — spelled exactly like this, correctly and crisply rendered, and no other text
anywhere in the image:
Large title: Dex
Subtitle underneath: Autonomous Coding You Can Rewind

HERO VISUAL (lower two thirds): two dark floating application windows, angled slightly
toward each other, with soft violet rim-light and subtle glass reflections. The LEFT window
shows a vertical checklist of completed pipeline stages — a column of glowing green
check-circles, each beside a short muted grey label bar, with one row highlighted violet.
The RIGHT window shows a branching version-control graph: violet dots connected by smooth
curved lines that split into two parallel branches. Floating large and softly glowing
between and behind the two windows is the segmented violet spiral ring from the first
reference image — a coil of thick tapered blades curving into a deep central well.

PALETTE: near-black background (#0A0B0F), deep violet (#7C3AED) and lavender (#A78BFA) neon
accents, purple light bloom, deep shadows, high contrast.

STYLE: premium 3D product render, crisp, cinematic lighting, edge-to-edge composition, clean
and uncluttered.

DO NOT INCLUDE: any text other than the two lines specified above; misspelled or garbled
lettering; watermarks; readable code, paragraphs, or small body text; robot hands; people;
circuit-board backgrounds; world maps; cyan or blue-and-gold palettes.
```

</details>

**Check the spelling of any regeneration before uploading.** Image models render text
plausibly rather than reliably; this one came out correct on the first pass, but that is not
guaranteed on a re-roll. The two strings are "Dex" and "Autonomous Coding You Can Rewind".

The UI panels in the hero are illustrative, not screenshots — the same is true of the other
product thumbnails, so it is consistent, but it does mean the thumbnail shows nothing the
viewer will literally see in the video.

---

## Title

Pick one. Recommended first.

1. **Dex — autonomous coding you can pause, rewind, and merge**
2. Dex — an AI agent that runs your repo, and hands control back
3. A fresh AI agent per stage, every stage a git commit — Dex

Keep it under ~60 characters if you care about the title surviving un-truncated in search
results; option 1 is 56.

`TODO` chosen title:

---

## Description

Paste from the line below to the end of the tag block.

```text
Dex points an AI agent at a repo with one goal file and lets it run — specify, plan, tasks,
implement, verify — a brand new agent for every stage, each with an empty context window.
Every finished stage is a git commit, so the whole run is something you can watch, pause,
rewind to any point, and merge on your terms.

Built on two ideas: GitHub's spec-kit for the artefacts, and the Ralph loop's insight that
context is the scarce resource, so you throw it away between steps.

What's in the video:
• A full autonomous run ticking through its stages, live
• Pause that stops at a stage boundary, not mid-thought — and resumes where it stopped
• Click any node in the run graph to move the working tree back to that point and fork
• Promoting a run branch into a main that moved underneath it, conflicts resolved by a
  one-shot agent under a fixed iteration and cost ceiling
• The audit trail: no database, just git commits and JSON in the repo

Dex is an Electron app that orchestrates Claude Code instances.
Source: https://github.com/lukaskellerstein/dex

The run in this video uses Dex's deterministic mock agent backend, so it replays identically
and costs nothing. The orchestration, the git history, the branching and the merge are all
real — only the agents' replies are scripted.

References:
Ralph loop — Geoffrey Huntley: https://ghuntley.com/ralph/
spec-kit — https://github.com/github/spec-kit

Chapters:
0:00 One long session degrades
0:19 A fresh agent per stage
0:48 Spec-kit, on a Ralph loop
1:08 Pause that means pause
1:25 Rewind the run
1:44 Merge into main
2:04 No database, just git

#ai #softwareengineering #devtools #claude #git #automation
```

**On the mock-backend paragraph:** the video itself no longer says this anywhere — the
on-screen marker was removed. Keeping the line here is the honest version and, for this
audience, a reasonable selling point (a full autonomous run that replays for free is
something a live model cannot give you). Delete it if you disagree; it is your call, but
decide deliberately rather than by omission.

`TODO` keep or cut the mock paragraph:

---

## Chapters — why these

YouTube only renders a chapter list if **every** chapter is at least 10 seconds and the
first starts at `0:00`. Two sections are therefore folded into their neighbours rather than
listed:

- `01-intro` (3.5s) — folded into the first chapter, which starts at `0:00` as required
- `09-close` (6.6s) — folded into "No database, just git", which then runs 17s to the end

Adding either back breaks the whole list, not just that entry. If section durations change,
regenerate the timestamps from the timeline rather than editing them by hand:

```bash
node -e 'const t=require("./demo/timeline.json");const f=n=>`${Math.floor(n/t.fps/60)}:${String(Math.floor(n/t.fps)%60).padStart(2,"0")}`;for(const s of t.sections)console.log(f(s.startFrame),s.title)'
```

---

## Tags

```text
dex, ai coding agent, autonomous coding, claude code, spec-kit, ralph loop, ai software
engineering, developer tools, electron app, git workflow, ai agent orchestration,
context window, code review, open source
```

---

## Upload settings

| Field | Value |
|---|---|
| Visibility | `TODO` public / unlisted / private |
| Category | Science & Technology |
| Playlist | `TODO` |
| Audience | Not made for kids |
| Language | English |
| Comments | `TODO` on / off |
| License | `TODO` standard YouTube / Creative Commons |
| End screen | `TODO` — the close card holds from 2:14, so an end screen fits there |
| Pinned comment | `TODO` — the repo link is a good default |

## Before publishing

- [ ] Watch once at laptop volume — narration was normalised to −16 LUFS, but check it
      against whatever you last watched
- [ ] Read the thumbnail's two text lines once more for spelling (see provenance above)
- [ ] Confirm the thumbnail reads at ~210px wide (that is the size in a search result)
- [ ] Decide on the mock-backend paragraph above
- [ ] `TODO` anything repo-specific you want to say about the current state of the project
