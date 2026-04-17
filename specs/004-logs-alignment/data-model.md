# Data Model: Unified Logs & Diagnostics Layout

**Feature**: `004-logs-alignment`
**Phase**: 1 — Design
**Status**: Complete

This feature is a layout refactor — it has **no persisted data model** in the database sense (no new tables, no new JSON state fields, no schema migrations). The "data" for this feature is a set of filesystem paths and a pair of migration mappings. Both are captured below.

---

## Entity 1 — `DexPaths` (path table)

Module-level constants exported from `src/core/paths.ts`. The single source of truth for every absolute path the app writes under the global Dex home.

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEX_HOME` | `path.join(os.homedir(), ".dex")` | Root of every machine-level Dex artefact. |
| `DB_DIR` | `path.join(DEX_HOME, "db")` | Parent of SQLite DB files. |
| `DB_PATH` | `path.join(DB_DIR, "data.db")` | Audit DB. Siblings `data.db-wal` and `data.db-shm` are managed by SQLite itself. |
| `LOGS_ROOT` | `path.join(DEX_HOME, "logs")` | Root of the per-run log tree (`<project>/<runId>/…`) and the fallback log. |
| `FALLBACK_LOG` | `path.join(LOGS_ROOT, "_orchestrator.log")` | Catch-all log for pre-run orchestrator events. Underscore prefix sorts above project dirs. |
| `DEV_LOGS_DIR` | `path.join(DEX_HOME, "dev-logs")` | Parent of `vite.log` and `electron.log` written by `dev-setup.sh`. |

### Invariants

- All constants are computed at module-load time from `os.homedir()`. No environment-variable override, no runtime reconfiguration.
- Each constant is `readonly` by construction (TypeScript `const` + `string` type). Consumers never mutate them.
- No path escapes `DEX_HOME` — every exported value has `DEX_HOME` as a prefix.
- Per-project paths are *not* declared here. `<projectDir>/.dex/learnings.md` is resolved inline at the call site in `manifest.ts` from the caller-supplied `projectDir` argument, consistent with the existing pattern for `state.json` and `feature-manifest.json`.

### Per-project paths (resolved at call site, not exported from `paths.ts`)

| Path | Owner | Notes |
|------|-------|-------|
| `<projectDir>/.dex/state.json` | `state.ts` (existing) | Unchanged by this feature. |
| `<projectDir>/.dex/state.lock` | `state.ts` (existing) | Unchanged. Only gitignored entry. |
| `<projectDir>/.dex/feature-manifest.json` | `manifest.ts` (existing) | Unchanged. |
| `<projectDir>/.dex/learnings.md` | `manifest.ts` (moved) | Was at `.claude/rules/learnings.md`. |

---

## Entity 2 — Migration mapping

Each mapping is a tuple `(oldPath, newPath)`. There are exactly three mappings — one per writer call site. No registry is persisted; the filesystem itself records whether a migration has completed (by the presence of the new file and absence of the old).

| # | Owner | `oldPath` | `newPath` | Triggered at |
|---|-------|-----------|-----------|--------------|
| 1a | `database.ts` | `~/.dex/data.db` | `~/.dex/db/data.db` | `initDatabase()` — before `new Database(...)` |
| 1b | `database.ts` | `~/.dex/data.db-wal` | `~/.dex/db/data.db-wal` | same call as 1a |
| 1c | `database.ts` | `~/.dex/data.db-shm` | `~/.dex/db/data.db-shm` | same call as 1a |
| 2 | `orchestrator.ts` | `~/.dex/orchestrator.log` | `~/.dex/logs/_orchestrator.log` | `log()` — before first `appendFileSync` |
| 3 | `manifest.ts` | `<projectDir>/.claude/rules/learnings.md` | `<projectDir>/.dex/learnings.md` | `appendLearnings()` — before reading existing file |

### State transitions

Each migration record has exactly three observable states, deterministic from the filesystem alone:

```
    ┌─────────────────┐
    │  PRE-MIGRATION  │  old exists, new does not
    └────────┬────────┘
             │ migrateIfNeeded() — single atomic renameSync
             ▼
    ┌─────────────────┐
    │    MIGRATED     │  old gone, new exists
    └────────┬────────┘
             │ subsequent calls are no-ops (existsSync short-circuit)
             ▼
    ┌─────────────────┐
    │  STEADY STATE   │  (idempotent)
    └─────────────────┘

    Special case (fresh install):
      NEITHER EXISTS → migrateIfNeeded() is a no-op → first write creates new path
```

There is no "partial" state: `renameSync` on a single filesystem is atomic, and each sibling file (`data.db`, `data.db-wal`, `data.db-shm`) is migrated independently. If a process were killed mid-helper (impossible in a meaningful window — three sequential syscalls), the next startup finds the already-moved files in their new location and skips those particular records.

### Edge case: both paths exist simultaneously

Not produced by this feature's code, but possible if a user copied files manually. The helper's `existsSync(newPath)` guard sees the new file and returns without touching the old file. The legacy file remains on disk untouched, so the user can inspect or delete it; the new-path file is treated as authoritative.

---

## Non-entities (explicitly excluded)

- **SQLite schema** — no `runs`, `phase_traces`, `trace_steps`, `subagent_metadata`, `loop_cycles`, or `failure_tracker` change. Same columns, same indexes, same WAL settings.
- **JSON state file shapes** — `state.json`, `feature-manifest.json` structure unchanged.
- **Log-line format** — `[<ISO-timestamp>] [<LEVEL>] <message> <optional JSON>` unchanged.
- **Persisted migration metadata** — no migration version table, no `.dex/migrations/` directory, no sentinel file marking completion. The filesystem's own state is the record.
- **IPC contracts** — `window.dexAPI.*` signatures and return shapes unchanged. Readers of the DB reach it only through the typed helpers in `database.ts`, which now resolve the path through `paths.ts` transparently.
