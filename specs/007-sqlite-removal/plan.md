# Implementation Plan: Retire SQLite audit DB in favor of per-project JSON files

**Branch**: `007-sqlite-removal` | **Date**: 2026-04-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/007-sqlite-removal/spec.md`

## Summary

Remove the global SQLite audit database (`~/.dex/db/data.db` + `better-sqlite3`) and replace it with per-project JSON files at `<projectDir>/.dex/runs/<runId>.json`. Introduce a new `src/core/runs.ts` module that owns the JSON lifecycle (read / write / mutate under the existing `state.lock` single-writer invariant). Rewire every orchestrator call site (`createRun`, `createPhaseTrace`, `completePhaseTrace`, `insertSubagent`, `completeSubagent`, `insertLoopCycle`, `updateLoopCycle`, `upsertFailureRecord`, `updateRunLoopsCompleted`, `completeRun`) to corresponding JSON-mutating helpers. Move tool-call-level "trace steps" out of the database entirely: the orchestrator already hooks PreToolUse/PostToolUse/SubagentStart/SubagentStop and stores steps via `insertStep`; that call becomes an append to a new per-phase `steps.jsonl` alongside the existing `agent.log`. Wipe any legacy `~/.dex/db/` on first launch, remove the native-compiled dependency entirely, and preserve the four public IPC helper names (`listRuns`, `getRun`, `getPhaseSubagents`, `getPhaseSteps`) plus their closest cousins (`getLatestProjectRun`, `getLatestPhaseTrace`, `getSpecPhaseStats`, `getSpecAggregateStats`) so the renderer only sees a field-name rename, not a rewrite.

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime)
**Primary Dependencies**: Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45, `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0. **Removed** — `better-sqlite3` ^12.9.0 + `@types/better-sqlite3` ^7.6.13. Implementation uses only `node:fs`, `node:path`, `node:os`, `node:crypto`.
**Storage**:
- `<projectDir>/.dex/runs/<runId>.json` — primary audit record (new; replaces `runs`, `phase_traces`, `subagent_metadata`, `loop_cycles`, `failure_tracker` SQL tables)
- `~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl` — tool-call stream (new; replaces `trace_steps` SQL table) written alongside the existing `agent.log`
- `<projectDir>/.dex/state.json`, `<projectDir>/.dex/state.lock`, `<projectDir>/.dex/feature-manifest.json`, `<projectDir>/.dex/learnings.md` — unchanged
- `~/.dex/logs/<project>/<runId>/` — unchanged log tree; gains one file per phase (`steps.jsonl`)
- `~/.dex/db/` — **removed** on first launch post-upgrade (one-shot silent cleanup)

**Testing**: `npx tsc --noEmit` for typecheck; electron-chrome MCP (CDP port 9333) for renderer verification; `dex/scripts/reset-example-to.sh` + `dex-ecommerce` for end-to-end; `node --test` for `runs.ts` unit tests (round-trip, corrupted-file skip, concurrent-read safety).
**Target Platform**: Electron desktop (Linux primary, macOS/Windows supported). Frameless BrowserWindow + Vite renderer.
**Project Type**: Desktop app — Electron main (`src/main/`) + pure-Node orchestration core (`src/core/`) + React renderer (`src/renderer/`). No backend service, no CLI.
**Performance Goals**:
- `listRuns(limit=50)` returns in <50 ms for a project with ≤100 runs (cold disk cache) — envelope derived from "read 100 JSON files ≤2 KB each".
- `readRun(runId)` returns in <10 ms for a typical run JSON (≤50 phases, ≤20 KB).
- `getPhaseSteps(phaseTraceId)` returns ≤500 parsed step rows in <50 ms by streaming `steps.jsonl` (line-delimited JSON).
- End-to-end UI goal: first visible frame in a newly opened phase's trace view ≤100 ms from click, matching SC-004.

**Constraints**:
- Single-writer per project invariant must hold. Writes to `.dex/runs/*.json` occur only inside the orchestrator process that holds `<projectDir>/.dex/state.lock`; readers (renderer via IPC) may race reads freely.
- Writes must be crash-durable within the same process — use `fs.writeFileSync(tmp); fs.renameSync(tmp, target)` on every run-JSON mutation. No partial files left behind.
- No new runtime dependencies. Exactly one removed (`better-sqlite3` + its types).
- Zero migration code. Dev-phase; legacy DB is wiped on first launch, not converted.
- IPC helper names preserved on `window.dexAPI` (eight methods under `// History` in `preload.ts`).

**Scale/Scope**:
- Typical project: 10–50 runs × ~20 phases/run × ~5 subagents/phase ≈ 1,000–5,000 phase/subagent records. Run JSON file size: ~5–30 KB.
- Tool-call step volume: up to ~500 steps per phase. `steps.jsonl` size: typically 100 KB – 2 MB per phase, bounded by the existing 10,000-char content truncation per step.
- Approximate code scope: delete `src/core/database.ts` (610 lines) + touch `src/core/orchestrator.ts` (~40 call-site edits) + rewrite `src/main/ipc/history.ts` (~60 lines) + minor edits in `src/main/index.ts`, `src/main/preload.ts`, `src/renderer/electron.d.ts`, and two renderer hooks. Net delta: ~−300 lines after adding `src/core/runs.ts` (~250 lines).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**I. Clean-Context Orchestration** — No change. Agents still spawn via `query()` per phase; audit storage is out-of-band from agent context. ✅ Pass.

**II. Platform-Agnostic Core** — `src/core/runs.ts` uses only `node:fs`, `node:path`, `node:os`, `node:crypto`. No electron imports. The pure-Node contract is preserved and arguably strengthened — we are removing a native C++ dependency (`better-sqlite3`) that had Electron-ABI coupling, replacing it with standard-library I/O. ✅ Pass.

**III. Test Before Report** — DoD checklist defined in `quickstart.md`. Verification combines `npx tsc --noEmit`, `node --test` for the `runs.ts` module, and electron-chrome MCP for end-to-end UI parity against `dex-ecommerce` at the `after-tasks` checkpoint. ✅ Pass.

**IV. Simplicity First** — This feature *is* a simplification. Net line delta is negative; one major dependency removed; five SQL tables + ~10 query helpers collapsed into one module with ~8 helpers. No speculative abstractions (e.g., no "pluggable storage backend" interface). No backwards-compatibility shims (spec FR-013 explicitly forbids migration). ✅ Pass.

**V. Mandatory Workflow** — Spec approved before plan; plan will be approved before tasks; tasks will be approved before implementation. ✅ Pass.

**Result**: All gates pass. No violations to track. Proceeding to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/007-sqlite-removal/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # Feature specification (/speckit.specify output)
├── research.md          # Phase 0 output — decisions on atomic writes, step file format, field-naming, legacy cleanup
├── data-model.md        # Phase 1 output — JSON schemas + state transitions
├── quickstart.md        # Phase 1 output — manual verification walkthrough
├── contracts/
│   ├── runs-module.md   # `src/core/runs.ts` public surface (TypeScript signatures + behavior)
│   ├── ipc-history.md   # `window.dexAPI.*` history methods, IPC channel names, payload shapes
│   └── json-schemas.md  # `run.json` + `steps.jsonl` file formats (authoritative)
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify output)
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan — see /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/                       # Platform-agnostic orchestration engine (pure Node)
│   ├── runs.ts                 # NEW — JSON audit-trail module (read / write / mutate helpers)
│   ├── runs.test.ts            # NEW — node --test unit tests (round-trip, corruption, atomicity)
│   ├── database.ts             # DELETED
│   ├── orchestrator.ts         # EDITED — ~40 call sites migrated to runs.ts helpers
│   ├── paths.ts                # EDITED — remove DB_DIR, DB_PATH, keep LOGS_ROOT/DEX_HOME
│   ├── types.ts                # EDITED (optional) — move RunRow/PhaseTraceRow/etc. from database.ts to types.ts if still needed
│   ├── git.ts                  # unchanged
│   ├── manifest.ts             # unchanged
│   ├── parser.ts               # unchanged
│   ├── prompts.ts              # unchanged
│   └── state.ts                # unchanged
├── main/                       # Electron main process
│   ├── index.ts                # EDITED — remove initDatabase/closeDatabase calls; add legacy-DB cleanup on app.ready
│   ├── preload.ts              # EDITED — history methods now pass projectDir through
│   └── ipc/
│       ├── history.ts          # EDITED — rewired to runs.ts + log-file readers (steps.jsonl)
│       ├── orchestrator.ts     # unchanged
│       └── project.ts          # unchanged
└── renderer/
    ├── electron.d.ts           # EDITED — RunRow/PhaseTraceRow/etc. imports + history-method signatures
    ├── hooks/
    │   ├── useOrchestrator.ts  # EDITED — call sites receive projectDir; adapt to renamed fields
    │   └── useProject.ts       # EDITED — same
    ├── components/             # unchanged (consumers use the hooks)
    ├── App.tsx                 # unchanged
    ├── styles/                 # unchanged
    └── utils/                  # unchanged

package.json                    # EDITED — remove better-sqlite3 + @types/better-sqlite3
package-lock.json               # EDITED — regenerated by `npm install` after package.json change
.claude/rules/06-testing.md     # EDITED — § 4f.4 rewritten for JSON file layout
CLAUDE.md                       # EDITED — dependency list updated, on-disk layout adjusted
```

**Structure Decision**: No new top-level directory. The change is internal to `src/core/` and `src/main/ipc/`. The renderer sees only TypeScript type-signature changes and minor field renames propagated through the `electron.d.ts` barrel. This matches the existing project layout described in `.claude/rules/05-implement.md` and preserves the platform-agnostic core boundary mandated by Constitution Principle II.

## Complexity Tracking

*No constitution violations. Table intentionally empty.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(none)_   | _(none)_                             |
