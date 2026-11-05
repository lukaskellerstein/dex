# WORKFLOW — MANDATORY FOR ANY PROMPT THAT RESULTS IN CODE CHANGES

**If you are going to use the Edit or Write tool, you MUST complete all applicable steps below before reporting completion.** This applies to every type of work: bug fixes, features, refactoring, config changes — no exceptions.

Execute these steps in order. Do NOT skip steps.

1. **Understand** — Read relevant code, ask clarifying questions, identify gaps and opportunities. For bugs: reproduce the issue first.
2. **Plan** — Create a plan, get user approval, iterate if needed *(skip for trivial changes)*
3. **Spec Documentation** — Update spec via `/sync-spec-kit` *(skip on `main` branch or trivial changes)*
4. **Implement** — Write the code
5. **Test** — Define DoD checklist, test, fix, repeat until it works *(see `.claude/rules/06-testing.md`)*
6. **Feature Documentation** — Update docs via `/update-feature-docs` *(skip on `main` branch or trivial changes)*
7. **Report** — Short summary: what was done, what was tested, whether docs were updated

**NEVER report completion without first testing.** If you write code and stop without verifying it works, you have failed. Testing is YOUR responsibility — the user should never need to ask you to test.

**Trivial changes** (typo, one-line fix, config tweak): skip steps 2, 3, and 6. State what you'll do and proceed.

**On `main` branch**: skip steps 3 and 6 — spec and feature docs are tied to feature branches only.

## Dex at a glance

- **What it is** — an Electron desktop app that orchestrates Claude Code instances for spec-kit projects. "Ralph Wiggum" approach: a fresh agent per phase, each with clean context, so tokens never bloat across a run.
- **Three layers** — `src/main/` (Electron main + IPC), `src/core/` (platform-agnostic orchestrator, no Electron imports, testable standalone), `src/renderer/` (React 18 UI).
- **Dev loop** — `dev-setup.sh` starts Vite + Electron and exposes CDP on **port 9333**; readiness is `ready in` in `~/.dex/dev-logs/vite.log` and `DevTools listening on ws://127.0.0.1:9333` in `electron.log`.
- **Tests** — `npm test` = core (`node --test`) + renderer (`vitest run`) + `check:size`. Types: **`npm run typecheck`** — a bare `npx tsc --noEmit` covers only `src/main/` + `src/core/` and skips the renderer and the core tests entirely. See `CLAUDE.md` § Commands for the three configs.
- **End-to-end testing runs against a second repo** — `~/Projects/Github/lukaskellerstein/dex-ecommerce`, reset via `scripts/reset-example-to.sh`. It is the only repo the destructive scripts may touch.
- **State lives outside the app** — `~/.dex/logs/<project>/<runId>/` for the per-run log tree, `<projectDir>/.dex/` for per-project state. No database; SQLite was retired in 007.

Full facts → [`rules/01-project-config.md`](rules/01-project-config.md); stack and conventions → [`rules/10-tech-stack.md`](rules/10-tech-stack.md); the machine CLIs → [`rules/machine-tools.md`](rules/machine-tools.md) (the `nvim-tools` and `lukas-ps` CLIs — pre-approved, read-only); symbol navigation → [`rules/lsp.md`](rules/lsp.md) (the `LSP` tool — only in repos that opted in, and deferred, so it must be loaded before it can be called).

## Standing authorizations — do NOT ask before doing these

These actions are pre-approved. Run them yourself when the situation calls for it.

### Read-only inspection (always safe)

- Read any file in this repo, and in `dex-ecommerce`; `git status` / `git log` / `git diff` in either.
- Read `~/.dex/dev-logs/*.log` and the `~/.dex/logs/` run tree — the diagnostics map is `rules/06-testing.md` § 4f.
- Query app state via `mcp__electron-playwright__browser_snapshot` / `browser_console_messages` / `browser_evaluate` against the running dev server.

This machine's own `nvim-tools` and `lukas-ps` are pre-approved too, and are
documented once in [`rules/machine-tools.md`](rules/machine-tools.md) — do not
restate them here. Two things about *this* repo make them worth reaching for:
`dev-setup.sh` leaves Vite, Electron and a CDP endpoint running at once, so
memory questions here are about a process *tree*, not a process; and the repo is
markdown-heavy (210 tracked `.md` against 117 `.ts`), so most of what the
repo-wide check reports is prose, not code.

### Pre-approved mutations

- **Start / restart `dev-setup.sh`** when the dev server (Vite + Electron + CDP on port 9333) is down or stale. Run it in the background and wait for the readiness lines in `~/.dex/dev-logs/{vite,electron}.log`. Details: `.claude/rules/06-testing.md` § Step 2.
- **Run `scripts/reset-example-to.sh`** (any mode — `initial`, `pristine`, `clean`, `<checkpoint>`, `list`) against the `dex-ecommerce` example project. **Only** authorized against that one repo. Note: `initial` force-pushes `origin/main` back to the root commit and deletes all non-main branches on origin — only use it when the scenario calls for a true blank slate.
- **Run `scripts/prune-example-branches.sh`** and **`scripts/promote-checkpoint.sh`** against `dex-ecommerce`.
- **Drive the running app via CDP** (`mcp__electron-playwright__*`) including state-mutating clicks against the dex-ecommerce session.

### Requires confirmation — always ask first

- Anything outside the list above — pushing, force-resetting, deleting branches in the `dex` repo itself, mutating non-`dex-ecommerce` projects.
- `git push`, `git push --force`, branch deletes — **never commit unless the user explicitly asks**.
- Anything touching secrets, tokens or credential files. A secret never enters this repo in plaintext; if one must be versioned at all it is SOPS+age — see [`rules/12-security.md`](rules/12-security.md).

When in doubt: ask. `reset-example-to.sh initial` force-pushes `origin/main` on a real GitHub repo back to its root commit and deletes every other remote branch — the destructive authorizations here are scoped to `dex-ecommerce` precisely because that is not recoverable from this machine.
