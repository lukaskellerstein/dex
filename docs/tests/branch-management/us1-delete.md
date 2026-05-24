# US1 — Remove a saved version (delete branch)

Tests for the `deleteBranch` core fn + IPC + UI surface. Spec source: `specs/014-branch-management/spec.md` user story 1; `specs/014-branch-management/quickstart.md` recipes 1A–1E.

Each scenario follows the README pre-flight + uses fixtures from `fixtures.md`.

---

## 1A — Clean delete (no unique commits)

**Goal**: Verify a `dex/*` branch sharing main's tip is deletable in one click without any modal.

**Maps to**: FR-001, FR-007, US1-AS1.

### Pre-flight

1. Run `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F1 — empty-dex-branch**.
3. CDP driver online: `node scripts/test-014-cdp.mjs open` returns badges including `branch-badge-dex/2026-05-04-empty`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-empty"
node scripts/test-014-cdp.mjs wait "branch-badge-dex/2026-05-04-empty" 5000 --gone
```

### Expected final state

**Git side** (run in `dex-ecommerce`):

```sh
git rev-parse --abbrev-ref HEAD          # → "main"
git branch --list 'dex/*'                # → empty
git status --short                       # → empty
```

**UI side** (`node scripts/test-014-cdp.mjs snap`):

- `badges` no longer contains `branch-badge-dex/2026-05-04-empty`.
- `alerts` is empty (no error banners).
- `toasts` is empty (no toast — clean delete is silent per FR-001).

### Visual cues (what the agent should see on screen)

- The timeline canvas redraws within ~1 second; the deleted lane is gone.
- No modal opens at any point.
- HEAD-position highlight (the white halo) remains on whatever step-commit was current before.

### Common failures

- **Lost-work modal opens** — fixture F1 was misapplied; the branch has commits unique relative to other refs. Verify via `git log dex/2026-05-04-empty --not main --branches='dex/*'` returns empty. If not, redo F1.
- **`Another Dex instance holds the project lock`** banner — concurrent IPC; wait 2s and retry, or kill any other Electron instance.

### Cleanup

`[run cleanup helper from fixtures.md]`

---

## 1B — Lost-work warning + Cancel keeps branch

**Goal**: Verify the lost-work modal opens with the right step labels + SHAs and Cancel leaves the branch intact.

**Maps to**: FR-004, US1-AS3 (cancel path).

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F2 — dex-with-unique-step**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-unique"
node scripts/test-014-cdp.mjs wait "delete-branch-lost-steps" 3000
node scripts/test-014-cdp.mjs modal "delete-branch-lost-steps"
node scripts/test-014-cdp.mjs click "delete-branch-cancel"
node scripts/test-014-cdp.mjs wait "delete-branch-lost-steps" 3000 --gone
```

### Expected final state

**Git side**:

```sh
git branch --list 'dex/*'                # → "dex/2026-05-04-unique" still present
git status --short                       # → empty
```

**UI side**:

- `delete-branch-lost-steps` modal element no longer present.
- `branch-badge-dex/2026-05-04-unique` still rendered on the timeline.

### Visual cues

- Modal title: **"These steps will be lost"**.
- Modal body: explanation paragraph + scrollable list of lost steps.
- The lost-steps list contains exactly one row showing **`cycle 1 · plan written`** on the left and **`<7-char SHA>`** on the right (right-aligned, monospace).
- Two footer buttons: **`Cancel`** (secondary) and **`Remove`** (primary, red/orange tint per the dark theme).
- Cancel button has `data-testid="delete-branch-cancel"`; Remove button has `data-testid="delete-branch-confirm"`.
- After clicking Cancel: the modal fades out; the timeline view is identical to pre-action.

### Common failures

- **Modal lists wrong label** — the trailer parser couldn't extract `[checkpoint:plan:1]`. Verify `git log dex/2026-05-04-unique -1 --format=%B` shows the trailer.
- **Modal body shows the literal commit subject instead of "cycle 1 · plan written"** — that's a fallback path; check the trailer was committed correctly in F2 (use `git commit -m subject -m body` form, not `--message`).

### Cleanup

`[run cleanup helper]`

---

## 1C — Lost-work warning + Confirm deletes

**Goal**: Verify Confirm in the lost-work modal actually removes the branch.

**Maps to**: FR-004, FR-007, US1-AS3 (confirm path).

### Pre-flight

Same as 1B (fixture F2 + open project).

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-unique"
node scripts/test-014-cdp.mjs wait "delete-branch-lost-steps" 3000
node scripts/test-014-cdp.mjs click "delete-branch-confirm"
node scripts/test-014-cdp.mjs wait "branch-badge-dex/2026-05-04-unique" 5000 --gone
```

### Expected final state

**Git side**:

```sh
git rev-parse --abbrev-ref HEAD            # → "main"
git branch --list 'dex/*'                  # → empty
git log --all --grep='\[checkpoint:plan:1\]' --oneline  # → empty (the orphan step-commit is unreachable; reflog will keep it briefly)
```

**UI side**:

- Modal closed; branch badge gone; no error banner.

### Visual cues

- Identical to 1B until the Confirm click; then modal fades out and the dex/* lane disappears from the timeline within ~1 second.

### Cleanup

`[run cleanup helper]`

---

## 1D — HEAD-on-target switches to main

**Goal**: Verify deleting the branch HEAD is currently on auto-switches HEAD to main first.

**Maps to**: FR-003, US1-AS2.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F3 — head-on-dex-branch** (HEAD ends up on `dex/2026-05-04-head-here`).
3. `node scripts/test-014-cdp.mjs open`.
4. Sanity check: `cd dex-ecommerce && git rev-parse --abbrev-ref HEAD` returns `dex/2026-05-04-head-here`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-head-here"
node scripts/test-014-cdp.mjs wait "branch-badge-dex/2026-05-04-head-here" 5000 --gone
```

### Expected final state

**Git side**:

```sh
git rev-parse --abbrev-ref HEAD            # → "main" (the auto-switch fired)
git branch --list 'dex/*'                  # → empty
```

**UI side**: badge gone; no modal; no error.

### Visual cues

- The HEAD halo (white double-circle around the current step-commit) jumps from the dex/* lane to the main lane immediately as the branch disappears.

### Common failures

- **Lost-work modal appears unexpectedly** — F3 created an empty dex/* but maybe a stray edit committed there. Verify with `git log dex/2026-05-04-head-here --not main --format=%H` before running.

### Cleanup

`[run cleanup helper]`

---

## 1E — HEAD-on-target falls back to master when no main

**Goal**: When the project uses `master` instead of `main`, HEAD-on-target should fall back to master.

**Maps to**: FR-003 (fallback branch), data-model.md `findPrimaryFallback`.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F4 — master-only-no-main**.
3. Manually `git checkout -q dex/2026-05-04-on-master` so HEAD is on the dex/* branch.
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-on-master"
node scripts/test-014-cdp.mjs wait "branch-badge-dex/2026-05-04-on-master" 5000 --gone
```

### Expected final state

**Git side**:

```sh
git rev-parse --abbrev-ref HEAD       # → "master"
```

### Visual cues

- The badge labelled `mas` (last-3-chars convention from `badgeText`) is the only one on the timeline besides the deleted dex/*'s. Wait — the badge labelled `master` is shown verbatim per `badgeText`. Look for that label.

### Cleanup (special)

After this scenario, restore the original `main` naming: `cd dex-ecommerce && git branch -m master main`.

---

## 1F — No-primary refusal

**Goal**: When neither `main` nor `master` exists AND HEAD is on a `dex/*`, deleting must refuse with a friendly message.

**Maps to**: edge case in spec.md, FR-003 fallback.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Manually destroy main:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout -q -b dex/2026-05-04-orphan
   git branch -D main
   ```
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-orphan"
sleep 1
node scripts/test-014-cdp.mjs snap     # inspect alerts[]
```

### Expected final state

**Git side**:

```sh
git branch --list 'dex/*'              # → "dex/2026-05-04-orphan" still present (refusal is non-destructive)
git rev-parse --abbrev-ref HEAD        # → "dex/2026-05-04-orphan"
```

**UI side**: `alerts` array contains exactly one entry with text `"Cannot remove this version because the project has no primary version to fall back to."` (from `copy.ts:DELETE_NO_PRIMARY`).

### Cleanup

```sh
cd dex-ecommerce
git branch main                        # recreate
git checkout -q main
[run cleanup helper]
```

---

## 1G — Refused on `main` (control hidden)

**Goal**: Verify the delete control is never rendered on `main` (defense-in-depth).

**Maps to**: FR-002, US1-AS5.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs eval "
  return {
    mainHasDelete: !!document.querySelector('[data-testid=\"delete-branch-main\"]'),
    mainBadgeRendered: !!document.querySelector('[data-testid=\"branch-badge-main\"]'),
  };
"
```

### Expected return

```json
{ "mainHasDelete": false, "mainBadgeRendered": true }
```

### Visual cues

- The `main` badge is on the timeline (top-left, label "main") with NO ✕ control on its right side.
- Hovering the main badge shows a `<title>` tooltip with the branch name "main" but no other controls appear.

---

## 1H — Refused on user branches (control hidden)

**Goal**: User-created branches outside Dex's namespace are not deletable.

**Maps to**: FR-002, US1-AS5.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F5 — user-branch-and-dex**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs snap
# Inspect the deletes[] array.
```

### Expected return (key fields)

```json
{
  "deletes": ["delete-branch-dex/2026-05-04-coexist"],
  "badges": ["branch-badge-main", "branch-badge-dex/2026-05-04-coexist", ...]
}
```

The `feature/foo` branch is NOT in `deletes[]`. **Note**: it may not even appear in `badges[]` because the timeline filters to Dex-owned + main/master + currentBranch only — see `timeline.ts:visibleBranches`.

### Cleanup

`[run cleanup helper]`

---

## 1I — Mid-run refusal

**Goal**: When the orchestrator is running on the target branch, delete is refused with the friendly message.

**Maps to**: FR-005, US1-AS4.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F6 — mid-run-state**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs click "delete-branch-dex/2026-05-04-active"
sleep 1
node scripts/test-014-cdp.mjs snap     # inspect alerts[]
```

### Expected final state

**Git side**:

```sh
git branch --list 'dex/*'              # → "dex/2026-05-04-active" still present
```

**UI side**: `alerts` contains `"This version is currently being built — pause the run first."` (from `copy.ts:DELETE_MID_RUN`).

### Visual cues

- A red error banner at the top of the timeline area (above the canvas) with the message above. The banner has a thin red border and red text on the dark theme.
- The branch badge is still in place.

### Cleanup

```sh
cd dex-ecommerce
rm -f .dex/state.json   # clear the mid-run state
[run cleanup helper]
```

---

## 1J — Locked-by-other-instance handling

**Goal**: Verify the `locked_by_other_instance` IPC error surfaces a friendly banner.

**Maps to**: cross-cutting safety guard FR-030.

### Pre-flight

This is hard to reproduce naturally — the lock is held only during in-flight IPC. To test:

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture F2 (a branch with a lost-work step-commit, so the IPC takes longer).
3. `node scripts/test-014-cdp.mjs open`.

### Actions

In rapid succession (within ~50ms), fire two `deleteBranch` IPC calls:

```sh
node scripts/test-014-cdp.mjs eval "
  const proj = '/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce';
  const [r1, r2] = await Promise.all([
    window.dexAPI.checkpoints.deleteBranch(proj, 'dex/2026-05-04-unique'),
    window.dexAPI.checkpoints.deleteBranch(proj, 'dex/2026-05-04-unique'),
  ]);
  return { r1, r2 };
"
```

### Expected return

One of `r1`/`r2` returns `{ ok: false, error: 'would_lose_work', lostSteps: [...] }`; the other may return `{ ok: false, error: 'locked_by_other_instance' }` OR may also reach the would-lose-work path if the lock is released between the two calls. Both outcomes are acceptable — the deterministic guarantee is that NEVER will both calls successfully delete (the second would fail with a git error like "branch not found").

### Common failures

- **Both calls succeed concurrently** — the lock isn't being held; check `withLock` is wired correctly in the IPC handler.

### Cleanup

`[run cleanup helper]`

---

## Quick cross-reference

| Scenario | Fixture | Triggers | Final state |
|---|---|---|---|
| 1A | F1 | clean delete | branch gone, no modal, no toast |
| 1B | F2 | lost-work + Cancel | branch survives |
| 1C | F2 | lost-work + Confirm | branch gone |
| 1D | F3 | HEAD on target | HEAD switches to main |
| 1E | F4 | no main | HEAD switches to master |
| 1F | _custom_ | no primary | refusal banner |
| 1G | (default) | main badge | no delete control rendered |
| 1H | F5 | user branch | user branch not in deletes[] |
| 1I | F6 | mid-run | refusal banner |
| 1J | F2 | concurrent IPC | one succeeds, one is locked or also-races |
