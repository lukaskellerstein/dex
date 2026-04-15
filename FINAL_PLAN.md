# Ralph-Claude: Final Plan

## 1. Architecture Comparison

| Aspect | Original Ralph Wiggum | Our Implementation (Ralph-Claude) |
|--------|----------------------|-----------------------------------|
| **Runtime** | Bash loop: `while :; do cat PROMPT.md \| claude-code ; done` | Electron app + Claude Agent SDK `query()` |
| **Context isolation** | Fresh CLI process each loop iteration | Fresh `query()` call per stage (same effect) |
| **Execution unit** | 1 task per loop (Ralph picks the most important) | 1 feature per loop cycle (specify → plan → tasks → implement → verify) |
| **Planning** | Separate PLANNING mode prompt (generates/updates `IMPLEMENTATION_PLAN.md`) | Gap analysis stage decides: new feature, resume, or re-plan |
| **Task tracking** | `IMPLEMENTATION_PLAN.md` / `fix_plan.md` (bullet list, Ralph updates it) | `tasks.md` (spec-kit format, tracked via TodoWrite + disk reconciliation) |
| **Spec structure** | Free-form `specs/*.md` | Spec-kit templated: `spec.md` + `plan.md` + `tasks.md` + `research.md` + `data-model.md` + `contracts/` |
| **Self-improvement** | Ralph updates `AGENTS.md` with operational learnings each loop | `.claude/rules/learnings.md` — updated by learnings stage, auto-loaded by SDK via `settingSources: ["project"]` |
| **Backpressure** | Tests + typecheck after each task; 1 subagent for validation | Verify stage: build + tests + browser-based e2e. Per-task backpressure via prompt guardrails |
| **Subagent control** | Explicit parallelism caps ("up to 500 for search, 1 for build") | Explicit in prompts: 500 for search/reads, 1 for build/test, Opus for complex reasoning |
| **Loop-back** | Automatic — bash loop restarts with fresh context | Automatic — loop cycles with fresh `query()` per stage |
| **"Signs" system** | Guardrails embedded in prompts (numbered 999...N for priority) | Same pattern in `buildPrompt()` — orient phase (0a-0d), numbered guardrails |
| **UI** | None — watch `fix_plan.md` and git log | Full 3-column desktop app (sidebar, task board, agent trace) |
| **Persistence** | Git commits only | SQLite (runs, phases, steps, subagents) + git |
| **Cost tracking** | None | Per-phase cost/duration, aggregated in PR |
| **Constitution** | None | `.specify/constitution.md` — project-wide constraints that shape all spec generation |

## 2. Gaps Identified and How We Address Them

All gaps from the original Ralph Wiggum comparison. Each is marked as resolved (addressed by our plan) or deferred.

### G1 — Resolved: Planning Mode
**Ralph:** Separate PLANNING mode prompt for gap analysis and plan generation.
**Our solution:** Planning is integrated into every loop cycle — gap analysis (step 1) decides what to build, then `/speckit.specify` → `/speckit.plan` → `/speckit.tasks` generate structured plans per feature. No separate mode needed.

### G2 — Resolved: Continuous Loop / Self-Correction
**Ralph:** `while :; do ... ; done` — bash loop restarts with fresh context, picks next task, self-corrects.
**Our solution:** `runLoop()` — each cycle is a fresh `query()` call per stage. Same philosophy (clean context per unit of work), but programmatic with abort control, cost tracking, and failure recovery.

### G3 — Resolved: Self-Improvement
**Ralph:** Updates `AGENTS.md` with operational learnings each iteration. Knowledge persists across loops.
**Our solution:** Learnings stage (step 7 of each cycle) writes to `.claude/rules/learnings.md`. Because the SDK loads `settingSources: ["project"]`, every subsequent `query()` call automatically receives the learnings. Same effect as AGENTS.md, using spec-kit's `.claude/rules/` convention.

### G4 — Resolved: "Don't Assume Not Implemented" Guard
**Ralph:** Explicit guardrail — search codebase with subagents before implementing anything.
**Our solution:** Added to implement prompt orient phase (0b) and instruction 1: "Before making changes, search the codebase using subagents — don't assume not implemented."

### G5 — Resolved: Per-Task Backpressure
**Ralph:** Implement → test → fix → commit, all within same iteration. 1 subagent for validation.
**Our solution:** Implement prompt instruction 2: "After implementing EACH task, run build/tests. Fix failures before moving on. All required tests must pass before marking a task [x]."

### G6 — Resolved: Subagent Parallelism Control
**Ralph:** "Up to 500 subagents for search, 1 for build/test."
**Our solution:** Same numbers in implement prompt: "You may use up to 500 parallel subagents for file searches and reads. Use only 1 subagent for build, test, or typecheck commands. Use Opus subagents when complex reasoning is needed."

### G7 — Resolved: Failed Feature Recovery
**Ralph:** Operator throws out plan and regenerates via PLANNING mode.
**Our solution:** Gap analysis outputs one of four decisions:
- `NEXT_FEATURE` — no spec exists, create via full specify → plan → tasks cycle
- `RESUME_FEATURE` — spec exists with incomplete tasks, skip to `/speckit.implement`
- `REPLAN_FEATURE` — spec exists but tasks are wrong, re-run `/speckit.plan` + `/speckit.tasks` (overwrite operations), then implement
- `GAPS_COMPLETE` — all features done

Auto-trigger: 3 consecutive failures on same spec → force `REPLAN_FEATURE`. 3 re-plan failures → skip feature, log to `learnings.md`.

### G8 — Resolved: "Signs" Prompt Architecture
**Ralph:** Numbered guardrails (999...N), orient phase (0a-0c), specific language patterns.
**Our solution:** Step 8 implements full Ralph-style prompts — orient phase (0a-0e), numbered guardrails, "study"/"don't assume"/"capture the why" language patterns.

### G9 — Resolved (Our Innovation): Interactive Clarification
**Ralph:** Assumes operator provides correct specs upfront.
**Our solution:** Phase A — thorough interactive clarification session with completeness checklist before the autonomous loop starts. Neither Ralph nor any other approach does this. Produces `.specify/full_plan.md` as read-only source of truth.

### G10 — Resolved: Functional Verification
**Ralph:** Build + typecheck backpressure only.
**Our solution:** Verify stage includes browser-based e2e — uses chrome-devtools-mcp or playwright MCP to open the app, navigate user flows, take screenshots, and verify functionality visually.

### G11 — Resolved: Spec-Kit Constitution
**Ralph:** No constitution concept.
**Our solution:** Step 0 of Phase B runs `/speckit.constitution` to create `.specify/constitution.md` from `full_plan.md`. All subsequent `/speckit.specify` calls inherit project-wide constraints.

### G12 — Deferred (P4): LLM-as-Judge Backpressure
**Ralph playbook:** Proposes non-deterministic backpressure for subjective criteria (aesthetics, tone, UX).
**Status:** Not yet addressed. Planned as future P4 work — `llm-review.ts` utility with binary pass/fail `createReview()` API, integrated as optional backpressure in the verify stage.

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

**Clarification completeness signal** — before transitioning to Phase B, the agent must verify:
```
- [ ] At least one user story with acceptance criteria for each major feature
- [ ] Technology stack with specific versions
- [ ] Build command, test command, and dev server command
- [ ] Deployment target (even if "local only")
- [ ] Testing strategy (unit, integration, e2e — which ones and with what tools)
- [ ] Data model overview (entities, relationships)
```
When ALL items are covered, write `.specify/full_plan.md` and declare `CLARIFICATION_COMPLETE`.
If the user wants to stop early, note which items are incomplete in `full_plan.md`.

Output: a comprehensive `.specify/full_plan.md` — the single source of truth for the autonomous loop.

**Phase B — Autonomous Ralph Loop** (no user input):

**Step 0 (once):** Constitution — run `/speckit.constitution` to create `.specify/constitution.md` from `full_plan.md`. Skip if constitution already exists.

Each cycle is one feature, fully isolated:
1. **Gap Analysis** (separate `query()`) — study `full_plan.md` + existing specs/code → output one of four decisions:
   - `NEXT_FEATURE: {name} | {description}` — no spec exists yet, create one → proceed to step 2
   - `RESUME_FEATURE: {specDir}` — spec exists, tasks remain → skip to step 5
   - `REPLAN_FEATURE: {specDir}` — spec exists, plan/tasks are wrong → skip to step 3
   - `GAPS_COMPLETE` — everything in `full_plan.md` is done → terminate loop
2. **Specify** (separate `query()`) — run `/speckit.specify` to create a new spec dir
3. **Plan** (separate `query()`) — run `/speckit.plan` to generate plan.md (overwrites if re-planning)
4. **Tasks** (separate `query()`) — run `/speckit.tasks` to generate tasks.md (overwrites if re-planning)
5. **Implement** (separate `query()` per phase) — run `/speckit.implement` per phase (existing behavior)
6. **Verify** (separate `query()`) — run build, tests, and functional validation (browser-based e2e via MCP tools for web projects)
7. **Learnings** (separate `query()`) — update `.claude/rules/learnings.md`
8. Loop back to step 1

**Termination conditions:**
- `GAPS_COMPLETE` from gap analysis — all features in `full_plan.md` are implemented
- Budget exhausted (`maxBudgetUsd` reached)
- Max loop cycles reached (`maxLoopCycles`)
- User abort (`AbortController`)

**Degenerate case safeguards:**
- Track consecutive failures per spec directory. After 3 failed implementation attempts on the same spec, auto-trigger `REPLAN_FEATURE`. After 3 re-plan failures, skip the feature and log to `learnings.md`.
- Gap analysis prompt MUST include the list of existing spec directories: "The following specs already exist: {list}. Do NOT create new specs for features that already have a spec directory. Use `RESUME_FEATURE` or `REPLAN_FEATURE` instead."
- Gap analysis prompt MUST be scoped: "Only identify gaps for features described in `full_plan.md`. Do not invent new features."

### Key Design Decisions

- **Separate `query()` per stage**: Each spec-kit command and each stage gets its own fresh context window. Matches Ralph's philosophy: clean context per unit of work. Prevents context bloat.
- **LLM decides autonomously** what to build next (gap analysis). Full trust in the model's prioritization.
- **`/speckit.clarify` is skipped** during the autonomous loop — all clarification happens upfront in Phase A.
- **Spec-kit idempotency constraints respected**: `/speckit.specify` is create-only (never re-run on existing spec). `/speckit.plan` and `/speckit.tasks` overwrite existing files — safe for re-planning.
- **Backpressure is project-agnostic**: Works with any tech stack. The testing strategy (build commands, test runners, e2e approach) is declared in `full_plan.md` during clarification.
- **Verification includes browser testing**: For web projects, the verify stage uses chrome-devtools-mcp or playwright MCP to open the app, navigate user flows, take screenshots, and verify functionality visually — not just unit tests.
- **Self-improvement via `.claude/rules/learnings.md`**: Referenced from `.claude/CLAUDE.md`, automatically loaded by `settingSources: ["project"]` on every subsequent `query()` call.
- **`full_plan.md` is read-only**: The loop NEVER modifies `full_plan.md`. It captures the user's original intent from clarification. Individual feature specs (derived from it) are mutable. Enforced via prompt guardrail: `999. DO NOT modify .specify/full_plan.md.`
- **Acceptance-driven test derivation**: The plan stage derives required tests from acceptance criteria. The implement stage treats tests as part of task scope — all required tests must pass before marking a task `[x]`.
- **Backward compatible**: Existing "build" mode (implement existing specs) remains unchanged.

### Implementation Steps

#### Step 1: Extract `runBuild()` from `run()` (pure refactor)
Move the existing spec-loop + phase-loop code into a new `runBuild()` function. `run()` calls it for modes `"plan"` and `"build"`. Zero behavior change.

#### Step 2: Add new types
- `RunConfig.mode`: add `"loop"` alongside `"plan" | "build"`
- New fields: `description?`, `descriptionFile?`, `fullPlanPath?`, `maxLoopCycles?`, `maxBudgetUsd?`
- New types: `LoopStage`, `GapAnalysisResult` (with `NEXT_FEATURE`, `RESUME_FEATURE`, `REPLAN_FEATURE`, `GAPS_COMPLETE` variants)
- New events: `clarification_started/question/completed`, `loop_cycle_started/completed`, `stage_started/completed`, `loop_terminated`

#### Step 3: Add `runStage()` function
Lightweight `query()` wrapper for single-shot stages (gap analysis, specify, plan, tasks, verify, learnings). Similar to `runPhase()` but without RunTaskState. Captures and returns result text output.

#### Step 4: Add prompt builders (`src/core/prompts.ts`)
New file with all prompt construction:
- `buildClarificationPrompt(description)` — thorough user interview via `AskUserQuestion`, with completeness checklist
- `buildConstitutionPrompt(config, fullPlanPath)` — wraps `/speckit.constitution`
- `buildGapAnalysisPrompt(config, fullPlanPath, existingSpecs)` — gap analysis against `full_plan.md`, includes existing spec list to prevent duplicates, scoped to `full_plan.md` features only
- `buildSpecifyPrompt(config, featureName, featureDescription)` — wraps `/speckit.specify`
- `buildPlanPrompt(config, specPath)` — wraps `/speckit.plan`, includes acceptance-driven test derivation instructions
- `buildTasksPrompt(config, specPath)` — wraps `/speckit.tasks`
- `buildVerifyPrompt(config, specDir, fullPlanPath)` — build + tests + browser-based e2e
- `buildLearningsPrompt(config, specDir)` — update `.claude/rules/learnings.md`
- `buildImplementPrompt(config, phase)` — existing `buildPrompt()` with Ralph-style guardrails
- `parseGapAnalysisResult(output)` — extract decision (`NEXT_FEATURE`/`RESUME_FEATURE`/`REPLAN_FEATURE`/`GAPS_COMPLETE`)
- `discoverNewSpecDir(projectDir, knownSpecs)` — find just-created spec dir

#### Step 5: Add `runLoop()` function
The main Ralph loop: clarification → constitution → [gap analysis → (specify → plan → tasks | resume | replan) → implement → verify → learnings → loop]. Wired into `run()` when `mode === "loop"`. Includes failure tracking per spec for automatic re-plan triggers.

#### Step 6: Update `git.ts`
Handle `"loop"` mode in branch names (`ralph/loop/{date}-{id}`) and PR titles.

#### Step 7: Update UI
- Mode selector (Build / Loop) in App.tsx
- Description input (textarea or file path) for loop mode
- `ClarificationPanel.tsx` — chat-like Q&A interface for Phase A
- Cycle/stage indicators in Topbar during Phase B
- Budget controls (max cycles, max USD)
- Hook state: `currentCycle`, `currentStage`, `isClarifying`, `loopMode`

#### Step 8: Add guardrails to prompts ("Signs" architecture)
Ralph-style prompt structure for the implement stage:
```
0a. Study the spec at {specPath}/spec.md
0b. Study the existing codebase using subagents
0c. Study {specPath}/tasks.md
0d. Study .claude/rules/learnings.md for operational knowledge from previous phases
0e. Study .specify/full_plan.md for testing strategy and project conventions

1. Before making changes, search the codebase using subagents — don't assume not implemented.
   You may use up to 500 parallel subagents for file searches and reads.
   Use only 1 subagent for build, test, or typecheck commands.
   Use Opus subagents when complex reasoning is needed (debugging, architectural decisions).
2. After implementing EACH task, run the project's build/test commands. Fix failures before moving on.
   Tasks include required tests — implement tests as part of task scope.
   All required tests must exist and pass before marking a task [x].
3. After completing EACH task, immediately mark it [x] in tasks.md.

999. DO NOT modify .specify/full_plan.md. It captures the user's original intent.
9999. DO NOT IMPLEMENT PLACEHOLDER OR SIMPLE IMPLEMENTATIONS.
99999. After completing EACH task, immediately mark it [x] in tasks.md.
999999. Capture the "why" in test documentation — future loops won't have this context.
9999999. If you discover bugs unrelated to your task, document them in .claude/rules/learnings.md.
99999999. Single sources of truth — no migrations/adapters. If tests unrelated to your work fail, resolve them.
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

Gap analysis prompt:
```
Study .specify/full_plan.md and compare against existing specs and implementation.

The following spec directories already exist: {existingSpecs}
Do NOT create new specs for features that already have a directory. Use RESUME_FEATURE or REPLAN_FEATURE.
Only identify gaps for features described in full_plan.md. Do not invent new features.

For each planned feature, determine:
1. Does a spec directory exist? → If no, NEXT_FEATURE
2. Are all tasks marked [x]? → If no, check if tasks are valid
3. Are tasks valid but incomplete? → RESUME_FEATURE
4. Are tasks wrong/conflicting/impossible? → REPLAN_FEATURE
5. All features complete? → GAPS_COMPLETE

Output EXACTLY one of:
- NEXT_FEATURE: {name} | {one-line description}
- RESUME_FEATURE: {specDir}
- REPLAN_FEATURE: {specDir}
- GAPS_COMPLETE
```

Plan stage prompt addition (acceptance-driven test derivation):
```
For each task, derive required tests from acceptance criteria in spec.md.
Specify WHAT to verify (outcomes), not HOW to implement.
Include required tests as part of each task definition in tasks.md.
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
| LLM-as-judge backpressure | Medium | High | **P4** |

## 6. Key Insight

The original Ralph Wiggum is philosophically about **eventual consistency through iteration** — a dumb loop that self-corrects over time. Our implementation is architecturally superior (typed SDK, real-time UI, structured persistence) but philosophically incomplete: we run a single pass and stop.

Our enhanced approach goes beyond both:
1. **Interactive clarification** before the loop ensures the agent has complete context — something neither Ralph nor any other approach does well
2. **Spec-kit constitution** establishes project-wide constraints that shape all feature specs consistently
3. **Four-way gap analysis** (`NEXT_FEATURE`/`RESUME_FEATURE`/`REPLAN_FEATURE`/`GAPS_COMPLETE`) handles the full lifecycle — not just "create" but also "recover" and "re-plan"
4. **Acceptance-driven test derivation** links acceptance criteria → required tests → backpressure, preventing agents from claiming tasks as done without real verification
5. **Functional verification** (browser-based e2e, not just unit tests) catches issues that compile-and-test backpressure misses
6. **Spec-kit integration** gives structured, reproducible planning instead of Ralph's free-form TODO list
7. **`full_plan.md` as read-only source of truth** eliminates drift from user intent while keeping individual specs mutable
8. **Degenerate case safeguards** (failure tracking, duplicate prevention, scope constraints) prevent the loop from burning budget unproductively

The result: a system that can take a vague user description, clarify it into a complete plan, and autonomously build, verify, and iterate for hours/days without human intervention.
