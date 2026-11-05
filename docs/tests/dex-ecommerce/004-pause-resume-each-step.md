# Test: pause and resume on every cycle step — paused/running icon parity

Systematically pauses the autonomous loop in the middle of **every** per-entry stage (`specify`, `clarify`, `plan`, `tasks`, `implement`, `verify`), verifies that the loop dashboard's stage list renders the correct `running` / `paused` indicators throughout, and confirms that the mock agent's commits line up exactly with the steps the user observed complete.

Regression test for the rendering bugs fixed in `014-branch-management`:

- `getStageVisibility` returned `"skip"` for some cycle decisions, so stopping mid-`plan` (which sets `cycle.decision === "stopped"`) made `Plan` render with the dimmed grey minus icon. Since 015 the function hides only a `brief` row that has no record.
- `deriveStageStatus` checked visibility-skip before the `actual` block, so a stopped step lost to that misclassification.
- `resolvePausePendingStage` continued past a `stopped`/`failed` actual, so the *next* (not-yet-started) step was also marked paused — `Implement` lit up orange even though only `Plan` had been running.

If any of those regressions return, this test fails on a specific pause iteration.

**Target project:** `~/Projects/Github/lukaskellerstein/dex-ecommerce`

**Follow `.claude/rules/06-testing.md`** for the standard test mechanics — dev server startup, welcome screen flow, autonomous-loop kickoff, log/state diagnostics. This file specifies only what is unique to this scenario.

## Prerequisite

Clean local slate; `origin/main` is not touched. Run the commands in this file from the root of the Dex checkout under test.

```bash
./scripts/reset-example-to.sh pristine
```

Sanity check:

```bash
cd ~/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls -a
```

The tree is clean and holds only what `origin/main` tracks plus `.git/`. `pristine` runs `git clean -fdx`, so no runtime file (`.dex/state.json`, `.dex/runs/`) is left.

## Configuration

| Param | Default | Override |
|---|---|---|
| Agent backend | `mock` | **Not overridable.** The pause-timing assertions only work against the deterministic mock — a live agent's per-step latency is not predictable enough to land the Pause click reliably inside the right step. |

The fixture's stage delays (300 ms) are far too short: by the time you click Pause from CDP the step has already advanced. Seed `mock-config.json` with **20 000 ms per entry stage** so every step holds in the `running` indicator long enough to inspect and snapshot, and restrict the manifest to a **single feature** so the test is bounded:

```bash
mkdir -p ~/Projects/Github/lukaskellerstein/dex-ecommerce/.dex
echo '{ "agent": "mock" }' > ~/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
jq '.entries["*"] |= map_values(.delay = 20000)
    | .clarification.manifest_extraction.structured_output.features |= .[:1]' \
  fixtures/mock/new-project.json \
  > ~/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/mock-config.json
```

`prerequisites` and `clarification` keep the fixture's short delays — they are not pause-tested here and slow setup is dead weight. Do not reuse an older `mock-config.json` from the example project: the pre-015 `dex_loop` shape is refused by the mock loader.

## Definition of Done

- [ ] Mock backend seeded with **20 s** `delay` on every entry stage before the run starts; manifest pinned to a single feature.
- [ ] For each step in `{ specify, clarify, plan, tasks, implement, verify }`, **all six** of the following hold:
  1. While running, the stage-list row for that step shows the **running indicator** — cyan ring with the spinning Loader glyph, label bold cyan, `running…` (or the latest-action caption) visible to the right. No other step in the cycle shows the running indicator.
  2. After Pause, the same row flips to the **paused indicator** — orange ring with the filled Pause glyph, label bold orange, `paused` badge visible to the right.
  3. **Exactly one** step row in the cycle carries the paused indicator at any given moment.
  4. Every earlier step in cycle order remains green ✓ completed; none regresses to a dimmed minus icon (`skipped` styling) or to plain pending.
  5. Every later step remains plain pending — light-grey empty circle, no icon. None is drawn with the dimmed minus icon, none with the paused indicator. `Tasks` stays visible throughout.
  6. The top `Dex Loop` phase chip shows the orange ⏸ icon while paused; no other top chip shows pause; the cycle header shows the in-progress / paused indicator (not the green ✓).
- [ ] Commit ledger at every pause: the mock's stage commits (`mock(<stage>): <entry>`) cover **exactly** the steps whose rows are green ✓ in cycle 1 — no more, no less. The currently-paused step has **not** committed.
- [ ] After Resume on each step, the same row's indicator flips back to **running** within ~1 s, and on step completion a new `mock(<step>): <entry>` commit appears at HEAD.
- [ ] After the sixth resume (`verify` completes), the cycle is marked completed and the ledger lists the expected commits in canonical order (§ 4).
- [ ] `git status` is clean after the run completes; `<projectDir>/.dex/state.json` reports `status: "completed"`.

## Pass / Fail criteria

- **PASS** — every Definition-of-Done item above is satisfied AND no failure mode called out in § 4 was observed.
- **FAIL** — any DoD item is unsatisfied, OR any failure mode triggered (multiple rows paused, wrong row paused, commit ledger out of sync with the UI, a row that should be visible disappears, Tasks rendered as minus icon, Implement rendered as paused while Plan is still in flight), OR execution was aborted before all six pause iterations finished.

The Reporting section below MUST conclude with an explicit `PASS` or `FAIL` verdict on its own line. Do not omit the verdict, even if the run ended early — in that case report `FAIL` and state which step iteration failed and why.

## Notes on `brief` and the commit ledger

The cycle's first stage, `brief`, runs only for a queue entry that generates its brief from sources. Entries that come from manifest extraction have no brief, so the `brief` row stays hidden and the iteration loop in § 3 starts at `specify`.

Dex makes no commits of its own. The mock agent commits each stage that changed something as `mock(<stage>): <entry>`, the way an agent following the project's rules would, and a stopped mock stage writes and commits nothing. `implement` runs once per task phase, and the fixture's `tasks.md` has two, so `implement` adds **two** commits. The project-level steps before the loop commit as `mock(<step>): project`; the ledger query below filters them out.

```bash
git -C ~/Projects/Github/lukaskellerstein/dex-ecommerce log --format=%s \
  | grep -E '^mock\((specify|clarify|plan|tasks|implement|verify)\):'
```

## Steps

### 1. Reset, seed config, capture baseline

Reset + seed per Prerequisite and Configuration above. Confirm the seeded `mock-config.json` has `delay: 20000` on every entry stage:

```bash
jq '.entries["*"] | map_values(.delay)' ~/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/mock-config.json
```

Baseline ledger — the query from the Notes above prints nothing on a freshly-pristined repo.

### 2. Start the loop and wait for cycle 1 to enter `specify`

- Confirm `dev-setup.sh` is running (CDP on 9333) per 06-testing.md § 4c Step 2.
- Open the app, fill the welcome screen for `dex-ecommerce`, click **Open Existing**.
- On the Autonomous Loop page, toggle **Automatic Clarification** on, click **Start Autonomous Loop**.
- Wait until the stage list expands into **Cycle 1** and `Specify` shows the running indicator. (`Prerequisites` and `Clarification` will have flown by under their short delays.)

The ledger query is still empty at this point.

### 3. Pause / Resume iteration

Run the same six-action loop for each `<step>` in this order:

```text
specify → clarify → plan → tasks → implement → verify
```

#### 3.<n>. Pause on `<step>`

**(a)** Confirm the `<step>` row is currently **running**. Snapshot the stage list. Verify visually + via the DEBUG badge that `Stage: <step>` and `Cycle: 1`.

**(b)** Click the topbar **Pause** button (orange ⏸).

**(c)** Take a stage-list snapshot of the **paused** state. Verify, in this exact order:

1. Locate the `<step>` row. It must show the paused indicator — orange filled Pause glyph in an orange ring, label bold orange, `paused` badge on the right.
2. Walk every other row in the cycle. Earlier rows (canonical `CYCLE_STAGES` order, up to but not including `<step>`) must all be green ✓. Later rows must all be plain pending — light-grey empty circle, no Loader, no Pause icon, no minus icon. Count the rows showing the orange paused indicator — there must be **exactly 1**.
3. Confirm `Tasks` (and `Specify`, and `Plan` if this iteration is past it) is visible in the row list. If any of them disappears after Pause, the visibility regression has returned — fail this DoD item explicitly.
4. Check the top phase chips. `Dex Loop` shows the orange ⏸; `Prerequisites`, `Clarification`, `Completion` do not.

**(d)** Commit-ledger cross-check. Run the ledger query from the Notes. Every green ✓ row must have its `mock(<stage>)` commit, and the current `<step>` must have **none** — a stopped mock stage commits nothing. For `implement`, the number of `mock(implement)` commits equals the number of task phases already ticked in `tasks.md`.

**(e)** Click the topbar **Resume** button (purple ▶). Within ~1 s the `<step>` row must flip back to the cyan running indicator. The `Dex Loop` chip must return to its in-progress (non-paused) state. Snapshot the stage list in the resumed state.

**(f)** Wait for `<step>` to complete. Its row turns green ✓, the next step's row turns running (cyan). Check the newest commit:

```bash
git -C ~/Projects/Github/lukaskellerstein/dex-ecommerce log -1 --format=%s
```

It must read `mock(<step>): <entry>`, and the ledger must have grown by exactly the commits that step makes (one; two for `implement`).

Move on to the next step.

#### Special-case the last iteration

When `<step> === "verify"`, step (f) finishes the cycle: the verify record passes, the entry is done, and because the manifest only has one feature the orchestrator emits `loop_cycle_completed` and `loop_terminated` with `queue_complete`. There is no "next running step". Capture the final stage-list snapshot — every step in cycle 1 must be green ✓, the cycle header green ✓, `Dex Loop` chip green ✓, `Completion` chip green ✓ if the run terminated cleanly.

### 4. Final verification

```bash
cd ~/Projects/Github/lukaskellerstein/dex-ecommerce
git status --short                                    # clean
git log --format=%s | grep -E '^mock\((specify|clarify|plan|tasks|implement|verify)\):'
jq '{status, current}' .dex/state.json                # status: "completed"
```

Expected ledger (newest first, exact order; `<entry>` is the queue id manifest extraction gave the feature, e.g. `001-catalog-and-search`):

```text
mock(verify): <entry>
mock(implement): <entry>      (task phase 2)
mock(implement): <entry>      (task phase 1)
mock(tasks): <entry>
mock(plan): <entry>
mock(clarify): <entry>
mock(specify): <entry>
```

Failure modes to flag explicitly:

- Pause click ignored — the stage list keeps showing running, no paused indicator within 2 s → main-process stop IPC not wired to the orchestrator's `abortController`. Check `~/.dex/dev-logs/electron.log` for `[stopRun] abort signal sent to orchestrator`.
- Pause indicator on the wrong row (e.g. you paused during `plan` and the indicator landed on `implement`) → `resolvePausePendingStage` is short-circuiting after the `stopped` actual and returning the next pending stage. The authoritative resume point is what the picker reads from the files: `node dist/core/cli.js run ~/Projects/Github/lukaskellerstein/dex-ecommerce --status` (build with `npx tsc` first) prints the entry's next stage and writes nothing.
- Pause indicator on **two** rows → `resolvePausePendingStage` is firing alongside the `actual.status === "stopped"` branch in `deriveStageStatus`. Same fix point as above; the guard that returns `null` on a stopped actual is missing or has regressed.
- A row before the paused one is rendered with the dimmed minus icon → `deriveStageStatus` is short-circuiting on `getStageVisibility === "skip"` before the `actual` block. The reorder fix in `src/renderer/components/loop/StageList.logic.ts` has regressed.
- `Tasks` row disappears after Pause → `getStageVisibility` is hiding a stage other than a record-less `brief` again. Same file.
- Commit ledger ahead of the UI (a `mock(<step>)` commit for the paused step) → the mock did not see the abort, so Stop did not reach the stage's `AbortController`. Bug in the abort path.
- Commit ledger behind the UI (a green ✓ row with no commit) → the renderer is marking a step ✓ before the stage finished. Bug in the `step_completed` reducer.

## Reporting

For each of the six iterations (3.1 – 3.6), capture:

- **Step name** (`specify` … `verify`).
- Snapshot of the stage list in the **running** state immediately before Pause.
- Snapshot of the stage list in the **paused** state immediately after Pause.
- Output of the ledger query at pause time, and whether it covers exactly the green ✓ rows.
- Snapshot of the stage list in the **resumed running** state after Resume.
- Output of `git log -1 --format=%s` after the step completes — must read `mock(<step>): <entry>`.

At the end:

- Final stage-list snapshot — cycle 1 all green.
- Final ledger query output for the full cycle.
- Final `<projectDir>/.dex/state.json` snapshot.
- Pass/fail status against each DoD item, with pointers to the specific snapshots / log excerpts backing each claim.
- An explicit `PASS` or `FAIL` verdict on its own line at the end of the report, per the Pass / Fail criteria above.
