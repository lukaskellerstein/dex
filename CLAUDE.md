# Dex Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-04-16

## Active Technologies
- `better-sqlite3` (audit trail, unchanged), `.dex/state.json` (new — primary state), filesystem artifacts with SHA-256 integrity hashing (002-filesystem-state-management)

- TypeScript (strict mode), Node.js (Electron 30+) + `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18, GSAP, Lucide React (001-autonomous-loop)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript (strict mode), Node.js (Electron 30+): Follow standard conventions

## Recent Changes
- 002-filesystem-state-management: Added TypeScript (strict mode), Node.js (Electron 30+) + `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18

- 001-autonomous-loop: Added TypeScript (strict mode), Node.js (Electron 30+) + `@anthropic-ai/claude-agent-sdk` ^0.1.0, `better-sqlite3` ^12.9.0, Electron ^30.0.0, React 18, GSAP, Lucide React

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
