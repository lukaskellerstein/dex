# Implementation Plan: Unified Logs & Diagnostics Layout

**Branch**: `004-logs-alignment` | **Date**: 2026-04-17 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-logs-alignment/spec.md`

## Summary

Reorganise Dex's on-disk log and diagnostic layout into predictable roots-by-scope and subdirectories-by-concern. Every writer module points at a new path; on first run, a small idempotent migration helper moves legacy files into place so no historical data is lost. No reader-side change — the renderer and IPC surface do not reference log paths today.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode)
**Primary Dependencies**: Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18.
**Storage**: `~/.dex/db/data.db` (moved), `~/.dex/logs/` (log tree), `<projectDir>/.dex/` (per-project state).
**Testing**: `npx tsc --noEmit`, manual verification against the `dex-ecommerce` example project per `.claude/rules/06-testing.md` section 4c.
**Target Platform**: Electron desktop app (macOS/Linux).
**Project Type**: Single-project; platform-agnostic core engine.
**Scale/Scope**: 3 source files modified, 1 new file created, 1 shell script edited, 2 docs updated. ≈80 lines added, ≈10 removed.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Clean-Context Orchestration | **PASS** | No change to agent spawning or stage orchestration. |
| II. Platform-Agnostic Core | **PASS** | All modified core files (`database.ts`, `orchestrator.ts`, `manifest.ts`) remain Electron-free. New `paths.ts` uses only `node:fs` and `node:path`. |
| III. Test Before Report | **PASS** | Verification plan exercises the end-to-end migration against the live example project before declaring done. |
| IV. Simplicity First | **PASS** | One helper (`migrateIfNeeded`) used by three callers. No abstractions beyond what the three sites need. |
| V. Mandatory Workflow | **PASS** | Understand → Plan (this doc) → Implement → Test → Report. |

No violations.

## Final Layout

### Global — `~/.dex/`

```text
~/.dex/
├── db/
│   ├── data.db
│   ├── data.db-wal
│   └── data.db-shm
├── logs/
│   ├── _orchestrator.log                  # fallback / pre-run (underscore sorts first)
│   └── <project>/<runId>/
│       ├── run.log
│       └── phase-<N>_<slug>/
│           ├── agent.log
│           └── subagents/<subagentId>.log
└── dev-logs/
    ├── vite.log
    └── electron.log
```

### Per-project — `<projectDir>/.dex/`

```text
<projectDir>/.dex/
├── state.json                             # committed
├── state.lock                             # gitignored (PID file)
├── feature-manifest.json                  # committed
└── learnings.md                           # moved from .claude/rules/ — committed
```

No `artifacts/` subdirectory (never existed). No per-project logs (logs go to the global tree, keyed by `runId`).

## Files to Change

### Source

| # | File | Change |
|---|---|---|
| 1 | `src/core/paths.ts` | **NEW** — exports `DEX_HOME`, `DB_DIR`, `DB_PATH`, `LOGS_ROOT`, `FALLBACK_LOG`, `DEV_LOGS_DIR`, plus the `migrateIfNeeded(oldPath, newPath)` helper. Single source of truth for all paths. |
| 2 | `src/core/database.ts:9-17` | `getDbPath()` returns `DB_PATH`. `initDatabase()` calls `migrateIfNeeded` for `data.db`, `data.db-wal`, `data.db-shm` **before** `new Database()`. Ensures `DB_DIR` exists. |
| 3 | `src/core/orchestrator.ts:96-175` | Import `LOGS_ROOT` and `FALLBACK_LOG` from `paths.ts` (remove local constants). Before first write to `FALLBACK_LOG`, call `migrateIfNeeded(~/.dex/orchestrator.log, FALLBACK_LOG)`. |
| 4 | `src/core/manifest.ts:181` (`appendLearnings`) | New target `<projectDir>/.dex/learnings.md`. Call `migrateIfNeeded(<projectDir>/.claude/rules/learnings.md, <projectDir>/.dex/learnings.md)` once on first call per project. |

### Tooling

| # | File | Change |
|---|---|---|
| 5 | `dev-setup.sh:14` | `LOG_DIR="${HOME}/.dex/dev-logs"` (was `/tmp/dex-logs`). `mkdir -p "$LOG_DIR"` already exists on line 15 — no further script changes needed. Update the echoed banner (lines 55–57) to print the new paths. |

### Documentation

| # | File | Change |
|---|---|---|
| 6 | `CLAUDE.md` | Remove `<projectDir>/.dex/artifacts/` bullet (never implemented). Add note that `<projectDir>/.dex/` is committable except `state.lock`. |
| 7 | `.claude/rules/06-testing.md` section 4f | Update all path references: `/tmp/dex-logs/` → `~/.dex/dev-logs/`, `~/.dex/data.db` → `~/.dex/db/data.db`, `~/.dex/orchestrator.log` → `~/.dex/logs/_orchestrator.log`. Add `learnings.md` to the per-project state table. |
| 8 | `.gitignore` (project root) | **No change.** `.dex/state.lock` is already the only entry, which matches the commit policy documented in CLAUDE.md. |

## Migration Helper

New file `src/core/paths.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEX_HOME    = path.join(os.homedir(), ".dex");
export const DB_DIR      = path.join(DEX_HOME, "db");
export const DB_PATH     = path.join(DB_DIR, "data.db");
export const LOGS_ROOT   = path.join(DEX_HOME, "logs");
export const FALLBACK_LOG = path.join(LOGS_ROOT, "_orchestrator.log");
export const DEV_LOGS_DIR = path.join(DEX_HOME, "dev-logs");

/** Idempotent one-time move. Safe to call repeatedly. */
export function migrateIfNeeded(oldPath: string, newPath: string): void {
  if (!fs.existsSync(oldPath)) return;
  if (fs.existsSync(newPath)) return;
  fs.mkdirSync(path.dirname(newPath), { recursive: true });
  fs.renameSync(oldPath, newPath);
}
```

## Migration Call Sites

| Caller | Old path | New path |
|---|---|---|
| `database.ts → initDatabase()` | `~/.dex/data.db`, `data.db-wal`, `data.db-shm` | `~/.dex/db/data.db` + siblings |
| `orchestrator.ts → log()` (fallback) | `~/.dex/orchestrator.log` | `~/.dex/logs/_orchestrator.log` |
| `manifest.ts → appendLearnings()` | `<projectDir>/.claude/rules/learnings.md` | `<projectDir>/.dex/learnings.md` |

All migrations use `fs.renameSync` on the same filesystem (atomic) and guard with `existsSync` checks on both sides (idempotent).

## Non-changes (Explicit)

- **SQLite schema** — unchanged.
- **Log line format** — unchanged (`[<ISO>] [<LEVEL>] <msg> <optional json>`).
- **IPC contracts** — unchanged (no IPC method exposes log paths; renderer queries DB for run history via existing methods).
- **Per-run log tree structure** — unchanged; only its parent path (`LOGS_ROOT`) moves conceptually, though it remains `~/.dex/logs/`.
- **`/tmp/dex-pr-body-*.md`** — ephemeral PR body buffers passed to `gh`, cleaned by OS. Leave at `/tmp/`.
- **`<projectDir>/.dex/` contents** — same files; only gains `learnings.md` moved from `.claude/rules/`.

## Verification

End-to-end verification against the `dex-ecommerce` example project per `.claude/rules/06-testing.md` section 4c.

### Pre-upgrade snapshot (before running the modified code)

1. Confirm legacy paths exist:

    ```bash
    ls -la ~/.dex/data.db* 2>&1        # expect: present
    ls -la ~/.dex/orchestrator.log 2>&1 # expect: maybe present (rare)
    ls /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.claude/rules/learnings.md 2>&1
    ```

2. Note the latest run ID in the current DB:

    ```bash
    sqlite3 ~/.dex/data.db "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1;"
    ```

### Typecheck

```bash
npx tsc --noEmit
```

### Launch dev environment

User runs `./dev-setup.sh`. Observe:

- Banner prints `${HOME}/.dex/dev-logs/vite.log` and `${HOME}/.dex/dev-logs/electron.log`.
- `ls ~/.dex/dev-logs/` contains both files; `/tmp/dex-logs/` untouched (or absent).

### Post-upgrade layout check

After the Electron app has started and opened the example project once (triggers `initDatabase`, orchestrator init, and eventually `appendLearnings` after a full cycle):

```bash
ls ~/.dex/                          # expect: db/ logs/ dev-logs/  (no data.db*, no orchestrator.log)
ls ~/.dex/db/                       # expect: data.db data.db-wal data.db-shm
ls ~/.dex/logs/                     # expect: _orchestrator.log (if legacy existed) + project trees
```

### Historical data preserved

In the Loop Dashboard, the pre-upgrade runs must still appear. Cross-check:

```bash
sqlite3 ~/.dex/db/data.db "SELECT id FROM runs ORDER BY created_at DESC LIMIT 1;"
```

Must return the same row ID noted in the pre-upgrade snapshot.

### Learnings migration

After completing at least one loop cycle on `dex-ecommerce`:

```bash
cat /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/learnings.md
ls /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.claude/rules/learnings.md 2>&1
# expect: new file present; old file absent (migrated away)
```

### Idempotency

Restart Electron twice. Each startup must be a silent no-op for the migrations (no thrown errors, no duplicate files, no data loss). `migrateIfNeeded` guards on both `existsSync` sides.

## Risk / Rollback

- `fs.renameSync` on the same filesystem is atomic — partial state is impossible.
- Migration runs **before** `new Database()` opens the DB, so SQLite never sees an in-flight move.
- Migrations are forward-only. If a user must revert, it is a manual move back; dual-path support would re-introduce exactly the problem this spec solves.
- Edge case: if a user has permissions issues under `~/.dex/`, the migration throws and initialisation fails fast — correct behaviour, user sees a clear error instead of silently falling back to a stale path.

## Phasing

All work can land in a single PR — the changes are small and interdependent (a half-done migration would leave the DB at the old path while the code points at the new one).

1. Add `src/core/paths.ts` with all constants and helper.
2. Update `database.ts`, `orchestrator.ts`, `manifest.ts` to import from `paths.ts` and call `migrateIfNeeded`.
3. Update `dev-setup.sh` banner and path.
4. Update `CLAUDE.md` and `.claude/rules/06-testing.md`.
5. Typecheck and run the verification flow above.
