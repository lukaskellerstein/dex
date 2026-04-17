# Dex Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-17

## Active Technologies
- `better-sqlite3` (audit trail, unchanged), `.dex/state.json` (new — primary state), filesystem artifacts with SHA-256 integrity hashing (002-filesystem-state-management)
- TypeScript 5.6+ (strict mode) + `@anthropic-ai/claude-agent-sdk` ^0.1.45 (upgrade from ^0.1.0), `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18 (003-structured-outputs)
- `.dex/state.json` (filesystem state), `.dex/feature-manifest.json` (new — feature manifest), SQLite (run/phase/step audit trail) (003-structured-outputs)
- TypeScript 5.6+ (strict mode) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18. Migration uses only `node:fs`, `node:path`, `node:os` (no new dependency). (004-logs-alignment)
- `~/.dex/db/data.db` (+ WAL/SHM) — SQLite audit trail (moved). `~/.dex/logs/` — text log tree (root moves conceptually; inner layout unchanged). `<projectDir>/.dex/` — per-project state (adds `learnings.md`). (004-logs-alignment)
- Bash (POSIX + git + jq), no TypeScript. Existing project is TypeScript 5.6+ strict but this feature adds zero TS. + `bash`, `git`, `jq`. No npm dependency added. Implicitly depends on the orchestrator's existing state-reconciliation code paths (`src/core/state.ts:435-654` `reconcileState`, `src/core/state.ts:290-295` `detectStaleState`, `src/core/orchestrator.ts:1850-1945` resume entry, `src/renderer/App.tsx:297-304` / `src/renderer/components/Topbar.tsx:250` UI resume detection) as stable unchanged contracts. (005-testing-improvements)
- Git fixture branches on `dex-ecommerce` (two total, long-lived, force-updatable): `fixture/after-clarification`, `fixture/after-tasks`. No new on-disk Dex state. `.dex/` and `.specify/` inside the example repo are committed into each fixture branch. (005-testing-improvements)
- TypeScript 5.6+ (strict mode). + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, `electron` ^41.2.1, `react` ^18.3.1. No additions. (006-mid-cycle-resume)
- Unchanged — `<projectDir>/.dex/state.json` (filesystem state, in particular `cyclesCompleted`, `currentSpecDir`, `lastCompletedStage`, `artifacts.features`), `~/.dex/db/data.db` (SQLite audit trail — `runs`, `phase_traces`, `loop_cycles` tables are read to pin cycle identity on resume). (006-mid-cycle-resume)
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0. **Removed** — `better-sqlite3` ^12.9.0 + `@types/better-sqlite3` ^7.6.13. Implementation uses only `node:fs`, `node:path`, `node:os`, `node:crypto`. (007-sqlite-removal)

- TypeScript (strict mode), Node.js (Electron 30+) + `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18, GSAP, Lucide React (001-autonomous-loop)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript (strict mode), Node.js (Electron 30+): Follow standard conventions

## Recent Changes
- 007-sqlite-removal: Added TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0. **Removed** — `better-sqlite3` ^12.9.0 + `@types/better-sqlite3` ^7.6.13. Implementation uses only `node:fs`, `node:path`, `node:os`, `node:crypto`.
- 006-mid-cycle-resume: Added TypeScript 5.6+ (strict mode). + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, `electron` ^41.2.1, `react` ^18.3.1. No additions.
- 005-testing-improvements: Added Bash (POSIX + git + jq), no TypeScript. Existing project is TypeScript 5.6+ strict but this feature adds zero TS. + `bash`, `git`, `jq`. No npm dependency added. Implicitly depends on the orchestrator's existing state-reconciliation code paths (`src/core/state.ts:435-654` `reconcileState`, `src/core/state.ts:290-295` `detectStaleState`, `src/core/orchestrator.ts:1850-1945` resume entry, `src/renderer/App.tsx:297-304` / `src/renderer/components/Topbar.tsx:250` UI resume detection) as stable unchanged contracts.


<!-- MANUAL ADDITIONS START -->

## On-Disk Layout

Global (machine-wide):

```text
~/.dex/
├── logs/         per-run orchestrator tree + _orchestrator.log fallback
│                 (per-phase steps.jsonl now lives under each phase dir)
└── dev-logs/     dev-setup.sh captures (vite.log, electron.log)
```

Note: `~/.dex/db/` was retired in 007-sqlite-removal. The audit trail moved to per-project JSON files (see below). Any pre-existing `db/` directory is auto-removed on first launch.

Per-project (inside each opened project):

```text
<projectDir>/.dex/
├── state.json               committed
├── state.lock               gitignored (PID)
├── feature-manifest.json    committed
├── learnings.md             committed
└── runs/                    committed by default — one <runId>.json per run
    └── <runId>.json         full audit summary (RunRecord)
```

All files in `<projectDir>/.dex/` are committable except `state.lock`. Teams who want private traces add `.dex/runs/` to `.gitignore` themselves. Diagnostics paths are documented in full in `.claude/rules/06-testing.md` section 4f.

<!-- MANUAL ADDITIONS END -->
