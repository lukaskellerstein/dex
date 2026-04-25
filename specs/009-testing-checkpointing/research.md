# Phase 0 Research — Testing Checkpointing via Mock Agent

**Feature**: 009-testing-checkpointing
**Date**: 2026-04-18
**Purpose**: Resolve every design decision needed before writing the interface contracts and data model in Phase 1. No `[NEEDS CLARIFICATION]` remain — spec was clean and the brief (`docs/my-specs/009-testing-checkpointing/README.md`) provided the shape; this document captures the "why" behind each pick and the alternatives rejected.

---

## D1. Agent abstraction shape: interface with two methods vs. per-stage strategy map

**Decision**: Single `AgentRunner` interface with two methods — `runStage(ctx) → StageResult` and `runPhase(ctx) → PhaseResult`. These map 1:1 to today's call sites (`src/core/orchestrator.ts:970` and `:566`).

**Rationale**:
- The orchestrator already has exactly two entry points into agent execution. Mirroring them keeps the refactor a straight extract-function — no reshuffling of control flow.
- Two methods is the narrowest surface that still captures the real/mock split. A richer interface (e.g., one method per stage) would bloat runners and push orchestration logic into them.
- Both methods receive a context object carrying everything they need (`stage`, `cycleNumber`, `specDir`, `config`, `rlog`, `emit`, `abortController`, `outputFormat?`) — no hidden dependencies on orchestrator module globals.

**Alternatives considered**:
- **One method `run(ctx)` with a `kind: "stage" | "phase"` discriminator**. Rejected — every runner then has to branch internally, duplicating the dispatch the orchestrator already does. Loses type precision.
- **One method per stage (`runSpecify`, `runPlan`, …)**. Rejected — explosion as `STAGE_ORDER` grows; mock would have 15+ thin methods. Real runner's branching (stage-specific prompt assembly) is already done by the orchestrator before calling the runner.

---

## D2. Registry mechanism: module-level map + `registerAgent()`

**Decision**: A module-level `Record<string, AgentRunnerFactory>` populated by side-effecting calls to `registerAgent(name, factory)` from `src/core/agent/index.ts`. `createAgentRunner(name, runConfig, projectDir)` looks up by name and throws `UnknownAgentError` with the registered names listed on miss.

**Rationale**:
- Matches how `better-sqlite3` replacement (007-sqlite-removal) and existing Dex module-load patterns already work — no novel patterns introduced.
- Import-time registration means the factory list is deterministic and inspectable; no runtime discovery, no filesystem scanning.
- The error message format "Unknown agent: `X`. Registered: `claude`, `mock`" directly satisfies spec SC-003 and FR-003.

**Alternatives considered**:
- **DI container (`inversify`, `tsyringe`)**. Rejected — introduces a dependency, hides the registration point, and gains nothing at this scale.
- **Plugin-style discovery (scan `src/core/agent/*/runner.ts`)**. Rejected — magic, slower startup, breaks bundling. Explicit registration is trivially greppable.
- **Enum + switch**. Rejected — forces the orchestrator to know every runner's identity at compile time, defeating the point of the abstraction.

---

## D3. Config selector location: `<projectDir>/.dex/dex-config.json`

**Decision**: The backend selector lives at `<projectDir>/.dex/dex-config.json` with initial shape `{ "agent": "claude" | "mock" | … }`. Gitignored by default. Absent file → default `{ "agent": "claude" }`.

**Rationale**:
- Per-project, not global: different projects may use different backends (mock the Dex example, real for user projects).
- Per-developer, not shared: each developer chooses whether to run scripted or real on their own machine. Committing this file would force a team-wide choice.
- `.dex/` is already the established per-project state directory (`state.json`, `state.lock`, `feature-manifest.json`, `learnings.md`, `runs/`) — selector belongs there.
- Small and stable: the selector stays minimal so it can evolve without churn. Per-agent config files (D4) absorb backend-specific growth.

**Alternatives considered**:
- **User-level config in `~/.dex/`**. Rejected — forces a single global backend choice across all projects on a developer's machine.
- **UI toggle in Loop Start Panel**. Rejected for now (explicit Non-Goal in the brief) — adds UI complexity before the mechanism is proven. The future in-process override (FR-018, `RunConfig.agent?`) is already reserved so a UI toggle can be added later without changing this feature's design.

**Gitignore entry added**: `.dex/dex-config.json`, `.dex/mock-config.json`.

---

## D4. Per-runner config convention: `<agent>-config.json` siblings

**Decision**: Each runner owns its config file, named `<agent>-config.json` and living next to `dex-config.json`. Today: `mock-config.json`. Tomorrow: `codex-config.json`, `gemini-config.json`. `claude` needs no file (its config is the existing per-run `RunConfig`).

**Rationale**:
- Keeps the selector small and stable (D3).
- Each runner loads its own file — loader code colocates with the runner that owns the schema. No central mega-schema to maintain.
- Naming convention means "where do I put Codex config?" has exactly one answer.
- Gitignored by default for the same reason as the selector (D3).

**Alternatives considered**:
- **Monolithic `dex-config.json` with nested `mock: {…}`, `codex: {…}` sections**. Rejected — selector bloat, merge conflicts across runners, awkward for team members not using a given backend.
- **Per-runner config in a separate tree (`.dex/agents/mock.json`)**. Rejected — one more level of nesting for zero benefit.

---

## D5. Mock-config structure: four phases mirroring orchestrator phases

**Decision**: Top-level keys `prerequisites`, `clarification`, `dex_loop`, `completion`. The first three contain sub-objects keyed by stage name (from `STAGE_ORDER` at `src/core/state.ts:380`). `dex_loop` additionally contains `cycles: [{ feature, stages }, …]` because that phase's stages repeat per cycle. `completion` is reserved for future post-loop stages (currently empty).

Phase→stage mapping:

| Phase | Stages |
|---|---|
| `prerequisites` | `prerequisites` |
| `clarification` | `clarification_product`, `clarification_technical`, `clarification_synthesis`, `constitution`, `manifest_extraction` |
| `dex_loop` | per cycle — `gap_analysis`, `specify`, `plan`, `tasks`, `implement`, `implement_fix`, `verify`, `learnings` |
| `completion` | *(reserved)* |

**Rationale**:
- Matches the orchestrator's own mental model — a reader of both the orchestrator and the mock-config can pattern-match between them.
- Putting cycles-only-when-needed (inside `dex_loop`) keeps the non-cycle phases flat and obvious.
- `completion` is empty today but reserved so adding post-loop stages later doesn't force a schema migration.

**Alternatives considered**:
- **Flat `stages: { [name]: descriptor }` with a separate `cycles: [...]`**. Rejected — loses phase grouping, makes it unclear which stages repeat per cycle.
- **Array-of-steps (`steps: [{ phase, stage, cycle?, … }, …]`)**. Rejected — harder to author (lots of repetition), harder to validate (no per-phase key set), and doesn't surface cycle boundaries visually.

---

## D6. Step descriptor: `{ delay, writes?, appends?, structured_output? }`

**Decision**: Every stage's descriptor is a plain object with these optional keys. Semantics:

| Key | Type | Behavior |
|---|---|---|
| `delay` | `number` (ms, default 0) | `MockAgentRunner` sleeps this long before producing side effects. Required to let the UI show per-stage progress. |
| `writes` | `[{ path, from? \| content? }]` | Copy a fixture file (`from`, relative to `fixtureDir`) or write literal content (`content`) to `path`. `path` supports template substitution: `{specDir}`, `{cycle}`, `{feature}`. Parent dirs created. |
| `appends` | `[{ path, line }]` | Append a line to `path` (creating file if absent). |
| `structured_output` | `object` | For stages that normally return JSON-schema-constrained output (`gap_analysis`, `verify`, `clarification_synthesis`, `manifest_extraction`) — returned verbatim to the orchestrator. |

**Rationale**:
- These four keys cover every orchestrator side effect observed in `src/core/orchestrator.ts:runStage` / `runPhase`: filesystem writes (specs, plans, tasks, manifest, source files), filesystem appends (learnings), and structured returns (decisions).
- Every key is optional — a stage with only `{ delay: 100 }` is valid and common (e.g., `prerequisites`, `clarification_product`).
- Template substitution in `path` (`{specDir}`, `{cycle}`, `{feature}`) avoids hard-coding paths in the fixture set and lets one fixture serve multiple cycles if needed.

**Alternatives considered**:
- **Inline content-only writes (drop `from`)**. Rejected — authoring specs/plans inline in JSON is painful and loses syntax highlighting; fixtures are plain `.md` / `.json` files developers can edit with their normal tools.
- **Separate `copyFrom` vs `writeLiteral` keys**. Rejected — current `writes[].from | content` keeps the descriptor compact and validates by "exactly one of" at load time.
- **Auto-populate `delay: 100` default**. Rejected — mild magic. Spec FR-015 mandates honoring the delay; it's simpler to require the author to set it.

---

## D7. Cycle semantics: ordered list, one feature per cycle, explicit termination

**Decision**: `dex_loop.cycles` is an ordered list. Each entry declares the feature being worked on and its per-stage descriptors. The `MockAgentRunner` indexes into this list using the orchestrator's `ctx.cycleNumber - 1`. Loop termination happens when a cycle's `gap_analysis.structured_output.decision === "GAPS_COMPLETE"` — exactly as in a real run. Exhausting `cycles[]` without a `GAPS_COMPLETE` halts with a clear error.

**Rationale**:
- Matches the orchestrator's view — each outer-loop iteration *is* one cycle, bound to one feature (`src/core/orchestrator.ts:2441-2502`).
- Termination via `GAPS_COMPLETE` means the mock doesn't need a separate "stop" flag — it reuses the real control-flow signal.
- Running off the end is a loud error, not a silent loop — matches spec FR-011 and the "no silent fakes" principle.

**Alternatives considered**:
- **Number-of-cycles field `cycleCount: N`**. Rejected — doesn't let each cycle carry its own feature metadata and `gap_analysis.decision`; less explicit.
- **Auto-generate a terminal `GAPS_COMPLETE` at `cycles[]` end**. Rejected — hides intent; authors must state "yes, this is the last one."
- **Allow multiple features per cycle**. Rejected — the orchestrator itself treats one cycle as one feature pass; multi-feature cycles would fake a non-existent orchestrator shape.

---

## D8. Event emission: minimum viable set (what the UI actually reads)

**Decision**: `MockAgentRunner` emits exactly the events the orchestrator and UI rely on for checkpoint flows:

- `stage_started` — before delay + side effects
- `agent_step` — one synthetic step per stage (type `"mock_stage"`, payload includes stage name and cycle) so the trace view shows something
- `stage_completed` — after delay + side effects, carrying `costUsd: 0, durationMs: <actual>`
- `phase_started` / `phase_completed` / `checkpoint_created` — delegated to the orchestrator (the mock doesn't drive these; the orchestrator does, regardless of runner)

Runs-ledger writes (`runs.startPhase`, `runs.completePhase`) also happen in the orchestrator, not the runner. The runner only emits events; the orchestrator persists them.

**Rationale**:
- Per constitution Principle II, the runner interface should be minimal. Events + structured output are the complete orchestrator→runner→orchestrator vocabulary today.
- The UI's sparseness guarantee (spec assumption) means we don't need to synthesize tool-use steps, subagent starts, or PreToolUse payloads. Trace view shows one row per stage — acceptable.
- Having the orchestrator own run-ledger writes means swapping runners doesn't risk dropping audit records.

**Alternatives considered**:
- **Mock emits richer synthetic tool-use steps**. Rejected for this feature (spec assumption) — out of scope. Can be layered in later without changing the interface.
- **Mock writes run-ledger entries itself**. Rejected — duplicates logic and makes the contract between runner and orchestrator fuzzier.

---

## D9. Fixture set location: `fixtures/mock-run/` at the Dex repo root

**Decision**: Fixtures live at `<dexRepo>/fixtures/mock-run/`, committed to the Dex repo. The `mock-config.json` in a developer's project points at them via `fixtureDir` (default: resolved to the absolute path of that directory at runtime).

**Rationale**:
- Fixtures are reference artifacts the Dex team maintains — they belong with Dex's source, not with arbitrary example projects.
- One canonical fixture set means every developer gets the same baseline; drift shows up as config errors, not as "works on my machine."
- Committing them (unlike the `mock-config.json`) means the CI machine has them available too, even though CI doesn't use the mock.

**Alternatives considered**:
- **Per-project fixtures under `.dex/mock-fixtures/`**. Rejected — every project would duplicate them; divergence inevitable.
- **Ship fixtures inside the npm package**. Rejected — Dex is an Electron app, not a published npm package. Repo-root is the natural location.

---

## D10. Structured-output schemas: not validated by mock

**Decision**: `MockAgentRunner` returns `structured_output` verbatim without schema validation. Orchestrator-side validation (existing, against `GAP_ANALYSIS_SCHEMA`, `VERIFY_SCHEMA`, `MANIFEST_SCHEMA` from `src/core/schemas.ts`) is what catches shape errors.

**Rationale**:
- Single source of truth — the orchestrator's schemas are authoritative. If the mock also validated, we'd have two validators that can drift.
- When the script declares `structured_output: { decision: "GAPS_COMPLETE" }` and the orchestrator expects `{ decision: "GAPS_COMPLETE", reason: string }`, the orchestrator surfaces a clear error at the next line — exactly what we want.
- Consistent with the "loud drift" theme — missing/wrong shapes fail at the point of consumption.

**Alternatives considered**:
- **Validate in mock with the same schemas**. Rejected — couples mock to those specific schemas, adds a second error path, no new signal. If a schema changes, both sides need updates anyway.

---

## D11. Mock `enabled` flag: explicit kill-switch, loud when contradicted

**Decision**: `mock-config.json` carries a top-level `enabled: boolean` (default `true` for simplicity, but required-to-be-explicit — schema rejects omission). If `dex-config.json` selects `mock` but `mock-config.enabled === false`, startup throws with `MockDisabledError`.

**Rationale**:
- Gives authors a one-field disable without deleting the selector — useful during debugging of a regression to force the real path temporarily.
- Loud-when-contradicted means no accidental "I thought I'd enabled it, why is it running real?" confusion.

**Alternatives considered**:
- **No flag, presence of `mock-config.json` means enabled**. Rejected — removes the dedicated kill-switch use case.
- **Default `enabled: true` when omitted**. Rejected — explicitness beats magic. Author always sees the flag in their file.

---

## D12. Registry override precedence: `RunConfig.agent` wins over selector

**Decision**: `RunConfig.agent?: string` is optional. If set (e.g., by a future UI toggle or a scripted run trigger), it wins over `dex-config.json`'s selection. If unset, the selector file wins. If both are absent, the runner defaults to `"claude"`.

**Rationale**:
- Preserves the future-UI path (spec FR-018) without coupling this feature to a UI change.
- Precedence: per-run override → per-project file → built-in default. Standard three-tier layering, matches how most tools resolve config.

**Alternatives considered**:
- **File always wins**. Rejected — blocks the future UI toggle.
- **UI always wins**. Rejected — means the selector file is meaningless once a UI exists, which is worse than either alone.

---

## D13. Refactor safety net: real-path regression smoke run

**Decision**: Phase 2 tasks include a mandatory real-agent smoke run on `dex-ecommerce` after the `ClaudeAgentRunner` extraction lands, covering at minimum `prerequisites → clarification_synthesis → manifest_extraction → gap_analysis → specify → plan → tasks → implement`. Must complete end-to-end without errors. Per spec SC-007.

**Rationale**:
- The ~300 LOC move is the biggest risk in the feature. Unit tests on the real path are minimal today. One smoke run catches any subtle behavior change (event ordering, abort handling, canUseTool interception) that unit tests would miss.
- Matches constitution Principle III — test before report, no exceptions.

**Alternatives considered**:
- **Rely on unit tests alone**. Rejected — the real path exercises the SDK, hooks, abort handling, `canUseTool`, structured-output parsing, message-loop consumption; unit tests on that surface don't exist and building them is out of scope for this feature.
- **Rely on the mock e2e run**. Rejected — the mock doesn't exercise the SDK at all, so it can't catch a real-path regression.

---

## D14. Template substitution: `{specDir}`, `{cycle}`, `{feature}` only

**Decision**: Three substitutable tokens in `writes[].path` and `appends[].path`: `{specDir}` (the orchestrator's current `specDir`), `{cycle}` (cycle number), `{feature}` (the current cycle's `feature.id`). Substitution happens at stage execution time inside `MockAgentRunner`. Unknown tokens → `MockConfigInvalidPathError` listing the valid tokens.

**Rationale**:
- Covers every path-shape the orchestrator uses today (`specs/<specDir>/<file>`, `src/mock/c<cycle>-f<feature>.ts`).
- Unknown-token loudness consistent with D3/D7 — drift is a hard error.

**Alternatives considered**:
- **Full Mustache/Handlebars**. Rejected — overkill; three tokens suffice.
- **No substitution (hard-code paths)**. Rejected — forces per-cycle fixture duplication and breaks when specDir varies.

---

## D15. Vitest vs. node:test for unit tests

**Decision**: Vitest, matching existing test infrastructure.

**Rationale**:
- Dex already runs `vitest` (`package.json` has it as a devDependency; `npm test` invokes it). Adding tests to the existing runner means no new CI config.
- `node:test` would be the alternative for zero-dep testing but introduces a second runner with no benefit.

**Alternatives considered**:
- **`node:test` stdlib**. Rejected — second test runner, confusing for contributors.

---

## Summary

| Decision | Pick |
|---|---|
| D1 — Interface shape | Two methods: `runStage`, `runPhase` |
| D2 — Registry | Module-level map + `registerAgent()` + throw-on-unknown |
| D3 — Selector location | `<projectDir>/.dex/dex-config.json` (gitignored) |
| D4 — Per-runner config | `<agent>-config.json` siblings of selector |
| D5 — Mock-config shape | Four phases (prerequisites, clarification, dex_loop, completion); dex_loop has cycles[] |
| D6 — Step descriptor | `{ delay, writes?, appends?, structured_output? }`, templated paths |
| D7 — Cycle semantics | Ordered list, one feature each, terminate via `GAPS_COMPLETE` |
| D8 — Events | Minimal set: `stage_started`, one `agent_step`, `stage_completed`; orchestrator owns phase + checkpoint events |
| D9 — Fixtures location | `<dexRepo>/fixtures/mock-run/` |
| D10 — Schema validation | Not in mock; orchestrator validates |
| D11 — Enabled flag | Explicit `enabled: boolean`; required; loud on contradiction |
| D12 — Override precedence | `RunConfig.agent` > `dex-config.json` > `"claude"` default |
| D13 — Regression guard | Mandatory real-agent smoke run on `dex-ecommerce` post-refactor |
| D14 — Template tokens | `{specDir}`, `{cycle}`, `{feature}` only |
| D15 — Test runner | Vitest |

All gates in the Constitution Check remain green under these decisions. Proceed to Phase 1.
