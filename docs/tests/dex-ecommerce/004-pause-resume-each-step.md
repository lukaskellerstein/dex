# Test: pause and resume on every cycle step — paused/running icon parity and commit checkpoints

Systematically pauses the autonomous loop in the middle of **every** substantive cycle stage (`specify`, `plan`, `tasks`, `implement`, `verify`, `learnings`), verifies that the Steps tab renders the correct `running` / `paused` indicators throughout, and confirms that the checkpoint-commit ledger lines up exactly with the steps the user observed complete.

Regression test for the rendering bugs fixed in `014-branch-management`:

- `getStageVisibility` returned `"skip"` for any decision other than `NEXT_FEATURE` / `REPLAN_FEATURE`, so stopping mid-`plan` (which sets `cycle.decision === "stopped"`) made `Plan` render with the dimmed grey minus icon.
- `deriveStageStatus` checked visibility-skip before the `actual` block, so a stopped step lost to that misclassification.
- `resolvePausePendingStage` continued past a `stopped`/`failed` actual, so the *next* (not-yet-started) step was also marked paused — `Implement` lit up orange even though only `Plan` had been running.

If any of those regressions return, this test fails on a specific pause iteration.

**Target project:** `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`

**Follow `.claude/rules/06-testing.md`** for the standard test mechanics — dev server startup, welcome screen flow, autonomous-loop kickoff, log/state diagnostics. This file specifies only what is unique to this scenario.

## Prerequisite

Clean local slate; `origin/main` is not touched. `.dex/` is wiped and reseeded in the configuration step.

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex
./scripts/reset-example-to.sh pristine
```

Sanity check:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
```

`ls` should show only the root commit's contents plus `.git/`. `.dex/` is gone.

## Configuration

| Param | Default | Override |
|---|---|---|
| Agent backend | `mock` | **Not overridable.** The pause-timing assertions only work against the deterministic mock — a live agent's per-step latency is not predictable enough to land the Pause click reliably inside the right step. |

The default mock delays (3–6 s) are too tight: by the time you click Pause from CDP the step has already advanced. Seed `mock-config.json` with **20 000 ms per cycle stage** so every step holds in the `running` indicator long enough to inspect and snapshot.

Seed `dex-config.json`:

```bash
mkdir -p /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex
echo '{ "agent": "mock" }' > /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
```

Seed `mock-config.json` — copy the canonical mock fixture (e.g. the one currently in `<projectDir>/.dex/mock-config.json` after a recent run, or the template in `fixtures/mock-run/` if present) and **rewrite every `dex_loop.cycles[*].stages.<stage>.delay` value to `20000`**. Leave `prerequisites`, `clarification`, and `completion` delays at their default (1–5 s) — they are not pause-tested here and slow setup is dead weight.

Restrict the manifest to a **single feature, single cycle** so the test is bounded:

```json
"manifest_extraction": {
  "delay": 1000,
  "structured_output": {
    "features": [
      { "id": 1, "title": "Authentication", "description": "Sign-up / log-in / log-out." }
    ]
  }
}
```

…and ensure `dex_loop.cycles` contains exactly one cycle entry for that feature.

## Definition of Done

- [ ] Mock backend seeded with **20 s** `delay` on every cycle stage before the run starts; manifest pinned to a single feature / single cycle.
- [ ] For each step in `{ specify, plan, tasks, implement, verify, learnings }`, **all six** of the following hold:
  1. While running, the Steps-tab row for that step shows the **running indicator** — cyan ring with the spinning Loader glyph, label bold cyan, `running…` (or the latest-action caption) visible to the right. No other step in the cycle shows the running indicator.
  2. After Pause, the same row flips to the **paused indicator** — orange ring with the filled Pause glyph, label bold orange, `paused` badge visible to the right.
  3. **Exactly one** step row in the cycle carries the paused indicator at any given moment.
  4. Every earlier step in cycle order remains green ✓ completed; none regresses to a dimmed minus icon (`skipped` styling) or to plain pending.
  5. Every later step remains plain pending — light-grey empty circle, no icon. None is drawn with the dimmed minus icon, none with the paused indicator. `Tasks` (and any other stage that gap-analysis might normally hide on a `RESUME_FEATURE` cycle) stays visible throughout.
  6. The top `Dex Loop` phase chip shows the orange ⏸ icon while paused; no other top chip shows pause; the cycle header shows the in-progress / paused indicator (not the green ✓).
- [ ] Commit ledger at every pause: `git log --grep '\[checkpoint:.*:1\]' --oneline` returns **exactly** the steps whose Steps-tab rows are green ✓ in cycle 1 — no more, no less. The currently-paused step has **not** committed yet.
- [ ] After Resume on each step, the same row's indicator flips back to **running** within ~1 s, and on step completion a new `[checkpoint:<step>:1]` commit appears at HEAD.
- [ ] After the seventh resume (`learnings` completes), the cycle is marked completed; `git log --grep '^\[checkpoint:' --oneline` for cycle 1 lists the seven expected checkpoint commits in canonical order: `gap_analysis`, `specify`, `plan`, `tasks`, `implement`, `verify`, `learnings`.
- [ ] `git status` is clean after the run completes; `<projectDir>/.dex/state.json` reports `lastCompletedStep: "learnings"` and `cyclesCompleted: 1`.

## Pass / Fail criteria

- **PASS** — every Definition-of-Done item above is satisfied AND no failure mode called out in step 3 was observed.
- **FAIL** — any DoD item is unsatisfied, OR any failure mode triggered (multiple rows paused, wrong row paused, commit ledger out of sync with the UI, a row that should be visible disappears, Tasks rendered as minus icon, Implement rendered as paused while Plan is still in flight), OR execution was aborted before all six pause iterations finished.

The Reporting section below MUST conclude with an explicit `PASS` or `FAIL` verdict on its own line. Do not omit the verdict, even if the run ended early — in that case report `FAIL` and state which step iteration failed and why.

## Notes on `gap_analysis`

`gap_analysis` on the **first cycle** with a never-seen feature (the `NEXT_FEATURE` deterministic path in `src/core/stages/main-loop.ts`) is **synthetic** — `emitSyntheticGapAnalysis` fires `step_started` and `step_completed` back-to-back with zero delay and **does not** invoke the mock agent. It also does not write a checkpoint commit of its own — the cycle's first checkpoint commit is `[checkpoint:specify:1]`. This makes `gap_analysis` impossible to pause on cycle 1, so the iteration loop in step 3 starts at `specify`. A separate test (not part of this scenario) would have to seed a `RESUME_FEATURE` cycle to exercise pause on a real `gap_analysis` run.

## Steps

### 1. Reset, seed config, capture baseline

Reset + seed per Prerequisite and Configuration above. Confirm the seeded `mock-config.json` has `delay: 20000` on every entry under `dex_loop.cycles[0].stages` (read it back with `jq '.dex_loop.cycles[0].stages | map_values(.delay)'`).

Baseline ledger — should be **empty** for `[checkpoint:` matches on a freshly-pristined repo:

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce log --grep '^\[checkpoint:' --oneline | wc -l   # 0
```

### 2. Start the loop and wait for cycle 1 to enter `specify`

- Confirm `dev-setup.sh` is running (CDP on 9333) per 06-testing.md § 4c Step 2.
- Open the app, fill the welcome screen for `dex-ecommerce`, click **Open Existing**.
- On the Autonomous Loop page, toggle **Automatic Clarification** on, click **Start Autonomous Loop**.
- Wait until the Steps tab expands into **Cycle 1** and `Specify` shows the running indicator. (`Prerequisites`, `Clarification`, and `gap_analysis` will have flown by under their cheap defaults.)

At this point capture:

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce log --grep '\[checkpoint:.*:1\]' --oneline
```

Expected: empty (or, if `gap_analysis` does emit a synthetic-completion checkpoint commit in your build, exactly one line `[checkpoint:gap_analysis:1]`). Record whichever case you see — every later iteration's expected commit count is offset from this baseline.

### 3. Pause / Resume iteration

Run the same five-action loop for each `<step>` in this order:

```
specify → plan → tasks → implement → verify → learnings
```

#### 3.<n>. Pause on `<step>`

**(a)** Confirm the Steps-tab `<step>` row is currently **running**. Snapshot the Steps tab. Verify visually + via the DEBUG badge that `Stage: <step>` and `Cycle: 1`.

**(b)** Click the topbar **Pause** button (orange ⏸).

**(c)** Take a Steps-tab snapshot of the **paused** state. Verify, in this exact order:

1. Locate the `<step>` row. It must show the paused indicator — orange filled Pause glyph in an orange ring, label bold orange, `paused` badge on the right.
2. Walk every other row in the cycle. Earlier rows (canonical CYCLE_STAGES order, up to but not including `<step>`) must all be green ✓. Later rows must all be plain pending — light-grey empty circle, no Loader, no Pause icon, no minus icon. Count the rows showing the orange paused indicator — there must be **exactly 1**.
3. Confirm `Tasks` (and `Specify`, and `Plan` if this iteration is past it) is visible in the row list. If any of them disappears after Pause, the visibility regression has returned — fail this DoD item explicitly.
4. Check the top phase chips. `Dex Loop` shows the orange ⏸; `Prerequisites`, `Clarification`, `Completion` do not.

**(d)** Commit-ledger cross-check. Run:

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce log --grep '\[checkpoint:.*:1\]' --oneline
```

The number of matching commits must equal the number of green ✓ rows in cycle 1 (offset by any baseline from § 2). The current `<step>` must **not** yet appear as `[checkpoint:<step>:1]` — that commit is written by `finalize.ts` only after the step's agent returns successfully, which a Pause prevents.

**(e)** Click the topbar **Resume** button (purple ▶). Within ~1 s the `<step>` row must flip back to the cyan running indicator. The `Dex Loop` chip must return to its in-progress (non-paused) state. Snapshot the Steps tab in the resumed state.

**(f)** Wait for `<step>` to complete. Its row turns green ✓, the next step's row turns running (cyan). Re-run the commit-ledger query:

```bash
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce log -1 --pretty='%B' | head -2
```

The most recent commit's body must contain `[checkpoint:<step>:1]`. The total `[checkpoint:.*:1]` count must have incremented by exactly 1 since pause (d).

Move on to the next step.

#### Special-case the last iteration

When `<step> === "learnings"`, step (f) finishes the cycle. There is no "next running step"; instead the orchestrator emits `loop_cycle_completed` and (because the manifest only has one feature) terminates the run. Capture the final Steps-tab snapshot — every step in cycle 1 must be green ✓, the cycle header green ✓, `Dex Loop` chip green ✓, `Completion` chip green ✓ if the run terminated cleanly.

### 4. Final verification

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git status --short                                                         # clean
git log --grep '^\[checkpoint:' --oneline                                  # full ledger
jq '{lastCompletedStep, cyclesCompleted}' .dex/state.json                  # learnings / 1
```

Expected `git log` (newest first, exact order):

```
<sha>  dex: learnings completed     [cycle:1] [feature:...]
<sha>  dex: verify completed        [cycle:1] [feature:...]
<sha>  dex: implement completed     [cycle:1] [feature:...]
<sha>  dex: tasks completed         [cycle:1] [feature:...]
<sha>  dex: plan completed          [cycle:1] [feature:...]
<sha>  dex: specify completed       [cycle:1] [feature:...]
(optional) [checkpoint:gap_analysis:1]  — only if the synthetic stage commits in your build
(optional) completion commit — only when the whole run terminates
```

Failure modes to flag explicitly:

- Pause click ignored — Steps tab keeps showing running, no paused indicator within 2 s → main-process `onStop` IPC not wired to the orchestrator's `abortController`. Check `~/.dex/dev-logs/electron.log` for `runLoop: abort detected`.
- Pause indicator on the wrong row (e.g. you paused during `plan` and the indicator landed on `implement`) → `resolvePausePendingStage` is short-circuiting after the `stopped` actual and returning the next pending stage. Compare against `<projectDir>/.dex/state.json::currentStage` — that is the authoritative paused step.
- Pause indicator on **two** rows → `resolvePausePendingStage` is firing alongside the `actual.status === "stopped"` branch in `deriveStageStatus`. Same fix point as above; the guard that returns `null` on a stopped actual is missing or has regressed.
- A row before the paused one is rendered with the dimmed minus icon → `deriveStageStatus` is short-circuiting on `getStageVisibility === "skip"` before the `actual` block. The reorder fix in `src/renderer/components/loop/StageList.logic.ts` has regressed.
- `Tasks` row disappears after Pause → `getStageVisibility` is again treating `cycle.decision === "stopped"` like a gap-analysis skip. The inverted-decision-list fix in the same file has regressed.
- Commit ledger ahead of the UI (more `[checkpoint:.*:1]` commits than green ✓ rows) → `finalize.ts` is committing past a paused step. Bug in the abort path.
- Commit ledger behind the UI (fewer commits than green ✓ rows) → the renderer is marking a step ✓ before its checkpoint commit lands. Bug in step_completed reducer.

## Reporting

For each of the six iterations (3.1 – 3.6), capture:

- **Step name** (`specify` … `learnings`).
- Snapshot of Steps tab in the **running** state immediately before Pause.
- Snapshot of Steps tab in the **paused** state immediately after Pause.
- Output of `git log --grep '\[checkpoint:.*:1\]' --oneline` at pause time, and the row-count vs. green-✓-count delta (should be 0).
- Snapshot of Steps tab in the **resumed running** state after Resume.
- Output of `git log -1 --pretty='%B' | head -2` after the step completes — must contain `[checkpoint:<step>:1]`.

At the end:

- Final Steps-tab snapshot — cycle 1 all green.
- Final `git log --grep '^\[checkpoint:' --oneline` output for the full cycle.
- Final `<projectDir>/.dex/state.json` snapshot.
- Pass/fail status against each DoD item, with pointers to the specific snapshots / log excerpts backing each claim.
- An explicit `PASS` or `FAIL` verdict on its own line at the end of the report, per the Pass / Fail criteria above.
