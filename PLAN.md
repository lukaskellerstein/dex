# Plan: Ralph Claude — Electron Orchestrator for Spec-Kit

## Context

**Problem**: Implementing a full spec-kit feature in a single Claude Code session leads to context bloat. The "Ralph Wiggum" approach solves this: spawn fresh Claude Code instances per unit of work, each with clean context.

**Goal**: Build an Electron desktop app that reads any spec-kit `tasks.md`, visualizes phases/tasks, spawns fresh Claude Code instances via `@anthropic-ai/claude-agent-sdk` — one per **phase** — using spec-kit's own `/speckit.implement` skill to handle context and implementation. Full step-by-step agent visibility including subagents (inspired by vex's AgentTrace UI).

**Repo**: `~/Projects/Github/lukaskellerstein/ralph-claude`

**Core concepts**:
- **Ralph Wiggum approach** (https://github.com/ghuntley/how-to-ralph-wiggum): Loop that spawns fresh Claude Code instances per unit of work. Each iteration starts with clean context, reads shared state, does work, updates state, exits. Context clears between iterations to prevent token bloat.
- **GitHub spec-kit** (https://github.com/github/spec-kit): Structured specification system with phases/tasks. Each spec contains: `spec.md`, `plan.md`, `tasks.md`, `data-model.md`, `contracts/`, `research.md`. Has built-in skills like `/speckit.implement Phase N`.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): TypeScript SDK wrapping Claude Code CLI. Provides `query()` async generator with streaming, hooks (PreToolUse, PostToolUse, SubagentStart, SubagentStop), permission modes, and settingSources for loading project skills.

**Key design decision**: The Ralph loop operates at **phase level**, not task level. Tasks within a phase are tightly coupled — the agent needs the full phase context (purpose, all tasks, their interdependencies) to produce coherent work. Spec-kit's `/speckit.implement Phase N` already handles task-level orchestration within a phase. No custom prompt builder needed.

---

## Why Phases, Not Tasks

Tasks within a phase are tightly coupled. Example from a real spec:

```markdown
## Phase 3: Newsletter Extension (Listmonk)
**Purpose**: First real extension. Proves the full pipeline: NATS event → extension container → Listmonk API.

- [~] T019 Extension code exists at extensions/newsletter/
- [ ] T020 Newsletter extension runs as separate Docker container
- [ ] T021 API routes: GET/POST /api/ext/newsletter/sync
- [ ] T022 E2E verified: create member → NATS event → newsletter subscriber
```

T020 (containerize) is meaningless without T019 (the code it containerizes). T022 (E2E test) validates T019-T021 together. The **phase purpose** is what gives each task its reason for existing. An agent implementing one task in isolation would lack this context and produce work that doesn't integrate.

Spec-kit's `/speckit.implement Phase N` is designed for exactly this granularity — it loads the phase context, understands all tasks, and implements them as a coherent unit.

---

## Architecture Overview

```
ralph-claude/
├── package.json                    # Vite + Electron, React 18, @anthropic-ai/claude-agent-sdk
├── vite.config.ts                  # Renderer build
├── tsconfig.json
├── src/
│   ├── main/                       # Electron main process
│   │   ├── index.ts                # App lifecycle, BrowserWindow, IPC registration
│   │   ├── preload.ts              # contextBridge → window.ralphAPI
│   │   └── ipc/
│   │       ├── handlers.ts         # IPC handler registration
│   │       ├── project.ts          # Open project, list specs, parse tasks
│   │       └── orchestrator.ts     # Start/stop/pause, bridge events to renderer
│   ├── core/                       # Orchestrator engine (pure Node.js, no Electron deps)
│   │   ├── orchestrator.ts         # Main loop: parse → select phase → spawn → validate → next
│   │   ├── parser.ts              # tasks.md → Phase[] with Task[] (for UI display + phase status)
│   │   ├── validator.ts           # Runs build/typecheck after each phase
│   │   ├── git.ts                 # Commit/restore helpers
│   │   ├── types.ts               # Shared interfaces (Phase, Task, AgentStep, etc.)
│   │   └── schemas.ts            # JSON Schema for structured output
│   └── renderer/                   # React app
│       ├── main.tsx
│       ├── App.tsx                 # Layout: sidebar + main + log panel
│       ├── electron.d.ts          # window.ralphAPI types
│       ├── styles/
│       │   └── theme.css          # Catppuccin-inspired dark theme (CSS custom props)
│       ├── components/
│       │   ├── layout/
│       │   │   ├── AppShell.tsx
│       │   │   ├── Sidebar.tsx
│       │   │   └── WindowControls.tsx
│       │   ├── sidebar/
│       │   │   ├── SpecList.tsx        # Specs found in project
│       │   │   ├── ConfigPanel.tsx     # Model, budget, max turns, phases
│       │   │   └── RunControls.tsx     # Start/Pause/Stop
│       │   ├── task-board/
│       │   │   ├── PhaseView.tsx       # Expandable phase with task rows
│       │   │   ├── TaskRow.tsx         # Status, ID, description, cost, time
│       │   │   └── ProgressBar.tsx     # X/Y phases, total cost, total time
│       │   └── agent-trace/           # ← Inspired by vex project-detail
│       │       ├── AgentStepList.tsx   # Timeline container, GSAP animations
│       │       ├── AgentStepItem.tsx   # Step renderer (thinking, tool_call, text, etc.)
│       │       ├── SubagentList.tsx    # Horizontal pill badges for subagents
│       │       ├── ToolCard.tsx        # Generic tool wrapper with badges
│       │       ├── BashInput.tsx       # Terminal-style command display
│       │       ├── WriteInput.tsx      # File path + content preview
│       │       ├── EditInput.tsx       # Diff view with +/- markers
│       │       ├── ReadInput.tsx       # File path badge
│       │       └── ToolResultStep.tsx  # Collapsible result/error display
│       └── hooks/
│           ├── useOrchestrator.ts      # IPC listener for orchestrator events
│           └── useProject.ts          # Project/spec state
└── index.html
```

---

## Core Engine (`src/core/`)

Platform-agnostic orchestrator — no Electron imports. Can be tested standalone.

### Key Types (`types.ts`)

```typescript
// ── Spec-Kit Types (parsed from tasks.md for UI display) ──
interface Phase {
  number: number;
  name: string;
  purpose: string;
  tasks: Task[];
  status: "complete" | "partial" | "not_started";  // derived from task statuses
}

interface Task {
  id: string;                // "T019"
  userStory: string | null;  // "US3"
  description: string;
  status: "done" | "not_done" | "code_exists";  // [x], [ ], [~]
  lineNumber: number;
  phase: number;
}

// ── Agent Execution Types (mirrors vex's AgentStep) ──
type StepType =
  | "thinking" | "text" | "tool_call" | "tool_result" | "tool_error"
  | "subagent_spawn" | "subagent_result" | "completed" | "error";

interface AgentStep {
  id: string;
  sequenceIndex: number;
  type: StepType;
  content: string | null;
  metadata: Record<string, unknown> | null;
  durationMs: number | null;
  tokenCount: number | null;
  createdAt: string;
}

interface SubagentInfo {
  id: string;
  subagentId: string;
  subagentType: string;
  description: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ── Configuration ──
interface RunConfig {
  projectDir: string;        // absolute path to project root
  specDir: string;           // relative, e.g., "specs/002-extension-integrations"
  mode: "planning" | "building";
  model: string;             // default: "claude-sonnet-4-5-20250514"
  maxIterations: number;     // max phases to process in one run
  budgetPerPhase: number;    // USD per phase
  maxTurnsPerPhase: number;  // agent turns per phase, default: 75
  phases: number[] | "all";
  interactive: boolean;      // pause between phases for user confirmation
}

// ── Events: Orchestrator → UI ──
type OrchestratorEvent =
  | { type: "run_started"; config: RunConfig }
  | { type: "phase_started"; phase: Phase; iteration: number }
  | { type: "agent_step"; step: AgentStep }
  | { type: "subagent_started"; info: SubagentInfo }
  | { type: "subagent_completed"; subagentId: string }
  | { type: "validation_started" }
  | { type: "validation_result"; passed: boolean; output: string }
  | { type: "git_committed"; phaseNumber: number; commitHash: string }
  | { type: "phase_completed"; phase: Phase; cost: number; durationMs: number }
  | { type: "run_completed"; totalCost: number; totalDuration: number; phasesCompleted: number }
  | { type: "error"; message: string; phaseNumber?: number }
```

### tasks.md Parser (`parser.ts`)

Needed for **UI display and phase selection** only — not for prompt building (spec-kit handles that).

```
Phase header:  /^## Phase (\d+): (.+)$/
Purpose:       /^\*\*Purpose\*\*: (.+)$/
Task:          /^- \[([ x~])\] (T\d+)\s*(?:\[([^\]]+)\])?\s*(.+)$/
```

Phase status is derived: all tasks `[x]` → "complete", all `[ ]` → "not_started", mixed → "partial".

### The Loop (`orchestrator.ts`)

```
orchestrator.run(config, emit):
  1. Parse tasks.md → phases[] (for status tracking)
  2. For each incomplete phase (in order, or filtered by config.phases):
     a. Re-parse tasks.md to get current status
     b. Skip phases where all tasks are [x]
     c. Emit phase_started { phase }
     d. Spawn fresh Claude Code agent via SDK:
        - prompt: "Run /speckit.implement for Phase {N}: {name}"
        - cwd: config.projectDir (CLAUDE.md + spec-kit skills load automatically)
        - settingSources: ["project"] (loads .claude/skills/ including spec-kit)
        - hooks: capture all steps, subagents, tool calls for UI
     e. Stream agent steps to UI in real-time
     f. When agent completes:
        - Emit validation_started
        - Run validator (build/typecheck)
        - If valid: git commit with "Phase {N}: {name}", emit phase_completed
        - If invalid: git restore, emit error, optionally retry once
     g. Pause if config.interactive (wait for user to confirm before next phase)
  3. Emit run_completed { totalCost, totalDuration, phasesCompleted }
```

### Agent Spawning with Step Capture

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

let stepIndex = 0;

for await (const msg of query({
  prompt: `Run /speckit.implement for Phase ${phase.number}: ${phase.name}`,
  options: {
    model: config.model,
    cwd: config.projectDir,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
    maxTurns: config.maxTurnsPerPhase,   // ~50-100 turns per phase
    permissionMode: "acceptEdits",
    streaming: true,
    settingSources: ["project"],          // loads spec-kit skills from .claude/skills/

    // Hooks capture every step for the Agent Trace UI
    hooks: {
      PreToolUse: [{ hooks: [async (input) => {
        emit({ type: "agent_step", step: toToolCallStep(input, stepIndex++) });
        return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
      }]}],
      PostToolUse: [{ hooks: [async (input) => {
        emit({ type: "agent_step", step: toToolResultStep(input, stepIndex++) });
        return { hookSpecificOutput: { hookEventName: "PostToolUse" } };
      }]}],
      SubagentStart: [{ hooks: [async (input) => {
        emit({ type: "subagent_started", info: toSubagentInfo(input) });
        emit({ type: "agent_step", step: toSubagentSpawnStep(input, stepIndex++) });
        return {};
      }]}],
      SubagentStop: [{ hooks: [async (input) => {
        emit({ type: "subagent_completed", subagentId: input.subagent_id });
        emit({ type: "agent_step", step: toSubagentResultStep(input, stepIndex++) });
        return {};
      }]}],
    },
  }
})) {
  // Capture text, thinking from streamed messages
  if (msg.type === "assistant") {
    for (const block of msg.content || []) {
      if (block.type === "text") {
        emit({ type: "agent_step", step: {
          id: crypto.randomUUID(),
          type: "text",
          content: block.text,
          metadata: null,
          sequenceIndex: stepIndex++,
          durationMs: null,
          tokenCount: null,
          createdAt: new Date().toISOString(),
        }});
      }
    }
  }
  if (msg.type === "result") {
    // Capture cost, duration from msg.total_cost_usd, msg.duration_ms
  }
}
```

No custom prompt builder needed — spec-kit's `/speckit.implement` skill handles loading spec.md, plan.md, contracts, data-model, and understanding what Phase N requires.

### Validation (`validator.ts`)

Runs after each phase. Generic: inspects `package.json` scripts at project root and in changed file directories.
1. Check for `build`, `typecheck`, `lint` scripts
2. Run whichever exist
3. For subdirectories with their own `package.json`, detect and run their builds too

### Git Helpers (`git.ts`)

- `commit(projectDir, message)` — one commit per phase: "Phase {N}: {name}"
- `restore(projectDir)` — `git checkout -- .` on validation failure
- `getCommitHash(projectDir)` — returns HEAD hash after commit

### Failure Handling

| Scenario | Action |
|---|---|
| Phase completed + validation passes | Commit, move to next phase |
| Phase completed + validation fails | `git restore`, retry once |
| Agent hits maxTurns | Emit error, skip phase |
| Agent errors out | Emit error, skip phase |

---

## Electron Layer (`src/main/`)

### IPC Channels

```typescript
// Request-Response (ipcMain.handle)
"project:open"          → dialog.showOpenDialog → returns project dir path
"project:list-specs"    → scans for specs/*/tasks.md → returns string[] of spec dir names
"project:parse-spec"    → runs parser → returns Phase[]
"orchestrator:start"    → starts run with RunConfig → returns void
"orchestrator:pause"    → pauses between phases → returns void
"orchestrator:stop"     → aborts current run → returns void

// Events: main → renderer (webContents.send)
"orchestrator:event"    → OrchestratorEvent (all types listed above)
```

### Preload (`preload.ts`)

```typescript
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("ralphAPI", {
  // Request-Response
  openProject: () => ipcRenderer.invoke("project:open"),
  listSpecs: (dir: string) => ipcRenderer.invoke("project:list-specs", dir),
  parseSpec: (dir: string, spec: string) => ipcRenderer.invoke("project:parse-spec", dir, spec),
  startRun: (config: RunConfig) => ipcRenderer.invoke("orchestrator:start", config),
  pauseRun: () => ipcRenderer.invoke("orchestrator:pause"),
  stopRun: () => ipcRenderer.invoke("orchestrator:stop"),

  // Events
  onOrchestratorEvent: (cb: (event: OrchestratorEvent) => void) => {
    const handler = (_e: any, data: OrchestratorEvent) => cb(data);
    ipcRenderer.on("orchestrator:event", handler);
    return () => ipcRenderer.removeListener("orchestrator:event", handler);
  },

  // Window controls
  minimize: () => ipcRenderer.invoke("window-minimize"),
  maximize: () => ipcRenderer.invoke("window-maximize"),
  close: () => ipcRenderer.invoke("window-close"),
});
```

### Main Process (`index.ts`)

- Frameless BrowserWindow (`frame: false`) with custom title bar
- Registers all IPC handlers
- Orchestrator IPC handler instantiates core orchestrator, forwards events via `webContents.send`

---

## Renderer (`src/renderer/`)

### Tech Stack (mirroring vex patterns)

- **React 18** — same as vex
- **CSS Custom Properties** — Catppuccin-inspired dark theme, no CSS framework
- **GSAP** — step insertion animations
- **Lucide React** — icons
- **Local component state** — useState/useEffect, no Redux/Zustand
- **No React Router** — single-page app

### Layout

```
┌─ Window Controls ──────────────────────────────────────────────┐
│  Ralph Claude                                    _ □ ×        │
├──────────────┬─────────────────────────────────────────────────┤
│  Sidebar     │  Task Board              │  Agent Trace        │
│              │                          │                     │
│  Project:    │  Phase 3: Newsletter ⚙️  │  ┃ 🧠 Thinking...  │
│  /kithable   │  ┌────────────────────┐  │  ┃ 📝 text output  │
│              │  │ ✅ T019 Sub sync   │  │  ┃ 🔧 Read file    │
│  Specs:      │  │ ⚙️ T020 Container  │  │  ┃   └─ result     │
│   001-core   │  │ ⚙️ T021 API routes │  │  ┃ 🤖 Agent spawn  │
│ > 002-ext    │  │ ○ T022 E2E test    │  │  ┃   ├─ [Explore]  │
│   003-auth   │  └────────────────────┘  │  ┃   └─ result     │
│              │                          │  ┃ 🔧 Edit file     │
│  Config:     │  Phase 4: Chat Zulip     │  ┃   └─ diff view   │
│  Model: [▾]  │  ┌────────────────────┐  │  ┃ ✅ Completed    │
│  Budget: [$] │  │ ○ T023 Zulip sync  │  │  │                 │
│  Turns: [75] │  │ ○ T024 Bot API     │  │  │  Subagents:     │
│  Phases: [▾] │  │ ○ T025 E2E test    │  │  │  [Explore ✅]   │
│              │  └────────────────────┘  │  │  [Plan ⚙️]       │
│  [▶ Start]   │                          │  │                 │
│  [⏸ Pause]   │  Progress: 3/11 phases  │  │  Cost: $2.10    │
│  [⏹ Stop]    │  Cost: $8.50  Time: 45m │  │  Turns: 32/75   │
└──────────────┴──────────────────────────┴──────────────────────┘
```

**3 resizable columns**:
1. **Sidebar** (left, ~200px) — project path, spec list, config inputs, run controls
2. **Task Board** (center) — phases with expandable task rows, progress bar at bottom
3. **Agent Trace** (right) — live step timeline for current phase's agent, subagent pills

### Agent Trace Components (inspired by vex `project-detail/`)

**`AgentStepList.tsx`** — Vertical timeline container:
- Thin vertical line (2px, `var(--border)`) on left side
- Circular nodes (10px) at each step
- GSAP animation on new steps: `opacity: 0→1`, `x: -20→0`, `scale: 0.97→1`, `duration: 0.4s`, `stagger: 0.06s`
- Auto-scroll to bottom when running (disable when user scrolls up manually)
- Groups detail steps into parent `tool_call`'s metadata
- Memoized step grouping: pairs `tool_result`/`tool_error` with their `tool_call`

**`AgentStepItem.tsx`** — Per-step renderer with type-specific styling:

| Type | Color | Icon | Display |
|---|---|---|---|
| `thinking` | Gray `hsl(0,0%,55%)` | Brain | Dark bg, italic text, left border |
| `text` | Blue `hsl(195,85%,55%)` | MessageSquare | Light blue bg, left border |
| `tool_call` | Varies by tool name | Tool-specific | ToolCard with badges |
| `tool_result` | Blue `hsl(220,50%,55%)` | — | Collapsible, indented under tool_call |
| `tool_error` | Red `var(--status-error)` | AlertTriangle | Red left border |
| `subagent_spawn` | Info blue | GitBranch | Blue card with type + description |
| `subagent_result` | Info blue | — | Indented under spawn |
| `completed` | Green `hsl(142,69%,55%)` | CheckCircle | Green shadow |

**`SubagentList.tsx`** — Horizontal pill badges:
- Running state: spinning `Loader2` icon
- Completed state: `CheckCircle` icon
- Shows subagent type + truncated description (40 chars)

**`ToolCard.tsx`** — Wraps tool_call steps:
- Header: icon + tool name badge (Bash=green, Read/Write/Edit=blue, MCP=teal)
- Body: rich input renderer based on tool name
- Footer: collapsible result/error

**Rich input renderers** (same patterns as vex `AgentStepItem.tsx`):
- `BashInput.tsx` — terminal `$` prefix, monospace font, green accent
- `WriteInput.tsx` — file path badge + scrollable content preview
- `EditInput.tsx` — diff view with `+`/`-` markers, red/green backgrounds
- `ReadInput.tsx` — simple file path badge
- `ToolResultStep.tsx` — collapsed by default, 120-char preview, click to expand

### Hooks

**`useOrchestrator.ts`**:
```typescript
function useOrchestrator() {
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [subagents, setSubagents] = useState<SubagentInfo[]>([]);
  const [currentPhase, setCurrentPhase] = useState<Phase | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [totalCost, setTotalCost] = useState(0);

  useEffect(() => {
    const unsub = window.ralphAPI.onOrchestratorEvent((event) => {
      switch (event.type) {
        case "phase_started":
          setCurrentPhase(event.phase);
          setLiveSteps([]);        // clear steps for new phase
          setSubagents([]);
          break;
        case "agent_step":
          setLiveSteps(prev => [...prev, event.step]);
          break;
        case "subagent_started":
          setSubagents(prev => [...prev, event.info]);
          break;
        case "subagent_completed":
          setSubagents(prev => prev.map(s =>
            s.subagentId === event.subagentId
              ? { ...s, completedAt: new Date().toISOString() }
              : s
          ));
          break;
        case "run_started":
          setIsRunning(true);
          break;
        case "run_completed":
          setIsRunning(false);
          setTotalCost(event.totalCost);
          break;
      }
    });
    return unsub;
  }, []);

  return { liveSteps, subagents, currentPhase, isRunning, totalCost };
}
```

**`useProject.ts`**:
```typescript
function useProject() {
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [specs, setSpecs] = useState<string[]>([]);
  const [selectedSpec, setSelectedSpec] = useState<string | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);

  const openProject = async () => {
    const dir = await window.ralphAPI.openProject();
    if (dir) {
      setProjectDir(dir);
      const specList = await window.ralphAPI.listSpecs(dir);
      setSpecs(specList);
    }
  };

  const selectSpec = async (specName: string) => {
    setSelectedSpec(specName);
    const parsed = await window.ralphAPI.parseSpec(projectDir!, specName);
    setPhases(parsed);
  };

  return { projectDir, specs, selectedSpec, phases, openProject, selectSpec };
}
```

---

## Data Flow

```
Claude Agent SDK (query + hooks)
        │
        ├─ streaming messages → text/thinking AgentSteps
        ├─ PreToolUse hook ──→ tool_call AgentStep
        ├─ PostToolUse hook ─→ tool_result AgentStep
        ├─ SubagentStart ────→ subagent_spawn AgentStep + SubagentInfo
        ├─ SubagentStop ─────→ subagent_result AgentStep
        └─ result message ───→ cost, duration
                │
        OrchestratorEvent
                │
        IPC: webContents.send("orchestrator:event", event)
                │
        Renderer: window.ralphAPI.onOrchestratorEvent(cb)
                │
        React state → AgentStepList → AgentStepItem (GSAP animated)
```

No NATS broker needed — the orchestrator runs in the Electron main process and emits directly via IPC.

---

## Implementation Sequence

### Phase 1: Scaffold + Core Engine
1. Init repo with `package.json`, `tsconfig.json`, `vite.config.ts`
   - Dependencies: `electron`, `vite`, `react`, `react-dom`, `@anthropic-ai/claude-agent-sdk`, `gsap`, `lucide-react`
   - Dev dependencies: `typescript`, `@types/react`, `@types/react-dom`, `electron-builder`
2. `src/core/types.ts` — all interfaces and type definitions
3. `src/core/schemas.ts` — JSON Schema if needed for structured output
4. `src/core/parser.ts` — tasks.md parser (for UI display + phase status detection)
5. `src/core/validator.ts` — generic build/typecheck runner
6. `src/core/git.ts` — commit/restore helpers
7. `src/core/orchestrator.ts` — phase-level loop with SDK hooks + event emission

### Phase 2: Electron Shell
8. `src/main/index.ts` — Electron app lifecycle, frameless BrowserWindow
9. `src/main/preload.ts` — contextBridge with `window.ralphAPI`
10. `src/main/ipc/handlers.ts` — register all IPC handlers
11. `src/main/ipc/project.ts` — open project dialog, list specs, parse spec
12. `src/main/ipc/orchestrator.ts` — bridge core orchestrator events to IPC

### Phase 3: Layout + Sidebar
13. `src/renderer/styles/theme.css` — Catppuccin dark theme with CSS custom properties
14. `src/renderer/components/layout/` — AppShell, Sidebar, WindowControls
15. `src/renderer/components/sidebar/` — SpecList, ConfigPanel, RunControls

### Phase 4: Task Board
16. `src/renderer/components/task-board/` — PhaseView, TaskRow, ProgressBar
17. Wire IPC: open project → list specs → parse → display phases in UI

### Phase 5: Agent Trace (the core differentiator)
18. `src/renderer/components/agent-trace/AgentStepList.tsx` — timeline + GSAP animations
19. `src/renderer/components/agent-trace/AgentStepItem.tsx` — type-based step rendering
20. `src/renderer/components/agent-trace/SubagentList.tsx` — horizontal pill badges
21. `src/renderer/components/agent-trace/ToolCard.tsx` — tool wrapper with badges
22. `src/renderer/components/agent-trace/` — BashInput, WriteInput, EditInput, ReadInput, ToolResultStep
23. Wire IPC: orchestrator events → live step state → animated timeline

### Phase 6: Integration + Polish
24. End-to-end: open project → select spec → configure → run phase → watch agent steps stream live
25. Error handling, pause/resume, stop functionality
26. Window controls, app icon, menu bar

---

## Verification

1. **Parser**: Open a project → select spec → verify all phases and tasks render with correct status icons
2. **Phase run**: Run one phase → agent uses `/speckit.implement` → all steps stream live in Agent Trace
3. **Subagent visibility**: Verify SubagentStart/Stop hooks fire and render as pills + timeline entries
4. **Tool cards**: Bash/Read/Write/Edit steps render with rich input displays + collapsible results
5. **Validation**: After phase completes, build/typecheck runs, commit created
6. **Auto-commit**: Verify git commit message is "Phase {N}: {name}"
7. **Generic**: Open a different project with spec-kit format → works without project-specific assumptions

---

## Key Reference Files

**Vex patterns to follow** (at `~/Projects/Github/lukaskellerstein/vex/electron-app/`):
- `src/renderer/components/project-detail/AgentStepList.tsx` — timeline container with GSAP animations
- `src/renderer/components/project-detail/AgentStepItem.tsx` — step rendering logic (1486 lines, main reference)
- `src/renderer/components/project-detail/SubagentList.tsx` — horizontal subagent pill display
- `src/renderer/utils/hook-steps.ts` — hook event → AgentStep conversion utility
- `src/renderer/styles/theme.css` — Catppuccin dark theme CSS custom properties
- `src/main/preload.ts` — IPC contextBridge pattern
- `package.json` — Electron + Vite build configuration

**Claude Agent SDK examples** (at `~/Projects/Github/lukaskellerstein/vibe-coding-course/5_Claude_Agent_SDK/`):
- All examples, especially hooks, streaming, and structured output patterns

**Spec-kit format reference** (at `~/Projects/Github/kithable/kithable/`):
- `specs/002-extension-integrations/tasks.md` — reference tasks.md format with phases and task checkboxes
- `specs/002-extension-integrations/spec.md` — reference spec with user stories
- `specs/002-extension-integrations/contracts/` — reference contract files
