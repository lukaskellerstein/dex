# US2 — Promote (clean merge)

Tests for `mergeToMain` clean-merge path + `computePromoteSummary` + `<BranchContextMenu>` + `<PromoteConfirm>`. Spec source: spec.md user story 2; quickstart.md recipes 2A–2D.

---

## 2A — Clean promote end-to-end (happy path)

**Goal**: Right-click → "Make this the new main" → Confirm → merge commit on main, source branch deleted, success toast.

**Maps to**: FR-008, FR-010, FR-014, US2-AS1, US2-AS2, US2-AS3.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F7 — clean-promote**.
3. `node scripts/test-014-cdp.mjs open`.
4. Sanity: `node scripts/test-014-cdp.mjs snap` shows `branch-badge-dex/2026-05-04-clean` and `branch-badge-main`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "branch-context-menu" 2000
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "promote-summary-stats" 5000
node scripts/test-014-cdp.mjs modal "promote-summary-stats"
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "timeline-toast" 5000
node scripts/test-014-cdp.mjs modal "timeline-toast"
```

### Expected final state

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# A merge commit was created on main with the canonical subject.
git log -1 --format=%s main
# → "dex: promoted dex/2026-05-04-clean to main"

# Two parents → --no-ff topology preserved.
git log -1 --format=%P main | tr ' ' '\n' | wc -l
# → 2

# Source branch is gone.
git branch --list 'dex/*'
# → empty

# HEAD on main.
git rev-parse --abbrev-ref HEAD
# → "main"

# CRITICAL regression check: NO checkpoint/promoted-* tag was created.
git tag --list 'checkpoint/promoted-*'
# → empty
```

**UI side**:

- `timeline-toast` text: `"dex/2026-05-04-clean is now main. The old version has been removed."`
- The dex/* lane is gone from the timeline.
- The HEAD halo is on the most recent step-commit on main.

### Visual cues

#### Step 1 — Right-click opens the context menu

- A small floating menu appears anchored at the cursor position with a single item labelled **"Make this the new main"**.
- The item has hover affordance (background lightens to `var(--surface-hover)` on mouse-over).

#### Step 2 — Click → confirmation modal

Modal title: **"Replace main with this version?"**

Modal body:

- Plain-English explanation paragraph.
- A monospace stat line with format like `3 files changed · +5 -1 (+5 -1)` — green `+5`, red `-1`, dim `(+5 -1)` parenthetical.
- A scrollable file-path list (top-5) in monospace, fontsize ~11px, in a bordered surface-elevated panel, max-height ~110px before expansion.
- An expander button labelled `View all changes (+0)` — disabled when there are 5 or fewer files.

Footer: two buttons: **`Cancel`** (secondary) and **`Make this the new main`** (primary).

#### Step 3 — Confirm → success toast

- Modal fades out.
- The timeline canvas redraws within ~1–2 seconds: the dex/* lane disappears, main acquires a new step-commit (the merge commit).
- A green-bordered banner above the canvas with the success message + a ✕ button.

### Common failures

- **`promote-summary-stats` shows `0 files changed`** — the dex/* branch's commits are also reachable from main (e.g. main was already at the same SHA). Re-stage F7.
- **No success toast** — check `electron.log` for `mergeToMain: clean merge` line. If absent, the IPC didn't run; check `withLock` isn't held.

### Cleanup

`[run cleanup helper]`

---

## 2B — `--no-ff` topology preserved (regression check)

**Goal**: Verify the merge commit always has 2 parents, even when fast-forward would have been valid.

**Maps to**: FR-011, design decision in plan.md "Drop `unselect` outright".

### Pre-flight

Same as 2A.

### Actions

Same as 2A through `promote-confirm`. After success:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git log --merges -1 main
# → A merge commit
```

### Expected verification

```sh
parents=$(git log -1 --format=%P main | tr ' ' '\n' | wc -l)
test "$parents" -eq 2 && echo "PASS: --no-ff topology" || echo "FAIL: parent count $parents"
```

### Visual cues

After the promote, the timeline canvas shows a **fork-and-rejoin shape**:

- A vertical lane for the deleted dex/* branch's history (now visible only as the second parent's lineage).
- A merge-back edge (right-angle path with rounded corner) from the dex/* branch's tip back into the main lane.
- The merge commit on main is rendered as a **hollow circle** (per `TimelineGraph.tsx` — `n.isMerge` → `<circle fill={SURFACE_COLOR} stroke={dotColor} />`).

---

## 2C — NO `checkpoint/promoted-*` tag (regression)

**Goal**: Verify earlier draft's "tag every promote" idea was correctly dropped.

**Maps to**: plan.md complexity-tracking note "No new tag on promote", DoD #6.

### Pre-flight + Actions

Same as 2A.

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
test -z "$(git tag --list 'checkpoint/promoted-*')" && echo "PASS: no promoted tags" || echo "FAIL: tags exist"
```

### Visual cues

- The merge commit on main does NOT have a red ring around it (red rings indicate `kept` state — see `ringFor()` in `TimelineGraph.tsx`).

---

## 2D — Source branch deleted post-merge

**Goal**: Verify the source branch is automatically removed after a successful merge.

**Maps to**: FR-014.

### Pre-flight + Actions

Same as 2A.

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch --list dex/2026-05-04-clean
# → empty (line is gone)
```

### Visual cues

- The `branch-badge-dex/2026-05-04-clean` testid is no longer in the page snapshot.
- The dex/* lane on the timeline canvas is gone.

---

## 2E — HEAD lands on main

**Goal**: Verify HEAD is on `main` after a successful merge regardless of where it started.

**Maps to**: FR-014, edge case for HEAD-handling.

### Pre-flight

Same as 2A — but additionally, before clicking promote, set HEAD to the source branch:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git checkout -q dex/2026-05-04-clean
```

Refresh the renderer: `node scripts/test-014-cdp.mjs reload`.

### Actions

Same right-click + confirm sequence as 2A.

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git rev-parse --abbrev-ref HEAD     # → "main"
```

---

## 2F — Success toast shows the right text

**Goal**: Verify the toast message matches `copy.ts:POST_MERGE_TOAST`.

**Maps to**: FR-014, copy.ts.

### Pre-flight + Actions

Same as 2A.

### Expected verification

```sh
node scripts/test-014-cdp.mjs modal "timeline-toast"
# .text contains: "dex/2026-05-04-clean is now main. The old version has been removed."
```

### Visual cues

- Toast banner is **green** (passed `var(--status-success)`), thin border, monospace ✕ on the right edge. Auto-dismisses only when the user clicks ✕ — there is no time-based auto-dismiss in v1 (see README known limitation).

---

## 2G — Mid-run refused (source branch active)

**Goal**: Promote is refused when state.json reports the orchestrator running on the source.

**Maps to**: FR-012, US2-AS4.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F6 — mid-run-state**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-active"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-active"
sleep 1
node scripts/test-014-cdp.mjs snap   # inspect alerts[]
```

### Expected verification

`alerts` contains: `"This version is currently being built — pause the run first."` (from `copy.ts:PROMOTE_MID_RUN_BRANCH`).

### Visual cues

- The promote-confirm modal opens briefly (the IPC for `promoteSummary` succeeds), but as soon as the user clicks confirm, the IPC for `mergeToMain` returns refused and a red error banner appears. Test by NOT clicking confirm — instead just snap right away to catch the state.
- Actually wait: the refusal happens at confirm time, not at right-click time. So you DO need to click the confirm button first to trigger the refusal.

### Refined actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-active"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-active"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
sleep 2
node scripts/test-014-cdp.mjs snap   # alerts[] should now have the message
```

### Cleanup

```sh
cd dex-ecommerce && rm -f .dex/state.json
[run cleanup helper]
```

---

## 2H — Mid-run refused (main is the active branch)

**Goal**: Promote is refused when state.json reports the orchestrator running on `main`.

**Maps to**: FR-012.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F7 — clean-promote** AND additionally write `.dex/state.json` while HEAD is on main:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout -q main
   mkdir -p .dex
   cat > .dex/state.json <<'EOF'
   {"version":1,"runId":"main-mid-run","status":"running","baseBranch":"main","mode":"loop"}
   EOF
   ```
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
sleep 2
node scripts/test-014-cdp.mjs snap
```

### Expected verification

`alerts` contains: `"Main is currently being built — pause the run first."` (from `copy.ts:PROMOTE_MID_RUN_MAIN`).

### Cleanup

```sh
cd dex-ecommerce && rm -f .dex/state.json
[run cleanup helper]
```

---

## 2I — No-primary refusal

**Goal**: When neither `main` nor `master` exists, promote refuses with `no_primary_branch`.

**Maps to**: edge case in spec.md, FR core fn check.

### Pre-flight

Hard to reproduce naturally. Use:

1. `bash scripts/reset-example-to.sh pristine`.
2. Manually:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout -q -b dex/2026-05-04-orphan
   git branch -D main
   ```
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-orphan"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-orphan"
sleep 1
node scripts/test-014-cdp.mjs snap
```

### Expected verification

`alerts` contains a `PROMOTE_FAILED("no primary version exists in this project")` message.

### Cleanup

```sh
cd dex-ecommerce && git branch main && git checkout -q main
[run cleanup helper]
```

---

## 2J — Dirty tree → save → proceeds

**Goal**: Working tree has uncommitted changes when promote is triggered. The existing `<GoBackConfirm>` modal opens; choosing Save commits to current branch and the merge proceeds.

**Maps to**: FR-013, US2-AS5.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture F7.
3. Add a dirty edit:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout -q main
   echo "scratch edit" >> README.md
   ```
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
# GoBackConfirm modal should open. There's no testid, so click by button text.
node scripts/test-014-cdp.mjs eval "
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save');
  btn?.click();
  return { saveClicked: !!btn };
"
node scripts/test-014-cdp.mjs wait "timeline-toast" 8000
node scripts/test-014-cdp.mjs modal "timeline-toast"
```

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
# Autosave commit exists with the canonical subject.
git log main --grep='^dex: pre-promote autosave' --oneline | head -1
# → one line; the autosave commit lives on main
# Source branch deleted, HEAD on main.
git rev-parse --abbrev-ref HEAD     # → "main"
git branch --list 'dex/*'            # → empty
```

### Visual cues

- After the promote-confirm click, a different modal opens titled **"Uncommitted changes — how to proceed?"** (this is the existing `<GoBackConfirm>` modal).
- It has 3 buttons: `Cancel`, `Discard`, `Save`.
- After clicking Save: the modal closes, brief delay (~1s) for the autosave + merge, then the success toast appears.

---

## 2K — Dirty tree → discard

**Goal**: Discard option drops uncommitted edits and the merge proceeds.

**Maps to**: FR-013.

### Pre-flight + Actions

Same as 2J but click `Discard` instead of `Save`.

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
# README.md is back to its pre-edit state.
git diff HEAD~1 README.md | wc -l    # → 0 (no diff vs the previous commit)
# No autosave commit was created.
git log main --grep='pre-promote autosave' --oneline | wc -l  # → 0
# Promote succeeded.
git rev-parse --abbrev-ref HEAD     # → "main"
git branch --list 'dex/*'            # → empty
```

---

## 2L — Dirty tree → cancel keeps everything

**Goal**: Cancel on the dirty-tree dialog leaves both the working tree edits AND the source branch intact.

**Maps to**: FR-013.

### Pre-flight + Actions

Same as 2J but click `Cancel` instead of `Save`.

### Expected verification

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git status --short                   # → " M README.md" (still dirty)
git branch --list 'dex/*'            # → "dex/2026-05-04-clean" still present
git log main --grep='pre-promote autosave' --oneline | wc -l  # → 0
```

### Visual cues

- The GoBackConfirm modal closes; no other modal opens; no toast.

---

## 2M — Right-click context menu opens correctly

**Goal**: Verify `<BranchContextMenu>` appears at the right position on right-click.

**Maps to**: FR-008.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture F7.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
sleep 1
node scripts/test-014-cdp.mjs eval "
  const menu = document.querySelector('[data-testid=\"branch-context-menu\"]');
  if (!menu) return { found: false };
  const item = menu.querySelector('[data-testid=\"promote-menu-item-dex/2026-05-04-clean\"]');
  return {
    found: true,
    label: item?.textContent ?? null,
    enabled: !item?.hasAttribute('disabled'),
    fixedPosition: menu.style.position === 'fixed',
  };
"
```

### Expected return

```json
{ "found": true, "label": "Make this the new main", "enabled": true, "fixedPosition": true }
```

### Outside-click closes the menu

```sh
node scripts/test-014-cdp.mjs eval "
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 200));
  return { stillOpen: !!document.querySelector('[data-testid=\"branch-context-menu\"]') };
"
```

Returns `{ stillOpen: false }`.

### Escape key closes the menu

```sh
node scripts/test-014-cdp.mjs eval "
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  return { stillOpen: !!document.querySelector('[data-testid=\"branch-context-menu\"]') };
"
```

Returns `{ stillOpen: false }`.

---

## 2N — Promote menu disabled on `main` with tooltip

**Goal**: Right-clicking `main` opens the menu but the item is disabled with the right tooltip.

**Maps to**: FR-009, US2-AS6.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-main"
sleep 1
node scripts/test-014-cdp.mjs eval "
  const item = document.querySelector('[data-testid=\"promote-menu-item-main\"]');
  return {
    found: !!item,
    disabled: item?.hasAttribute('disabled'),
    tooltip: item?.getAttribute('title'),
    enabled: item ? !item.hasAttribute('disabled') : null,
  };
"
```

### Expected return

```json
{ "found": true, "disabled": true, "tooltip": "This version can't be made the new main.", "enabled": false }
```

### Visual cues

- Menu opens normally.
- The "Make this the new main" item is rendered with reduced opacity (`var(--foreground-dim)` color) and `cursor: not-allowed`.
- Hovering shows the tooltip.

---

## 2O — Promote menu disabled on user branches

**Goal**: User branches outside Dex's namespace get the disabled menu item.

**Maps to**: FR-009.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F5 — user-branch-and-dex**.
3. `cd dex-ecommerce && git checkout -q feature/foo` (so feature/foo becomes the currentBranch and shows on the timeline).
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-feature/foo"
sleep 1
node scripts/test-014-cdp.mjs eval "
  const item = document.querySelector('[data-testid=\"promote-menu-item-feature/foo\"]');
  return { found: !!item, disabled: item?.hasAttribute('disabled') };
"
```

### Expected return

`{ found: true, disabled: true }`.

### Cleanup

```sh
cd dex-ecommerce && git checkout -q main
[run cleanup helper]
```

---

## 2P — Diff summary shows the right counts

**Goal**: `<PromoteConfirm>` renders the file count + +/- line counts that match `git diff --shortstat`.

**Maps to**: FR-010, research.md R2.

### Pre-flight

Same as 2A (fixture F7).

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-clean"
node scripts/test-014-cdp.mjs wait "promote-summary-stats" 5000
node scripts/test-014-cdp.mjs modal "promote-summary-stats"
```

### Expected verification

The modal text contains a phrase matching `<n> files changed · +<a> -<b> (+<a> -<b>)`. Compare to:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git diff --shortstat main...dex/2026-05-04-clean
# → "3 files changed, 5 insertions(+), 1 deletion(-)" (numbers depend on F7's commits)
```

The `n`, `a`, `b` in the modal must match this output exactly.

### Cleanup

`[run cleanup helper]` (and click Cancel on the modal first).

---

## 2Q — Top-5 paths + expander

**Goal**: When more than 5 files are changed, only the top 5 are shown initially; the expander reveals all.

**Maps to**: FR-010, research.md R2.

### Pre-flight

A fixture with > 5 changed files. Use a fattened F7:

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git checkout -q -b dex/2026-05-04-many main
for i in 1 2 3 4 5 6 7 8; do
  echo "file ${i}" > "f${i}.txt"
done
git add -A
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/many]" \
                 -m "[checkpoint:plan:1]"
git checkout -q main
```

Then `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-many"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-many"
node scripts/test-014-cdp.mjs wait "promote-summary-paths" 3000

# Count visible paths before expanding.
node scripts/test-014-cdp.mjs eval "
  const list = document.querySelector('[data-testid=\"promote-summary-paths\"]');
  const before = list?.children.length ?? 0;
  document.querySelector('[data-testid=\"promote-summary-expand\"]')?.click();
  await new Promise(r => setTimeout(r, 200));
  const after = list?.children.length ?? 0;
  return { before, after };
"
```

### Expected return

`{ before: 5, after: 8 }`.

### Visual cues

- Before clicking expand: the path list has a subtle scrollbar; only 5 paths visible.
- An italic-blue `View all changes (+3)` link appears below the list.
- After clicking: list expands (max-height jumps from 110px to 280px); the `View all` link disappears.

### Cleanup

Click Cancel + `[run cleanup helper]`.
