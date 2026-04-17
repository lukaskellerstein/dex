# Dex Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-17

## Active Technologies
- `better-sqlite3` (audit trail, unchanged), `.dex/state.json` (new — primary state), filesystem artifacts with SHA-256 integrity hashing (002-filesystem-state-management)
- TypeScript 5.6+ (strict mode) + `@anthropic-ai/claude-agent-sdk` ^0.1.45 (upgrade from ^0.1.0), `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18 (003-structured-outputs)
- `.dex/state.json` (filesystem state), `.dex/feature-manifest.json` (new — feature manifest), SQLite (run/phase/step audit trail) (003-structured-outputs)
- TypeScript 5.6+ (strict mode) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18. Migration uses only `node:fs`, `node:path`, `node:os` (no new dependency). (004-logs-alignment)
- `~/.dex/db/data.db` (+ WAL/SHM) — SQLite audit trail (moved). `~/.dex/logs/` — text log tree (root moves conceptually; inner layout unchanged). `<projectDir>/.dex/` — per-project state (adds `learnings.md`). (004-logs-alignment)

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
- 004-logs-alignment: Added TypeScript 5.6+ (strict mode) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18. Migration uses only `node:fs`, `node:path`, `node:os` (no new dependency).
- 003-structured-outputs: Added TypeScript 5.6+ (strict mode) + `@anthropic-ai/claude-agent-sdk` ^0.1.45 (upgrade from ^0.1.0), `better-sqlite3` ^12.9.0, Electron ^41.2.1, React 18
- 002-filesystem-state-management: Added TypeScript (strict mode), Node.js (Electron 30+) + `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18


<!-- MANUAL ADDITIONS START -->

## On-Disk Layout

Global (machine-wide):

```text
~/.dex/
├── db/           data.db + WAL/SHM — audit trail
├── logs/         per-run orchestrator tree + _orchestrator.log fallback
└── dev-logs/     dev-setup.sh captures (vite.log, electron.log)
```

Per-project (inside each opened project):

```text
<projectDir>/.dex/
├── state.json               committed
├── state.lock               gitignored (PID)
├── feature-manifest.json    committed
└── learnings.md             committed
```

All files in `<projectDir>/.dex/` are committable except `state.lock`. Diagnostics paths are documented in full in `.claude/rules/06-testing.md` section 4f.

<!-- MANUAL ADDITIONS END -->
