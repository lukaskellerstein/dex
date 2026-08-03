# Dex: Autonomous Software Engineering at Scale

## The Problem

AI coding assistants today operate in one of two modes: **interactive** (human drives every prompt) or **single-shot** (one task, one context window, done). Neither scales to building real software — projects with dozens of features, thousands of files, and days of work.

The fundamental challenges:

1. **Context window exhaustion** — A 200K token window fills fast. After ~100K tokens of accumulated tool calls, code reads, and reasoning, the model enters a "dumb zone" where output quality degrades. Long-running sessions produce increasingly poor code.

2. **No persistent memory across sessions** — Each new conversation starts from zero. The agent re-discovers project structure, re-reads the same files, and makes the same mistakes it already learned to avoid.

3. **No structured planning** — Agents jump straight to implementation. Without a specification-first workflow, features are incomplete, inconsistent, and don't compose well across a multi-feature project.

4. **No verification beyond "it compiles"** — Most AI workflows stop at `tsc --noEmit` or `npm test`. Nobody checks if the feature actually works in a browser, if the UI renders correctly, or if the user flow makes sense.

5. **No recovery from failure** — When an agent gets stuck or produces bad code, the only option is human intervention. There's no automatic re-planning, no failure tracking, no self-correction loop.

6. **No cost or progress visibility** — The agent runs in a terminal. You watch scrolling text and hope for the best. No dashboards, no phase tracking, no cost attribution.

## The Three Pillars

Dex synthesizes three independent innovations into a unified system:

```mermaid
graph TB
    subgraph "Ralph Wiggum"
        RW[Infinite Loop Philosophy]
        RW1[Context Isolation per Task]
        RW2[Self-Improvement via AGENTS.md]
        RW3[Numbered Guardrails]
        RW4[Subagent Parallelism Control]
    end

    subgraph "GitHub Spec-Kit"
        SK[Specification-Driven Development]
        SK1[Structured Spec Templates]
        SK2[Constitution / Project Principles]
        SK3[Phased Execution: specify → plan → tasks → implement]
        SK4[Multi-Agent Support]
    end

    subgraph "Claude Agent SDK"
        AS[Programmatic Agent Control]
        AS1["query() API with Typed Hooks"]
        AS2[Session & Abort Management]
        AS3[MCP Server Integration]
        AS4[settingSources for Config Loading]
    end

    RW --> RC[Dex]
    SK --> RC
    AS --> RC

    style RC fill:#a855f7,stroke:#7c3aed,color:#fff
    style RW fill:#f59e0b,stroke:#d97706,color:#000
    style SK fill:#3b82f6,stroke:#2563eb,color:#fff
    style AS fill:#10b981,stroke:#059669,color:#fff
```

### Pillar 1: Ralph Wiggum — The Loop Philosophy

[Ralph Wiggum](https://ghuntley.com/ralph/) by Geoffrey Huntley is a deceptively simple idea: run `while :; do cat PROMPT.md | claude ; done` in a bash loop. Each iteration gets a fresh context window, picks the most important task, implements it, commits, and exits. The loop restarts. Over hours and days, the project converges toward completeness through iteration.

**Key insights we inherit:**
- **Context isolation** — fresh context per unit of work prevents quality degradation
- **Self-improvement** — `AGENTS.md` accumulates operational learnings across iterations
- **"Signs" system** — numbered guardrails (999, 9999, 99999...) enforce invariants with escalating priority
- **Subagent control** — 500 parallel subagents for reads, 1 for builds (backpressure)
- **Trust the loop** — eventual consistency through iteration, not perfection per step

**What Ralph lacks:** No UI, no structured specs, no programmatic control, no abort, no cost tracking, no recovery logic. It's a bash script.

### Pillar 2: GitHub Spec-Kit — Structured Planning

[Spec-Kit](https://github.com/github/spec-kit) by GitHub implements Specification-Driven Development (SDD) — specs are the primary artifact, code is generated output. It provides a templated workflow:

```text
/speckit.constitution → /speckit.specify → /speckit.plan → /speckit.tasks → /speckit.implement
```

Each command produces structured artifacts:

| Artifact | Purpose |
|----------|---------|
| `constitution.md` | Immutable project-wide principles |
| `spec.md` | Feature specification with user stories, acceptance criteria |
| `plan.md` | Technical implementation plan, architecture decisions |
| `research.md` | Technology decisions and rationale |
| `data-model.md` | Entities, relationships, schemas |
| `contracts/` | API contracts, interface definitions |
| `tasks.md` | Dependency-ordered, actionable task list |

**Key insights we inherit:**
- **Specs before code** — forces thorough thinking before implementation
- **Constitution** — project-wide constraints that shape all feature specs consistently
- **Phased execution** — each phase has focused scope, testable output
- **Acceptance-driven testing** — tests derived from acceptance criteria, not invented ad-hoc

**What Spec-Kit lacks:** No autonomous loop, no gap analysis, no failure recovery, no self-improvement. It's a sequential workflow that requires human orchestration.

### Pillar 3: Claude Agent SDK — Programmatic Control

The [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) provides programmatic access to Claude Code instances via the `query()` API:

```typescript
const result = await query({
  prompt: "implement the auth module",
  options: {
    allowedTools: ["Read", "Write", "Edit", "Bash"],
    settingSources: ["project"],
    maxTurns: 200,
    hooks: { PreToolUse: [...], PostToolUse: [...] }
  }
});
```

**Key insights we inherit:**
- **Typed hooks** — intercept every tool call, subagent spawn, and completion event
- **Session management** — resume, fork, and abort running agents
- **`settingSources`** — automatically loads `.claude/rules/` including learnings from prior iterations
- **MCP integration** — browser automation, playwright, custom tools
- **AbortController** — graceful mid-phase cancellation

**What the SDK lacks:** No loop, no planning, no specs, no UI. It's a library.

## The Synthesis: Dex

Dex combines these three pillars into an autonomous software engineering system that can take a vague description and build a complete project over hours or days — without human intervention.

```mermaid
flowchart TB
    subgraph "Phase A — Interactive Clarification"
        USER[User provides description] --> CLARIFY[Thorough Q&A session]
        CLARIFY --> CHECKLIST{Completeness\nchecklist}
        CHECKLIST -->|Incomplete| CLARIFY
        CHECKLIST -->|Complete| FULLPLAN["Write .specify/full_plan.md"]
    end

    subgraph "Phase B — Autonomous Ralph Loop"
        FULLPLAN --> CONST["Step 0: Constitution\n/speckit.constitution"]
        CONST --> GAP["Step 1: Gap Analysis\nStudy full_plan.md vs existing specs/code"]

        GAP -->|NEXT_FEATURE| SPECIFY["Step 2: Specify\n/speckit.specify"]
        GAP -->|RESUME_FEATURE| IMPL
        GAP -->|REPLAN_FEATURE| PLAN
        GAP -->|GAPS_COMPLETE| DONE[Loop Terminates]

        SPECIFY --> PLAN["Step 3: Plan\n/speckit.plan"]
        PLAN --> TASKS["Step 4: Tasks\n/speckit.tasks"]
        TASKS --> IMPL["Step 5: Implement\n/speckit.implement per phase"]
        IMPL --> VERIFY["Step 6: Verify\nBuild + Tests + Browser E2E"]
        VERIFY --> LEARN["Step 7: Learnings\nUpdate .claude/rules/learnings.md"]
        LEARN --> GAP
    end

    subgraph "Safeguards"
        FAIL_TRACK["3 failures → auto REPLAN\n3 replans → skip + log"]
        BUDGET["Budget exhausted → stop"]
        ABORT["User abort → graceful stop"]
    end

    IMPL -.->|failure| FAIL_TRACK
    FAIL_TRACK -.-> GAP
    BUDGET -.-> DONE
    ABORT -.-> DONE

    style FULLPLAN fill:#3b82f6,stroke:#2563eb,color:#fff
    style GAP fill:#a855f7,stroke:#7c3aed,color:#fff
    style DONE fill:#10b981,stroke:#059669,color:#fff
```

### How Context Isolation Works

Every box in the loop above is a **separate `query()` call** — a fresh Claude Code instance with a clean 200K context window. This is the core Ralph Wiggum insight, implemented programmatically:

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant Q1 as query() #1
    participant Q2 as query() #2
    participant Q3 as query() #3
    participant Q4 as query() #4
    participant FS as Filesystem

    Note over O: Cycle N starts
    O->>Q1: Gap Analysis prompt + full_plan.md
    Q1->>FS: Read specs, code, tasks.md
    Q1-->>O: NEXT_FEATURE: auth-module

    O->>Q2: /speckit.specify "auth-module"
    Q2->>FS: Write specs/001-auth-module/spec.md
    Q2-->>O: Done

    O->>Q3: /speckit.plan specs/001-auth-module
    Q3->>FS: Read spec.md, write plan.md + tasks.md
    Q3-->>O: Done

    O->>Q4: /speckit.implement Phase 1
    Q4->>FS: Read tasks.md, implement, run tests
    Q4-->>O: Done (3 tasks completed)

    Note over O: Each query() = fresh 200K context
    Note over O: Learnings persist via filesystem
```

State doesn't pass through the context window — it passes through the **filesystem**. Specs, tasks, code, and learnings are written to disk. Each new `query()` reads what it needs from disk, operates in the "smart zone" of its context window, and writes results back. This is how Ralph Wiggum achieves eventual consistency: not by remembering everything, but by reading the current state each time.

### The Four-Way Gap Analysis

The gap analysis stage is the loop's brain. It reads `full_plan.md` (the user's original intent) and compares it against the current state of specs and code, then outputs exactly one decision:

```mermaid
flowchart LR
    GAP[Gap Analysis] --> CHECK{Feature has\nspec dir?}
    CHECK -->|No| NF["NEXT_FEATURE\nCreate new spec"]
    CHECK -->|Yes| TASKS{All tasks\ncomplete?}
    TASKS -->|"Yes, all done"| NEXT{More features\nin full_plan.md?}
    TASKS -->|No| VALID{Tasks still\nvalid?}
    VALID -->|Yes| RF["RESUME_FEATURE\nContinue where left off"]
    VALID -->|No| RP["REPLAN_FEATURE\nRegenerate plan + tasks"]
    NEXT -->|Yes| CHECK
    NEXT -->|No| GC["GAPS_COMPLETE\nTerminate loop"]

    style NF fill:#3b82f6,color:#fff
    style RF fill:#f59e0b,color:#000
    style RP fill:#ef4444,color:#fff
    style GC fill:#10b981,color:#fff
```

This handles the full feature lifecycle: creation, resumption after crash, recovery from bad plans, and graceful termination. Ralph Wiggum's bash loop can only create and continue — it can't detect when a plan is wrong and needs regeneration.

### Self-Improvement Loop

Learnings accumulate in `.claude/rules/learnings.md` and are automatically loaded by every subsequent `query()` call via the SDK's `settingSources: ["project"]` mechanism:

```mermaid
flowchart LR
    Q1["query() Cycle 1"] -->|discovers| L1["Learning: 'npm test requires\n--experimental-vm-modules flag'"]
    L1 -->|writes| FILE[".claude/rules/learnings.md"]
    FILE -->|auto-loaded via\nsettingSources| Q2["query() Cycle 2"]
    Q2 -->|discovers| L2["Learning: 'auth module uses\nargon2 not bcrypt'"]
    L2 -->|appends| FILE
    FILE -->|auto-loaded| Q3["query() Cycle 3"]

    style FILE fill:#a855f7,stroke:#7c3aed,color:#fff
```

This is functionally identical to Ralph Wiggum's `AGENTS.md` updates, but uses the SDK's native config loading instead of explicit file reads in the prompt.

### Backpressure Architecture

Multiple layers of verification prevent the agent from claiming work is done when it isn't:

```mermaid
flowchart TB
    subgraph "Per-Task Backpressure (during implement)"
        T1[Implement task] --> BUILD1[Run build]
        BUILD1 -->|fail| FIX1[Fix & retry]
        FIX1 --> BUILD1
        BUILD1 -->|pass| TEST1[Run tests]
        TEST1 -->|fail| FIX2[Fix & retry]
        FIX2 --> TEST1
        TEST1 -->|pass| MARK["Mark task [x]"]
    end

    subgraph "Per-Feature Verification (after all tasks)"
        MARK --> VBUILD[Build entire project]
        VBUILD --> VTEST[Run full test suite]
        VTEST --> E2E["Browser E2E\n(Playwright/CDP)"]
        E2E --> SCREENSHOT[Take screenshots\nVerify UI flows]
    end

    subgraph "Loop-Level Safeguards"
        SCREENSHOT -->|pass| LEARNINGS[Update learnings]
        SCREENSHOT -->|fail 3x| REPLAN[Force REPLAN_FEATURE]
        REPLAN -->|fail 3x| SKIP[Skip feature\nLog to learnings]
    end

    style E2E fill:#3b82f6,color:#fff
    style REPLAN fill:#ef4444,color:#fff
    style SKIP fill:#6b7280,color:#fff
```

Key innovation over Ralph: **browser-based E2E verification**. Ralph only runs build + typecheck. Dex opens the app in a browser (via MCP tools), walks user flows, takes screenshots, and verifies the UI actually works. This catches an entire class of bugs — rendering issues, broken interactions, missing styles — that compile-and-test backpressure misses.

### Acceptance-Driven Test Derivation

Tests aren't invented ad-hoc. They flow from acceptance criteria through the spec-kit pipeline:

```mermaid
flowchart LR
    AC["Acceptance Criteria\n(spec.md)"] -->|/speckit.plan| RT["Required Tests\n(plan.md)"]
    RT -->|/speckit.tasks| TT["Test Tasks\n(tasks.md)"]
    TT -->|/speckit.implement| CODE["Tests + Code\n(implementation)"]
    CODE -->|backpressure| VERIFY["All tests must pass\nbefore task marked [x]"]

    style AC fill:#3b82f6,color:#fff
    style VERIFY fill:#10b981,color:#fff
```

This creates a traceable chain from "what the user wants" to "what the tests verify." An agent can't mark a task complete without implementing and passing the tests derived from its acceptance criteria.

## Architecture

### System Architecture

```mermaid
graph TB
    subgraph "Electron App"
        subgraph "Renderer Process (React 18)"
            UI[3-Column Layout]
            SIDEBAR[Sidebar\nProject selector\nRun controls]
            BOARD[Task Board\nPhase progress\nTask status]
            TRACE[Agent Trace\nLive step stream\nSubagent tree]
            CLARIFY_UI["Clarification Panel\nChat-style Q&A"]
        end

        subgraph "Main Process"
            IPC[IPC Handlers]
            DB[(SQLite\nRuns, Phases\nSteps, Subagents)]
        end

        subgraph "Core Engine (Platform-Agnostic)"
            ORCH[Orchestrator]
            PROMPTS[Prompt Builders]
            PARSER[tasks.md Parser]
            GIT[Git Automation]
            LOOP[runLoop]
            STAGE[runStage]
            BUILD[runBuild]
        end
    end

    subgraph "External"
        SDK["Claude Agent SDK\nquery() per stage"]
        CC["Claude Code Instances\n(subprocess per query)"]
        SPECKIT["Spec-Kit Skills\n(/speckit.* commands)"]
        MCP["MCP Servers\n(browser, playwright)"]
    end

    UI --- SIDEBAR
    UI --- BOARD
    UI --- TRACE
    UI --- CLARIFY_UI

    SIDEBAR <-->|IPC| IPC
    BOARD <-->|IPC| IPC
    TRACE <-->|IPC| IPC

    IPC <--> ORCH
    IPC <--> DB

    ORCH --> LOOP
    ORCH --> BUILD
    LOOP --> STAGE
    LOOP --> BUILD
    STAGE --> PROMPTS
    BUILD --> PROMPTS
    ORCH --> PARSER
    ORCH --> GIT

    STAGE --> SDK
    BUILD --> SDK
    SDK --> CC
    CC --> SPECKIT
    CC --> MCP

    style ORCH fill:#a855f7,stroke:#7c3aed,color:#fff
    style SDK fill:#10b981,stroke:#059669,color:#fff
    style LOOP fill:#f59e0b,stroke:#d97706,color:#000
```

### Core Engine Design

The core engine (`src/core/`) is **platform-agnostic** — pure Node.js with no Electron imports. It can be tested standalone, embedded in a CLI, or run as a service. The Electron app is just one possible frontend.

Three execution modes:

| Mode | Entry Point | Use Case |
|------|------------|----------|
| `build` | `runBuild()` | Implement existing specs (single pass) |
| `plan` | `runBuild()` | Generate plans for existing specs |
| `loop` | `runLoop()` | Full autonomous loop (Phase A + B) |

### Data Flow

```mermaid
flowchart LR
    subgraph "User Input"
        DESC[Project Description]
    end

    subgraph "Phase A Output"
        FP[".specify/full_plan.md\n(read-only source of truth)"]
    end

    subgraph "Phase B Artifacts (per feature)"
        CONST[".specify/constitution.md"]
        SPEC["specs/NNN-feature/spec.md"]
        PLAN["specs/NNN-feature/plan.md"]
        TASKS["specs/NNN-feature/tasks.md"]
        CODE["src/**/* (implementation)"]
        TESTS["tests/**/* (test suites)"]
    end

    subgraph "Cross-Cycle Persistence"
        LEARN[".claude/rules/learnings.md"]
        DBFILE["~/.dex/data.db"]
        LOGS["~/.dex/logs/"]
    end

    DESC --> FP
    FP --> CONST
    FP --> SPEC
    SPEC --> PLAN
    PLAN --> TASKS
    TASKS --> CODE
    TASKS --> TESTS
    CODE -.->|discoveries| LEARN
    LEARN -.->|auto-loaded| SPEC

    style FP fill:#3b82f6,color:#fff
    style LEARN fill:#a855f7,color:#fff
```

Key design decision: **`full_plan.md` is immutable**. The loop never modifies it. It captures the user's original intent from Phase A. Individual feature specs (derived from it) are mutable — they can be replanned, rewritten, and iterated on. This prevents drift from user intent while allowing the loop to self-correct at the feature level.

## Why This Approach Is Superior

### vs. Interactive AI Coding (Cursor, Copilot, Claude Code manual)

| Dimension | Interactive | Dex |
|-----------|------------|--------------|
| **Scale** | One task at a time, human-driven | Dozens of features, autonomous |
| **Context** | Single session, degrades over time | Fresh context per stage, always in "smart zone" |
| **Planning** | Ad-hoc or none | Structured specs with acceptance criteria |
| **Verification** | Manual | Automated build + test + browser E2E |
| **Recovery** | Human restarts | Auto-replan after 3 failures |
| **Cost visibility** | None | Per-phase cost/duration tracking |
| **Time to complete** | Hours of human attention | Runs overnight, report in the morning |

### vs. Original Ralph Wiggum

| Dimension | Ralph Wiggum | Dex |
|-----------|-------------|--------------|
| **Interface** | Bash script, watch terminal | Desktop app with live trace |
| **Planning** | Free-form TODO list | Spec-kit: spec → plan → tasks pipeline |
| **Specs** | `specs/*.md` (unstructured) | Templated: spec.md + plan.md + tasks.md + data-model.md + contracts/ |
| **Scope** | One task per iteration | One feature per cycle (all phases) |
| **Gap analysis** | Linear: "pick next task" | Four-way: NEXT / RESUME / REPLAN / COMPLETE |
| **Recovery** | Manual: delete plan, re-run | Automatic: 3 failures → replan → 3 replans → skip |
| **Verification** | Build + typecheck | Build + tests + browser E2E |
| **Clarification** | Assumes correct specs upfront | Interactive Phase A with completeness checklist |
| **Constitution** | None | Project-wide principles shape all specs |
| **Persistence** | Git only | SQLite + structured logs + git |
| **Abort** | Kill the terminal | AbortController with graceful cleanup |
| **Cost tracking** | None | Per-phase cost/duration attribution |

### vs. Other Agent Frameworks (Devin, SWE-Agent, OpenHands)

| Dimension | Agent Frameworks | Dex |
|-----------|-----------------|--------------|
| **Context strategy** | Single long session | Fresh context per stage (Ralph philosophy) |
| **Planning depth** | Varies, usually shallow | Spec-kit's full specify → plan → tasks pipeline |
| **Self-improvement** | None across sessions | learnings.md persists across all future stages |
| **Verification** | Usually just tests | Tests + browser-based E2E + screenshots |
| **Failure recovery** | Retry or give up | Structured replan with failure tracking |
| **Transparency** | Opaque or log-only | Real-time UI with step-by-step trace |
| **Local-first** | Cloud-hosted (Devin) or CLI | Desktop app, your machine, your data |
| **Spec integration** | None | Native spec-kit with constitution |

## Key Innovation: Interactive Clarification

Neither Ralph Wiggum nor any other autonomous coding approach solves the **specification quality problem**: garbage in, garbage out. If the agent starts with a vague description, it builds the wrong thing — and burns budget doing it.

Dex's Phase A is a thorough interactive session that transforms a vague idea into a comprehensive plan:

```mermaid
flowchart TB
    VAGUE["'Build me a task management app'"] --> Q1["What's the tech stack?\nReact + Node + PostgreSQL"]
    Q1 --> Q2["What auth? OAuth, email/password, both?\nOAuth with Google + GitHub"]
    Q2 --> Q3["Real-time updates? WebSockets?\nYes, for team collaboration"]
    Q3 --> Q4["Deployment target?\nDocker on AWS ECS"]
    Q4 --> Q5["Testing strategy?\nJest + Playwright E2E"]
    Q5 --> CHECK{Completeness\nChecklist}

    CHECK -->|"User stories?"| Q6["At least one per feature\nwith acceptance criteria"]
    CHECK -->|"Data model?"| Q7["Users, Teams, Projects,\nTasks, Comments"]
    CHECK -->|"Build commands?"| Q8["npm run build,\nnpm test, npm run dev"]

    Q6 --> FP
    Q7 --> FP
    Q8 --> FP

    FP[".specify/full_plan.md\n200+ lines of structured context\nReady for autonomous execution"]

    style VAGUE fill:#ef4444,color:#fff
    style FP fill:#10b981,color:#fff
```

The completeness checklist ensures the plan has everything needed for autonomous execution:
- At least one user story with acceptance criteria per feature
- Technology stack with specific versions
- Build, test, and dev server commands
- Deployment target
- Testing strategy with specific tools
- Data model overview

Only when all items are covered does Phase B begin. This front-loads the human effort into a 30-minute clarification session, then the loop runs for hours without needing input.

## Summary

Dex is the convergence of three ideas:

1. **Ralph Wiggum's loop philosophy** — context isolation, self-improvement, eventual consistency through iteration
2. **Spec-Kit's structured planning** — specifications before code, constitution-governed, acceptance-driven testing
3. **Claude Agent SDK's programmatic control** — typed hooks, abort management, MCP integration, session control

The result: a desktop application that takes a project description, clarifies it into a complete plan, and autonomously builds, verifies, and iterates — feature by feature, phase by phase — with fresh context windows, structured specs, browser-based verification, automatic failure recovery, and real-time visibility into every step.

```mermaid
graph LR
    A["Vague Idea"] -->|Phase A| B["Complete Plan"]
    B -->|Phase B| C["Working Software"]
    C -->|Verified| D["Shipped"]

    style A fill:#ef4444,color:#fff
    style B fill:#f59e0b,color:#000
    style C fill:#3b82f6,color:#fff
    style D fill:#10b981,color:#fff
```
