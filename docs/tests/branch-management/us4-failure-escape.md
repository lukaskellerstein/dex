# US4 — Failure-modal escape paths

Tests for `<ResolverFailureModal>` and the three follow-up IPCs (`acceptResolverResult`, `abortResolverMerge`, `openInEditor`). Every scenario assumes the resolver has already failed and the failure modal has opened.

To force a deterministic resolver failure, every scenario in this file uses `maxIterations: 1` and a content conflict that the agent can't resolve in a single iteration (or skips the agent via the cost cap).

---

## 4A — Max iterations exhausted (failure modal opens)

**Goal**: When the resolver runs out of iterations, the failure modal opens with the right reason.

**Maps to**: FR-022, US4-AS1.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F8 — single-file-content-conflict**.
3. Set `maxIterations: 1` to force the failure path:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   cat > .dex/dex-config.json <<'EOF'
   {
     "agent": "claude",
     "conflictResolver": {
       "model": "claude-sonnet-4-6",
       "maxIterations": 1,
       "maxTurnsPerIteration": 1,
       "costCapUsd": 0.50,
       "verifyCommand": null
     }
   }
   EOF
   ```

   The combination `maxIterations: 1` + `maxTurnsPerIteration: 1` is the cheapest way to provoke a failure: one shot, one turn — too tight for any reasonable conflict resolution.
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-failure-accept" 60000
node scripts/test-014-cdp.mjs modal "resolver-failure-accept"
```

### Expected final state

**Modal text** contains a substring matching one of:

- `(max_iterations)` — if iteration was attempted and ran out
- `(agent_gave_up)` — if the agent's runOneShot returned `finishedNormally: false` due to `error_max_turns`

Either reason is acceptable here — both indicate the agent couldn't complete with the tight ceiling.

**Git side**: working tree is in unmerged state (UU on `conflict-test.txt`); main has not advanced; source branch still exists.

```sh
git status --short                   # → "UU conflict-test.txt"
git branch --list 'dex/*'            # → "dex/2026-05-04-cflict-a"
```

The failure modal's three buttons are visible. The merge is left in-progress so the user's choice in the modal can finalize or roll back.

### Visual cues

- Modal title: **"AI couldn't fully resolve the disagreement"**.
- Modal body:
  - Paragraph: `"The AI couldn't fully reconcile the disagreement (<reason>)."` with `<reason>` rendered as monospace dim text.
  - "Pick one:" introduction line.
  - Bulleted list explaining what each button does.
  - A scrollable file-path panel listing the failed files (data-testid `resolver-failure-files`).
- Footer layout (left-to-right):
  - **Bottom-LEFT corner**: small underlined dim-text link **"Open in editor"** (data-testid `resolver-failure-open-editor`). This is intentionally subordinate per FR-023.
  - **Bottom-RIGHT corner, two buttons**: secondary `Roll back the merge entirely`, primary `Accept what AI did`.

### Cleanup

Click any of the three buttons; the modal closes and one of 4B/4C/4D's behaviour fires. Then:

`[run cleanup helper]` (and restore default dex-config).

---

## 4B — "Accept what AI did" commits despite failure

**Goal**: Clicking Accept finalizes the merge with whatever state the AI reached. Useful when the user wants to inspect the result themselves.

**Maps to**: FR-022, FR-024, US4-AS2.

### Pre-flight + first part of actions

Same as 4A through the failure modal opening.

### Action

```sh
node scripts/test-014-cdp.mjs click "resolver-failure-accept"
sleep 3
node scripts/test-014-cdp.mjs snap   # toast should appear
```

### Expected final state

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# A merge commit was created on main.
git log -1 --format=%s main
# → "dex: promoted dex/2026-05-04-cflict-a to main"

# Source branch is gone.
git branch --list 'dex/*'
# → empty

# HEAD on main.
git rev-parse --abbrev-ref HEAD
# → "main"

# The conflict file may still contain conflict markers OR may have whatever
# the AI partially produced — caller acknowledged this risk.
grep -c '^<<<<<<<\|^>>>>>>>' conflict-test.txt
# → 0 OR positive (depending on AI's partial state)
```

**UI side**:

- Failure modal closes.
- Success toast: `"dex/2026-05-04-cflict-a is now main. The old version has been removed."` (the standard post-merge toast — Accept routes to the same success path).
- The dex/* lane is gone from the timeline.

### Visual cues

- Modal closes within ~500ms of click.
- Brief delay (~1s for the IPC) then the success toast appears + timeline refreshes.

### Common failures

- **`alerts` shows `Couldn't make this version the new main: nothing to commit, working tree clean`**: means `acceptResolverResult` was called when no merge was actually pending. This shouldn't happen if the failure modal was reached via the standard flow, but can if the merge was already aborted.

### Cleanup

`[run cleanup helper]`

---

## 4C — "Roll back the merge entirely" returns to pre-merge state

**Goal**: Clicking Rollback runs `git merge --abort` and restores everything to its pre-attempt state.

**Maps to**: FR-025, US4-AS3.

### Pre-flight + first part

Same as 4A through the failure modal opening.

### Action

```sh
node scripts/test-014-cdp.mjs click "resolver-failure-rollback"
sleep 2
node scripts/test-014-cdp.mjs snap
```

### Expected final state

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# Working tree clean.
git status --short
# → empty

# HEAD on main, NOT advanced (no merge commit).
git rev-parse --abbrev-ref HEAD     # → "main"
git log -1 --format=%s main
# → some pre-existing commit, NOT "dex: promoted ..."

# Source branch survives.
git branch --list 'dex/*'
# → "dex/2026-05-04-cflict-a"

# No new tags.
git tag --list 'checkpoint/promoted-*'
# → empty
```

**UI side**:

- Failure modal closes.
- A neutral toast appears: `"Merge rolled back. Nothing changed."`
- The dex/* lane is still on the timeline.

### Visual cues

- Modal closes within ~500ms.
- Toast text matches the rollback message exactly.

### Cleanup

`[run cleanup helper]`

---

## 4D — "Open in editor" spawns external editor, leaves state intact

**Goal**: The Open-in-editor button spawns the user's `$EDITOR` (or fallback) on the failed files, WITHOUT modifying the merge state.

**Maps to**: FR-022, FR-023, US4-AS4.

### Pre-flight + first part

Same as 4A through the failure modal opening.

### Action

```sh
# Set $EDITOR to a no-op echo so we can detect that it's invoked
# without spawning a real editor that would block the test.
EDITOR_LOG=/tmp/dex-014-editor.log
rm -f "$EDITOR_LOG"

# (We need to set $EDITOR for the Electron main process. The actual app's
# environment is what matters — for testing, the agent should set it BEFORE
# starting dev-setup. Reference: scripts/reset-example-to.sh sets nothing.)
# As a stand-in: just verify the IPC is invoked with the right files.

node scripts/test-014-cdp.mjs eval "
  // Inspect what files would be passed.
  const failedListEl = document.querySelector('[data-testid=\"resolver-failure-files\"]');
  const files = failedListEl ? [...failedListEl.children].map(d => d.textContent.trim()) : [];
  return { failedFiles: files };
"

# Click the button.
node scripts/test-014-cdp.mjs click "resolver-failure-open-editor"
sleep 2
node scripts/test-014-cdp.mjs snap
```

### Expected verification

**Failed files** array (from the eval above) contains `conflict-test.txt`.

**After clicking**:

- The failure modal **stays open** — Open-in-editor does NOT auto-dismiss. This is intentional per the spec; the user can come back to Accept or Rollback after editing.
- An editor window may briefly flash (depending on `$EDITOR` / `xdg-open` configuration). On a headless test agent, the spawn may fail silently — the IPC still returns `{ ok: true }` because it doesn't wait on the editor's exit.
- Git state is **unchanged** from when the failure modal opened (still UU, no commit).

### Verifying via IPC directly

If the on-screen behaviour is hard to capture (editor spawning is environment-specific), call the IPC directly to verify it routes:

```sh
node scripts/test-014-cdp.mjs eval "
  const r = await window.dexAPI.checkpoints.openInEditor(
    '/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce',
    ['conflict-test.txt'],
  );
  return r;
"
# → { ok: true }
```

### Cleanup

Click Rollback to clean up the merge state, then `[run cleanup helper]`.

---

## 4E — Cost-cap reason in failure modal

**Goal**: When the cost cap halts the resolver, the failure modal's reason text shows `(cost_cap)`.

**Maps to**: FR-019, FR-022.

### Pre-flight

Same as scenario 3G — set `costCapUsd: 0.001`. Run fixture F8.

### Actions

Same as 4A but the failure mode is cost_cap.

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-failure-accept" 60000
node scripts/test-014-cdp.mjs modal "resolver-failure-accept"
```

### Expected verification

Modal text contains `(cost_cap)`.

### Cleanup

Click Rollback + `[run cleanup helper]`.

---

## 4F — `agent_gave_up` reason in failure modal

**Goal**: When the agent returns `finishedNormally: false` (e.g. `error_max_turns`), the failure modal shows `(agent_gave_up)`.

**Maps to**: FR-022.

### Pre-flight

Same as 4A — `maxTurnsPerIteration: 1` is the easiest way to provoke `error_max_turns`.

### Actions

Same as 4A.

### Expected verification

Modal text contains `(agent_gave_up)`. (Actual reason depends on which check fires first; see 4A common-failures table.)

### Cleanup

Click Rollback + `[run cleanup helper]`.

---

## 4G — `verify_failed` reason in failure modal

**Goal**: When the verify command exits non-zero after the resolver succeeds, failure modal shows `(verify_failed)`.

**Maps to**: FR-018, US4-AS2.

### Pre-flight + actions

Same as scenario 3I.

### Expected verification

Modal text contains `(verify_failed)`. Click Accept to override the verify failure and finalize anyway:

```sh
node scripts/test-014-cdp.mjs click "resolver-failure-accept"
sleep 3
# Verify the merge committed despite the failed verify.
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git log -1 --format=%s main          # → "dex: promoted ..."
git branch --list 'dex/*'            # → empty
```

### Cleanup

`[run cleanup helper]` + restore verifyCommand.

---

## 4H — `user_cancelled` reason after Cancel

**Goal**: After clicking Cancel on the progress modal, the resolver returns `user_cancelled` and (eventually) the failure modal opens with that reason — OR no failure modal opens because the immediate `abortResolverMerge` cleaned up first.

**Maps to**: FR-021, US3-AS3.

### Pre-flight

Same as 3C.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-progress-status" 10000

# Cancel as soon as the progress modal opens.
node scripts/test-014-cdp.mjs click "resolver-progress-cancel"

# Watch for either an immediate cleanup (no further modal) OR a transient
# failure modal that gets dismissed.
node scripts/test-014-cdp.mjs eval "
  const deadline = Date.now() + 60000;
  let sawFailure = false;
  let sawErrorBanner = false;
  while (Date.now() < deadline) {
    if (document.querySelector('[data-testid=\"resolver-failure-accept\"]')) sawFailure = true;
    const alert = document.querySelector('[role=\"alert\"]');
    if (alert && /user_cancelled/i.test(alert.textContent)) sawErrorBanner = true;
    const cleanCheck = !document.querySelector('[data-testid=\"resolver-progress-status\"]')
      && !document.querySelector('[data-testid=\"resolver-failure-accept\"]');
    if (cleanCheck) return { state: 'clean', sawFailure, sawErrorBanner };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { state: 'timeout', sawFailure, sawErrorBanner };
"
```

### Expected return (one of)

- `{ state: 'clean', sawFailure: false, sawErrorBanner: false }` — most likely on a fast cancel
- `{ state: 'clean', sawFailure: true, sawErrorBanner: false }` — failure modal flashed briefly
- `{ state: 'clean', sawFailure: false, sawErrorBanner: true }` — error banner with `user_cancelled` shown

All three are documented v1 behaviour (see README known limitation).

### Expected git state

```sh
git status --short                   # → empty
git rev-parse --abbrev-ref HEAD     # → "main" (or whatever was the start state)
git branch --list 'dex/*'            # → "dex/2026-05-04-cflict-a"
```

The merge is fully torn down; nothing is left committed.

### Cleanup

`[run cleanup helper]`

---

## Quick cross-reference

| Scenario | Reason exercised | What's verified |
|---|---|---|
| 4A | max_iterations / agent_gave_up | Failure modal opens |
| 4B | (any) | Accept commits despite failure |
| 4C | (any) | Rollback restores pre-merge state |
| 4D | (any) | Open-in-editor spawns editor without dismissing modal |
| 4E | cost_cap | Modal reason text |
| 4F | agent_gave_up | Modal reason text |
| 4G | verify_failed | Modal reason text + Accept overrides |
| 4H | user_cancelled | Cancel mid-resolution cleans up |
