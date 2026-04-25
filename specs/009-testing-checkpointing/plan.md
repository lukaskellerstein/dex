# Implementation Plan: Testing Checkpointing via Mock Agent

**Branch**: `009-testing-checkpointing` | **Date**: 2026-04-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-testing-checkpointing/spec.md`

## Summary

Extract agent execution from the orchestrator into a pluggable `AgentRunner` contract with a small registry, refactor today's Claude-SDK path into a `ClaudeAgentRunner`, and introduce a deterministic `MockAgentRunner` that replays a project-local, fully enumerated script. The selector lives in `<projectDir>/.dex/dex-config.json` (`{ "agent": "claude" | "mock" | … }`); each runner owns its own config file (`<agent>-config.json`). The mock script mirrors the orchestrator's four phases — `prerequisites`, `clarification`, `dex_loop` (with explicit `cycles[]`), `completion` — and drives checkpoint testing end-to-end in under 60 seconds at zero API cost. Missing script entries and fixtures surface as loud, coordinate-pinpointed errors; no silent defaults. The refactor preserves real-agent behavior byte-for-byte (constitution Principle II — Platform-Agnostic Core — and III — Test Before Report — are explicit gates).

## Technical Context

**Language/Version**: TypeScript 5.6+ (strict mode), Node.js bundled with Electron 41 (Node 20 runtime)
**Primary Dependencies**: Unchanged — `@anthropic-ai/claude-agent-sdk` ^0.1.45 (used only by `ClaudeAgentRunner`), `electron` ^41.2.1, `react` ^18.3.1, `gsap` ^3.12.5, `lucide-react` ^0.460.0. **No new dependencies.** Mock uses `node:fs`, `node:path`, `node:crypto` only.
**Storage**: Project-local filesystem only — `<projectDir>/.dex/dex-config.json` (new, gitignored), `<projectDir>/.dex/mock-config.json` (new, gitignored), `fixtures/mock-run/` in the Dex repo (committed). No new per-run persistence; existing `.dex/state.json`, `.dex/feature-manifest.json`, `.dex/learnings.md`, `.dex/runs/<runId>.json`, and `~/.dex/logs/<project>/<runId>/…` continue unchanged.
**Testing**: `npx tsc --noEmit` + Vitest unit tests for `MockAgentRunner`, `registry`, `loadDexConfig`, `loadMockConfig`. End-to-end validation via `electron-chrome` MCP on the `dex-ecommerce` example project per `.claude/rules/06-testing.md` §4c.
**Target Platform**: Electron desktop app (Linux/macOS/Windows). Core engine (`src/core/`) remains pure Node.js — no Electron imports (constitution Principle II).
**Project Type**: Desktop app with platform-agnostic orchestration core.
**Performance Goals**: Mock-driven full multi-cycle run completes in under 60 s (spec SC-001, SC-009). Single stage advances within `delay + filesystem_io` (~10–500 ms range configured per stage). No throughput target for the real path — behavior is unchanged.
**Constraints**: (1) Real-path behavior MUST remain observationally identical post-refactor (spec SC-007); (2) Mock MUST emit the same `OrchestratorEvent` lifecycle (`stage_started`, `stage_completed`, `phase_started`, `phase_completed`, `checkpoint_created`) used by the UI (spec FR-014); (3) `src/core/` stays free of Electron/renderer imports (constitution II); (4) No silent fakes — every missing script entry or fixture halts with coordinates (spec FR-010, FR-011).
**Scale/Scope**: One refactor touching `orchestrator.ts` (move ~300 LOC of SDK-invocation bodies into `ClaudeAgentRunner`), seven new files under `src/core/agent/`, two new config loaders (`src/core/dexConfig.ts`, plus loader inside `MockAgentRunner`), one new fixture directory (`fixtures/mock-run/`), two Vitest files. No UI changes. No IPC changes.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan complies |
|---|---|---|
| **I. Clean-Context Orchestration** | ✅ Pass | Each phase/stage still runs as an isolated agent invocation. `ClaudeAgentRunner.runPhase()` / `runStage()` are a 1:1 move of today's `query()` call sites — no context threading between stages is introduced. `MockAgentRunner` also executes each stage independently (no cross-stage state beyond the script's ordered-cycles index). Hook capture (PreToolUse / PostToolUse / SubagentStart / SubagentStop) stays inside `ClaudeAgentRunner` unchanged. |
| **II. Platform-Agnostic Core** | ✅ Pass | All new files live under `src/core/agent/` (plus `src/core/dexConfig.ts`). No Electron / renderer / `window.dexAPI` imports. `MockAgentRunner` uses only `node:fs`, `node:path`, `node:crypto`. Verified by `tsc --noEmit` on the core subtree and by the `ESLint no-restricted-imports` rule already enforced on `src/core/**`. |
| **III. Test Before Report (NON-NEGOTIABLE)** | ✅ Pass | DoD is wired into the quickstart (Phase 1) and into Phase 2 tasks: `tsc --noEmit`, Vitest for `MockAgentRunner` + `registry` + `loadDexConfig`, e2e mock run against `dex-ecommerce` covering all checkpoint UX flows (Go Back, Try Again, Step Mode, Record Mode), and a real-agent smoke run to guard against regression (spec SC-007). UI observability via `mcp__electron-chrome__*` per `.claude/rules/06-testing.md` §4d. |
| **IV. Simplicity First** | ✅ Pass — with one intentional abstraction | The registry + factory + interface are a three-box Strategy pattern, not a framework. No DI container, no plugin-discovery magic — runners are registered by name in `src/core/agent/index.ts`. The alternative (leave SDK inline, add `if (mockMode)` branches in two places) was rejected because it couples the orchestrator to one provider forever and makes the mock a special case the loop has to know about — violates Principle IV's "no special-case conditionals" heuristic. Per-runner config files (`<agent>-config.json`) instead of a monolithic config prevent schema bloat as future runners are added (YAGNI in reverse: each runner grows its own surface only when it needs to). |
| **V. Mandatory Workflow** | ✅ Pass | Understand → Plan (this document) → Implement (Phase 2 tasks) → Test (DoD checklist in quickstart) → Report. Spec approved; plan under review before any code edits. |

**Gate result**: PASS — proceed to Phase 0.

No Complexity Tracking entries required — every new file is load-bearing for the feature's stated outcomes.

## Project Structure

### Documentation (this feature)

```text
specs/009-testing-checkpointing/
├── plan.md                         # This file
├── research.md                     # Phase 0 output — decisions + rationale
├── data-model.md                   # Phase 1 output — entities, relationships
├── quickstart.md                   # Phase 1 output — end-to-end developer walkthrough + DoD
├── contracts/
│   ├── AgentRunner.md              # Interface contract: runStage / runPhase, StageContext/Result, PhaseContext/Result
│   ├── registry.md                 # Registry API: registerAgent / createAgentRunner / unknown-name error shape
│   ├── dex-config.schema.json      # JSON Schema for .dex/dex-config.json
│   └── mock-config.schema.json     # JSON Schema for .dex/mock-config.json
├── checklists/
│   └── requirements.md             # Spec quality checklist (from /speckit.specify)
└── tasks.md                        # Phase 2 output — /speckit.tasks (NOT created here)
```

### Source Code (repository root)

```text
src/
├── core/                                   # Platform-agnostic orchestrator engine
│   ├── agent/                              # NEW — agent backend abstraction
│   │   ├── AgentRunner.ts                  # Interface + shared types (StageContext, StageResult, PhaseContext, PhaseResult)
│   │   ├── ClaudeAgentRunner.ts            # Claude-SDK path — receives the ~300 LOC moved verbatim from runStage/runPhase
│   │   ├── MockAgentRunner.ts              # Scripted playback backend — reads mock-config, emits events, writes fixtures
│   │   ├── MockConfig.ts                   # Schema + loader + validator for .dex/mock-config.json
│   │   ├── registry.ts                     # AGENT_REGISTRY + registerAgent + createAgentRunner
│   │   ├── index.ts                        # Barrel — registers built-in runners at module init
│   │   └── __tests__/
│   │       ├── MockAgentRunner.test.ts
│   │       ├── MockConfig.test.ts
│   │       └── registry.test.ts
│   ├── dexConfig.ts                        # NEW — loadDexConfig(projectDir) → { agent: string }
│   ├── orchestrator.ts                     # MODIFIED — runStage/runPhase bodies extracted; run() resolves runner via registry
│   ├── types.ts                            # MODIFIED — RunConfig.agent? optional override
│   ├── state.ts                            # Unchanged
│   ├── checkpoints.ts                      # Unchanged
│   ├── git.ts                              # Unchanged
│   ├── runs.ts                             # Unchanged
│   └── …                                   # Everything else unchanged
├── main/                                   # Unchanged
└── renderer/                               # Unchanged

fixtures/
└── mock-run/                               # NEW — committed reference artifacts
    ├── GOAL_clarified.md
    ├── CLAUDE.md
    ├── constitution.md
    ├── feature-manifest.json
    ├── f1-spec.md  f1-plan.md  f1-tasks.md
    ├── f2-spec.md  f2-plan.md  f2-tasks.md
    └── f3-spec.md  f3-plan.md  f3-tasks.md

<projectDir>/.dex/                          # Per-project — authored by developer
├── dex-config.json                         # NEW — gitignored — { "agent": "mock" }
└── mock-config.json                        # NEW — gitignored — full scripted run
```

**Structure Decision**: Single-project layout. All new production code lives under `src/core/agent/` (Principle II — no Electron imports allowed there), alongside the existing orchestrator engine. Fixtures live at the repo root under `fixtures/mock-run/` so they ship with Dex itself and can be referenced by any developer testing any example project. Per-project developer config (`.dex/dex-config.json`, `.dex/mock-config.json`) is gitignored so each developer can run their own test harness without polluting shared history.

## Complexity Tracking

*No violations — section intentionally empty.*

The `AgentRunner` interface + registry introduces one abstraction layer where today there is none. Per Principle IV, this must be justified:

- **What it buys**: provider-agnostic orchestrator loop; mock becomes "just another backend" instead of a special case; future Codex/Gemini providers slot in by implementing and registering, with zero edits to `orchestrator.ts`.
- **What the simpler alternative looked like**: inline `if (mockMode) { … } else { query(…) }` at both call sites. Rejected: two duplicated branches, permanent coupling of the orchestrator to one real provider, and the mock remains a special case that every future orchestrator change has to remember. That's the speculative-abstraction trap in reverse — refusing to abstract where the abstraction boundary already exists in the code's shape.
- **How it stays simple**: three small files (`AgentRunner.ts`, `registry.ts`, `index.ts`), ~100 LOC total. No DI container, no plugin discovery, no lifecycle hooks beyond the two methods. Runners register themselves by name at module load. Unknown-name lookup throws with the registered names listed — spec FR-003, SC-003.
