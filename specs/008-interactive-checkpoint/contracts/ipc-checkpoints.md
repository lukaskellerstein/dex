# Contract: Checkpoints IPC

**File**: `src/main/ipc/checkpoints.ts`
**Preload bridge**: `window.dexAPI.checkpoints.*` (registered in `src/main/preload.ts`)
**Renderer typings**: `src/renderer/electron.d.ts`

All mutating handlers acquire `<projectDir>/.dex/state.lock` via `acquireStateLock(projectDir)` and release in `finally`. Read-only handlers do not take the lock. The second Dex window on the same project sees `isLockedByAnother === true` and renders the timeline read-only until the first window releases.

Error envelope convention: `{ ok: false, error: "<machine_code>", ...context }`. Human-readable strings are produced by the renderer from the machine code + context, never by the main process — this keeps localisation in one place and matches spec FR-040.

---

## Read-only handlers (no lock)

### `checkpoints:listTimeline`

- **Request**: `(projectDir: string) → TimelineSnapshot`
- **Response**: `TimelineSnapshot` (see `data-model.md` §3).
- **Behaviour**: Delegates to `listTimeline(projectDir)`. Safe to call in parallel.

### `checkpoints:isLockedByAnother`

- **Request**: `(projectDir: string) → boolean`
- **Response**: `true` iff `.dex/state.lock` is held by a different PID than the calling instance.
- **Behaviour**: Cheap probe. Second window polls this to know when to re-enable mutating actions.

### `checkpoints:checkIsRepo`

- **Request**: `(projectDir: string) → boolean`
- **Response**: `true` iff `<projectDir>/.git/` exists.

### `checkpoints:checkIdentity`

- **Request**: `(projectDir: string) → { name: string | null; email: string | null; suggestedName: string; suggestedEmail: string }`
- **Response**:
  - `name` / `email` — from `git config --get user.name` / `user.email` (null if unset).
  - `suggestedName` — `os.userInfo().username`.
  - `suggestedEmail` — `${os.userInfo().username}@${os.hostname()}`.

### `checkpoints:estimateVariantCost`

- **Request**: `(projectDir: string, stage: LoopStageType, variantCount: number) → CostEstimate`
- **Response**:

  ```ts
  interface CostEstimate {
    perVariantMedian: number | null;
    perVariantP75: number | null;
    totalMedian: number | null;
    totalP75: number | null;
    sampleSize: number;     // number of matching phase records found (0–5)
  }
  ```

- **Behaviour**: `listRuns(projectDir, 20)` → `flatMap phases` → filter by stage + status completed → take most recent 5 → sort by cost → pick index `floor(n/2)` for median, `floor(n*0.75)` for p75. `sampleSize === 0` → all fields null; renderer shows "No cost history yet".

### `checkpoints:readPendingVariantGroups`

- **Request**: `(projectDir: string) → VariantGroupFile[]`
- **Response**: Array of group files where any variant has status `pending` or `running`. Used by the app-start resume flow (§Resume below).

---

## Mutating handlers (lock required)

All mutating handlers share this envelope; `locked_by_other_instance` is the only new error code common to every one.

```ts
type MutatingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "locked_by_other_instance" }
  | { ok: false; error: string; [k: string]: unknown };
```

### `checkpoints:promote`

- **Request**: `(projectDir: string, tag: string, sha: string)`
- **Response**: `{ ok: true } | { ok: false, error }`
- **Behaviour**: Acquires lock → `promoteToCheckpoint(projectDir, tag, sha, rlog)` → releases lock. On success, orchestrator emits `checkpoint_promoted` (renderer receives via event stream).

### `checkpoints:goBack`

- **Request**: `(projectDir: string, tag: string, options?: GoBackOptions)`

  ```ts
  interface GoBackOptions {
    force?: "save" | "discard";   // discarding is user-confirmed
  }
  ```

- **Response**:
  - Happy path: `{ ok: true, branch: string }`.
  - Dirty tree, no force: `{ ok: false, error: "dirty_working_tree", files: string[] }` — renderer opens `GoBackConfirm` modal.
  - Other failures: `{ ok: false, error: string }`.
- **Behaviour**:
  1. Acquire lock.
  2. `isWorkingTreeDirty(projectDir)`. Dirty + no force → return `dirty_working_tree` envelope with `files[]`.
  3. Dirty + `force === "save"` → `git checkout -B attempt-<Date.now()>-saved && git add -A && git commit -m "saved: …"` → proceed to step 4.
  4. Dirty + `force === "discard"` → proceed to step 4 (clean will drop files anyway).
  5. `startAttemptFrom(projectDir, tag, rlog)` → return its result.
  6. Release lock.

### `checkpoints:spawnVariants`

- **Request**: `(projectDir: string, request: VariantSpawnRequest)`
- **Response**: `{ ok: true, result: VariantSpawnResult } | { ok: false, error }`
- **Behaviour**: Acquires lock → `spawnVariants(...)` → writes `.dex/variant-groups/<groupId>.json` via `checkpoints:writeVariantGroup` (below) → releases lock.
- **Invariant**: On success, a variant-group file exists and is readable by the resume flow on the next orchestrator start.

### `checkpoints:deleteAttempt`

- **Request**: `(projectDir: string, branch: string)`
- **Response**: `{ ok: true } | { ok: false, error: "cannot_delete_current" | "locked_by_other_instance" | string }`
- **Behaviour**: Refuses to delete the current branch (HEAD). Otherwise `git branch -D <branch>`.

### `checkpoints:writeVariantGroup`

- **Request**: `(projectDir: string, group: VariantGroupFile)`
- **Response**: `{ ok: true } | { ok: false, error }`
- **Behaviour**: Atomic write (`tmp` + `rename`) to `.dex/variant-groups/<groupId>.json`. Creates the directory if absent.

### `checkpoints:cleanupVariantGroup`

- **Request**: `(projectDir: string, groupId: string, kind: "keep" | "discard", pickedLetter?: string)`
- **Response**: `{ ok: true } | { ok: false, error }`
- **Behaviour**:
  1. Read `<groupId>.json`.
  2. For each variant with a worktree and letter ≠ pickedLetter (keep) or all (discard): `cleanupVariantWorktree(projectDir, worktree)`.
  3. Update `resolved` block.
  4. Delete the group file.
- **Branches are NOT deleted** — retained 30 days per R13, swept by `prune-example-branches.sh`.

### `checkpoints:initRepo`

- **Request**: `(projectDir: string)`
- **Response**: `{ ok: true } | { ok: false, error }`
- **Behaviour**: `git init` + initial commit of whatever already exists in the dir (including `.gitignore` with `.dex/state.json`, `.dex/variant-groups/`, `.dex/worktrees/`).

### `checkpoints:setIdentity`

- **Request**: `(projectDir: string, name: string, email: string)`
- **Response**: `{ ok: true } | { ok: false, error }`
- **Behaviour**: `git config user.name` / `user.email` (local, never `--global`).

### `checkpoints:setRecordMode`

- **Request**: `(projectDir: string, on: boolean)`
- **Response**: `{ ok: true }`
- **Behaviour**: Updates `DexState.ui.recordMode` via `updateState(projectDir, { ui: { recordMode: on } })`. Mid-run toggle = from-now-forward only (spec FR-030).

### `checkpoints:setPauseAfterStage`

- **Request**: `(projectDir: string, on: boolean)`
- **Response**: `{ ok: true }`
- **Behaviour**: Updates `DexState.ui.pauseAfterStage`. Applied at the next stage boundary.

---

## Stage-aware comparison (read-only, but sits under same namespace)

### `checkpoints:compareAttempts`

- **Request**: `(projectDir: string, branchA: string, branchB: string, stage: LoopStageType)`
- **Response**: `{ diff: string }`
- **Behaviour**: Path filter lookup by stage:

  | Stage | Paths |
  |---|---|
  | `gap_analysis`, `manifest_extraction` | `.dex/feature-manifest.json` |
  | `specify`, `plan`, `tasks` | `specs/` |
  | `learnings` | `.dex/learnings.md` |
  | `verify` | `.dex/verify-output/` |
  | `implement`, `implement_fix` | (none — stat only) |

  - Stage in the table → `git diff <A>..<B> -- <paths>`.
  - Stage not in the table → `git diff --stat <A>..<B>`.
- **Used by both** Story 6 manual compare and Story 4 variant compare modal. Single implementation prevents drift (FR-033).

---

## Event stream additions

Existing channel: `orchestrator:event` (`webContents.send` from main, subscribed by `useOrchestrator` in the renderer).

This feature adds five event variants (see `data-model.md` §6). Renderer handlers:

| Event | Renderer handler |
|---|---|
| `stage_candidate` | `useTimeline` invalidates; step-mode sets `CandidatePrompt` open. |
| `checkpoint_promoted` | `useTimeline` invalidates; toast "Promoted <label>". |
| `paused { reason }` | LoopDashboard shows paused state; if `reason === "step_mode"` opens CandidatePrompt. |
| `variant_group_resume_needed` | `App.tsx` opens the "Continue variant group" modal; blocks Start button. |
| `variant_group_complete` | Opens `VariantCompareModal` if one is expected for the current group. |

---

## Resume flow (orchestrator startup)

1. `orchestrator.ts` startup path (`src/core/orchestrator.ts:1850-1945` in today's code):
   - Acquire `state.lock`.
   - Call `readPendingVariantGroups(projectDir)`.
   - If non-empty → emit `variant_group_resume_needed` for each → return (don't start a new run).
2. Renderer shows the Continue modal. User confirms.
3. Orchestrator resumes:
   - Variants with `status === "pending"` → spawn via `runSingleVariant`.
   - Variants with `status === "running"` → process died; recreate worktree if missing and restart from `fromCheckpoint`.
4. On group completion → emit `variant_group_complete` and call `cleanupVariantGroup` (keep or discard per user's compare-modal choice).

---

## Preload exposure

```ts
// src/main/preload.ts (excerpt)
contextBridge.exposeInMainWorld("dexAPI", {
  // … existing
  checkpoints: {
    listTimeline: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:listTimeline", projectDir),
    isLockedByAnother: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:isLockedByAnother", projectDir),
    checkIsRepo: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:checkIsRepo", projectDir),
    checkIdentity: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:checkIdentity", projectDir),
    estimateVariantCost: (projectDir: string, stage: LoopStageType, n: number) =>
      ipcRenderer.invoke("checkpoints:estimateVariantCost", projectDir, stage, n),
    readPendingVariantGroups: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:readPendingVariantGroups", projectDir),
    promote: (projectDir: string, tag: string, sha: string) =>
      ipcRenderer.invoke("checkpoints:promote", projectDir, tag, sha),
    goBack: (projectDir: string, tag: string, options?: GoBackOptions) =>
      ipcRenderer.invoke("checkpoints:goBack", projectDir, tag, options),
    spawnVariants: (projectDir: string, request: VariantSpawnRequest) =>
      ipcRenderer.invoke("checkpoints:spawnVariants", projectDir, request),
    deleteAttempt: (projectDir: string, branch: string) =>
      ipcRenderer.invoke("checkpoints:deleteAttempt", projectDir, branch),
    writeVariantGroup: (projectDir: string, group: VariantGroupFile) =>
      ipcRenderer.invoke("checkpoints:writeVariantGroup", projectDir, group),
    cleanupVariantGroup: (projectDir: string, groupId: string, kind: "keep"|"discard", pickedLetter?: string) =>
      ipcRenderer.invoke("checkpoints:cleanupVariantGroup", projectDir, groupId, kind, pickedLetter),
    initRepo: (projectDir: string) =>
      ipcRenderer.invoke("checkpoints:initRepo", projectDir),
    setIdentity: (projectDir: string, name: string, email: string) =>
      ipcRenderer.invoke("checkpoints:setIdentity", projectDir, name, email),
    setRecordMode: (projectDir: string, on: boolean) =>
      ipcRenderer.invoke("checkpoints:setRecordMode", projectDir, on),
    setPauseAfterStage: (projectDir: string, on: boolean) =>
      ipcRenderer.invoke("checkpoints:setPauseAfterStage", projectDir, on),
    compareAttempts: (projectDir: string, a: string, b: string, stage: LoopStageType) =>
      ipcRenderer.invoke("checkpoints:compareAttempts", projectDir, a, b, stage),
  },
});
```

---

## Error code catalogue

| Code | Raised by | Meaning |
|---|---|---|
| `locked_by_other_instance` | every mutating handler | Second Dex window on same project cannot mutate. |
| `dirty_working_tree` | `goBack` | Working tree has uncommitted changes; renderer opens `GoBackConfirm`. Payload includes `files: string[]`. |
| `cannot_delete_current` | `deleteAttempt` | Refused to delete the branch that is currently HEAD. |
| `tag_missing` | `promote`, `goBack` | Checkpoint tag does not exist (e.g., deleted externally). Renderer marks the timeline entry unavailable and offers refresh. |
| `git_operation_failed` | any (fallback) | A git subprocess exited non-zero. `context.stderr` included. Full error to `electron.log`; renderer shows friendly toast. |
| `not_a_repo` | `initRepo`, others called before init | `.git/` absent. Renderer should have caught via `checkIsRepo` first. |

---

## Tests (IPC-level)

Tests run under Electron with the main-process IPC handlers instantiated against a tmpdir project.

| Case | Assertion |
|---|---|
| `listTimeline` on empty repo | Returns `{checkpoints: [], attempts: [], ...}`. |
| `promote` happy path | Event `checkpoint_promoted` emitted; `listTimeline` now includes the tag. |
| `goBack` dirty tree | Returns `{ok: false, error: "dirty_working_tree", files}`. |
| `goBack` force=save | Creates `attempt-…-saved` branch with the dirty changes committed; then proceeds. |
| `spawnVariants` parallel | Group file written; 3 worktree dirs exist; result `parallel: true`. |
| `cleanupVariantGroup` keep | Non-picked worktrees removed; group file deleted; branches still exist. |
| `isLockedByAnother` | With a sibling process holding the lock → true; otherwise false. |
| `compareAttempts` with stage `plan` | Diff filtered to `specs/` only. |
| `compareAttempts` with stage `implement` | `git diff --stat` (no path filter). |
| `estimateVariantCost` empty project | Returns all nulls, `sampleSize: 0`. |
