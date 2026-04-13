---
description: "Step 4: Testing — define DoD, test with MCP tools against Electron (CDP port 9222), fix and repeat until passing"
---

# Step 4: Testing

**Every code change must be tested before reporting completion. No exceptions.**

## 4a. Define your Definition of Done

Before testing, **write out your DoD checklist in the conversation** so the user can see what you intend to verify. Example:

> **Definition of Done for this task:**
> - [ ] The new component renders correctly in the app
> - [ ] Clicking the button triggers the expected action
> - [ ] Status updates are reflected in the UI

## 4b. MCP Server & CDP Port

One chrome-devtools MCP server is configured in `.mcp.json`:

| MCP Server | CDP Port | Target | Use For |
|---|---|---|---|
| `electron-chrome` | 9222 | Electron app | All UI changes (renderer pages, components, IPC-driven UI) |

Tools available: `mcp__electron-chrome__take_snapshot`, `mcp__electron-chrome__take_screenshot`, `mcp__electron-chrome__click`, `mcp__electron-chrome__evaluate_script`, `mcp__electron-chrome__fill`, `mcp__electron-chrome__navigate_page`, etc.

## 4c. Test

**UI / Renderer changes** — use `electron-chrome` MCP (CDP port 9222):
1. Ensure `dev-setup.sh` is running.
2. Use `mcp__electron-chrome__*` tools to verify the change is visible and functional.

**Core engine changes** (`src/core/`):
1. Run `npx tsc --noEmit` to verify types compile.
2. If unit tests exist, run them.
3. If the change affects UI behavior, verify via `electron-chrome` MCP.

**IPC / Main process changes**:
1. Verify the Electron app starts without errors (check `/tmp/ralph-claude-logs/electron.log`).
2. Test IPC round-trips via `mcp__electron-chrome__evaluate_script` calling `window.ralphAPI.*` methods.

**Non-testable changes** (docs, config, build scripts): explicitly state why no runtime test is needed.

## 4d. Fix and repeat

If a test fails: fix the issue, then retest. Repeat until all DoD items pass. If you encounter a problem that you repeatedly cannot resolve, ask the user for help.

## 4e. Process log reading

`dev-setup.sh` writes each process's output to log files under `/tmp/ralph-claude-logs/`:
- `/tmp/ralph-claude-logs/vite.log` — Vite dev server
- `/tmp/ralph-claude-logs/electron.log` — Electron app

Use the `Read` tool to inspect these logs when debugging. Logs are truncated on each `dev-setup.sh` restart, so they always reflect the current session.
