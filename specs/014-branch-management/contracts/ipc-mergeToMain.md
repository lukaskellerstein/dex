# IPC Contract: `checkpoints:mergeToMain`

**Channel**: `checkpoints:mergeToMain`
**Direction**: Renderer → Main (request/response via `ipcMain.handle`)
**Side channel**: `orchestrator:event` (`webContents.send`) — resolver progress events stream while the request is in flight.
**Lock**: Acquires `withLock(projectDir, ...)`.

## Request

```ts
window.dexAPI.mergeToMain(
  projectDir: string,
  sourceBranch: string,
  opts?: MergeToMainOpts,
): Promise<MergeToMainResult>
```

| Argument | Type | Notes |
|---|---|---|
| `projectDir` | absolute path | Same project the timeline is open against. |
| `sourceBranch` | string | A `dex/*` or `selected-*` branch. Defense-in-depth check rejects others. |
| `opts.force` | `"save" \| "discard"` (optional) | Mirrors `JumpToOpts.force`. Caller passes after the user picks an option in `<GoBackConfirm>` for a dirty tree. |
| `opts.resolverOverride` | `Partial<ConflictResolverConfig>` (optional) | One-shot override of the project's resolver config. Used by tests to inject lower limits; not exposed in v1 UI. |

## Response

`MergeToMainResult` — discriminated union, key on `ok` then `mode`/`error`.

### Success: clean merge

```ts
{ ok: true; mode: "clean"; mergeSha: string; deletedSource: string }
```

The merge had no conflicts. `mergeSha` is the new merge-commit SHA on `main`; `deletedSource` echoes the source branch name (now removed). Renderer fires success toast.

### Success: AI-resolved merge

```ts
{
  ok: true; mode: "resolved";
  mergeSha: string;
  deletedSource: string;
  resolverCostUsd: number;
  resolvedFiles: string[];
}
```

The merge had conflicts; the resolver finished, verified, committed. `resolverCostUsd` and `resolvedFiles.length` populate the success toast ("AI resolved N disagreements. The new main is ready.").

### Error: dirty tree

```ts
{ ok: false; error: "dirty_working_tree"; files: string[] }
```

Returned only when `opts.force` is undefined. Renderer responds by opening `<GoBackConfirm>` with the file list, then re-calls with `opts.force` set to whichever button the user picked.

### Error: branch active in run

```ts
{ ok: false; error: "branch_in_active_run"; branch: string }
```

The orchestrator is currently building `branch`. Friendly refusal.

### Error: main active in run

```ts
{ ok: false; error: "main_in_active_run" }
```

The orchestrator is currently checked out on `main`. Friendly refusal.

### Error: not Dex-owned

```ts
{ ok: false; error: "not_dex_owned"; branch: string }
```

Defense-in-depth: the context-menu item should have been disabled. The promote core-fn double-checks before any destructive op.

### Error: no primary

```ts
{ ok: false; error: "no_primary_branch" }
```

Neither `main` nor `master` exists. Edge case from spec.

### Error: non-content conflict

```ts
{ ok: false; error: "non_content_conflict"; kinds: NonContentConflictKind[] }
```

Detected via the algorithm in [research.md R1](../research.md#r1--detecting-non-content-conflicts-before-invoking-the-resolver). Merge has been aborted (`git merge --abort`). Renderer shows the single-line message from the copy module.

### Error: resolver failed

```ts
{
  ok: false; error: "resolver_failed";
  reason: ResolverFailReason;
  partialMergeSha: string | null;
}
```

The resolver gave up. `reason` distinguishes:
- `max_iterations` — outer iteration cap reached.
- `cost_cap` — cumulative cost would exceed `costCapUsd`.
- `verify_failed` — files resolved but verify command returned non-zero.
- `agent_gave_up` — the SDK reported a non-normal stream end (e.g. tool returned an unrecoverable error).
- `user_cancelled` — the user clicked Cancel on the progress modal.

`partialMergeSha` is the SHA of the (uncommitted) index state if the user picks "Accept what AI did" via a follow-up `checkpoints:acceptResolverPartial` call. **Not exposed in v1** — the renderer reads `partialMergeSha` only as a hint that the merge is recoverable; the accept/rollback choice is handled by **two follow-up IPC channels** described below.

### Error: git_error

Catch-all for unexpected git failures.

## Follow-up IPCs (failure modal)

The failure modal in `<ResolverFailureModal>` calls one of three follow-ups:

### `checkpoints:acceptResolverResult`

```ts
window.dexAPI.acceptResolverResult(projectDir: string): Promise<{ ok: true; mergeSha: string } | { ok: false; error: string }>
```

Stages all files in the working tree and commits the in-progress merge with the canonical merge subject (`dex: promoted <source> to main`). Then runs the post-merge actions (delete source branch, switch HEAD if not already there, emit success toast). Used by the "Accept what AI did" button.

### `checkpoints:abortResolverMerge`

```ts
window.dexAPI.abortResolverMerge(projectDir: string): Promise<{ ok: true } | { ok: false; error: string }>
```

Runs `git merge --abort`. Working tree, primary branch, and source branch return to pre-merge state. Used by "Roll back the merge entirely" — and, internally, by the `mergeToMain` handler itself when a `non_content_conflict` is detected.

### `checkpoints:openInEditor`

```ts
window.dexAPI.openInEditor(projectDir: string, files: string[]): Promise<{ ok: true } | { ok: false; error: string }>
```

Resolves the user's `$EDITOR` (falls back to `xdg-open` on Linux, `open` on macOS) and spawns it on the conflicted files. Does **not** run `git merge --abort` automatically — the merge stays in its current state, and the user can re-call either of the prior two IPCs after editing. This is the single intentional power-user gesture in the feature surface.

## In-flight progress events

While the resolver runs, the main process forwards `ConflictResolverEvent`s (see [data-model.md §5](../data-model.md#5-event-stream-additions)) over `webContents.send("orchestrator:event", evt)`. Renderer is expected to:

1. Subscribe on `mergeToMain` invocation (before `await`).
2. Filter events where `type` starts with `conflict-resolver:`.
3. Drive the `<ConflictResolverProgress>` UI from `iteration` and `file-start` events.
4. Unsubscribe on terminal `done` event or when the response Promise resolves.

Event ordering guarantee: events stream in the order the harness emits them. The harness emits `file-start` before any `iteration` for that file, and emits `file-done` before moving to the next file. `done` is the last event in the stream for a given invocation.

## Cancellation

The renderer cancels via `window.dexAPI.abortResolverMerge(projectDir)` (the same IPC the failure modal uses). The currently-running `runOneShot` call's `AbortController` is signalled, the SDK aborts, the harness emits `done` with `reason: "user_cancelled"`, and the merge is rolled back. The `mergeToMain` Promise then resolves with `{ ok: false, error: "resolver_failed", reason: "user_cancelled", partialMergeSha: null }`.

## Logging

```
[INFO] mergeToMain: starting source=<sourceBranch> target=main force=<save|discard|none>
[INFO] mergeToMain: clean merge committed mergeSha=<sha>
[INFO] mergeToMain: conflicts detected files=<n> handing off to resolver
[INFO] mergeToMain: resolver finished ok=<bool> cost=$<n>
[INFO] mergeToMain: post-actions complete deleted=<source> switched=<true|false>
```

Errors logged at `WARN` with the discriminated tag.
