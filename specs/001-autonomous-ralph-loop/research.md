# Research: Autonomous Ralph Loop

**Feature**: 001-autonomous-ralph-loop | **Date**: 2026-04-15

## R1: How to Handle Interactive Clarification (Phase A)

**Decision**: Phase A clarification runs as a single `query()` call where the agent uses the `AskUserQuestion` tool (built into the SDK) to conduct multi-turn Q&A with the user. The orchestrator streams events normally; the SDK handles the user-input loop internally.

**Rationale**: The `query()` API supports multi-turn interaction via built-in tools like `AskUserQuestion`. The agent receives the tool, asks a question, the SDK pauses for user input, and resumes. This means the clarification session is a single long-running `query()` call — not multiple calls. The orchestrator doesn't need custom Q&A infrastructure; it just needs to forward the question/answer events to the renderer via `emit()`.

**Alternatives considered**:
- *Custom event loop*: Orchestrator breaks clarification into multiple `query()` calls, passing accumulated context each time. Rejected: reinvents what the SDK already does, loses conversational continuity, and violates the principle of trusting SDK capabilities.
- *Pre-built form UI*: Renderer collects all answers upfront via a form. Rejected: can't adapt questions based on previous answers (the whole point of interactive clarification).

**How this affects implementation**: The `runClarification()` function is simpler than expected — one `query()` call with a comprehensive prompt. The complexity shifts to prompt engineering (ensuring the agent asks the right questions and writes `full_plan.md` when done). The IPC layer needs to support forwarding `AskUserQuestion` tool calls to the renderer and returning user responses.

**Open question**: The SDK's `AskUserQuestion` tool may require `permissionMode` to allow it. Need to verify during implementation. If it doesn't work with `bypassPermissions`, we'll use `approved` mode or handle it via a PreToolUse hook that captures the question and emits it to the UI.

## R2: Spec-Kit Command Invocation Pattern

**Decision**: Each loop stage invokes spec-kit commands by constructing a prompt string that starts with the slash command (e.g., `/speckit-specify`, `/speckit-plan`). This is the same pattern used by the existing `buildPrompt()` function.

**Rationale**: The existing orchestrator already does this — `buildPrompt()` returns `"/speckit-plan {path} --phase {n}"` or `"/speckit-implement {path} --phase {n}"`. The SDK treats the prompt as if the user typed it, triggering the skill. This is proven, battle-tested infrastructure.

**Key constraints discovered**:
- Skills have `disable-model-invocation: true` — they MUST be invoked as the initial prompt (user-invoked), not by the model during execution.
- `/speckit-specify` is create-only — never re-run on an existing spec directory.
- `/speckit-plan` and `/speckit-tasks` overwrite existing files — safe for re-planning (`REPLAN_FEATURE`).
- `/speckit-implement` expects `tasks.md` to exist — `check-prerequisites.sh --require-tasks` verifies this.

**Alternatives considered**:
- *Direct script execution*: Call the bash scripts directly instead of going through the SDK. Rejected: loses all the agent intelligence (reading context, making decisions, handling edge cases). The scripts are just setup helpers; the agent does the real work.

## R3: State Persistence Between Loop Stages

**Decision**: All state between stages is persisted on disk (spec-kit artifacts) and in SQLite (run metadata, loop cycles). No in-memory state crosses `query()` boundaries.

**Rationale**: This is mandated by Constitution Principle I (Clean-Context Orchestration). Each `query()` call starts fresh. The agent reads its context from:
- `.specify/full_plan.md` — what to build (read-only)
- `.specify/memory/constitution.md` — project constraints
- `specs/NNN-feature/` — feature-specific artifacts (spec.md, plan.md, tasks.md)
- `.claude/rules/learnings.md` — operational knowledge from previous cycles (auto-loaded via `settingSources: ["project"]`)

The orchestrator tracks loop state (current cycle, failure counts, cumulative cost) in memory during the run, but also persists to SQLite for crash recovery.

**Alternatives considered**:
- *Session continuity*: Use `session_id` from the SDK to resume conversations. Rejected: defeats the purpose of clean context per stage.

## R4: Gap Analysis Result Parsing

**Decision**: The gap analysis prompt instructs the agent to output exactly one of four structured lines. The orchestrator extracts this from the `result` message's text content using regex matching.

**Rationale**: The `query()` result message includes a `result` field (string) with the agent's final output. A simple regex pattern can extract the decision:

```
/^(NEXT_FEATURE|RESUME_FEATURE|REPLAN_FEATURE|GAPS_COMPLETE)(?::\s*(.+))?$/m
```

For `NEXT_FEATURE`, the capture group contains `{name} | {description}`. For `RESUME_FEATURE`/`REPLAN_FEATURE`, it contains `{specDir}`.

**Alternatives considered**:
- *Structured JSON output*: Instruct the agent to output JSON. Rejected: more brittle (agent may wrap in markdown code blocks), harder to debug, and the four-variant format is simple enough for regex.
- *Tool-based output*: Create a custom tool for the agent to call with the decision. Rejected: over-engineered for a single structured output.

## R5: Failure Tracking and Degenerate Case Recovery

**Decision**: Track consecutive failures per spec directory using an in-memory `Map<string, { implFailures: number, replanFailures: number }>`. Persist to SQLite `failure_tracker` table for crash recovery. Reset counters on successful completion of a stage.

**Rationale**: The failure tracking is simple state: increment on failure, reset on success, threshold check before each cycle. In-memory map is sufficient for the running loop; SQLite backup handles the crash-recovery edge case (FR-009, FR-010).

**Thresholds**: 3 consecutive implementation failures → force `REPLAN_FEATURE`. 3 consecutive re-plan failures → skip feature, log to `learnings.md`.

**Alternatives considered**:
- *Exponential backoff*: Wait longer between retries. Rejected: the agent either succeeds or the problem is structural. Waiting doesn't help.
- *Feature quarantine file*: Write skipped features to a file. Rejected: `learnings.md` already serves this purpose and is auto-loaded by the SDK.

## R6: Clarification-to-FullPlan Output Format

**Decision**: `full_plan.md` follows a structured markdown format covering all completeness checklist items. Written by the clarification agent at the end of Phase A.

**Rationale**: The file must be parseable by the gap analysis agent (a separate `query()` call with no memory of the clarification session). A structured format with clear section headers makes this reliable. The completeness checklist (FR-004) maps to required sections:
- User stories with acceptance criteria per major feature
- Technology stack with versions
- Build/test/dev commands
- Deployment target
- Testing strategy
- Data model overview

**Alternatives considered**:
- *JSON schema*: Machine-parseable but harder for agents to generate and read naturally. Rejected.
- *Free-form prose*: Flexible but makes gap analysis unreliable. Rejected.

## R7: Budget Tracking Across Stages

**Decision**: Accumulate `total_cost_usd` from each `query()` result message. Check against `maxBudgetUsd` after each stage completes. Terminate gracefully if exceeded.

**Rationale**: The SDK provides `total_cost_usd` in the result message (authoritative, not estimated). The orchestrator already tracks this per-phase. For the loop, we sum across all stages in all cycles. The check happens between stages (not mid-stage) because aborting mid-stage wastes the work already done.

**Key finding**: `estimateCost()` is used for real-time UI updates during a stage, but the authoritative cost from `message.type === "result"` overwrites it at stage completion. This dual tracking already exists and works.

## R8: UI Architecture for Loop Mode

**Decision**: Add a mode selector to the existing overview view. Loop mode replaces the spec-card grid with a description input + budget controls. During Phase A, a chat-like panel shows the Q&A. During Phase B, the existing task board and agent trace views are reused, with a loop progress indicator in the topbar.

**Rationale**: Maximize reuse of existing UI components. The task board already shows phases/tasks; the agent trace already shows steps. The only new UI surfaces are: mode selector, description input, clarification panel, and loop progress indicator.

**Alternatives considered**:
- *Separate app view*: Completely different UI for loop mode. Rejected: unnecessary duplication, and the existing views already show the right information.

## R9: `runStage()` vs `runPhase()` Separation

**Decision**: Create a new `runStage()` function for loop stages. It's a lighter wrapper around `query()` than `runPhase()` — no `RunTaskState` tracking, no TodoWrite detection, but same hooks for step capture and event emission. `runPhase()` is used only for the implement stage (which needs task tracking).

**Rationale**: Most loop stages (gap analysis, specify, plan, tasks, verify, learnings) don't need the task-tracking machinery of `runPhase()`. They're single-shot operations that produce a result. The implement stage reuses `runPhase()` because it does need TodoWrite detection and incremental task updates.

**Alternatives considered**:
- *Reuse `runPhase()` for everything*: Pass a flag to disable task tracking. Rejected: muddies the function's responsibility. `runPhase()` is already 200+ lines; making it more conditional makes it harder to reason about.
- *Inline `query()` calls*: No wrapper function. Rejected: too much duplication of hook setup, event emission, cost tracking, and abort checking.
