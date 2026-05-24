# IPC Contract: `checkpoints:deleteBranch`

**Channel**: `checkpoints:deleteBranch`
**Direction**: Renderer → Main (request/response via `ipcMain.handle`)
**Lock**: Acquires `withLock(projectDir, ...)` — concurrent invocations against the same project queue.

## Request

```ts
window.dexAPI.deleteBranch(
  projectDir: string,
  branchName: string,
  opts?: { confirmedLoss?: boolean },
): Promise<DeleteBranchResult>
```

| Argument | Type | Notes |
|---|---|---|
| `projectDir` | absolute path | Must be the same project the timeline is open against. |
| `branchName` | string | Local branch name (no `refs/heads/` prefix). |
| `opts.confirmedLoss` | boolean (optional) | Set to `true` on the second call after the user confirms the lost-work modal. Default `false`. |

## Response

`DeleteBranchResult` (see [data-model.md](../data-model.md#2-branch-operations--branchopsts)). Discriminated union; key on `ok`.

### Success: `{ ok: true; deleted: string; switchedTo: string | null }`

- `deleted`: the branch name that was removed.
- `switchedTo`: the branch HEAD now points to. `null` when HEAD was not on the deleted branch (no switch needed); `"main"` (or `"master"`) when HEAD was on the deleted branch and the handler switched it before deletion.

### Error: `{ ok: false; error: "not_dex_owned"; branch: string }`

The branch is not `dex/*` and not `selected-*`. Renderer copies "Remove this version" → never shown for this case (the ✕ control should not have been rendered); the error is a defense-in-depth check.

### Error: `{ ok: false; error: "is_protected"; branch: string }`

The branch is `main` or `master`. Same defense-in-depth as `not_dex_owned`.

### Error: `{ ok: false; error: "no_primary_to_switch_to" }`

HEAD is on the target branch and neither `main` nor `master` exists. Caller renders the "the project doesn't have a primary version to fall back to" message (rare; documented in spec edge cases).

### Error: `{ ok: false; error: "would_lose_work"; lostSteps: LostStep[] }`

The branch carries one or more commits not reachable from any other tracked branch. Caller MUST display `<DeleteBranchConfirm>` listing the `lostSteps` and re-call with `opts.confirmedLoss: true` if the user confirms.

### Error: `{ ok: false; error: "branch_in_active_run"; branch: string }`

The orchestrator's `state.json` reports `status === "running"` and `currentBranch === branchName`. Renderer shows the friendly mid-run message.

### Error: `{ ok: false; error: "git_error"; message: string }`

Catch-all for unexpected git failures. `message` carries the underlying stderr text — surfaced to logs but not directly to the user.

## Lost-work detection

The handler executes:

```sh
git log --format=%H <branchName> --not --branches=main --branches=master --branches='dex/*' --branches='selected-*'
```

Each resulting SHA is mapped to a `LostStep` by:

1. Inspect the commit's subject for the `[checkpoint:<stage>:<cycle>]` trailer (added by `commitCheckpoint`).
2. If present: format as `"Cycle <cycle> — <human stage>"` where `<human stage>` comes from `stageLabels` in `tags.ts`.
3. If absent: format as `"<commit subject (truncated to 60 chars)>"`.

`shortSha`: first 7 chars of the SHA.

## HEAD-handling

```ts
if (currentBranch === branchName) {
  if (mainExists) {
    git checkout main
    switchedTo = "main"
  } else if (masterExists) {
    git checkout master
    switchedTo = "master"
  } else {
    return { ok: false, error: "no_primary_to_switch_to" }
  }
}
git branch -D <branchName>
```

The `git branch -D` (capital D, force-delete) is required because the branch may carry unique commits that the user has explicitly elected to lose (or that are reachable only from the now-checked-out main, in which case `-d` would also work). Using `-D` uniformly keeps the code path single.

## Mid-run-active detection

Read `<projectDir>/.dex/state.json`. If the file exists and:

- `state.status === "running"`, AND
- `state.currentBranch === branchName`,

then return `branch_in_active_run`. This is consistent with the existing `withLock` posture: the lock prevents *concurrent* writes to state, but a running orchestrator that holds the lock between writes wouldn't be caught by lock alone.

## Logging

The handler writes a single line to the IPC logger on success:
```
[INFO] deleteBranch: deleted <branchName>(switchedTo=<...>) (caller=<wcId>)
```

On error, the discriminated `error` tag is logged at `WARN` level alongside the underlying message.

## Backwards-incompatible removals

This contract supersedes:

- IPC channel `checkpoints:unselect` (deleted)
- `window.dexAPI.unselect(projectDir, branchName)` (removed from preload)
- `unselect()` in `src/core/checkpoints/jumpTo.ts` (function removed; file kept)

Renderer call sites are updated in lockstep; no compat shim is provided (Constitution IV — no backwards-compatibility shims when the call sites can be updated atomically).
