# Data Model — Testing Checkpointing via Mock Agent

**Feature**: 009-testing-checkpointing
**Date**: 2026-04-18
**Scope**: The config files authored by developers, the in-memory shape passed across the `AgentRunner` contract, and the error types raised when the mock fails loudly. Everything else (state.json, feature-manifest.json, run records) is unchanged from prior features.

---

## 1. `DexConfig` — selector (`<projectDir>/.dex/dex-config.json`)

```typescript
// src/core/dexConfig.ts
export interface DexConfig {
  /** Name of the registered agent runner. Must match AGENT_REGISTRY key. */
  agent: string;   // "claude" (default) | "mock" | future "codex" | "gemini"
}
```

**Validation rules**:
- File absent → `loadDexConfig(projectDir)` returns `{ agent: "claude" }` (spec FR-002).
- File present but invalid JSON → throw `DexConfigParseError` with line/column from `JSON.parse`.
- `agent` missing or empty → throw `DexConfigInvalidError("dex-config.json: 'agent' field is required")`.
- `agent` not a string → `DexConfigInvalidError`.
- `agent` not in `AGENT_REGISTRY` → `UnknownAgentError` (raised by `createAgentRunner`, not by the loader — that way future registrations can participate before the error is final).

**Lifecycle**:
1. Created by developer, hand-edited. No UI.
2. Read once at the start of `orchestrator.run()`.
3. Never written by Dex. If a future UI adds an override, it goes through `RunConfig.agent?` (D12), not by mutating this file.

**Gitignore**: `.dex/dex-config.json` is added to the project's root `.gitignore` (spec FR-016). For the `dex-ecommerce` example project, this entry already exists in the broader `.dex/` ignore — verify during implementation.

---

## 2. `MockConfig` — scripted runtime (`<projectDir>/.dex/mock-config.json`)

```typescript
// src/core/agent/MockConfig.ts

/** Top-level config. One file per project. */
export interface MockConfig {
  /** Master kill switch. Required. If false while dex-config selects "mock" → MockDisabledError. */
  enabled: boolean;
  /** Base directory fixture `from` paths resolve against. Defaults to "<dexRepo>/fixtures/mock-run/". */
  fixtureDir?: string;
  prerequisites:  PhaseEntry;
  clarification:  PhaseEntry;
  dex_loop:       DexLoopEntry;
  completion:     PhaseEntry;   // reserved — empty object today
}

export type PhaseEntry = Record<StageName, StepDescriptor>;

export interface DexLoopEntry {
  /** Ordered; one entry per cycle the mock run will execute. */
  cycles: CycleEntry[];
}

export interface CycleEntry {
  feature: {
    id: string;       // e.g. "f-001"; must appear in the feature-manifest fixture
    title: string;    // e.g. "Authentication"
  };
  stages: {
    gap_analysis:   StepDescriptor;  // structured_output required (see §4)
    specify:        StepDescriptor;
    plan:           StepDescriptor;
    tasks:          StepDescriptor;
    implement:      StepDescriptor;
    implement_fix?: StepDescriptor;  // optional per cycle
    verify:         StepDescriptor;  // structured_output required
    learnings:      StepDescriptor;
  };
}

export interface StepDescriptor {
  /** ms; 0 allowed; no default (author must state it — spec FR-015 explicit). */
  delay: number;
  /** Copy fixtures or write literal content. Either `from` or `content`, not both. */
  writes?:  WriteSpec[];
  /** Append a line to a file. */
  appends?: AppendSpec[];
  /** For stages whose real counterparts return JSON-schema-constrained output. */
  structured_output?: Record<string, unknown>;
}

export interface WriteSpec {
  /** Destination path, relative to projectDir. Supports tokens: {specDir}, {cycle}, {feature}. */
  path: string;
  /** Fixture path, relative to fixtureDir. Exactly one of from/content. */
  from?: string;
  /** Literal content. Exactly one of from/content. */
  content?: string;
}

export interface AppendSpec {
  /** Destination, relative to projectDir. Supports the same tokens as WriteSpec.path. */
  path: string;
  /** Line to append. A trailing newline is added if absent. */
  line: string;
}
```

**Validation rules** (enforced by `loadMockConfig`, all raise `MockConfigInvalidError` with a pointer to the offending key):
- `enabled` must be a boolean.
- `prerequisites`, `clarification`, `dex_loop`, `completion` must all be present.
- `dex_loop.cycles` must be a non-empty array.
- Each `CycleEntry.stages` must include `gap_analysis`, `specify`, `plan`, `tasks`, `implement`, `verify`, `learnings` (mandatory seven). `implement_fix` optional.
- Every `StepDescriptor.delay` must be a finite non-negative number.
- `writes[].from` XOR `writes[].content` — never both, never neither (load-time).
- `structured_output` is required on stages that demand it (see §4).

**Lookup-time errors** (raised during run, not load):
- Script entry for `(phase, stage [, cycle])` missing → `MockConfigMissingEntryError` (details: phase, stage, cycleNumber?, featureId?).
- Fixture file `from` does not exist on disk → `MockFixtureMissingError` (details: resolved absolute path).
- `path` contains an unknown substitution token → `MockConfigInvalidPathError` (details: path, unknownToken, allowedTokens).

**Lifecycle**:
1. Authored by developer. No UI.
2. Loaded once when `MockAgentRunner` instantiates (at `orchestrator.run()` time).
3. Held in memory for the duration of the run. Mid-run edits have no effect (D7).

**Gitignore**: `.dex/mock-config.json` (spec FR-016).

---

## 3. `AgentRunner` contract — in-memory shapes

```typescript
// src/core/agent/AgentRunner.ts

/** Context passed to runStage. Everything a runner needs to do one stage. */
export interface StageContext {
  config: RunConfig;             // the run's config — model, cwd, maxTurns, projectDir, etc.
  prompt: string;                // fully-assembled prompt (unchanged from today's orchestrator prep)
  runId: string;
  cycleNumber: number;           // 0 for non-loop stages
  stage: LoopStageType;
  specDir: string | null;
  phaseTraceId: string;
  outputFormat?: {               // when the stage expects JSON-schema-constrained output
    type: "json_schema";
    schema: Record<string, unknown>;
  };
  abortController?: AbortController;
  /** Event emitter callback supplied by orchestrator. */
  emit: (event: OrchestratorEvent) => void;
  /** Structured logger supplied by orchestrator. */
  rlog: RunLogger;
}

export interface StageResult {
  cost: number;                  // USD — 0 for mock
  durationMs: number;
  /** Present iff outputFormat was supplied. */
  structuredOutput: Record<string, unknown> | null;
  /** Last assistant text, if any (used by a few stages for debug). */
  rawText?: string;
  sessionId: string | null;      // SDK session for real runner; null for mock
}

/** Context passed to runPhase. For phases that wrap multi-stage skill invocations. */
export interface PhaseContext {
  config: RunConfig;
  prompt: string;
  runId: string;
  phase: { number: number; name: string };
  phaseTraceId: string;
  specDir: string | null;
  abortController?: AbortController;
  emit: (event: OrchestratorEvent) => void;
  rlog: RunLogger;
}

export interface PhaseResult {
  cost: number;
  durationMs: number;
  sessionId: string | null;
}

export interface AgentRunner {
  runStage(ctx: StageContext): Promise<StageResult>;
  runPhase(ctx: PhaseContext): Promise<PhaseResult>;
}

export type AgentRunnerFactory = (
  config: RunConfig,
  projectDir: string,
) => AgentRunner;
```

**Invariants**:
- Runners MUST emit `stage_started` before producing side effects and `stage_completed` when finished, carrying `costUsd` and `durationMs` (real runner emits today; mock replicates the shape).
- Runners MUST NOT write to the runs ledger (`runs.startPhase` / `runs.completePhase`) — orchestrator owns that.
- Runners MUST NOT mutate `state.json` — orchestrator owns that.
- Runners MAY write arbitrary files under `config.projectDir` (that's the point for the real runner; the mock mimics it).
- A runner's `runStage(ctx)` MUST return a `StageResult.structuredOutput` that is non-null iff `ctx.outputFormat` was supplied.

---

## 4. Stages that require structured output

These stages pass `outputFormat` to the runner today. The mock script MUST supply `structured_output` for each (spec FR-008). Values echoed verbatim; schemas listed here only for reference — validation is owned by the orchestrator (D10).

| Stage | Schema source | Expected shape |
|---|---|---|
| `gap_analysis` | `GAP_ANALYSIS_SCHEMA` (`src/core/schemas.ts`) | `{ decision: "RESUME_FEATURE" \| "REPLAN_FEATURE" \| "NEXT_FEATURE" \| "GAPS_COMPLETE", reason: string }` |
| `verify` | `VERIFY_SCHEMA` | `{ ok: boolean, issues: string[] }` |
| `clarification_synthesis` | *(not structured — prose output; the stage writes files not JSON)* | — |
| `manifest_extraction` | `MANIFEST_SCHEMA` | Full feature manifest (see `src/core/schemas.ts`); typically the mock uses `writes` to drop the fixture file directly instead of `structured_output`, matching the brief's canonical table. |

**Note**: `clarification_synthesis` and `manifest_extraction` in the orchestrator today *do* consume structured output for some code paths. The brief's canonical table resolves this pragmatically by having the mock write the fixture file directly (both stages' primary output is a file). If a future orchestrator change routes these stages through structured output only, the mock-config gets a `structured_output` key and the fixture files go away — non-breaking change.

---

## 5. Error hierarchy

All errors below inherit from the existing `OrchestratorError` (or `Error` if simpler). Names listed so messages are greppable in `.dex/runs/<runId>.json` and `~/.dex/logs/...`.

```typescript
// src/core/dexConfig.ts
export class DexConfigParseError      extends Error { /* JSON parse error in dex-config.json */ }
export class DexConfigInvalidError    extends Error { /* Schema violation in dex-config.json */ }

// src/core/agent/registry.ts
export class UnknownAgentError        extends Error { /* agent name not in AGENT_REGISTRY */ }

// src/core/agent/MockConfig.ts
export class MockConfigParseError     extends Error { /* JSON parse error in mock-config.json */ }
export class MockConfigInvalidError   extends Error { /* Schema violation */ }

// src/core/agent/MockAgentRunner.ts
export class MockDisabledError        extends Error { /* mock selected but enabled: false */ }
export class MockConfigMissingEntryError extends Error {
  phase: string; stage: string; cycleNumber?: number; featureId?: string;
}
export class MockFixtureMissingError  extends Error { resolvedPath: string; }
export class MockConfigInvalidPathError extends Error {
  path: string; unknownToken: string; allowedTokens: readonly string[];
}
```

Every error's message format: `"<ClassName>: <human message>. <structured details>"`. Example:
```
MockConfigMissingEntryError: no script entry for phase=dex_loop, stage=implement, cycle=2, feature=f-001.
Available cycles in script: 1, 2 (stage keys in cycle 2: gap_analysis, specify, plan, tasks). Update .dex/mock-config.json.
```

---

## 6. Entity relationships

```mermaid
graph LR
  DexConfig -- selects --> AgentRunner
  AgentRunner -.registered via.-> Registry[AGENT_REGISTRY]
  AgentRunner <|-- ClaudeAgentRunner
  AgentRunner <|-- MockAgentRunner
  MockAgentRunner -- reads --> MockConfig
  MockConfig -- cycles[] --> CycleEntry
  CycleEntry -- stages --> StepDescriptor
  StepDescriptor -- writes[] --> WriteSpec
  WriteSpec -- from --> FixtureFile[fixtures/mock-run/*]
  Orchestrator -- runStage(ctx) --> AgentRunner
  Orchestrator -- runPhase(ctx) --> AgentRunner
  AgentRunner -- emits --> OrchestratorEvent
```

---

## 7. State transitions

**Agent backend selection, per run**:

```
START
  │
  ├─ RunConfig.agent set? ─── yes ──→ use RunConfig.agent
  │        │ no
  │        ▼
  ├─ loadDexConfig(projectDir) → { agent } ──→ use agent from file
  │        │ (file absent)
  │        ▼
  └─ default "claude"
     │
     ▼
  createAgentRunner(name, runConfig, projectDir)
     │
     ├─ name in registry? ── no ──→ throw UnknownAgentError
     │        │ yes
     │        ▼
     └─ factory(runConfig, projectDir) → AgentRunner instance
         │
         │ (if name === "mock")
         ▼
     MockAgentRunner ctor
         │
         ├─ loadMockConfig(projectDir) ── parse/invalid ──→ throw MockConfig*Error
         │        │ ok
         │        ▼
         ├─ enabled === true? ── no ──→ throw MockDisabledError
         │        │ yes
         │        ▼
         └─ ready — held until run ends
```

**Mock stage execution**:

```
ctx arrives
  │
  ├─ resolve phase from ctx.stage (map in MockAgentRunner)
  │
  ├─ look up descriptor:
  │     phase === dex_loop → config.dex_loop.cycles[ctx.cycleNumber - 1].stages[ctx.stage]
  │     else                → config[phase][ctx.stage]
  │
  ├─ missing? ── throw MockConfigMissingEntryError
  │        │ found
  │        ▼
  ├─ emit stage_started
  ├─ emit one agent_step (type "mock_stage")
  ├─ sleep(descriptor.delay)
  ├─ execute writes[] → may throw MockFixtureMissingError / MockConfigInvalidPathError
  ├─ execute appends[]
  ├─ emit stage_completed (costUsd: 0, durationMs)
  │
  └─ return StageResult (structuredOutput = descriptor.structured_output ?? null)
```

---

## 8. What does NOT change

- `.dex/state.json` schema (unchanged from 002/003/008).
- `.dex/feature-manifest.json` schema (unchanged from 003).
- `.dex/learnings.md` format (unchanged).
- `.dex/runs/<runId>.json` / `RunRecord` shape (unchanged from 007).
- `OrchestratorEvent` union (unchanged — mock uses the existing `agent_step` shape).
- `STAGE_ORDER`, `checkpointTagFor`, `commitCheckpoint` — all unchanged.

This feature is an additive refactor + additive config surface. Zero schema migrations.
