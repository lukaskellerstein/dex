# Dex Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-02

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
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime) + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45 (used only by `ClaudeAgentRunner`), `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0. **No new dependencies.** Mock uses `node:fs`, `node:path`, `node:crypto` only. (009-testing-checkpointing)
- Project-local filesystem only — `<projectDir>/.dex/dex-config.json` (new, gitignored), `<projectDir>/.dex/mock-config.json` (new, gitignored), `fixtures/mock-run/` in the Dex repo (committed). No new per-run persistence; existing `.dex/state.json`, `.dex/feature-manifest.json`, `.dex/learnings.md`, `.dex/runs/<runId>.json`, and `~/.dex/logs/<project>/<runId>/…` continue unchanged. (009-testing-checkpointing)
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime). + Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape` + `d3-zoom` (already used by current `TimelineGraph`). **No new dependencies.** Filesystem work uses `node:fs`, `node:path`, `node:crypto`; git invocations reuse `safeExec()`/`gitExec()` from `src/core/checkpoints.ts`. (010-interactive-timeline)
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime). + Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape` + `d3-zoom`. **One dev-dep block added in Wave D**: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. No other dependency change. (011-refactoring)
- Unchanged — per-project `.dex/state.json`, `.dex/feature-manifest.json`, `.dex/learnings.md`, `.dex/runs/<runId>.json`; `~/.dex/logs/<project>/<runId>/` text log tree. Five new spec-folder artefacts under `docs/my-specs/011-refactoring/` (committed to git, shared via push). (011-refactoring)
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime). + Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (already present from 011 Wave D). **No new dependencies.** (012-cleanup)
- Filesystem only — `<projectDir>/.dex/state.json`, `<projectDir>/.dex/feature-manifest.json`, `<projectDir>/.dex/learnings.md`, `<projectDir>/.dex/runs/<runId>.json`, `~/.dex/logs/<project>/<runId>/...`. No schema change. (012-cleanup)
- TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime) + Unchanged. `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (already present). **No dependencies added or removed by this spec.** (013-cleanup-2)
- Per-project filesystem only — `<projectDir>/.dex/state.json`, `<projectDir>/.dex/feature-manifest.json`, `<projectDir>/.dex/learnings.md`, `<projectDir>/.dex/runs/<runId>.json`. Per-run logs at `~/.dex/logs/<project>/<runId>/`. No schema change. (013-cleanup-2)

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
- 013-cleanup-2: Added TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime) + Unchanged. `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (already present). **No dependencies added or removed by this spec.**
- 012-cleanup: Added TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime). + Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape`, `d3-zoom`. Dev: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` (already present from 011 Wave D). **No new dependencies.**
- 011-refactoring: Added TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime). + Unchanged production stack — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0, `d3-shape` + `d3-zoom`. **One dev-dep block added in Wave D**: `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. No other dependency change.


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
├── state.json               gitignored (008 — runtime cache, local only)
├── state.lock               gitignored (PID)
├── feature-manifest.json    committed
├── learnings.md             committed
├── variant-groups/          gitignored — one <groupId>.json per in-flight Try N ways
├── worktrees/               gitignored — parallel-variant worktrees for spec-only stages
└── runs/                    committed by default — one <runId>.json per run
    └── <runId>.json         full audit summary (RunRecord)
```

History layer (committed to git, shared via push):

- `checkpoint/<name>` tags — named save points (created out-of-band by `scripts/promote-checkpoint.sh` and any future user-driven "Keep this" verb; the running app no longer auto-creates them per 013-cleanup-2)
- `dex/<date>-<id>` branches — one per autonomous loop run
- `selected-<ts>` branches — transient navigation forks created by Timeline click-to-jump (auto-pruned when empty relative to the next jump target)

All files in `<projectDir>/.dex/` are committable except those marked `gitignored`. Teams who want private traces add `.dex/runs/` to `.gitignore` themselves. Diagnostics paths are documented in full in `.claude/rules/06-testing.md` section 4f.

<!-- MANUAL ADDITIONS END -->
