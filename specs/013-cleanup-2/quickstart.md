# Phase 1 — Quickstart

**Feature**: Branch Namespace + Record-mode Cleanup (`013-cleanup-2`)
**Audience**: The engineer landing this cleanup. Treat this as a runbook.

This walkthrough takes you from a clean `013-cleanup-2` branch to a verified merge candidate. The companion README in `docs/my-specs/013-cleanup-2/README.md` has the file-level execution detail (what to delete in each file, line numbers, deletion sequence). This document handles the **harness** around that — pre-flight, build/test gates between steps, and the end-to-end DoD verification that needs the running app.

---

## 0. Prerequisites

```bash
# You should be on the feature branch already (created by /speckit.specify hook)
cd /home/lukas/Projects/Github/lukaskellerstein/dex
git status                                    # working tree clean
git rev-parse --abbrev-ref HEAD              # → 013-cleanup-2

# Dev harness
./dev-setup.sh                               # starts Vite + Electron in the background
mcp                                          # confirm the electron-chrome MCP is connected
```

The `electron-chrome` MCP must be reachable on CDP port 9333 — UI-touching DoD steps depend on it.

---

## 1. Pre-flight grep audit

Run before touching any code. The expected hits are documented in [README §11 Pre-flight grep](../../docs/my-specs/013-cleanup-2/README.md#implementation-order). If anything beyond what's listed in the file map appears, **stop and update the spec** — do not proceed.

```bash
grep -rn "promoteToCheckpoint" src/ | grep -v test
grep -rn "autoPromoteIfRecordMode" src/ | grep -v test
grep -rn "checkpointDoneTag" src/ | grep -v test
grep -rn "captureBranchName\|captureBranches\|capture/" src/ | grep -v test
grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge" src/ | grep -v test
grep -rn "checkpoint_promoted" src/ | grep -v test
grep -rn "attemptBranchName\|AttemptInfo\|attempt-" src/ | grep -v test
grep -rn "stash uncommitted changes on a new branch\|attempt-…-saved\|Save on a new branch" src/
```

Each grep that appears in this list is paired with an expected set of hits in the README's [Why this is safe](../../docs/my-specs/013-cleanup-2/README.md#why-this-is-safe) section. The audit is fast (< 1 minute total).

---

## 2. Implementation, step by step

Follow the numbered steps in [README §11 Implementation order](../../docs/my-specs/013-cleanup-2/README.md#implementation-order). Each numbered step ends with the gate sequence below — do not advance to the next step with red gates.

```bash
# After every numbered step:
npx tsc --noEmit                # types must pass
npm test                         # unit tests must pass
npm run lint                     # lint must pass
```

The constitution mandates this gate (Principle III). Spec NFR-001 reaffirms it. Sequencing matters at one specific transition — **step 7b**, where the `events.ts` discriminant deletion lands after both `checkpoint_promoted` producers are gone. Both gates fail if you re-order steps 7 and 7b.

---

## 3. Definition of Done — runtime verification

Type-checks and unit tests prove the *types* are right. The DoD below proves the *behaviour* is right. Run all of these against the example project (`dex-ecommerce`).

### 3.1 — Reset the example project

```bash
./scripts/reset-example-to.sh clean
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
# Expected: only GOAL.md and .git/ visible
```

### 3.2 — Resume regression check (DoD #3, spec SC-004)

Goal: confirm the relocated `syncStateFromHead` still works.

```bash
# Pick a mid-run checkpoint
./scripts/reset-example-to.sh list | head -20
./scripts/reset-example-to.sh <some checkpoint/cycle-N-after-tasks>
```

Then in the app: open the example project. Welcome submit reads **Open Existing**. Loop page primary button reads **Resume**. Click **Resume**.

Expected: the orchestrator skips `prerequisites`, reuses the existing `runId`, resumes from the next stage after `state.lastCompletedStage`. Spot-check `~/.dex/logs/dex-ecommerce/<runId>/run.log` — the resumed `runId` matches the pre-existing one.

### 3.3 — One full autonomous loop, then audit the git state (DoD #4, #5, #6, #10; spec SC-002, SC-003)

```bash
./scripts/reset-example-to.sh clean
```

In the app: welcome screen → fill in `dex-ecommerce` path → submit `Open Existing` → on the Loop page toggle **Automatic Clarification** on → click **Start Autonomous Loop** → wait for completion.

Then audit the example project's git state:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

git branch --list 'capture/*'                 # expected: empty
git tag --list 'checkpoint/done-*'             # expected: empty
git tag --list 'checkpoint/*'                  # expected: empty (no auto-promoted tags)
git log --grep='^\[checkpoint:' --oneline      # expected: per-step commits exist (with [checkpoint:...] subjects)
git branch --list 'attempt-*'                  # expected: empty
```

The first four are SC-002 / SC-003. The last is SC-002 again (the `attempt-*` carve-out is fixture-only and does not run during a normal loop — only `reset-example-to.sh` mints them).

### 3.4 — Promote-script regression (DoD #7)

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex
./scripts/promote-checkpoint.sh /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce manual-013-test
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag --list 'checkpoint/manual-013-test'
# Expected: one match.

./scripts/reset-example-to.sh manual-013-test
# Expected: working tree restored to that checkpoint.

# Cleanup
git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag -d checkpoint/manual-013-test
```

### 3.5 — REC badge gone under all three trigger conditions (DoD #8, #9; spec SC-005)

For each of the three conditions below, restart the dev harness with the trigger applied, open the example project, and use MCP to snapshot the topbar:

```bash
# Trigger A — default (no env var, no state-file flag)
DEX_RECORD_MODE= ./dev-setup.sh

# Trigger B — env var
DEX_RECORD_MODE=1 ./dev-setup.sh

# Trigger C — hand-edited state.json (after first opening the project)
jq '.ui.recordMode = true' /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/state.json > /tmp/x.json && mv /tmp/x.json /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/state.json
./dev-setup.sh
```

In each case use `mcp__electron-chrome__take_snapshot` against the topbar and assert no element with the `RecBadge` testid is present and no "REC" text is rendered.

### 3.6 — Dirty-tree-save commits on current branch (DoD #11; spec SC-001, US1)

Sequence inside the running app:

1. Open the example project (any state).
2. Modify a tracked file in the project — e.g. `echo '// dirty' >> dex-ecommerce/src/<some file>`.
3. In the timeline, click a different node from where HEAD is.
4. The Go-Back confirm dialog should appear. **Capture the dialog body and the Save button label** via `mcp__electron-chrome__take_snapshot` — verify:
   - Save button reads **"Save"** (not "Save on a new branch").
   - Body contains "Save commits these changes to the current version so you can keep working with them later."
   - No occurrence of "branch", "attempt-", or "new branch" anywhere in the dialog text.
5. Click **Save**.
6. After the jump completes:

   ```bash
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

   # No new branch was created
   git branch --list | wc -l                    # same count as before the click

   # The pre-jump commit landed on the previous branch with the new subject
   git log --grep='^dex: pre-jump autosave' --oneline
   # Expected: at least one commit found.
   ```

### 3.7 — Detached-HEAD save refusal (DoD #12, US1 acceptance #3)

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git checkout <some checkpoint commit SHA>      # detach HEAD
echo '// dirty' >> README.md                  # modify a tracked file
```

In the app: click any timeline node, pick **Save** in the dialog. Expected: friendly refusal message, no commit is created on any branch (`git log --all --grep='^dex: pre-jump autosave'` count unchanged), and the timeline does not jump.

### 3.8 — Save on `selected-*` (DoD #13, US1 acceptance #2)

```bash
# Get onto a selected-* branch by jumping to a mid-branch ancestor that forces
# the navigation-fork path. The orchestrator's existing logic mints the
# selected-* branch on the click; you just need to trigger it.
```

In the app: jump to a checkpoint *inside* an existing run branch (not at the tip). Confirm a new `selected-<...>` branch was created. Modify a tracked file. Click another timeline node, pick **Save**. Expected:

- The autosave commit lands on the `selected-*` branch (not on `main`, not on `dex/*`).
- HEAD jumps to the click target.
- The original `selected-*` branch survives the post-jump auto-prune (because the new commit makes it non-empty relative to the jump target).
- The autosave commit is reachable from the timeline's `selected-*` lane and click-to-jump returns to it.

### 3.9 — Visual sweep (DoD #14)

`mcp__electron-chrome__take_screenshot` of:

- The topbar, before-and-after the cleanup, confirming the badge slot is gone or collapsed cleanly.
- The timeline, confirming no `attempt-*` or `capture/*` lanes anywhere.

---

## 4. Final pre-merge sweep

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex

# All non-test code in src/ should be clean:
grep -rn "recordMode\|DEX_RECORD_MODE\|RecBadge\|capture/\|captureBranch\|checkpointDoneTag\|autoPromoteIfRecordMode\|promoteToCheckpoint\|readRecordMode\|checkpoint/done-\|attemptBranchName\|AttemptInfo\|attempt-" src/ | grep -v test
# Expected: zero hits.

# Scripts should be clean except the deliberate fixture line:
grep -rn "attempt-\|capture/" scripts/
# Expected: only scripts/reset-example-to.sh:14 (file-header comment) and :53 (the attempt-${STAMP} mint).

# Final gate:
npx tsc --noEmit && npm test && npm run lint
```

---

## 5. Documentation punch list

The same PR also touches these non-source files (per spec NFR-002 and the [Out of scope / follow-ups](../../docs/my-specs/013-cleanup-2/README.md#out-of-scope--follow-ups) doc-update list):

- `CLAUDE.md` — `## On-Disk Layout` block (around lines 79-80) and any `attempt-*` / `capture/*` / `recordMode` mentions throughout the file.
- `.claude/rules/06-testing.md:48` — clarify `attempt-<ts>` minting is fixture-only.
- `.claude/rules/06-testing.md:75` — branch hygiene paragraph: rewrite to say only the fixture script produces `attempt-*`; the 30-day rule applies only to fixture project.
- `docs/my-specs/01X-state-reconciliation/README.md:110` — table cites `attempt-*` branches; annotate as pre-013 or update.
- `docs/my-specs/008-interactive-checkpoint/README.md` and `docs/my-specs/010-interactive-timeline/README.md` — add a one-line "Superseded in 013-cleanup-2" banner at the top of each. **Do not rewrite** — historical specs are immutable.

---

## 6. Open the PR

After all gates above are green:

1. Push the branch.
2. Open a PR titled `013-cleanup-2: branch namespace + Record-mode cleanup` against `main`.
3. Link the spec, the README, and a one-paragraph summary of the user-visible change (the Go-Back dialog copy / button label).
4. Reviewers should re-run the pre-flight greps and the DoD subset they care about.

The user is the only commit-authoriser on this repo (per CLAUDE.md). Do not commit until they explicitly request it.
