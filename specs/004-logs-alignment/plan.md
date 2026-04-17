# Implementation Plan: Unified Logs & Diagnostics Layout

**Branch**: `004-logs-alignment` | **Date**: 2026-04-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-logs-alignment/spec.md`

## Summary

Consolidate Dex's on-disk artefacts under `~/.dex/` into three purpose-scoped subdirectories — `db/` (audit DB + WAL/SHM), `logs/` (per-run orchestrator logs + fallback), `dev-logs/` (Vite/Electron dev-session captures) — and move the per-project `learnings.md` from `<projectDir>/.claude/rules/` into `<projectDir>/.dex/`. A single-source-of-truth path module (`src/core/paths.ts`) is introduced, along with an idempotent, same-filesystem-rename migration helper invoked by each writer before its first write. No schema, log-line format, or IPC contract changes. Forward-only migration; non-destructive when legacy files are absent.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode)
**Primary Dependencies**: Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18. Migration uses only `node:fs`, `node:path`, `node:os` (no new dependency).
**Storage**: `~/.dex/db/data.db` (+ WAL/SHM) — SQLite audit trail (moved). `~/.dex/logs/` — text log tree (root moves conceptually; inner layout unchanged). `<projectDir>/.dex/` — per-project state (adds `learnings.md`).
**Testing**: `npx tsc --noEmit` for type correctness. Manual end-to-end verification against `dex-ecommerce` example project per `.claude/rules/06-testing.md` section 4c. No unit-test layer exists for path/migration code today; the migration is small, pure, and verifiable by observation of the filesystem.
**Target Platform**: Electron desktop app (Linux, macOS). Same-filesystem rename is the migration primitive.
**Project Type**: Single project; platform-agnostic core engine in `src/core/`.
**Performance Goals**: Migration completes in <1 s on a typical audit DB (≤100 runs). Repeat startups are zero-write no-ops (SC-004).
**Constraints**: (a) No data loss — legacy rows must remain queryable in the Loop Dashboard post-upgrade; (b) Platform-agnostic core must not import Electron; (c) Single-atomic moves only — no copy-and-delete; (d) No renderer/preload/IPC changes.
**Scale/Scope**: ≈80 lines added, ≈10 removed. 3 source files modified (`database.ts`, `orchestrator.ts`, `manifest.ts`), 1 new source file (`paths.ts`), 1 shell script edited (`dev-setup.sh`), 2 docs updated (`CLAUDE.md`, `.claude/rules/06-testing.md`).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Clean-Context Orchestration | **PASS** | No change to agent spawning, hook callbacks, or stage sequencing. Pure filesystem layout refactor. |
| II. Platform-Agnostic Core | **PASS** | New `src/core/paths.ts` uses only `node:fs`, `node:path`, `node:os`. All three modified core files (`database.ts`, `orchestrator.ts`, `manifest.ts`) remain Electron-free. |
| III. Test Before Report | **PASS** | Verification exercises the end-to-end migration against the live example project; typecheck and directory-structure assertions documented in `quickstart.md`. |
| IV. Simplicity First | **PASS** | One helper (`migrateIfNeeded`) used by three callers. No retries, no dual-path fallbacks, no feature flags. Fewer than 10 lines of logic in the helper. |
| V. Mandatory Workflow | **PASS** | Understand → Plan (this doc) → Implement → Test → Report. Spec and plan precede implementation; verification gate is explicit. |

**No violations.** Complexity Tracking section omitted.

### Re-evaluation after Phase 1 design

No new complexity introduced. The Phase 1 artefacts (`data-model.md`, `quickstart.md`) document an existing minimal helper and path table — they do not add new machinery. Gates remain PASS.

## Project Structure

### Documentation (this feature)

```text
specs/004-logs-alignment/
├── plan.md                    # This file (/speckit.plan output)
├── spec.md                    # Feature specification
├── research.md                # Phase 0 output
├── data-model.md              # Phase 1 — entity schema for paths & migration state
├── quickstart.md              # Phase 1 — local verification walkthrough
├── contracts/                 # Phase 1 — intentionally empty (purely internal change)
│   └── README.md              # Explains why no external contracts
├── checklists/
│   └── requirements.md        # Spec quality checklist
└── tasks.md                   # Phase 2 — created by /speckit.tasks (NOT this command)
```

### Source Code (repository root)

The existing repository layout is preserved; this feature adds one new file and modifies four existing ones.

```text
dex/
├── src/
│   ├── core/                              # Platform-agnostic — no Electron imports
│   │   ├── paths.ts                       # NEW — DEX_HOME, DB_DIR, DB_PATH, LOGS_ROOT,
│   │   │                                  #       FALLBACK_LOG, DEV_LOGS_DIR, migrateIfNeeded()
│   │   ├── database.ts                    # MODIFIED — import DB_PATH/DB_DIR, call migrateIfNeeded
│   │   │                                  #            for data.db + data.db-wal + data.db-shm
│   │   ├── orchestrator.ts                # MODIFIED — import LOGS_ROOT, FALLBACK_LOG from paths.ts;
│   │   │                                  #            migrate legacy ~/.dex/orchestrator.log
│   │   ├── manifest.ts                    # MODIFIED — learnings.md target moves to
│   │   │                                  #            <projectDir>/.dex/learnings.md (+ migrate)
│   │   ├── git.ts                         # Unchanged
│   │   ├── parser.ts                      # Unchanged
│   │   ├── types.ts                       # Unchanged
│   │   └── …                              # Other core files unchanged
│   ├── main/                              # Electron main process — unchanged
│   └── renderer/                          # React renderer — unchanged
├── dev-setup.sh                           # MODIFIED — LOG_DIR → ~/.dex/dev-logs; banner updated
├── CLAUDE.md                              # MODIFIED — remove artifacts/ bullet; clarify commit policy
├── .claude/rules/06-testing.md            # MODIFIED — update all diagnostic path references
└── …                                      # Everything else unchanged
```

**Structure Decision**: Single-project layout preserved. No new directories under `src/`. The new `paths.ts` sits alongside existing core modules and is the sole owner of every on-disk path for the global Dex home; downstream modules import the constants rather than recomputing them. This makes future path changes a one-line edit.

## Phase 0 — Research

See [research.md](./research.md). Summary:

- **Decision**: Use `fs.renameSync` guarded by double-sided `existsSync` checks for migration. Same-filesystem moves are atomic on POSIX and Windows, and idempotent when guarded on both source and destination.
- **Decision**: Invoke migration at the *writer* layer, inside each module that owns a path, rather than at a central bootstrap. Writers are the only places guaranteed to run before any read of the same path, and distributing the call prevents ordering bugs.
- **Decision**: Use an underscore-prefixed filename (`_orchestrator.log`) for the fallback log so it sorts above project directories in `ls` listings. Small ergonomics gain; zero code cost.
- **Decision**: Keep `/tmp/dex-pr-body-*.md` in `/tmp/` — ephemeral buffers handed to `gh`, cleaned by OS, not relevant for post-session inspection.
- **Rejected**: Dual-path reader logic ("check both old and new paths"). Re-introduces exactly the search-in-two-places pain this feature eliminates and permanently retains legacy code.
- **Rejected**: `copyFileSync` + `unlinkSync`. Non-atomic; creates a partial-copy window where a crash loses data. `renameSync` is strictly better when source and destination share a filesystem (which they do — both are under `~/.dex/` or both inside the same project `.dex/`).
- **Rejected**: A CLI-based migration tool run once by the user. Violates "zero manual action" from User Story 2 and creates a window where running the new code without having run the migration corrupts the audit trail.

All `NEEDS CLARIFICATION` markers from the spec are resolved (there were none — the feature was fully specified in the source README).

## Phase 1 — Design & Contracts

### Data model

See [data-model.md](./data-model.md). Entities:

1. **`DexPaths`** (module-level constants exported from `src/core/paths.ts`) — the immutable table mapping each artefact to its canonical on-disk location.
2. **Migration record** (implicit, per call site) — the tuple `(oldPath, newPath)` representing a legacy-to-canonical mapping. Migration state is *on the filesystem*, not persisted separately.

No SQLite schema changes. No new JSON state fields.

### Contracts

See [contracts/README.md](./contracts/README.md). This feature is **purely internal**: no IPC method, CLI command, or external interface is added, removed, or modified. The IPC surface (`window.dexAPI.*`) does not expose log paths today and does not need to after the change — the renderer queries the audit DB via existing typed helpers that resolve paths internally.

No contract files are generated because there are no external interface changes to document. The `contracts/` directory exists with a README explaining this decision so the spec-kit tree is complete.

### Quickstart

See [quickstart.md](./quickstart.md). Local verification walkthrough:

1. Snapshot legacy paths (confirm presence of pre-upgrade data).
2. `npx tsc --noEmit` — compile the modified code.
3. Start `dev-setup.sh` — verify banner prints the new paths; verify `~/.dex/dev-logs/` is populated and `/tmp/dex-logs/` is not (re-)created.
4. Open `dex-ecommerce` and run one full loop cycle — triggers `initDatabase`, orchestrator fallback log (if exercised), and `appendLearnings`.
5. Post-upgrade filesystem assertions (`ls ~/.dex/`, `ls ~/.dex/db/`, project `.dex/` contents).
6. Idempotency check — restart Electron twice; verify no filesystem writes are attributable to the migration helper and no errors are thrown.

### Agent context update

Run:

```bash
.specify/scripts/bash/update-agent-context.sh claude
```

This regenerates the "Active Technologies" / "Recent Changes" sections of `CLAUDE.md` from the plan. No new technologies are introduced (dependencies unchanged), but the change is recorded in the rolling log at the bottom of `CLAUDE.md`.

## Migration Helper (normative)

```ts
// src/core/paths.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEX_HOME     = path.join(os.homedir(), ".dex");
export const DB_DIR       = path.join(DEX_HOME, "db");
export const DB_PATH      = path.join(DB_DIR, "data.db");
export const LOGS_ROOT    = path.join(DEX_HOME, "logs");
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

### Call sites

| Caller | Old path | New path |
|---|---|---|
| `database.ts → initDatabase()` (before `new Database(...)`) | `~/.dex/data.db`, `data.db-wal`, `data.db-shm` | `~/.dex/db/data.db` (+ siblings) |
| `orchestrator.ts → log()` (before first append to fallback) | `~/.dex/orchestrator.log` | `~/.dex/logs/_orchestrator.log` |
| `manifest.ts → appendLearnings()` (before first read/write per project) | `<projectDir>/.claude/rules/learnings.md` | `<projectDir>/.dex/learnings.md` |

All migrations are idempotent, atomic on a shared filesystem, and non-destructive when the legacy file is absent.

## Phasing

All changes land in a single PR — they are small and interdependent (a partial landing would leave the code pointing at a new path while the DB sits at the old path). Within that PR:

1. Add `src/core/paths.ts` with constants and helper.
2. Update `database.ts`, `orchestrator.ts`, `manifest.ts` to import from `paths.ts` and call `migrateIfNeeded` at the right moments (before first read/write at each site).
3. Update `dev-setup.sh` (`LOG_DIR` + banner).
4. Update `CLAUDE.md` and `.claude/rules/06-testing.md`.
5. Typecheck, then run the `quickstart.md` verification flow end-to-end.

## Risk / Rollback

- `fs.renameSync` on the same filesystem is atomic — partial state is impossible.
- Migration runs **before** `new Database(...)` opens the DB, so SQLite never observes an in-flight move.
- Migrations are forward-only. A user who needs to revert performs a manual move back; dual-path support would re-introduce the exact problem this feature eliminates.
- Edge case — permissions failure under `~/.dex/`: `renameSync` throws, orchestrator initialisation fails fast with a clear error. This is correct behaviour per FR-013; silent fallback to stale paths would be worse.

## Complexity Tracking

No violations to justify.
