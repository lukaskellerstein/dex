# Quickstart — Verifying Branch Management End-to-End

**Feature**: 014-branch-management
**Audience**: a developer or reviewer wanting to walk every spec acceptance scenario on the running Dex app.
**Test target**: `dex-ecommerce` example project at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`.

This walkthrough maps each spec User-Story-Acceptance scenario (`US<n>-AS<m>`) to a concrete test recipe. Run it after implementation; each step is also a Definition-of-Done item from the source design doc.

## 0 — Pre-flight

Before any test in this guide:

```sh
# 1. Make sure dev-setup is running (vite + electron + chrome devtools on port 9333).
ls ~/.dex/dev-logs/electron.log    # must exist; if not, start dev-setup.sh

# 2. Verify MCP connectivity.
# (In Claude conversation:) call mcp__electron-chrome__list_pages
# Expect: at least one page entry pointing at the Dex app.
```

Reset script semantics:

```sh
./scripts/reset-example-to.sh list                       # list checkpoints
./scripts/reset-example-to.sh clean                      # blank slate (rare)
./scripts/reset-example-to.sh cycle-2-after-tasks        # typical mid-cycle reset
```

Each reset puts `dex-ecommerce` on a fresh `attempt-<ts>` branch derived from the chosen checkpoint, with `.dex/` and `.specify/` restored to the checkpoint's state.

---

## 1 — US1: Remove a saved version

### Recipe 1A — Clean delete (no unique work)

**Maps to**: US1-AS1, US1-AS2, FR-001, FR-007, DoD #1.

1. `./scripts/reset-example-to.sh cycle-2-after-tasks`
2. In Dex, open the project. The timeline shows the `dex/<date>-...` branch from cycle 2.
3. **MCP**: `mcp__electron-chrome__take_snapshot`. Find the `delete-branch-<dex/...>` testid on the badge.
4. **MCP**: `mcp__electron-chrome__click` on that testid.
5. Expect: timeline refreshes within 2 seconds, the `dex/*` badge is gone, no modal appeared (the branch had no unique commits relative to other tracked refs).
6. **Shell verify**:
   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git rev-parse --abbrev-ref HEAD       # → main
   git branch --list 'dex/*'             # empty
   ```

### Recipe 1B — Lost-work warning

**Maps to**: US1-AS3, FR-004, DoD #2.

1. `./scripts/reset-example-to.sh clean`
2. In Dex, run **one full autonomous cycle** end-to-end (Specify → Plan → Tasks → Implement) so a `dex/*` branch with unique commits exists.
3. After the run finishes, do **not** click "Keep This" on any cycle — leave the branch unique.
4. **MCP**: click the delete control on the `dex/*` badge.
5. Expect: `<DeleteBranchConfirm>` modal opens titled "These steps will be lost", listing entries like:
   - "Cycle 0 — Plan" (`abc1234`)
   - "Cycle 0 — Tasks" (`def5678`)
   - "Cycle 0 — Implement" (`ghi9012`)
6. **Test**: click **Cancel**. Branch must remain.
7. Re-open and click **Remove**. Branch is removed; HEAD is on `main`.

### Recipe 1C — Delete-the-current-version

**Maps to**: US1-AS2, FR-003.

1. After Recipe 1A's reset and before any deletion, in the terminal:
   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout dex/<the-branch>
   ```
   so HEAD is on the to-be-deleted branch.
2. In Dex, click delete on that badge.
3. Expect: HEAD switches to `main` *before* the branch is removed; both happen inside one IPC call.

### Recipe 1D — Refusal on protected branches

**Maps to**: US1-AS5, FR-002, DoD #3, #4.

1. **MCP**: `take_snapshot` on a fresh project. Search for testids matching `delete-branch-main`, `delete-branch-master`. Expect: none rendered.
2. Manually create a user branch:
   ```sh
   cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
   git checkout -b feature/foo
   ```
3. Refresh Dex timeline. Expect: no delete control on `feature/foo`'s badge.

### Recipe 1E — Refusal mid-run

**Maps to**: US1-AS4, FR-005, DoD #5.

1. Reset and start an autonomous loop. While the orchestrator is mid-cycle (state.json reports `status: running`):
2. **MCP**: click delete on the active `dex/*` badge.
3. Expect: friendly modal/toast with "this version is currently being built — pause the run first". `git branch --list 'dex/*'` still includes the branch.

---

## 2 — US2: Promote (clean merge)

### Recipe 2A — Clean promote

**Maps to**: US2-AS1/2/3, FR-008..FR-014, DoD #6.

1. `./scripts/reset-example-to.sh cycle-2-after-tasks`. Confirm `main` and one `dex/*` exist; `main` has *not* moved past the fork point.
2. **MCP**: right-click on the `dex/*` badge.
3. Expect: `<BranchContextMenu>` opens with "Make this the new main".
4. Click it. `<PromoteConfirm>` opens with diff summary (e.g. "12 files changed · +340 -82") and the top-5 paths.
5. Click "Make this the new main". Expect: success toast "<source> is now main. The old version has been removed."
6. **Shell verify**:
   ```sh
   git -C dex-ecommerce log --oneline -5         # newest is "dex: promoted <source> to main"
   git -C dex-ecommerce log --merges -1 --format='%P'  # has TWO parents (no fast-forward)
   git -C dex-ecommerce branch --list 'dex/*'    # empty
   git -C dex-ecommerce tag -l 'checkpoint/promoted-*'  # MUST be empty (regression)
   git -C dex-ecommerce rev-parse --abbrev-ref HEAD     # → main
   ```
7. Visual check: timeline shows fork-and-rejoin shape (the `dex/*` lane converges back into `main`).

### Recipe 2B — Mid-run refusal

**Maps to**: US2-AS4, FR-012, DoD #7.

1. Start an autonomous loop. While running:
2. **MCP**: right-click another (non-running) `dex/*` badge → click "Make this the new main".
3. Confirmed via friendly mid-run refusal; no merge commit on `main`.

### Recipe 2C — Dirty-tree-save

**Maps to**: US2-AS5, FR-013, DoD #14.

1. After Recipe 2A's reset, edit a tracked file in the worktree.
2. Right-click promote on the `dex/*` badge.
3. `<GoBackConfirm>` opens (Save / Discard / Cancel).
4. Click **Save**. Expect: edit is committed on the current branch (not the source branch); promote then proceeds normally.

### Recipe 2D — Disabled menu items

**Maps to**: US2-AS6, FR-009.

1. Right-click on `main`'s badge.
2. Expect: `<BranchContextMenu>` opens with "Make this the new main" disabled, with a tooltip explaining why.
3. Right-click on `feature/foo` (created in Recipe 1D). Same expectation.

---

## 3 — US3: AI conflict resolution

### Recipe 3A — Single-file conflict

**Maps to**: US3-AS1/2, FR-016..FR-018, DoD #8.

Hand-prep a conflicting state:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
./scripts/reset-example-to.sh cycle-2-after-tasks
# Find the source branch
SOURCE=$(git branch --list 'dex/*' --format='%(refname:short)' | head -1)
# Add a conflicting commit to main
git checkout main
echo "// touched on main" >> src/index.ts
git add . && git commit -m "main: touch index"
# Restore main back to where Dex thinks
```

Then:

1. In Dex, right-click `dex/*` → "Make this the new main".
2. Confirm the diff modal.
3. Expect: `<ConflictResolverProgress>` opens. Iteration counter ticks; current file shown.
4. Resolver succeeds. Verify command runs (`npx tsc --noEmit`). On pass: success toast "AI resolved 1 disagreement. The new main is ready."
5. **Shell verify** as Recipe 2A.

### Recipe 3B — Multi-file conflict

**Maps to**: US3-AS1, DoD #9.

Same as 3A but craft conflicts in two files. Expect: progress modal increments through both, each shown separately. Final toast says "AI resolved 2 disagreements".

### Recipe 3C — User cancel

**Maps to**: US3-AS3, FR-021.

1. Trigger a conflicting promote. While `<ConflictResolverProgress>` is showing:
2. Click **Cancel**.
3. Expect: resolver halts. `git status` clean. `git log main` shows no merge commit. Source branch still exists.

### Recipe 3D — Non-content conflict

**Maps to**: US3-AS4, FR-020, DoD #12.

Hand-prep a rename-vs-delete:

```sh
git checkout dex/<branch>
git mv src/foo.ts src/bar.ts
git add . && git commit -m "rename foo to bar"
git checkout main
git rm src/foo.ts
git commit -m "delete foo"
```

Promote `dex/<branch>`. Expect: merge attempt aborts before invoking resolver. Friendly message "This version has a kind of conflict AI can't resolve yet…" appears. `git status` clean.

### Recipe 3E — Cost cap hit

**Maps to**: US3-AS5, FR-019, SC-008, DoD #13.

1. Edit `<projectDir>/.dex/dex-config.json`: set `"conflictResolver": { "costCapUsd": 0.001 }`.
2. Trigger a conflicting promote. Expect: resolver halts at first iteration; `<ResolverFailureModal>` opens with iterations exhausted / cost cap reason.

---

## 4 — US4: Failure escape paths

### Recipe 4A — Max iterations + accept-what-AI-did

**Maps to**: US4-AS1/2, FR-022, FR-024, DoD #10.

1. `dex-config.json`: `"conflictResolver": { "maxIterations": 1 }`.
2. Hand-craft an unresolvable conflict (e.g. mutually exclusive interface signatures).
3. Promote. Resolver fails after 1 iteration; `<ResolverFailureModal>` opens with three buttons.
4. Click **Accept what AI did**. Expect: merge committed despite verify-fail. Source deleted; HEAD on main; toast.

### Recipe 4B — Roll back the merge entirely

**Maps to**: US4-AS3, FR-025, DoD #10.

Same setup as 4A. In failure modal, click **Roll back the merge entirely**. Expect: `git merge --abort` runs. `git log main` unchanged. Source branch intact. No tag created.

### Recipe 4C — Open in editor

**Maps to**: US4-AS4, FR-022/023.

Same setup. Click **Open in editor** (small button bottom-right). Expect: external editor opens on the conflicted file paths. Merge state is preserved (the user can re-call accept or rollback after editing).

### Recipe 4D — Verify-failure path

**Maps to**: FR-018, US4-AS2, DoD #11.

1. `dex-config.json`: `"conflictResolver": { "maxIterations": 5, "verifyCommand": "npx tsc --noEmit" }`.
2. Engineer a conflict where the resolver removes markers but the result fails type-check (e.g. a deliberately type-incompatible merge).
3. Resolver finishes. Verify fails. `<ResolverFailureModal>` opens with `verify_failed` reason.
4. Accept-what-AI-did still works (user override).

---

## 5 — Cross-cutting

### Recipe 5A — Copy hygiene grep

**Maps to**: FR-028, FR-029, SC-004.

```sh
# from repo root
grep -rE '\b(merge|branch|fast-forward|rebase|conflict marker|PR)\b' src/renderer/components/checkpoints/branchOps/copy.ts
```

Expect: zero matches outside string literals that are explicitly part of the failure-modal labels (`Roll back the merge entirely`). All other user-visible strings use vibe-coder vocabulary. Total whitelist: ≤ 3 strings, all in `copy.ts`, each annotated with a `// allowed: …` comment.

Sanity grep across the whole renderer:

```sh
grep -rE '\b(merge commit|fast-forward|conflict marker|--no-ff)\b' src/renderer/components/checkpoints/
```

Expect: zero matches.

### Recipe 5B — Type/build/test

**Maps to**: DoD #15.

```sh
npm run test:core
npm run test:renderer
npx tsc --noEmit
```

All green.

### Recipe 5C — Visual catalog

**Maps to**: DoD #16.

Take MCP screenshots at:

1. ✕ tooltip on `dex/*` badge ("Remove this version").
2. `<DeleteBranchConfirm>` listing lost steps.
3. `<PromoteConfirm>` with diff summary.
4. `<ConflictResolverProgress>` mid-run.
5. `<ResolverFailureModal>` showing all three buttons.
6. Post-merge timeline showing fork-and-rejoin.

Save to `specs/014-branch-management/screenshots/` (gitignored — checked into the implementation PR via inline embeds).

---

## What to do when a recipe fails

1. Capture the DEBUG badge payload (Loop Dashboard or trace view).
2. Open `~/.dex/logs/<project>/<runId>/run.log` for run-level events; cross-reference resolver lifecycle with the per-phase logs.
3. For mid-flight UI issues, `mcp__electron-chrome__list_console_messages` surfaces React-side errors that don't appear in `electron.log`.
4. For resolver-specific issues, the IPC logger writes one line per major harness boundary; grep the IPC log for `mergeToMain:` or `conflict-resolver:`.
