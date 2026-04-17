# Contracts

**Feature**: 005-testing-improvements

This feature exposes **no external API contracts** — no public TypeScript exports, no IPC handlers, no HTTP endpoints, no library interfaces. The only surface contracts are the two shell-script CLIs that the testing protocol invokes.

They are documented here as the unit of review/testing so downstream `/speckit.tasks` can pin its verification to stable signatures.

---

## `dex/scripts/reset-example-to.sh`

### Invocation

```bash
./dex/scripts/reset-example-to.sh <checkpoint>
```

### Arguments

| Position | Name | Type | Required | Values |
|----------|------|------|----------|--------|
| 1 | `checkpoint` | string | Yes | `clean`, `after-clarification`, `after-tasks` |

### Environment

None. `TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` is hardcoded. No override.

### Side effects (by checkpoint)

**`clean`** (post-conditions):

- Current branch: `main`
- Working tree: only `GOAL.md` and `.git/` present
- `git status --short`: empty

**`after-clarification`** (post-conditions):

- Current branch: `fixture/after-clarification`
- Working tree matches the committed tree of `fixture/after-clarification`
- `.dex/state.json`'s `branchName` field equals `fixture/after-clarification`
- `git status --short`: empty

**`after-tasks`** (post-conditions):

- Current branch: `fixture/after-tasks`
- Working tree matches the committed tree of `fixture/after-tasks`
- `.dex/state.json`'s `branchName` field equals `fixture/after-tasks`
- `git status --short`: empty

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success — workspace restored, sanity check passed |
| 1 | Runtime failure: fixture branch missing, `state.json.branchName` drift, or any git error |
| 2 | Usage error: unknown checkpoint argument |

### Stderr behavior

- On exit 1 (missing fixture): `fatal: Needed a single revision` (from `git rev-parse --verify`) or `fixture drift: state.json branchName != <branch>`
- On exit 2: `unknown checkpoint: <value>`

### Invariants

- Only touches `$TARGET`. Never modifies any other repository.
- `set -euo pipefail` — any intermediate failure aborts.
- Destructive operations (`git reset --hard`, `git clean -fdx`) run only inside `$TARGET` via `cd "$TARGET"`.

---

## `dex/scripts/prune-example-branches.sh`

### Invocation

```bash
./dex/scripts/prune-example-branches.sh
```

### Arguments

None.

### Environment

None. `TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` is hardcoded.

### Behavior

1. Enumerate local refs matching `refs/heads/dex/*` with their committer-date in Unix seconds.
2. For each, if committer-date is older than `now - 7 days`, delete via `git branch -D`.
3. Branches matching `fixture/*`, `main`, or `lukas/*` are unreachable by the enumeration and therefore untouched regardless of age.
4. The currently checked-out branch, if it matches `dex/*`, is skipped by `git branch -D` (git refuses). Script continues.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including the case where no branches qualify for deletion) |
| 1 | Git operation error |

### Stdout

One line per deleted branch: `Deleted branch <name> (was <sha>).` (git's default output). May be empty.

### Invariants

- Never modifies remote branches.
- Never touches `main`, `fixture/*`, or `lukas/*`.
- Never touches `dex/*` branches younger than 7 days (per committer date).
- Never deletes the currently checked-out branch (git-enforced).
- Never runs outside `$TARGET`.

---

## Why no TypeScript/IPC contracts

- The feature is test-infrastructure tooling, not user-facing functionality.
- FR-015 forbids source-code changes in `src/core/`, `src/main/`, `src/renderer/`.
- The orchestrator's existing `detectStaleState`, `reconcileState`, `runLoop` resume entry, and UI `handleStart`/Topbar button-label logic are the only "contracts" this feature relies on — and they remain unchanged. Referencing them as stable contracts is recorded in `plan.md` Technical Context, not here.
