# Test: delete a merged branch via the UI (local only)

Exercises the in-app **delete branch** action added in `014-branch-management`. The action must remove the branch locally without propagating the deletion to `origin`.

**Target project:** `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`

**Follow `.claude/rules/06-testing.md`** for the standard test mechanics — dev server startup, log/state diagnostics. This file specifies only what is unique to this scenario.

## Prerequisite

This test depends on the post-state of `001-first-two-features.md`: at least one `dex/*` branch merged into `main` and pushed to `origin` (ideally two, so you can verify the *other* one is left untouched).

**Do not reset before running this test** — the prior test's branches are exactly what you're operating on. If your repo doesn't have that state, run `001-first-two-features.md` first.

Sanity check before starting:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch --merged main           # should list one or more dex/* branches
git branch -r | grep 'origin/dex/' # should list the same branches under origin/
```

## Definition of Done

- [ ] The deletion is performed **via the in-app UI** added in 014 — not via `git branch -D` from a terminal.
- [ ] After the action, `git branch` no longer lists the deleted `dex/*` branch locally.
- [ ] After the action, `git branch -r` still lists it as `origin/dex/...` — the deletion did **not** propagate to the remote.
- [ ] No other branch was affected — `main` is intact, and any other `dex/*` branches still exist both locally and on `origin`.

## Steps

### 1. Identify the branch to delete

The "first branch merged into main" is the `dex/*` branch from spec 001 in the `first-two-features` scenario — i.e. the **oldest** merged `dex/*` branch.

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git for-each-ref --sort=committerdate --format='%(refname:short)' refs/heads/dex/ | head -1
```

Record the exact branch name — you will reference it in step 3 for verification. If multiple `dex/*` branches exist and ordering is ambiguous, **confirm the choice with the user before proceeding**.

### 2. Delete it via the in-app UI

Make sure the dev server is running (06-testing.md § 4c Step 2). Open the app, fill the welcome screen for `dex-ecommerce` and click **Open Existing**.

Navigate to the **Branch Management** surface added in 014. Locate the branch identified in step 1 in the listing and click its **delete** affordance. Confirm any dialog the UI surfaces.

Do **not** run `git branch -D` from a terminal — the point of this test is to verify the in-app action behaves correctly.

Capture a snapshot or screenshot of the UI state immediately before and after the delete (for the report).

### 3. Verify the result

After the UI action completes:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git fetch --prune origin   # make sure local view of origin is fresh
git branch -a
```

Expected output:

- The deleted branch **does not** appear under local branches.
- It **does** still appear as `remotes/origin/dex/...` — origin was not touched.
- `main` and any other `dex/*` branches are still present locally and on origin.

Failure modes to flag explicitly:

- Local branch still present → the UI deletion failed silently. Check renderer console (`mcp__electron-chrome__list_console_messages`) and `~/.dex/dev-logs/electron.log` for IPC errors.
- Branch missing from `origin` too → the UI is incorrectly propagating the delete to the remote. That is a bug in 014.
- A different branch was deleted → wrong selection in the UI; capture which branch was lost.

## Reporting

Capture:

- The exact branch name that was deleted.
- `git branch -a` output **before** and **after** the deletion (so the local-vs-origin state is visible side-by-side).
- Any UI feedback shown after the delete (toast, confirmation, error).
- Pass/fail status against each DoD item, with pointers to logs or screenshots backing each claim.
