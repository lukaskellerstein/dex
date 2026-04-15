# Ralph-Claude: Comparison & Improvement Plan

## 1. Architecture Comparison

| Aspect | Original Ralph Wiggum | Our Implementation (Ralph-Claude) |
|--------|----------------------|-----------------------------------|
| **Runtime** | Bash loop: `while :; do cat PROMPT.md \| claude-code ; done` | Electron app + Claude Agent SDK `query()` |
| **Context isolation** | Fresh CLI process each loop iteration | Fresh `query()` call per phase (same effect) |
| **Execution unit** | 1 task per loop (Ralph picks the most important) | 1 phase per `query()` call (all tasks in that phase) |
| **Planning** | Separate PLANNING mode prompt (generates/updates `IMPLEMENTATION_PLAN.md`) | No planning mode -- jumps straight to implementation |
| **Task tracking** | `IMPLEMENTATION_PLAN.md` / `fix_plan.md` (bullet list, Ralph updates it) | `tasks.md` (spec-kit format, tracked via TodoWrite + disk reconciliation) |
| **Self-improvement** | Ralph updates `AGENTS.md` with operational learnings each loop | None -- `.claude/CLAUDE.md` is static, no learnings file |
| **Backpressure** | Tests + typecheck after each task; 1 subagent for validation | `validator.ts` exists but not deeply wired into the loop |
| **Subagent control** | Explicit parallelism caps ("up to 500 for search, 1 for build") | No parallelism control -- delegated to SDK defaults |
| **Loop-back** | Automatic -- bash loop restarts with fresh context | No loop-back -- phases run sequentially, stop on completion |
| **"Signs" system** | Guardrails embedded in prompts (numbered 999...N for priority) | Prompt construction via `buildPrompt()` -- less structured |
| **UI** | None -- watch `fix_plan.md` and git log | Full 3-column desktop app (sidebar, task board, agent trace) |
| **Persistence** | Git commits only | SQLite (runs, phases, steps, subagents) + git |
| **Cost tracking** | None | Per-phase cost/duration, aggregated in PR |

## 2. Gaps (What Ralph Has That We Lack)

### G1: No Planning Mode
Ralph has two distinct prompts -- PLANNING and BUILDING. Planning mode does gap analysis (specs vs code) and generates/updates the implementation plan. We skip this entirely: we assume `tasks.md` is already correct and jump to implementation. Spec-kit provides the commands for this (`/speckit.plan`, `/speckit.tasks`) but we don't orchestrate them. Note: `/speckit.specify` is create-only (new numbered dir each time) so re-planning must use `/speckit.plan` + `/speckit.tasks` which overwrite existing artifacts from the current spec.md.

**Impact:** If tasks.md is wrong or stale, we execute a bad plan. Ralph regenerates the plan frequently ("throw it out often").

### G2: No Continuous Loop / Self-Correction
Ralph's core insight: `while :; do ... ; done`. Each iteration gets fresh context, picks the next most important thing, and self-corrects from the previous iteration's mistakes. Our orchestrator runs phases linearly and stops.

**Impact:** If a phase partially fails or leaves issues, we don't automatically retry or course-correct. Ralph's "eventual consistency through iteration" is lost.

### G3: No Self-Improvement (.claude/rules/learnings.md Pattern)
Ralph updates `AGENTS.md` with operational learnings -- build commands that work, compiler quirks discovered, debugging techniques. This knowledge persists across loop iterations. We have `.claude/CLAUDE.md` + `.claude/rules/` but agents don't update them during execution.

**Impact:** Each phase starts from scratch knowledge-wise. Learnings from phase 1 (e.g., "this project uses pnpm not npm") are lost in phase 2's context.

### G4: No "Don't Assume Not Implemented" Guard
Ralph's biggest guardrail: before implementing anything, search the codebase with subagents to verify it doesn't already exist. This prevents duplicate implementations from non-deterministic `ripgrep` results.

**Impact:** Our agents may reimplement existing code, especially in later phases where earlier phases already created the foundation.

### G5: No Backpressure Loop
Ralph mandates: implement, then immediately run tests/typecheck for that unit. If it fails, fix in the same loop. Our `validator.ts` runs typecheck but isn't tightly integrated into the per-task flow.

**Impact:** Broken code can accumulate across tasks within a phase before being caught.

### G6: No Subagent Parallelism Control
Ralph explicitly controls: "500 subagents for file search, 1 for build/test." This prevents resource contention on build artifacts while maximizing search parallelism. We delegate subagent behavior entirely to the SDK.

**Impact:** Potential build contention if multiple subagents try to compile simultaneously.

### G7: No Plan Disposal / Regeneration
Ralph's operator can "throw out the plan" and run a planning loop to regenerate it from current code state. We have no mechanism to regenerate tasks.md from inside the app.

**Impact:** If implementation diverges from the plan, the operator must manually fix tasks.md.

### G8: No "Signs" Prompt Architecture
Ralph uses a structured prompt with numbered guardrails (999...N), orient phase (0a, 0b, 0c), and specific language patterns ("study", "ultrathink", "capture the why"). Our `buildPrompt()` is simpler and less battle-tested.

**Impact:** Less deterministic agent behavior, more "AI slop" outcomes.

### G9: No Interactive Clarification Phase
Ralph assumes the operator provides correct specs upfront. But users often start with a vague description. There's no step to iterate on the plan with the user, identify missing information, and produce a complete specification before autonomous execution begins.

**Impact:** The loop starts with an incomplete understanding, leading to wasted cycles on wrong assumptions.

### G10: No Post-Implementation Verification Beyond Unit Tests
Ralph relies on build/typecheck backpressure. Neither Ralph nor our implementation does functional verification -- e.g., opening a webapp in a browser and testing user flows end-to-end.

**Impact:** Code compiles and unit tests pass, but the feature may not actually work in the real application.

## 3. Advantages We Have Over Ralph

### A1: Real-Time Streaming UI
Full desktop app with live agent trace, task board with progress, phase timeline, GSAP animations. Ralph's operator stares at terminal output and `git log`.

### A2: Structured Execution History
SQLite persistence with runs, phases, steps, subagents. Enables replay, analysis, cost tracking, and crash recovery. Ralph has only git history.

### A3: Spec-Kit Integration (Phased Execution)
Phases are structured with numbered tasks, user story tags, priority markers. More granular than Ralph's "pick one thing" approach. Enables progress visualization and phase-level cost attribution.

### A4: Programmatic SDK Integration
Direct `query()` API with typed hooks vs bash pipe. Gives us abort control, session management, hook-based step capture, and error handling that bash can't provide.

### A5: State Management & Recovery
HMR-safe state via `getRunState()`, orphaned run cleanup, two-path task tracking (TodoWrite + disk reconciliation). Ralph crashes = `git reset --hard` and restart.

### A6: Git Automation with Metrics
Automated branch creation (`ralph/{plan|build}/{date}-{id}`), PR generation with cost/duration/phase metrics. Ralph commits but doesn't automate PRs with analytics.

### A7: Abort / Graceful Stop
`AbortController` integration for stopping a running agent mid-phase. Ralph's loop must be killed externally.

### A8: Multi-Spec Support
Can discover and orchestrate multiple spec directories in a single run. Ralph operates on one spec set at a time.

## 4. Target Architecture: The Ralph Wiggum Loop

### Overview

The user provides a high-level description (prompt text or a document). The system runs in two phases:

**Phase A — Interactive Clarification** (human-in-the-loop):
A thorough interactive session with the user to fully understand the project. The agent iterates on the description — asking questions, identifying gaps, surfacing opportunities, and polishing the plan until it has EVERYTHING needed for autonomous execution. The goal: the loop should run for hours/days without needing ANY user input.

The clarification covers:
- **Requirements**: What exactly to build, user stories, acceptance criteria, edge cases
- **Technology**: Languages, frameworks, libraries, databases — specific versions if relevant
- **Infrastructure**: Deployment target (cloud, on-prem, local), CI/CD, containerization
- **Credentials**: API keys, service accounts, OAuth configs — what's needed and where to get them
- **Testing strategy**: Unit tests, integration tests, e2e tests, browser-based testing, performance criteria
- **Architecture**: Monolith vs microservices, data model, API design, file structure
- **Non-functional**: Performance targets, security requirements, accessibility, i18n
- **Dependencies**: External services, third-party APIs, existing systems to integrate with

Output: a comprehensive `.specify/full_plan.md` — the single source of truth for the autonomous loop.

**Phase B — Autonomous Ralph Loop** (no user input):
Each cycle is one feature, fully isolated:
1. **Gap Analysis** (separate `query()`) — study `full_plan.md` + existing code/specs → decide what feature to build next, or declare `GAPS_COMPLETE`
2. **Specify** (separate `query()`) — run `/speckit.specify` to create a new spec dir
3. **Plan** (separate `query()`) — run `/speckit.plan` to generate plan.md
4. **Tasks** (separate `query()`) — run `/speckit.tasks` to generate tasks.md
5. **Implement** (separate `query()` per phase) — run `/speckit.implement` per phase (existing behavior)
6. **Verify** (separate `query()`) — run build, tests, and functional validation (browser-based e2e via MCP tools for web projects)
7. **Learnings** (separate `query()`) — update `.claude/rules/learnings.md`
8. Loop back to step 1

Terminates when: no gaps found, budget exhausted, or max loop cycles reached.

### Key Design Decisions

- **Separate `query()` per command**: Each spec-kit command and each stage gets its own fresh context window. Matches Ralph's philosophy: clean context per unit of work. Prevents context bloat.
- **LLM decides autonomously** what to build next (gap analysis). Full trust in the model's prioritization.
- **`/speckit.clarify` is skipped** during the autonomous loop — all clarification happens upfront in Phase A.
- **Spec-kit idempotency constraints respected**: `/speckit.specify` is create-only (never re-run on existing spec). Re-planning uses `/speckit.plan` + `/speckit.tasks`.
- **Backpressure is project-agnostic**: Works with any tech stack. The testing strategy (build commands, test runners, e2e approach) is declared in `full_plan.md` during clarification.
- **Verification includes browser testing**: For web projects, the verify stage uses chrome-devtools-mcp or playwright MCP to open the app, navigate user flows, take screenshots, and verify functionality visually — not just unit tests.
- **Self-improvement via `.claude/rules/learnings.md`**: Referenced from `.claude/CLAUDE.md`, automatically loaded by `settingSources: ["project"]` on every subsequent `query()` call.
- **Backward compatible**: Existing "build" mode (implement existing specs) remains unchanged.

### Implementation Steps

#### Step 1: Extract `runBuild()` from `run()` (pure refactor)
Move the existing spec-loop + phase-loop code into a new `runBuild()` function. `run()` calls it for modes `"plan"` and `"build"`. Zero behavior change.

#### Step 2: Add new types
- `RunConfig.mode`: add `"loop"` alongside `"plan" | "build"`
- New fields: `description?`, `descriptionFile?`, `fullPlanPath?`, `maxLoopCycles?`, `maxBudgetUsd?`
- New types: `LoopStage`, `ClarificationQuestion`
- New events: `clarification_started/question/completed`, `loop_cycle_started/completed`, `stage_started/completed`, `loop_terminated`

#### Step 3: Add `runStage()` function
Lightweight `query()` wrapper for single-shot stages (gap analysis, specify, plan, tasks, verify, learnings). Similar to `runPhase()` but without RunTaskState. Captures and returns result text output.

#### Step 4: Add prompt builders (`src/core/prompts.ts`)
New file with all prompt construction:
- `buildClarificationPrompt(description)` — thorough user interview via `AskUserQuestion`
- `buildGapAnalysisPrompt(config, fullPlanPath, completedSpecs)` — gap analysis against full_plan.md
- `buildSpecifyPrompt(config, featureName, featureDescription)` — wraps `/speckit.specify`
- `buildPlanPrompt(config, specPath)` — wraps `/speckit.plan`
- `buildTasksPrompt(config, specPath)` — wraps `/speckit.tasks`
- `buildVerifyPrompt(config, specDir, fullPlanPath)` — build + tests + browser-based e2e
- `buildLearningsPrompt(config, specDir)` — update `.claude/rules/learnings.md`
- `buildImplementPrompt(config, phase)` — existing `buildPrompt()` with Ralph-style guardrails
- `parseGapAnalysisResult(output)` — extract feature or detect `GAPS_COMPLETE`
- `discoverNewSpecDir(projectDir, knownSpecs)` — find just-created spec dir

#### Step 5: Add `runLoop()` function
The main Ralph loop: clarification → [gap analysis → specify → plan → tasks → implement → verify → learnings → loop]. Wired into `run()` when `mode === "loop"`.

#### Step 6: Update `git.ts`
Handle `"loop"` mode in branch names (`ralph/loop/{date}-{id}`) and PR titles.

#### Step 7: Update UI
- Mode selector (Build / Loop) in App.tsx
- Description input (textarea or file path) for loop mode
- `ClarificationPanel.tsx` — chat-like Q&A interface for Phase A
- Cycle/stage indicators in Topbar during Phase B
- Hook state: `currentCycle`, `currentStage`, `isClarifying`, `loopMode`

#### Step 8: Add guardrails to prompts ("Signs" architecture)
Ralph-style prompt structure for the implement stage:
```
0a. Study the spec at {specPath}/spec.md
0b. Study the existing codebase
0c. Study {specPath}/tasks.md
0d. Study .specify/full_plan.md for testing strategy and project conventions

1. Before making changes, search the codebase using subagents — don't assume not implemented.
2. After implementing each task, run the project's build/test commands. Use only 1 subagent for validation.

999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS.
9999. After completing EACH task, immediately mark it [x] in tasks.md.
99999. Capture the "why" in test documentation — future loops won't have this context.
```

Verify stage prompt:
```
1. Read .specify/full_plan.md for testing strategy.
2. Run project build command. Fix failures.
3. Run unit/integration tests. Fix failures.
4. For web apps: use chrome-devtools-mcp or playwright MCP to open the app, walk user flows, take screenshots, verify UI.
5. For APIs: hit key endpoints with curl/test scripts, verify responses.
6. Report: what was tested, what passed, what was fixed.

999. DO NOT skip verification.
9999. If you cannot fix a failure, document it in .claude/rules/learnings.md.
```

## 5. Priority Matrix

| Item | Impact | Effort | Priority |
|------|--------|--------|----------|
| Step 1: Extract runBuild() | Foundation | Low | **P0** |
| Step 2: Add types | Foundation | Low | **P0** |
| Step 8: Guardrails in prompts | High | Low | **P0** |
| Step 3: runStage() function | Foundation | Medium | **P1** |
| Step 4: Prompt builders | High | Medium | **P1** |
| Step 5: runLoop() function | Critical | Medium | **P1** |
| Step 6: git.ts update | Low | Low | **P1** |
| Step 7: UI updates | High | High | **P2** |

## 6. Key Insight

The original Ralph Wiggum is philosophically about **eventual consistency through iteration** -- a dumb loop that self-corrects over time. Our implementation is architecturally superior (typed SDK, real-time UI, structured persistence) but philosophically incomplete: we run a single pass and stop.

Our enhanced approach goes beyond both:
1. **Interactive clarification** before the loop ensures the agent has complete context — something neither Ralph nor any other approach does well
2. **Functional verification** (browser-based e2e, not just unit tests) catches issues that compile-and-test backpressure misses
3. **Spec-kit integration** gives structured, reproducible planning instead of Ralph's free-form TODO list
4. **`full_plan.md` as single source of truth** eliminates the ambiguity that causes wasted cycles

The result: a system that can take a vague user description, clarify it into a complete plan, and autonomously build, verify, and iterate for hours/days without human intervention.
