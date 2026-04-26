# IPC Contract — `checkpoints:jumpTo`

**Direction**: Renderer → Main (`ipcMain.handle`)
**File**: `src/main/ipc/checkpoints.ts`
**Preload binding**: `window.dexAPI.checkpoints.jumpTo(projectDir, targetSha, options?)`

## Signature

```ts
type JumpToOptions = { force?: "save" | "discard" };

type JumpToResult =
  | { ok: true; action: "noop" }
  | { ok: true; action: "checkout"; branch: string }
  | { ok: true; action: "fork"; branch: string }
  | { ok: false; error: "dirty_working_tree"; files: string[] }
  | { ok: false; error: "not_found"; message: string }
  | { ok: false; error: "git_error"; message: string };

interface DexAPI {
  checkpoints: {
    jumpTo: (
      projectDir: string,
      targetSha: string,
      options?: JumpToOptions,
    ) => Promise<JumpToResult>;
  };
}
```

## Behavior

The handler holds the existing per-project lock (`withLock`) for the duration of the call:

1. `git rev-parse HEAD` → `H`. If `targetSha === H`, return `{ok: true, action: "noop"}`.
2. `isWorkingTreeDirty(projectDir)`:
   - If dirty and `options?.force` is unset, return `{ok: false, error: "dirty_working_tree", files}`.
   - If dirty and `options.force === "save"`, run the existing save flow used by `goBack` (create `attempt-<ts>-saved` branch, commit dirty changes there, return to original branch). Continue.
   - If dirty and `options.force === "discard"`, run `git reset --hard` + `git clean -fd`. Continue.
3. Resolve `targetSha`:
   - If `git rev-parse <targetSha>` fails, return `{ok: false, error: "not_found", message}`.
4. `git for-each-ref --points-at <targetSha> --format='%(refname:short)' refs/heads/`:
   - Exactly one entry → `git checkout <branch>`. Return `{ok: true, action: "checkout", branch}`.
   - Otherwise → call `startAttemptFrom()`-style helper to `git checkout -B <attemptBranch> <targetSha>`. Return `{ok: true, action: "fork", branch: <attemptBranch>}`.
5. Any git error → `{ok: false, error: "git_error", message: <stderr>}`.

The handler MUST NOT touch `state.json` directly — the existing post-checkout reconciliation (in `runLoop` or via `state.detectStaleState`) handles state realignment on the next orchestrator tick.

## Error fallback for `checkpoints:listTimeline`

The existing handler at `src/main/ipc/checkpoints.ts:82–96` builds a fallback object on error. It MUST be extended to include `commits: []` and `selectedPath: []` so the renderer's new code paths never see `undefined`:

```ts
return {
  checkpoints: [],
  attempts: [],
  currentAttempt: null,
  pending: [],
  captureBranches: [],
  startingPoint: null,
  commits: [],         // NEW
  selectedPath: [],    // NEW
};
```

## Interactions with existing IPC

- `checkpoints:goBack` — kept. The right-click "Unmark kept" verb maps to `checkpoints:promote`'s tag-removal counterpart (a small new helper or a flag on `promote`); `goBack` itself is not invoked from the new context menu.
- `checkpoints:promote` — kept and called by **Keep this**.
- `checkpoints:listTimeline` — payload extended (see [timeline-snapshot.md](./timeline-snapshot.md)).

## Renderer call pattern

```tsx
async function handleNodeClick(commit: TimelineCommit) {
  const res = await window.dexAPI.checkpoints.jumpTo(projectDir, commit.sha);
  if (res.ok) {
    if (res.action === "noop") return;            // no-op: don't refresh
    refreshTimeline();                             // triggers useTimeline re-fetch
    return;
  }
  if (res.error === "dirty_working_tree") {
    openGoBackConfirm({
      files: res.files,
      onSave:    () => window.dexAPI.checkpoints.jumpTo(projectDir, commit.sha, {force: "save"}),
      onDiscard: () => window.dexAPI.checkpoints.jumpTo(projectDir, commit.sha, {force: "discard"}),
    });
    return;
  }
  showToast(`Jump failed: ${res.message ?? res.error}`);
}
```
