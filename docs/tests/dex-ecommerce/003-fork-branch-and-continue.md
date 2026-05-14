# Test: fork from a past commit and continue the loop

Exercises the **click-to-jump navigation** added in `010-interactive-timeline` and the loop's resume-from-selected-branch behavior. Picking a historical commit in the Timeline must mint a transient `selected-<ts>` branch at that commit, and clicking **Start** must continue the autonomous loop on that selected branch — leaving the original `dex/*` branch tip untouched.

**Target project:** `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`

**Follow `.claude/rules/06-testing.md`** for the standard test mechanics — dev server startup, welcome screen flow, autonomous-loop kickoff, log/state diagnostics. This file specifies only what is unique to this scenario.

## Prerequisite

This test depends on a `dex/*` branch with **multiple checkpoint commits** in its history (i.e. a loop run that progressed through several stages). The natural source is the post-state of `001-first-two-features.md` — the spec 002 `dex/*` branch contains a full chain of `[checkpoint:<stage>:<cycle>]` commits.

**Do not reset before running this test** — the prior test's branches are exactly what you're forking from. If your repo doesn't have that state, run `001-first-two-features.md` first.

Sanity check before starting:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
# Find the most recent dex/* branch and its checkpoint commits.
LATEST_DEX=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/dex/ | head -1)
echo "Latest dex/* branch: $LATEST_DEX"
git log --oneline "$LATEST_DEX" | head -20
```

You need at least 4–5 commits on the branch to make "fork from a mid-history commit" meaningful.

## Configuration

| Param | Default | Override |
|---|---|---|
| Agent backend | `mock` | reply with `agent: claude` (or another supported backend) |

The loop will run again as part of step 3, so the agent backend matters. Same convention as `001-first-two-features.md`:

1. **Confirm the agent choice with the user** before starting (skip if the user already named one in the invocation prompt).
2. **Seed `<projectDir>/.dex/dex-config.json`** with `{ "agent": "<chosen>" }` — but only if it is missing or differs from the chosen value. Do **not** wipe it; the prerequisite state may already have it set.

```bash
cat /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json 2>/dev/null \
  || echo '{ "agent": "mock" }' > /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
```

## Definition of Done

- [ ] Agent backend is confirmed with the user and `.dex/dex-config.json` reflects the choice before the loop runs.
- [ ] Clicking a **historical** commit (not the branch tip) in the Timeline creates a new `selected-<ts>` branch locally, with HEAD checked out at the chosen commit.
- [ ] After the fork, the **Timeline tab** displays the new `selected-<ts>` branch in the graph (visually distinct from the original `dex/*` branch).
- [ ] After the fork, the **Steps tab** reflects the orchestrator state **at the fork-point commit** — correct phase, correct step, matching the `[checkpoint:<stage>:<cycle>]` stamp on that commit. It must not still be showing the state at the original branch tip.
- [ ] Clicking **Start** on the loop dashboard kicks off a run on the `selected-<ts>` branch.
- [ ] While the continuation run is in progress, clicking **Pause** transitions the Steps tab into a coherent paused state: **exactly one** step (the one currently running) shows the paused indicator; no steps are rendered with strikethrough/crossed-out styling; previously-completed steps remain green; not-yet-started steps remain unstyled grey. No step before the currently-running one may be drawn as skipped.
- [ ] New commits produced by the loop land on the `selected-<ts>` branch.
- [ ] The **original** `dex/*` branch tip is unchanged — `git rev-parse <original-dex-branch>` returns the same SHA before and after the run.
- [ ] `git status` is clean after the run completes (no orphaned working-tree changes).
- [ ] After fully closing and reopening the Dex app on the same project, the app restores into the `selected-<ts>` branch context: the **Resume** button is visible in the loop dashboard header, the **Steps tab** reflects the persisted phase/step state (same content as before the close), and the **Timeline tab** still draws the `selected-<ts>` branch in the graph. The Steps tab must NOT regress to the "Autonomous Loop / Start Autonomous Loop" empty-run screen.

## Pass / Fail criteria

- **PASS** — every Definition-of-Done item above is satisfied AND no failure mode called out in steps 2–4 was observed.
- **FAIL** — any DoD item is unsatisfied, OR any failure mode triggered (no fork, HEAD didn't move, Steps tab didn't update, commits on wrong branch, loop refused to start with state-mismatch), OR execution was aborted before verification completed.

The Reporting section below MUST conclude with an explicit `PASS` or `FAIL` verdict on its own line. Do not omit the verdict, even if the run ended early — in that case report `FAIL` and explain where it stopped.

## Steps

### 1. Identify the branch and pick a fork point

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
LATEST_DEX=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/dex/ | head -1)
git log --oneline "$LATEST_DEX"
```

Pick a commit roughly **mid-history** on `$LATEST_DEX` (not the tip, not the very first commit). Record:

- The original branch name (`$LATEST_DEX`).
- The original branch tip SHA: `git rev-parse "$LATEST_DEX"` — you'll compare against it in the verification step.
- The fork-point commit's SHA and short subject.

If multiple `dex/*` branches exist and the choice is ambiguous, **confirm the branch and the fork-point commit with the user** before proceeding.

### 2. Fork from the chosen commit via the Timeline UI

Make sure the dev server is running (06-testing.md § 4c Step 2). Open the app, fill the welcome screen and click **Open Existing**.

Navigate to the **Timeline** view. Locate the original `dex/*` branch in the graph and click the historical commit you picked in step 1. The 010-interactive-timeline behavior must mint a `selected-<ts>` branch at that commit and switch HEAD to it.

**Before** clicking Start, verify the UI reflects the fork — both tabs:

1. **Timeline tab** — the graph now shows a new `selected-<ts>` branch diverging from the original `dex/*` branch at the chosen commit. The original `dex/*` branch is still drawn (unchanged); the new branch is visually distinct (own color / lane / label). Capture a snapshot.

2. **Steps tab** — the phase/step view now shows the orchestrator state **at the fork-point commit**, not at the original branch tip. Cross-check by reading the `[checkpoint:<stage>:<cycle>]` stamp on the fork-point commit (substitute the SHA you recorded in step 1):

   ```bash
   git log -1 --pretty=%B <fork-point-sha> | grep -E '^\[checkpoint:'
   ```

   The Steps tab must show that same `<stage>` as the most recent completed step in `<cycle>`, with subsequent steps unmarked. If the Steps tab is still showing the original branch tip's state (a later stage / later cycle), the fork did not propagate to the orchestrator state — flag this as a bug and capture a screenshot.

Then verify at the git level:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch --show-current               # should be selected-<ts>
git rev-parse HEAD                      # should equal the fork-point commit SHA from step 1
git branch | grep '^[[:space:]]*selected-'   # should list exactly one selected-* branch
```

### 3. Continue the loop from the selected branch

On the loop dashboard, click **Start** (or **Resume** — whichever label the UI shows for the selected-* branch state).

Observe via UI snapshots, `~/.dex/dev-logs/electron.log`, and `~/.dex/logs/dex-ecommerce/<runId>/` until the loop reaches a terminal stage. Confirm `status: succeeded` via the DEBUG badge or `<projectDir>/.dex/runs/<runId>.json`.

### 3a. Exercise Pause mid-run and verify the Steps tab

**While the continuation run is still in progress** (i.e. before the loop terminates in step 3), click the **Pause** button in the loop dashboard. Capture a snapshot of the Steps tab while paused.

Verify the rendering rules — every bullet below is a hard pass/fail:

- **Exactly one** step row displays the paused indicator (orange filled Pause icon inside an orange ring, label bold orange, `paused` badge on the right). Cross-check the identity of that step against `<projectDir>/.dex/state.json::currentStage` and `currentCycle`.
- The paused indicator lands on the step the orchestrator was actually executing — never on the *next* not-yet-started step (e.g. if Pause hit during `plan`, `Implement` must remain plain pending, not paused).
- All steps **before** the paused step are green ✓ completed.
- All steps **after** the paused step are plain pending — light-grey empty circle, **no icon inside**. They must not be drawn with the dimmed grey minus (`skipped`) icon, and they must not be drawn with strikethrough/crossed-out text.
- Steps that gap-analysis would normally hide on a `RESUME_FEATURE` cycle (`Specify`, `Tasks`, sometimes `Plan`) must remain **visible** in the list throughout the pause. Pause must not change the visible-stages set — disappearing rows when the user pauses is a regression of `getStageVisibility` conflating `cycle.decision === "stopped"` with a gap-analysis skip.
- The cycle headers above the paused cycle are all green; the paused cycle's header shows the in-progress indicator. The top `Dex Loop` phase chip shows the orange paused (⏸) icon; no other phase chip is paused.

Failure modes to flag explicitly:

- Two or more step rows show the paused indicator simultaneously (e.g. both `Plan` and `Implement` paused) → either the state machine is reporting multiple in-flight steps, OR `resolvePausePendingStage` is firing alongside an `actual.status === "stopped"` record (regression of the StageList.logic.ts fix).
- A step earlier than the paused step renders with strikethrough/crossed-out → Steps tab is misclassifying a completed step as skipped.
- The currently-executing step renders with the dimmed grey minus icon (`StatusDot status="skipped"`) instead of the orange paused indicator → `deriveStageStatus` is short-circuiting on `getStageVisibility === "skip"` before the `actual` block (regression of the same fix).
- `Tasks` (or `Specify` on a `RESUME_FEATURE` cycle) disappears from the list when Pause is clicked → `getStageVisibility` is treating `cycle.decision === "stopped"` like a gap-analysis skip.
- The paused indicator lands on a step that does not match `state.json::currentStage` → renderer is inferring stage from a stale event.

Then click **Resume** and let the run finish before moving to step 4. Re-snapshot the Steps tab once the run completes; all steps and cycles up to the terminal stage must be green, none crossed, none drawn as skipped.

### 4. Verify the new commits landed on the selected branch

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
SELECTED=$(git branch --show-current)
echo "Selected branch: $SELECTED"

# New commits on the selected branch (anything past the fork point):
git log --oneline "$SELECTED" ^"$LATEST_DEX"

# Original branch tip is unchanged:
git rev-parse "$LATEST_DEX"   # must equal the value recorded in step 1
```

Expected:

- `git log --oneline $SELECTED ^$LATEST_DEX` lists one or more new commits — the work the loop did on the selected branch.
- The original `dex/*` branch tip SHA matches what you recorded in step 1.
- `git status` is clean.

Failure modes to flag explicitly:

- No `selected-<ts>` branch was created → the click handler in the Timeline isn't forking; check renderer console (`mcp__electron-chrome__list_console_messages`) and `electron.log` for IPC errors on the fork action.
- HEAD did not move to the fork point → the fork created a branch but didn't check it out; UI/state mismatch.
- New commits landed on the original `dex/*` branch (its SHA changed) → the orchestrator did not honour the selected branch; bug in the resume-on-selected-* path.
- Loop refused to start with an empty-branch / state mismatch error → orchestrator state reconciliation didn't pick up the fork; check `~/.dex/logs/.../run.log` for the relevant detection lines.

### 5. Close and reopen the app — verify state restoration on the selected branch

Fully close the Dex app (window close, not just minimize). Confirm via `pgrep -fa "electron .*dex"` that the main process has exited. Then re-launch via `dev-setup.sh` (per 06-testing.md § 4c Step 2) and re-open the `dex-ecommerce` project from the welcome screen.

Verify on landing:

- The breadcrumb / branch indicator at the top of the loop dashboard reads `selected-<ts>` (the same branch you forked onto in step 2). `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce branch --show-current` independently confirms HEAD.
- The loop dashboard header shows a **Resume** button (purple, top-right). It must NOT show the "Autonomous Loop / Start Autonomous Loop" empty-run kickoff screen.
- The **Steps tab** shows the same persisted phase/step structure that was visible before the close — the same cycle expansion state, the same completed/in-progress/paused markers, the same cycle count. An empty Steps tab pointing at the "Start Autonomous Loop" form is a regression.
- The **Timeline tab** still draws the `selected-<ts>` branch in the graph at the fork-point commit.

Capture snapshots of (1) the loop dashboard header showing Resume, (2) the Steps tab, (3) the Timeline tab.

Failure modes to flag explicitly:

- After reopen, the Steps tab shows the "Autonomous Loop / Start Autonomous Loop" kickoff form → state.json/runs/<runId>.json was not rehydrated for the `selected-<ts>` branch; check `<projectDir>/.dex/state.json` and `<projectDir>/.dex/runs/` on disk to confirm the artifacts still exist, then walk the renderer's project-load path.
- After reopen, the Resume button is missing but the Steps tab does show data → header is not reading the persisted run state; bug in the loop-dashboard header logic.
- After reopen, HEAD is on `main` or on the original `dex/*` branch instead of `selected-<ts>` → app restoration is checking out a different branch than the one in use at close. Compare against the value the DEBUG badge reported just before close.
- After reopen, `selected-<ts>` no longer exists locally (`git branch | grep selected-` is empty) → branch was pruned on shutdown; check the timeline-fork lifecycle code in `src/core/checkpoints/branchOps.ts` for any auto-cleanup paths that fire on app close.

## Reporting

Capture:

- Original `dex/*` branch name + tip SHA (before and after).
- Fork-point commit SHA + subject.
- New `selected-<ts>` branch name.
- New commits the loop produced on the selected branch (`git log --oneline $SELECTED ^$LATEST_DEX`).
- Run id, terminal stage, run status for the continuation run.
- UI snapshots:
  - **Timeline tab** immediately after the fork — showing the new `selected-<ts>` branch alongside the original `dex/*` branch.
  - **Steps tab** immediately after the fork — showing the phase/step state at the fork-point commit.
  - **Steps tab while paused** during the continuation run (step 3a) — showing exactly one paused step and no crossed-out steps.
  - Timeline tab post-run — showing the new commits stacked on `selected-<ts>`.
  - Loop dashboard header + Steps tab + Timeline tab **after close/reopen** (step 5) — showing Resume button, persisted step state, and `selected-<ts>` still drawn.
- Pass/fail status against each DoD item, with pointers to logs / screenshots backing each claim.
- An explicit `PASS` or `FAIL` verdict on its own line at the end of the report, per the Pass / Fail criteria above.
