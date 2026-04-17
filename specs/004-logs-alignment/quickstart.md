# Quickstart: Verify Unified Logs & Diagnostics Layout

**Feature**: `004-logs-alignment`
**Phase**: 1 — Design
**Audience**: The engineer (or Claude Code instance) performing end-to-end verification after implementation.

This is the Definition of Done for the feature. Every item below MUST pass before the feature is reported as complete, per `.claude/rules/06-testing.md` section 4c and Constitution Principle III.

---

## Prerequisites

- Clean working tree on branch `004-logs-alignment` with all source changes applied.
- Dev environment set up (`node_modules/` present, TypeScript compiled on demand).
- Example project `dex-ecommerce` available at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`.

---

## Step 1 — Pre-upgrade snapshot (optional but recommended)

Capture the legacy state *before* the code changes take effect. Skip any lines where the file does not exist — fresh installs are valid and skip the migration entirely (Acceptance Scenario 3 of User Story 2).

```bash
# Legacy audit DB — must be present for the "zero data loss" check below to mean anything
ls -la ~/.dex/data.db* 2>&1

# Legacy fallback log — rare; present only if the orchestrator crashed pre-run
ls -la ~/.dex/orchestrator.log 2>&1

# Legacy per-project learnings — present only if the loop has run a completed cycle
ls -la /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.claude/rules/learnings.md 2>&1

# Note the latest run ID — used for the post-upgrade preservation check (SC-002)
sqlite3 ~/.dex/data.db "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1;"
```

Record the run ID printed by the final command for use in Step 6.

---

## Step 2 — Typecheck

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex
npx tsc --noEmit
```

**Expected**: exit code 0, no type errors. Verifies the new `paths.ts` exports are consumed correctly by the three modified modules.

---

## Step 3 — Launch dev environment (ask the user — `dev-setup.sh` is run manually)

The user runs `./dev-setup.sh`. Observe the startup banner. It must print the new paths:

```
  Log files:
    /home/<user>/.dex/dev-logs/vite.log
    /home/<user>/.dex/dev-logs/electron.log
```

**Expected**:

- `ls ~/.dex/dev-logs/` shows both `vite.log` and `electron.log`.
- `/tmp/dex-logs/` is not created (or is left untouched if it pre-existed — the script no longer writes there).

---

## Step 4 — Exercise the full writer set (drives the `dex-ecommerce` example)

Reset the example project to a clean state per `.claude/rules/06-testing.md` section 4c.1:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git checkout main && git reset --hard HEAD && git clean -fdx
```

Drive the Electron app through the welcome screen and start the autonomous loop per section 4c.3–4c.4. Let the loop run until it has:

- Called `initDatabase` (happens on first IPC, long before the loop starts — triggers DB migration).
- Written at least one line through the fallback logger (if a legacy `orchestrator.log` existed — otherwise this step is a no-op by design).
- Completed at least one cycle that calls `appendLearnings` (first cycle that persists insights — triggers `learnings.md` migration).

Typical cost: one short cycle on `dex-ecommerce` is enough.

---

## Step 5 — Post-upgrade layout assertions

Inspect the global Dex home:

```bash
ls ~/.dex/
```

**Expected** (order may vary):

```
db/
logs/
dev-logs/
```

**Rejected outputs** (fail the check):

- Loose `data.db*` files at the root of `~/.dex/` → DB migration did not run.
- Loose `orchestrator.log` at the root of `~/.dex/` → fallback-log migration did not run (only fails if Step 1 showed a legacy file).

Drill down:

```bash
ls ~/.dex/db/        # expect: data.db data.db-wal data.db-shm
ls ~/.dex/logs/      # expect: _orchestrator.log (if legacy existed) and/or <project>/<runId>/ trees
ls ~/.dex/dev-logs/  # expect: vite.log electron.log
```

Per-project state:

```bash
ls /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/
```

**Expected**: includes `state.json`, `state.lock`, `feature-manifest.json`, and (after Step 4 completed a cycle) `learnings.md`. Nothing else.

Legacy learnings location:

```bash
ls /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.claude/rules/learnings.md 2>&1
```

**Expected**: `No such file or directory` (moved away by migration) OR never-existed if the legacy file was absent pre-upgrade.

---

## Step 6 — Historical data preserved (SC-002)

```bash
sqlite3 ~/.dex/db/data.db "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1;"
```

**Expected**: same row ID noted in Step 1. If the pre-upgrade snapshot returned row `R`, the post-upgrade DB at the new path must return a row whose ID is `R` *or newer* (newer runs created by Step 4 are acceptable — the point is that `R` is still present in the table).

Cross-check in the UI: open the Loop Dashboard and confirm that the pre-upgrade runs still appear. Sample-check one historical run's phase traces by clicking through.

---

## Step 7 — Idempotency (SC-004)

Quit Electron. Restart Electron. Quit. Restart again. (Two restarts.) On each restart:

- `ls ~/.dex/` must still show only `db/`, `logs/`, `dev-logs/`.
- No new legacy files appear anywhere.
- `electron.log` (the new location) must contain no thrown errors attributable to `migrateIfNeeded` — no `ENOENT`, `EACCES`, or `EEXIST`.
- DB row count in `runs` is stable across restarts (no duplicate insertions, no data loss).

Strong form: run Electron in a terminal with an `strace` or `fs.watch`-based file watcher on `~/.dex/` during the second restart — zero write operations should be attributable to the migration helper.

---

## Step 8 — Fresh-install path (Acceptance Scenario 3 of User Story 2)

Verifiable without a clean machine by using a non-existent directory:

```bash
HOME=/tmp/dex-home-test npx tsc --noEmit && HOME=/tmp/dex-home-test node -e "
  require('./dist/core/paths').migrateIfNeeded('/tmp/nonexistent-old', '/tmp/nonexistent-new');
  console.log('ok');
"
```

**Expected**: prints `ok`, creates neither file, throws nothing.

---

## Step 9 — Documentation accuracy (SC-005)

Open `CLAUDE.md` and `.claude/rules/06-testing.md`. For every path reference:

- Does the path exist on the running system (after Step 4)? If not, either the doc is wrong or the implementation is wrong — fix whichever diverged.
- Is any `/tmp/dex-logs/` reference left behind? (There should be none.)
- Is any `~/.dex/orchestrator.log` reference left behind? (There should be none.)
- Is any `<projectDir>/.dex/artifacts/` reference left behind? (That directory was never implemented — references were documentation debt. There should be none.)

---

## Definition of Done

- [ ] Step 2 typecheck passes (`npx tsc --noEmit` exit 0).
- [ ] Step 3 banner prints new paths; `~/.dex/dev-logs/` populated.
- [ ] Step 4 loop run completes at least one cycle that writes learnings.
- [ ] Step 5 layout assertions all pass; no loose files at `~/.dex/`; legacy learnings gone.
- [ ] Step 6 pre-upgrade run ID still queryable at the new DB path; Loop Dashboard shows history.
- [ ] Step 7 two Electron restarts produce zero migration-helper writes and zero errors.
- [ ] Step 8 fresh-install path is a silent no-op.
- [ ] Step 9 every path in the updated docs resolves to a real on-disk location.

Report with a short summary listing the observations for each item.
