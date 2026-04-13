---
description: Project configuration — architecture, paths, dev environment
---

# Project Config

- **Project**: Ralph Claude — Electron desktop app that orchestrates Claude Code instances for spec-kit projects
- **Concept**: "Ralph Wiggum" approach — spawn fresh Claude Code instances per phase of work, each with clean context to prevent token bloat
- **Architecture**: Electron (main process) + React 18 (renderer) + Claude Agent SDK (orchestration engine)
- **Structure**: `src/main/` (Electron main process + IPC), `src/core/` (platform-agnostic orchestrator engine), `src/renderer/` (React UI)
- **Build**: Vite for renderer bundling, TypeScript throughout
- **Key dependency**: `@anthropic-ai/claude-agent-sdk` — spawns Claude Code agents via `query()` with hooks for step capture
- **Design**: Frameless BrowserWindow with custom title bar, 3-column layout (sidebar, task board, agent trace)
