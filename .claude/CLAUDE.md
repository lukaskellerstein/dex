# WORKFLOW — MANDATORY FOR ANY PROMPT THAT RESULTS IN CODE CHANGES

**If you are going to use the Edit or Write tool, you MUST complete all applicable steps below before reporting completion.** This applies to every type of work: bug fixes, features, refactoring, config changes — no exceptions.

Execute these steps in order. Do NOT skip steps.

1. **Understand** — Read relevant code, ask clarifying questions, identify gaps and opportunities. For bugs: reproduce the issue first.
2. **Plan** — Create a plan, get user approval, iterate if needed *(skip for trivial changes)*
3. **Implement** — Write the code
4. **Test** — Define DoD checklist, test, fix, repeat until it works *(see Step 4 below)*
5. **Report** — Short summary: what was done, what was tested

**NEVER report completion without first testing.** If you write code and stop without verifying it works, you have failed. Testing is YOUR responsibility — the user should never need to ask you to test.

**Trivial changes** (typo, one-line fix, config tweak): skip step 2. State what you'll do and proceed.

## Standing authorizations — do NOT ask before doing these

These actions are pre-approved. Run them yourself when the situation calls for it.

- **Start / restart `dev-setup.sh`** when the dev server (Vite + Electron + CDP on port 9333) is down or stale. Run it in the background and wait for the readiness lines in `~/.dex/dev-logs/{vite,electron}.log`. Details: `.claude/rules/06-testing.md` § Step 2.
- **Run `scripts/reset-example-to.sh`** (any mode — `pristine`, `clean`, `<checkpoint>`) against the `dex-ecommerce` example project. **Only** authorized against that one repo.
- **Run `scripts/prune-example-branches.sh`** and **`scripts/promote-checkpoint.sh`** against `dex-ecommerce`.
- **Drive the running app via CDP** (`scripts/test-014-cdp.mjs` or `mcp__electron-chrome__*`) including state-mutating clicks against the dex-ecommerce session.

Anything outside this list — pushing, force-resetting, deleting branches in the `dex` repo itself, mutating non-`dex-ecommerce` projects, etc. — still requires confirmation.
