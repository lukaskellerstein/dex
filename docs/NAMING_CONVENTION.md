# Naming Convention

The canonical vocabulary for the Dex orchestrator process. Every layer of the codebase uses these names — code, IPC, events, JSON storage, on-disk logs, UI labels, and conversation. When you write new code or docs, follow this convention.

## The 5-level hierarchy

```
Phase           4 user-facing buckets: Prerequisites · Clarification · Dex Loop · Completion
└── Cycle              iteration N (only inside the Dex Loop phase)
    └── Step                   unit of process work; kind: "script" | "agent" | "interactive"
        └── AgentRun                  one agent invocation (only when step.kind === "agent")
            └── AgentStep                    one tool call / text output inside an agent run
```

Read out loud:

> The process has **phases**. Inside each phase are **steps**. Inside the **Dex Loop** phase, steps are grouped into **cycles**. Each step is either **deterministic** code or it spawns an **agent run**, which emits a stream of **agent steps**.

## Phase — top-level bucket

One of exactly four user-facing groupings of work the orchestrator goes through, in order:

| Phase | Purpose |
|---|---|
| `prerequisites` | Environment checks (CLI versions, git init, GitHub repo). May pause for user input. |
| `clarification` | Multi-domain Q&A about the goal — produces `GOAL_clarified.md`, constitution, feature manifest. |
| `loop` | The autonomous build loop — repeats one cycle per feature. |
| `completion` | Post-run summary screen. UI-derived, not a real orchestrator phase. |

**TS type**: `type Phase = "prerequisites" | "clarification" | "loop" | "completion"` (`src/core/types.ts`).

**Where it lives**: `state.currentPhase` (`src/core/state.ts`).

**UI labels** (capitalized): "Prerequisites", "Clarification", "Dex Loop", "Completion".

## Cycle — Dex Loop iteration

One iteration of the Dex Loop phase. Each cycle works on one feature from start to finish. Cycles are numbered: Cycle 1, Cycle 2, …

**TS type**: `interface Cycle { cycleNumber: number; steps: Step[]; ... }` (`src/core/types.ts`).

Cycles only exist inside the Dex Loop phase. Prerequisites, Clarification, and Completion phases have no cycles. Don't introduce "cycle" outside the Dex Loop phase.

## Step — unit of process work

One named unit of work in the orchestrator pipeline. Every step has a `type` (which work it does) and a `kind` (how it executes).

**TS types**: `interface Step { type: StepType; kind: StepKind; ... }` (`src/core/types.ts`).

### Step kinds

| Kind | Meaning | Creates an AgentRun? |
|---|---|---|
| `script` | Pure TS/JS, no LLM call, no user wait. Runs and returns. | Never |
| `agent` | Spawns an agent via the Claude SDK `query()`. Emits a stream of agent steps. | Always (one per attempt; retries create additional runs) |
| `interactive` | Script-style code that pauses for user input via `waitForUserInput()`. | Never |

The kind is fixed per step type — see `STEP_KIND_MAP` in `src/core/types.ts`. When designing a new step, decide its kind first — it determines whether the step needs an AgentRun and what audit-trail records get written.

### Step types

The full list of `StepType` values, in execution order, with their kinds:

| Step type | Kind | What it does |
|---|---|---|
| `prerequisites` | `interactive` | Env checks, install prompts |
| `create_branch` | `script` | Create the orchestrator branch |
| `clarification_product` | `agent` | Generates `GOAL_product_domain.md` |
| `clarification_technical` | `agent` | Generates `GOAL_technical_domain.md` |
| `clarification_synthesis` | `agent` | Generates `GOAL_clarified.md` (structured output) |
| `constitution` | `agent` | Generates `.specify/memory/constitution.md` |
| `manifest_extraction` | `agent` | Extracts MVP features (structured output, 2-attempt retry) |
| `gap_analysis` | `script` | Walks `feature-manifest.json`, returns next-decision enum |
| `specify` | `agent` | Generates the spec dir for the chosen feature |
| `plan` | `agent` | Writes the feature's plan |
| `tasks` | `agent` | Writes the feature's `tasks.md` |
| `implement` | `agent` | Runs implementation per tasks.md phase |
| `implement_fix` | `agent` | Reverify-loop fix iteration (only after a failed `verify`) |
| `verify` | `agent` | Runs build/tests, returns pass/fail summary (structured output) |
| `learnings` | `agent` | Appends category-tagged insights to `learnings.md` (structured output) |
| `commit` | `script` | Creates the checkpoint git commit + tag |

The `clarification` symbol exists in the `StepType` union as an umbrella label used by `STEP_ORDER` for sequencing — actual work is done by the three `clarification_*` sub-steps.

## AgentRun — one agent invocation

One end-to-end invocation of an agent for a step that has `kind === "agent"`. Has a unique `agentRunId` (UUID), a status, cost, duration, and a parent step.

**TS type**: `interface AgentRunRecord { agentRunId: string; step: StepType | null; cycleNumber: number | null; ... }` (`src/core/runs.ts`).

A single step can have multiple agent runs — for example, when the orchestrator retries `manifest_extraction` after a structured-output validation failure, each attempt is its own AgentRun.

## AgentStep — one event inside an agent run

The leaf node — one event from an agent's execution stream. Each agent run emits many agent steps.

**TS type**: `interface AgentStep { id: string; type: AgentStepType; ... }` (`src/core/types.ts`).

`AgentStepType` enumerates the kinds of events an agent emits: `text`, `tool_call`, `tool_result`, `tool_error`, `thinking`, `skill_invoke`, `subagent_spawn`, `completed`, `error`, etc.

Persisted as one JSON object per line in `~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl`.

## TaskPhase — spec-kit tasks.md phase

Distinct from the macro `Phase` — `TaskPhase` is one phase parsed from a feature's `tasks.md` file (the spec-kit format). The `implement` step iterates over a feature's TaskPhases, running one agent per TaskPhase.

**TS type**: `interface TaskPhase { number: number; name: string; tasks: Task[]; ... }` (`src/core/types.ts`).

When you mean "a spec-kit tasks.md phase," always say `TaskPhase` — never abbreviate to `Phase` (which is reserved for the 4 macro buckets).

The `taskPhaseNumber` and `taskPhaseName` fields on `AgentRunRecord` identify which TaskPhase an AgentRun was working on (or `0` / `loop:<step>` for non-implement steps).

## Style rules for new code

- **Use the canonical vocabulary** in code, comments, commit messages, docs, and conversation. When in doubt, prefer the more specific name (`TaskPhase` over `Phase`, `AgentRun` over generic "run").
- **Be specific.** Say `TaskPhase` when you mean a tasks.md phase, `Phase` when you mean a macro bucket, `Step` when you mean a unit of process work, `AgentStep` when you mean an event inside an agent run. Don't shorten to "phase" or "step" in ambiguous contexts.
- **Step kind first, type second.** When adding a new step, decide the `kind` (script/agent/interactive) before the `type` — it determines whether the step needs an AgentRun and how its audit trail is recorded.
- **Cycle is loop-only.** Don't introduce "cycle" outside the Dex Loop phase.
- **`agentRunId` is the correlation ID.** Anywhere you'd want to identify a specific agent invocation — events, logs, JSON records, IPC payloads — use `agentRunId`. Don't invent new ID names.
- **Event naming**: orchestrator events that fire when a step starts/completes are `step_started` / `step_completed`. Events for tasks.md phases inside the implement step are `task_phase_started` / `task_phase_completed`. Events for agent stream output are `agent_step` (with field `agentStep: AgentStep`).
