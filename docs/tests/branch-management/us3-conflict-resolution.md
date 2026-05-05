# US3 — AI conflict resolution

Tests for the live AI resolver path: `mergeToMain` detects content conflicts → `resolveConflicts` harness → real `runOneShot` to Claude → file edited in place → verify command (optional) → success commit.

**These scenarios incur Claude API cost.** Default config uses `claude-sonnet-4-6` with `costCapUsd: 0.50`. A typical single-file resolution costs $0.05–$0.20.

---

## 3A — Single-file content conflict resolved by AI (happy path)

**Goal**: The classic case — both branches modify the same line. Resolver runs, AI edits the file, merge commits cleanly.

**Maps to**: FR-016, FR-017, FR-018, US3-AS1, US3-AS2.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F8 — single-file-content-conflict**.
3. `dex-config.json` set to default (Sonnet, maxIterations 5, maxTurnsPerIteration 10, costCapUsd 0.50, verifyCommand null).
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"

# Wait for the resolver progress modal to appear.
node scripts/test-014-cdp.mjs wait "resolver-progress-status" 10000

# Snapshot what's on screen mid-run.
node scripts/test-014-cdp.mjs modal "resolver-progress-status"

# Wait for outcome — either toast (success) OR resolver-failure-accept (failure).
node scripts/test-014-cdp.mjs eval "
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const failure = document.querySelector('[data-testid=\"resolver-failure-accept\"]');
    const toast = [...document.querySelectorAll('[data-testid=\"timeline-toast\"]')]
      .filter(t => /AI resolved \\\\d+ disagreement/.test(t.textContent))[0];
    if (failure) return { outcome: 'failure', text: document.querySelector('[role=\"dialog\"]')?.textContent?.slice(0, 300) };
    if (toast) return { outcome: 'success', toast: toast.textContent };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { outcome: 'timeout' };
"
```

### Expected final state

**Outcome**: `{ outcome: 'success', toast: "AI resolved 1 disagreement. The new main is ready.×" }`

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# Merge commit on main with two parents.
git log -1 --format=%s main
# → "dex: promoted dex/2026-05-04-cflict-a to main"

# The conflict file no longer has markers.
grep -c '^<<<<<<<\|^>>>>>>>' conflict-test.txt
# → 0

# Source branch deleted.
git branch --list 'dex/*'
# → empty

# Working tree clean.
git status --short
# → empty
```

The merged content of `conflict-test.txt` line 3 is some reasonable combination of the two branches' versions — exact wording is non-deterministic but should preserve the intent of both ("rewritten" + "with care for clarity" + "different approach").

### Visual cues

#### Phase 1 — promote-confirm modal

Same as 2A: title "Replace main with this version?", "1 file changed · +1 -1 (+1 -1)", path `conflict-test.txt`. Confirm button.

#### Phase 2 — resolver progress modal

Modal title: **"Two versions disagree on the same lines. Resolving with AI…"**.

Body:

- A status line showing "Resolving disagreement #1 of 1…".
- A monospace mini-line showing **"Iteration <n> · cost so far $0.0xxx"** that ticks up over time.
- A bordered-panel showing the file currently being resolved: `conflict-test.txt`.
- A counter line at the bottom: "Resolved 0 / 1" → flips to "Resolved 1 / 1" when the file finishes.
- A `Cancel` button in the footer with `data-testid="resolver-progress-cancel"`.

The modal stays open for ~15–60 seconds while the agent runs.

#### Phase 3 — resolver done → success toast

- The progress modal closes.
- The dex/* lane disappears from the timeline.
- The success toast shows **"AI resolved 1 disagreement. The new main is ready."** in green.

### Common failures (and what to check)

| Symptom | Cause / fix |
|---|---|
| Outcome is `failure` with reason `agent_gave_up` and electron.log shows `error_max_turns` | Agent exhausted turns before producing an Edit call. Bump `maxTurnsPerIteration` to 15. |
| Outcome is `failure` with reason `agent_gave_up` and electron.log shows the agent producing **textual analysis** but no Edit call | Prompt engineering — the agent is responding in text instead of calling tools. The current prompt has explicit `STEPS:` directives; if this still happens, switch to opus or add stronger directives. |
| Outcome is `failure` with reason `cost_cap` | Cost ceiling too low; bump `costCapUsd` to 1.00. |
| Outcome is `success` but the file still has markers | Bug in the harness's marker-residue check — verify by `grep '<<<<<<<' conflict-test.txt` directly. |
| Outcome is `timeout` (resolver runs > 90s without producing an outcome) | The SDK call is hung. Check `tail -f ~/.dex/dev-logs/electron.log` for activity; kill the process and restart if necessary. |

### Cleanup

`[run cleanup helper]`

---

## 3B — Multi-file content conflict

**Goal**: Resolver iterates per file; progress modal updates the file path between iterations.

**Maps to**: FR-016, US3-AS1, conflict-resolver-events.md ordering.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F9 — multi-file-content-conflict** (two files: `shared/config.txt` and `shared/label.txt`).
3. `node scripts/test-014-cdp.mjs open`.

### Actions

Same sequence as 3A but watch for the resolver to process two files:

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-multi"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-multi"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-progress-status" 10000

# Watch the progress modal cycle through files.
node scripts/test-014-cdp.mjs eval "
  const seen = new Set();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const cur = document.querySelector('[data-testid=\"resolver-progress-current-file\"]')?.textContent ?? null;
    if (cur) seen.add(cur);
    const toast = [...document.querySelectorAll('[data-testid=\"timeline-toast\"]')]
      .filter(t => /AI resolved/.test(t.textContent))[0];
    if (toast) return { outcome: 'success', filesSeen: [...seen], toast: toast.textContent };
    const failure = document.querySelector('[data-testid=\"resolver-failure-accept\"]');
    if (failure) return { outcome: 'failure', filesSeen: [...seen] };
    await new Promise(r => setTimeout(r, 2000));
  }
  return { outcome: 'timeout', filesSeen: [...seen] };
"
```

### Expected return

```json
{
  "outcome": "success",
  "filesSeen": ["shared/config.txt", "shared/label.txt"],
  "toast": "AI resolved 2 disagreements. The new main is ready.×"
}
```

(Order of files within `filesSeen` is `git status --porcelain` order — alphabetical by path.)

### Visual cues

- The progress modal's "Resolving disagreement #N of 2" text increments from "#1 of 2" to "#2 of 2".
- The current-file panel switches between `shared/config.txt` and `shared/label.txt`.
- The "Resolved N / 2" counter steps from 0/2 → 1/2 → 2/2.

### Cleanup

`[run cleanup helper]`

---

## 3C — User cancels mid-resolution

**Goal**: Clicking Cancel on the progress modal aborts the merge cleanly.

**Maps to**: FR-021, US3-AS3.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F8 — single-file-content-conflict**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-progress-status" 10000

# Cancel as soon as the progress modal opens.
node scripts/test-014-cdp.mjs click "resolver-progress-cancel"
sleep 3
```

### Expected final state

**Git side**:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

# Working tree clean (the merge was aborted).
git status --short
# → empty (or possibly " M conflict-test.txt" if the resolver wrote before abort — both acceptable)

# Source branch still exists.
git branch --list 'dex/*'
# → "dex/2026-05-04-cflict-a"

# Main is unchanged (no merge commit).
git log -1 --format=%s main
# → some pre-existing commit, NOT "dex: promoted ..."
```

**UI side**:

- The progress modal closes on Cancel.
- Either:
  - **No additional modal opens** (the renderer side fired `abortResolverMerge` immediately, and the still-running `mergeToMain` resolves with `resolver_failed: user_cancelled` and surfaces nothing further), OR
  - **A `resolver-failure-accept` modal briefly opens then is dismissed** by the cancel handler.

Both are documented v1 behaviour (see README known limitation about no-mid-resolver-cancel-signal).

### Visual cues

- Click on Cancel: progress modal fades out within ~200ms.
- The renderer may briefly show an error banner "AI couldn't fully resolve the disagreement (user_cancelled)" — this is acceptable.
- Within ~30s (depends on the in-flight runOneShot finishing its current turn), the merge is fully torn down.

### Cleanup

`[run cleanup helper]`

---

## 3D — Non-content conflict (rename/delete) — abort, no AI invocation

**Goal**: When git detects a rename-vs-delete, the resolver MUST NOT be invoked. The merge aborts with the friendly message.

**Maps to**: FR-020, US3-AS4, research.md R1.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F10 — rename-delete-conflict**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-rename"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-rename"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
sleep 3
node scripts/test-014-cdp.mjs snap   # inspect alerts[]
```

### Expected final state

**Git side**: clean working tree, source branch intact, main unchanged.

```sh
git status --short                   # → empty
git branch --list 'dex/*'            # → "dex/2026-05-04-rename"
```

**UI side**: `alerts` contains exactly:

```
"This version has a kind of conflict AI can't resolve yet. The merge has been undone. Edit the files manually and try again."
```

**No resolver progress modal opens** — this is the critical assertion. The IPC short-circuits before invoking the agent.

### Visual cues

- After clicking promote-confirm: brief delay (~1s) for the merge attempt + abort.
- A red error banner appears with the message above. No progress modal.

### Common failures

- **Resolver progress modal opens and the agent runs**: classification didn't fire. Check `electron.log` for the `mergeToMain: conflicts detected` line; verify the unmerged path's XY code via `git status --porcelain` (should be `DU`/`UD`).

### Cleanup

`[run cleanup helper]`

---

## 3E — Non-content conflict (binary file)

**Goal**: Binary file conflicts are classified as non-content; resolver MUST NOT be invoked.

**Maps to**: FR-020, research.md R1.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F11 — binary-file-conflict**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

Same as 3D, replacing the source branch name with `dex/2026-05-04-binary`.

### Expected final state

Same as 3D — abort, friendly message, no AI invocation.

### Cleanup

`[run cleanup helper]`

---

## 3F — Non-content conflict (both added)

**Goal**: When both branches add the same file with different content (XY=`AA`), classify as non-content.

**Maps to**: FR-020.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F12 — both-added-conflict**.
3. `node scripts/test-014-cdp.mjs open`.

### Actions

Same as 3D, source `dex/2026-05-04-both-add`.

### Expected final state

Same — abort, friendly message, no AI.

### Cleanup

`[run cleanup helper]`

---

## 3G — Cost-cap halts resolver

**Goal**: When `costCapUsd` is set very low, the resolver halts at the first iteration boundary that would exceed it.

**Maps to**: FR-019, SC-008, US3-AS5.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture **F8 — single-file-content-conflict**.
3. Modify dex-config.json to set `costCapUsd: 0.001`:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   cat > .dex/dex-config.json <<'EOF'
   {
     "agent": "claude",
     "conflictResolver": {
       "model": "claude-sonnet-4-6",
       "maxIterations": 5,
       "maxTurnsPerIteration": 10,
       "costCapUsd": 0.001,
       "verifyCommand": null
     }
   }
   EOF
   ```
4. `node scripts/test-014-cdp.mjs open`.

### Actions

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
# Wait for the failure modal — cost_cap halts before iteration 1 would push past the cap.
node scripts/test-014-cdp.mjs wait "resolver-failure-accept" 60000
node scripts/test-014-cdp.mjs modal "resolver-failure-accept"
```

### Expected verification

The failure modal text contains the substring `(cost_cap)`.

**Note on the threshold check**: Resolver checks `costSoFar + estimatedNext > costCapUsd` BEFORE each iteration. With `costCapUsd: 0.001` and the first-iteration estimate of $0.05, the check trips immediately on iteration 1 — no API call is made.

### Cleanup

```sh
# Restore default config
[run cleanup helper]
```

---

## 3H — Verify command success path

**Goal**: When `verifyCommand` is set, the resolver runs it after producing a clean file. On exit 0, promote finalizes.

**Maps to**: FR-018, research.md R5.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture F8.
3. Set verifyCommand to a guaranteed-success command:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   cat > .dex/dex-config.json <<'EOF'
   {
     "agent": "claude",
     "conflictResolver": {
       "model": "claude-sonnet-4-6",
       "maxIterations": 5,
       "maxTurnsPerIteration": 10,
       "costCapUsd": 0.50,
       "verifyCommand": "true"
     }
   }
   EOF
   ```
4. `node scripts/test-014-cdp.mjs open`.

### Actions

Same as 3A.

### Expected final state

Same as 3A — success toast.

### Cleanup

`[run cleanup helper]`

---

## 3I — Verify command failure routes to failure modal

**Goal**: When the verify command exits non-zero (e.g. tsc errors after merge), the resolver returns `verify_failed` and the failure modal opens.

**Maps to**: FR-018, US4-AS2.

### Pre-flight

1. `bash scripts/reset-example-to.sh pristine`.
2. Run fixture F8.
3. Set verifyCommand to a guaranteed-fail command:

   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   cat > .dex/dex-config.json <<'EOF'
   {
     "agent": "claude",
     "conflictResolver": {
       "model": "claude-sonnet-4-6",
       "maxIterations": 5,
       "maxTurnsPerIteration": 10,
       "costCapUsd": 0.50,
       "verifyCommand": "false"
     }
   }
   EOF
   ```
4. `node scripts/test-014-cdp.mjs open`.

### Actions

Same as 3A but expect failure modal at the end.

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-cflict-a"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-failure-accept" 90000
node scripts/test-014-cdp.mjs modal "resolver-failure-accept"
# The body text should contain "(verify_failed)".
```

### Visual cues

- Progress modal opens, ticks through iteration normally.
- Then closes and the failure modal opens with reason `verify_failed`.
- The merge state is preserved on disk — the failure modal's "Accept" can still commit it.

### Cleanup

`[run cleanup helper]` (+ restore verifyCommand to null).

---

## 3J — Progress modal counters update correctly

**Goal**: Verify iteration counter, file-path display, and cost number all increment correctly during a multi-file resolution.

**Maps to**: FR-017, conflict-resolver-events.md ordering.

### Pre-flight

Same as 3B (multi-file fixture).

### Actions

Drive the same flow as 3B, but capture the modal state at multiple poll-points:

```sh
node scripts/test-014-cdp.mjs rclick "branch-badge-dex/2026-05-04-multi"
node scripts/test-014-cdp.mjs click "promote-menu-item-dex/2026-05-04-multi"
node scripts/test-014-cdp.mjs wait "promote-confirm" 3000
node scripts/test-014-cdp.mjs click "promote-confirm"
node scripts/test-014-cdp.mjs wait "resolver-progress-status" 10000

node scripts/test-014-cdp.mjs eval "
  const samples = [];
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const status = document.querySelector('[data-testid=\"resolver-progress-status\"]');
    if (!status) break;   // modal closed → resolver finished
    const text = document.body.textContent;
    const iterMatch = text.match(/Iteration\\s+(\\d+)/);
    const costMatch = text.match(/cost so far \\\\$([\\\\d.]+)/);
    samples.push({
      t: Date.now(),
      iter: iterMatch ? Number(iterMatch[1]) : null,
      cost: costMatch ? Number(costMatch[1]) : null,
      currentFile: document.querySelector('[data-testid=\"resolver-progress-current-file\"]')?.textContent,
    });
    await new Promise(r => setTimeout(r, 1500));
  }
  return { samples };
"
```

### Expected behaviour

- `iter` is monotonically non-decreasing across samples (1, 1, 1, 2, 2, ...).
- `cost` is monotonically non-decreasing.
- `currentFile` changes value at least once (between the two files).

### Cleanup

`[run cleanup helper]`
