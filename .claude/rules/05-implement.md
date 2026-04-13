---
description: "Step 4: Implement — coding rules, Electron/React dev workflow"
---

# Step 4: Implement

Write clean code from the start. Follow these rules during implementation:

- Do NOT commit via `git` unless explicitly instructed by the user
- Do NOT start the dev server — the user runs it manually
- When creating diagrams or graphs, use `mermaid`
- Write clean code from the start — don't plan to "clean it up later"
- Refactor continuously — improve code structure immediately when you see issues
- Remove dead code — delete unused functions, variables, imports, and commented code
- After writing code: review comments, clean up imports, check for side effects

## Core Engine (`src/core/`)

Platform-agnostic orchestrator — no Electron imports. Can be tested standalone.

- `orchestrator.ts` — main loop: parse → select phase → spawn agent → validate → next
- `parser.ts` — tasks.md parser for UI display and phase status detection
- `validator.ts` — runs build/typecheck after each phase
- `git.ts` — commit/restore helpers
- `types.ts` — shared interfaces (Phase, Task, AgentStep, OrchestratorEvent, etc.)

## Electron Main Process (`src/main/`)

- IPC handlers bridge the core orchestrator to the renderer
- Preload script exposes `window.ralphAPI` via contextBridge
- All orchestrator events flow through IPC: `webContents.send("orchestrator:event", event)`

## Renderer (`src/renderer/`)

- React 18 with local component state (useState/useEffect) — no Redux/Zustand
- CSS Custom Properties for theming (Catppuccin-inspired dark theme) — no Tailwind, no CSS frameworks
- GSAP for step insertion animations in Agent Trace
- Lucide React for icons
- No React Router — single-page app

## Repository Structure

```
ralph-claude/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main/           # Electron main process
│   │   ├── index.ts    # App lifecycle, BrowserWindow, IPC
│   │   ├── preload.ts  # contextBridge → window.ralphAPI
│   │   └── ipc/        # IPC handler registration
│   ├── core/           # Orchestrator engine (pure Node.js)
│   │   ├── orchestrator.ts
│   │   ├── parser.ts
│   │   ├── validator.ts
│   │   ├── git.ts
│   │   └── types.ts
│   └── renderer/       # React app
│       ├── App.tsx
│       ├── styles/
│       ├── components/
│       └── hooks/
└── index.html
```
