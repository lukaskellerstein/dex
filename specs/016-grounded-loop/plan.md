# Implementation Plan: Grounded Loop — Tests and Checks Decide, Not the Agent

**Branch**: `016-grounded-loop` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/016-grounded-loop/spec.md`

## Summary

Dex stops taking an agent's word for progress and for done. It runs the
project's own checks and acceptance tests itself, in its own process, records
the results as evidence, and lets four pure gates decide: red-first after a new
`tests` stage, a baseline before every `implement` and `verify`, progress after
every `implement` run, and done after `verify`. A separate agent writes the
acceptance tests before any code exists; they are frozen for the implementer and
the verifier, each stage gets its own write scope, and `tasks.md` may change
only by checkbox flips. A stall fingerprint, a flaky-check rule, a per-entry
attempt log and a one-page digest complete the loop. Everything runs under the
mock with fake sensors at zero cost, and one real entry on a dex-ecommerce
scratch clone proves it.

The approach reuses 015's structure: the picker stays a pure read of files, the
gates are a pure module with table tests, the new decisions ride the existing
policy decision (`decideToolUse`) and the existing question path, and the run
state gains no field — every new count is derived from the evidence.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node.js ≥ 22 (`path.matchesGlob`, `node --test`; v26 on the dev machine)
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk` 0.3.318 (unchanged), Electron, React 18; no new package (research R21)
**Storage**: files only — tracked `acceptance.json` in the spec folder; local `.dex/evidence/<id>/`, `.dex/digests/` (both self-ignoring)
**Testing**: `node --test` for `src/core/` (table tests for gates, plan diff, scopes; mock-loop scenario tests); vitest for the renderer; `check:size`; Playwright MCP over CDP 9333 for the UI
**Target Platform**: macOS desktop app and the headless `dex run` CLI (POSIX `sh` for sensors)
**Project Type**: desktop app (Electron main + React renderer) over a platform-agnostic core engine
**Performance Goals**: gate decisions in milliseconds; at most one fast-check run per tree state (R6); a sensor's memory bounded to 200 output lines
**Constraints**: no Electron imports in `src/core/`; Dex writes no tracked file during a run; every file ≤ 600 lines; Stop must kill a running sensor's whole process group
**Scale/Scope**: about 1.6k new lines in `src/core/` (9 new modules, 3 stage modules), about 0.4k in the renderer, 13 mock config fixtures; touches about 65 existing files, tests and fixtures included

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Clean-context orchestration | The `tests` stage and both verifier modes are fresh `query()` sessions. The attempt log reaches the next agent as a prompt section built from files on disk, never as carried conversation state. | Pass |
| II. Platform-agnostic core | `sensors.ts` uses `node:child_process` only; gates, plan diff, scopes and digest are pure Node. The renderer gets data through one new IPC handler. | Pass |
| III. Test before report | Gate tables, scope tables, plan-diff cases and twelve mock scenarios (FR-044's nine, the happy path, the test amendment and a `tests` crash) are tests; quickstart lists the live checks. Note: the constitution still says `npx tsc --noEmit` and `/tmp/dex-logs/`; the repo's rules supersede both with `npm run typecheck` and `~/.dex/dev-logs/` (no conflict in intent). | Pass |
| IV. Simplicity first | No new dependency; no new state field; one canonical acceptance record instead of two copies (R3); exit-code classification instead of a report parser (R2). The added `StageScope` parameter is the smallest change that makes per-stage scopes pure and testable. | Pass |
| V. Mandatory workflow | This plan; implementation follows the brief's phase order with `npm test` + `npm run typecheck` after each. | Pass |
| Tech constraints | React local state, CSS custom properties, Lucide icons for the gate card and digest view; no commits by Dex. | Pass |

**Post-design re-check (after Phase 1)**: still Pass. The design adds five pause
reasons and three events, both additive. No Complexity Tracking entry needed.

## Project Structure

### Documentation (this feature)

```text
specs/016-grounded-loop/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R21
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── acceptance-json.md
│   ├── evidence.md
│   ├── policy-json.md
│   ├── queue-json.md
│   ├── cli.md
│   ├── ipc-events.md
│   └── mock-config.md
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks, not created here
```

### Source Code (repository root)

```text
src/core/
├── sensors.ts           # NEW  run a sensor: sh -c, process group, timeout, tail, re-runs (R1, R12)
├── gates.ts             # NEW  pure: redFirst, baseline, progress, done, fingerprint, stalled, flakyCount
├── plan-diff.ts         # NEW  pure: tasks.md structural diff; test-file changes; skip markers (R8, R9)
├── acceptance.ts        # NEW  parse acceptance.json; merge with the queue's acceptance (R3)
├── tree-stamp.ts        # NEW  HEAD + diff + untracked hash, for baseline reuse and fingerprints (R6)
├── attempt-log.ts       # NEW  progress.md append, prompt slice, archive (R14)
├── scope.ts             # NEW  StageScope, stageScope(), scopeDecision(): per-stage write scopes (R9)
├── digest.ts            # NEW  .dex/digests/<id>.md from evidence and state (R15)
├── entry-prompts.ts     # NEW  per-entry stage prompts moved from prompts.ts, plus tests / restore / verify modes (R18)
├── evidence.ts          # CHANGE  stage records, done.json v2, amendments; 015 keys kept (R5)
├── picker.ts            # CHANGE  tests + amend rows, red-first retry row, done row from done.json (R4)
├── policy.ts            # CHANGE  checks, testGlobs, testSupport, verify; decideToolUse takes a StageScope (scope.ts, R9)
├── queue.ts             # CHANGE  "tests" stage name; entry acceptance and checks
├── state.ts             # CHANGE  five PauseReason values
├── events.ts            # CHANGE  sensor_run, gate_decided, digest_written
├── humanInput.ts        # CHANGE  "Test amendment" questions: fixed options, always wait (R10)
├── prompts.ts           # CHANGE  keeps the project-level prompts and stageEnv
├── cli.ts, cli/describe.ts, cli/run.ts   # CHANGE  dex digest; Sensors in --dry-run; digest path on exit
├── agent/
│   ├── permissions.ts   # CHANGE  pass the stage scope; amendment questions
│   ├── claudeSession.ts # CHANGE  carries the scope into the permission chain
│   ├── AgentRunner.ts   # CHANGE  StepContext / TaskPhaseContext gain `scope`
│   ├── MockAgentRunner.ts, MockConfig.ts   # CHANGE  writes through the policy; deletes, tests, findings (R16)
└── stages/
    ├── gate-runs.ts     # NEW  impure wiring: baseline, progress, red-first and acceptance runs; records; events
    ├── tests-stage.ts   # NEW  the tests stage (create, amend) + red-first
    ├── verify-stage.ts  # NEW  runVerify moved from cycle-stages: acceptance first, diagnose or review, done record
    ├── cycle-stages.ts  # CHANGE  runImplement phase and restore modes; returns the run's start SHA
    ├── post-stage.ts    # CHANGE  progress from the gate; stall and flaky guards
    └── loop.ts          # CHANGE  dispatch tests; restore before verify on a red baseline; digest on pause

src/main/ipc/            # CHANGE  project:get-digest
src/main/preload-modules/project-api.ts   # CHANGE  dexAPI.getDigest
src/renderer/components/
├── agent-trace/GateCard.tsx          # NEW
├── agent-trace/GateCard.logic.ts     # NEW  GateTracker: sensor_run + gate_decided events → `gate` steps
├── queue/DigestView.tsx              # NEW
├── queue/QueuePanel.tsx              # CHANGE  Digest button
└── loop/PauseCard.tsx                # CHANGE  digest link

fixtures/mock/grounded/  # NEW  fake-check.mjs, policy.json, one config per D-016-11 scenario
src/core/__tests__/      # NEW  sensors, gates, plan-diff, acceptance, tree-stamp, attempt-log, digest, entry-prompts, verify-stage, grounded-scenarios (scope cases are in policy.test.ts)
```

**Structure Decision**: The existing three-layer layout stays. Pure decisions
(`gates.ts`, `plan-diff.ts`, the scope part of `policy.ts`) are split from the
impure wiring (`stages/gate-runs.ts`), the same split 015 made between
`picker.ts` and `stages/loop.ts`. Note the brief's `stages/main-loop.ts` is
`stages/loop.ts` on this branch (015 renamed it).

## How a stage flows after 016

```mermaid
sequenceDiagram
  participant L as loop.ts
  participant P as picker.ts
  participant G as gate-runs.ts
  participant S as sensors.ts
  participant X as gates.ts (pure)
  participant A as agent (fresh session)
  L->>P: pickNext()
  P-->>L: implement, phase 2
  L->>G: baseline(entry)
  G->>S: fast checks (unless the tree stamp matches)
  S-->>G: runs
  G->>X: baseline(runs)
  X-->>G: pass | fail→restore
  L->>A: implement (phase or restore prompt, evidence, attempt log, scope)
  A-->>L: done (writes denied outside scope)
  L->>G: progress(entry, startSha)
  G->>S: fast checks
  G->>X: progress(runs, planDiff, testChanges, mode)
  X-->>G: pass | fail | pause
  G-->>L: decision + record + gate_decided
  L->>L: post-stage: counters, stall, flaky, frozen; digest on pause
```

## Implementation phases

The brief's order, with the gate after each phase: `npm test` and
`npm run typecheck` pass.

| Phase | Builds | Proves |
|---|---|---|
| 0 | Confirm 015 as built: queue, picker, policy, evidence, CLI and their tests (FR-045) | the suite is green before any change |
| 1 | `sensors.ts`, `tree-stamp.ts`, evidence stage records, `gates.ts` | sensor tests with real `sh` commands (exit, timeout, kill group, tail); gate tables |
| 2 | baseline + progress in `implement`, restore mode, fingerprint and stall, flaky re-runs | mock: ticks-while-red, same-fingerprint, flaky-check |
| 3 | `plan-diff.ts`, `testGlobs`, `testSupport`, `StageScope`, frozen test set, `tests_changed` | scope table; plan-diff cases; mock: rewords-task, edits-frozen-test |
| 4 | `tests` stage, `acceptance.json`, red-first and its retry, amendments | mock: tests-already-pass, skip-tests-no-acceptance; amendment waits in every mode |
| 5 | `verify-stage.ts`: acceptance first, diagnose and review, `done.json`, the picker's done row | mock: verifier-passes-red, blocking-finding; commit after done re-verifies |
| 6 | attempt log, digest, `dex digest`, dry-run Sensors, UI gate card and digest view | CLI tests; renderer tests; live check over CDP |
| 7 | all D-016-11 scenarios in one test file; the dex-ecommerce mock loop | SC-002, SC-003 |
| 8 | real run on a dex-ecommerce scratch clone: configure, dry run, owner sign-off, one real entry, then the queue | SC-004, SC-009 |

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A runner uses exit code 1 for a crash (vitest, jest) | red-first reads a crash as red | the done gate stays red, the verifier diagnoses, the implementer asks for an amendment (R2); JUnit parsing is the follow-up |
| Slow fast checks | each implement run waits for them | the project chooses what is fast; baseline reuse removes the second run (R6); slow suites go to `checks.standing` |
| A sensor leaves a server running | port clashes on the next run | process-group kill on timeout and Stop (R1) |
| Bash-level frozen-file guard misses a form (`cp /dev/null x`) | the edit slips past the hook | the post-stage name-status diff pauses with `frozen_changed` (R9) |
| `verify.json` v1 ignored after the upgrade | one extra verify per done entry | accepted, once (R5) |
| Source size grows (015's SC-007 was not met) | `check:size` stays per file, but the total rises | the split in R18 keeps every file under 600 lines; the PR reports the per-area delta with `scripts/loc-by-area.sh` |

## Complexity Tracking

No constitution violation to justify.
