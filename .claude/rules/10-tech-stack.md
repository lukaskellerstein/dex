---
description: "Reference: Technology stack — Electron, React 18, Vite, Claude Agent SDK, GSAP"
---

# Reference: Technology Stack

## Desktop App

- **Framework**: Electron (frameless BrowserWindow with custom title bar)
- **Build Tool**: Vite (renderer bundling)
- **Language**: TypeScript with strict mode throughout

## Frontend (Renderer)

- **UI Library**: React 18
- **State Management**: Local component state (useState/useEffect) — no Redux/Zustand
- **Styling**: CSS Custom Properties (Catppuccin-inspired dark theme) — no Tailwind, no CSS frameworks
- **Animations**: GSAP (step insertion animations in Agent Trace timeline)
- **Icons**: Lucide React
- **Routing**: None — single-page app

## Orchestration Engine (Core)

- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` — spawns Claude Code agents via `query()` async generator
- **Hooks**: PreToolUse, PostToolUse, SubagentStart, SubagentStop for step capture
- **Design**: Platform-agnostic (pure Node.js, no Electron imports) — can be tested standalone

## IPC

- **Pattern**: `ipcMain.handle` for request-response, `webContents.send` for event streaming
- **Bridge**: `contextBridge.exposeInMainWorld("ralphAPI", ...)` in preload script

## Scripting & Automation

- Default: TypeScript/Node.js for scripts (consistent with the rest of the stack)
- Shell scripts only for trivial one-liners
