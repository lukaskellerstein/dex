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
- [ ] Clicking **Start** on the loop dashboard kicks off a run on the `selected-<ts>` branch.
- [ ] New commits produced by the loop land on the `selected-<ts>` branch.
- [ ] The **original** `dex/*` branch tip is unchanged — `git rev-parse <original-dex-branch>` returns the same SHA before and after the run.
- [ ] `git status` is clean after the run completes (no orphaned working-tree changes).

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

Verify immediately, without leaving the UI:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch --show-current               # should be selected-<ts>
git rev-parse HEAD                      # should equal the fork-point commit SHA from step 1
git branch | grep '^[[:space:]]*selected-'   # should list exactly one selected-* branch
```

Capture a snapshot of the Timeline UI showing the new branch.

### 3. Continue the loop from the selected branch

On the loop dashboard, click **Start** (or **Resume** — whichever label the UI shows for the selected-* branch state).

Observe via UI snapshots, `~/.dex/dev-logs/electron.log`, and `~/.dex/logs/dex-ecommerce/<runId>/` until the loop reaches a terminal stage. Confirm `status: succeeded` via the DEBUG badge or `<projectDir>/.dex/runs/<runId>.json`.

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

## Reporting

Capture:

- Original `dex/*` branch name + tip SHA (before and after).
- Fork-point commit SHA + subject.
- New `selected-<ts>` branch name.
- New commits the loop produced on the selected branch (`git log --oneline $SELECTED ^$LATEST_DEX`).
- Run id, terminal stage, run status for the continuation run.
- UI snapshots: Timeline at fork moment, post-run state.
- Pass/fail status against each DoD item, with pointers to logs / screenshots backing each claim.
