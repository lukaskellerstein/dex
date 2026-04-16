# Feature Specification: Unified Logs & Diagnostics Layout

**Feature Branch**: `004-logs-alignment`
**Created**: 2026-04-17
**Status**: Draft
**Input**: User description: "Optimize / simplify / align where Dex logs and diagnostic files live so it's more understandable and clear where is what."

## Problem

Dex currently writes logs and diagnostic files to four different roots with inconsistent naming:

| Where | What | Issue |
|---|---|---|
| `/tmp/dex-logs/` | `vite.log`, `electron.log` (dev-setup.sh) | Different root than everything else |
| `~/.dex/` (root) | `data.db`, `data.db-wal`, `data.db-shm`, `orchestrator.log` | DB files and log files mixed at the same level |
| `~/.dex/logs/<project>/<runId>/` | run / phase / subagent logs | Only this follows a clean per-run structure |
| `<projectDir>/.dex/` | `state.json`, `state.lock`, `feature-manifest.json` | Pure state — fine |
| `<projectDir>/.claude/rules/learnings.md` | Machine-generated cycle insights | Mixed with human-authored rules |

Additional issues surfaced by audit (Explore agent, 2026-04-16):

- `CLAUDE.md` mentions `<projectDir>/.dex/artifacts/` but **no code ever writes it** — dead documentation.
- Only `.dex/state.lock` is gitignored; `state.json`, `feature-manifest.json`, and `learnings.md` are intentionally committable for cross-session/cross-machine resumability. This is correct but undocumented.

A debugging agent today has to memorise four conventions and grep four roots. The spec audit also confirmed that **no code reads the log files** (they're write-only), so moving paths is a writer-side-only change — safe to reorganise.

## Goals

1. **One root per scope** — global (cross-project) data under `~/.dex/`, per-project data under `<projectDir>/.dex/`.
2. **Subdirectories named by concern** — `db/`, `logs/`, `dev-logs/` under the global root so an agent can locate a file by its concern, not its history.
3. **Zero data loss on upgrade** — existing `~/.dex/data.db`, `~/.dex/orchestrator.log`, and `<projectDir>/.claude/rules/learnings.md` must be migrated automatically on first run. Historical run data must remain visible in the Loop Dashboard.
4. **No code-reader churn** — the renderer and IPC surface do not reference log paths today, and must not start to. All changes live in writer modules.
5. **Drop dead docs** — remove the `<projectDir>/.dex/artifacts/` reference that no code implements.

## Non-goals

- SQLite schema changes.
- Log line format changes.
- Changes to the per-run directory tree structure (`run.log`, `phase-<N>_<slug>/agent.log`, `subagents/<id>.log`) — only its parent paths move.
- Exposing log paths through IPC (they remain unreachable from the renderer).
- Changing what `<projectDir>/.dex/` contains, beyond moving `learnings.md` in.

## User Scenarios

### Scenario 1 — Agent debugging a failed run

**Given** a run terminated with an error and the UI shows a DEBUG badge,
**When** the agent clicks the badge and extracts `RunID` + `PhaseTraceID`,
**Then** it opens `~/.dex/logs/<project>/<RunID>/phase-<N>_<slug>/agent.log` and sees the full event trace — a single, predictable path.

### Scenario 2 — Agent looking at the SQLite audit trail

**Given** the agent wants to query `~/.dex/db/data.db`,
**When** it runs `sqlite3 ~/.dex/db/data.db "SELECT ..."`,
**Then** the query works against a DB located under a directory named for its concern (`db/`), adjacent to `logs/` and `dev-logs/`.

### Scenario 3 — Developer inspecting dev-server logs

**Given** the dev loop has been running and a Vite error is suspected,
**When** the developer reads `~/.dex/dev-logs/vite.log`,
**Then** the current-session Vite output is there (truncated on each `dev-setup.sh` restart, same as before).

### Scenario 4 — Existing user upgrades to this layout

**Given** a user has a populated `~/.dex/data.db` and a prior `~/.dex/orchestrator.log`,
**When** the orchestrator starts for the first time after the upgrade,
**Then** both files are moved to their new locations (`~/.dex/db/data.db`, `~/.dex/logs/_orchestrator.log`) atomically, and the Loop Dashboard continues to show all historical runs with their original IDs, costs, and durations.

### Scenario 5 — Developer accidentally commits `.dex/`

**Given** the project's `.gitignore` ignores only `.dex/state.lock`,
**When** the developer stages `<projectDir>/.dex/state.json`, `feature-manifest.json`, and `learnings.md`,
**Then** the commit succeeds — these files are intentionally trackable to enable resumability across machines. `state.lock` stays ignored because it contains a live PID.

## Acceptance Criteria

1. `~/.dex/` after first post-upgrade run contains exactly: `db/`, `logs/`, `dev-logs/`. No `data.db*` or `orchestrator.log` at the root.
2. `~/.dex/db/` contains the migrated SQLite database and WAL/SHM files.
3. `~/.dex/logs/` contains `_orchestrator.log` (migrated) plus the existing per-project, per-run tree.
4. `~/.dex/dev-logs/` contains `vite.log` and `electron.log` after `dev-setup.sh` runs; `/tmp/dex-logs/` is no longer written to.
5. `<projectDir>/.dex/learnings.md` exists after the first cycle completes; `<projectDir>/.claude/rules/learnings.md` is gone (migrated).
6. Loop Dashboard shows all historical runs that existed before the upgrade (DB migration preserved data).
7. Re-launching the app is a no-op for all migrations (idempotent).
8. `CLAUDE.md` no longer references `.dex/artifacts/`.
9. `.claude/rules/06-testing.md` section 4f reflects the new paths.
10. Typecheck passes: `npx tsc --noEmit`.
