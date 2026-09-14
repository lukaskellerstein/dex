---
description: "Reference: worktrees — which checkout belongs to this session and how each agent moves between checkouts."
---

# Worktrees — where you work

Every edit, command, and test stays inside the checkout assigned to the current
session. Never reach into the main checkout or a sibling worktree by path. A
refusal from the sandbox or workspace guard names a boundary, not a problem to
route around.

Start by reading `pwd`, `git branch --show-current`, and the session-start guard
line. Another session may share or update the same checkout, so re-read a file
before editing it. Never commit, push, merge, delete a branch, or remove a
worktree unless the user explicitly asks for that exact action.

## Claude Code

Claude Code uses this machine's repository convention:

- Normal change sessions start with `claude -w <name>` and live in
  `<repo>/.worktrees/<name>` on branch `<name>`.
- The main checkout is read-only unless the user deliberately launched
  `claude --no-worktree`; the guard line identifies that exception.
- Do not call `EnterWorktree`, `ExitWorktree`, or `git worktree add/remove`.
  Let the user choose the session's checkout.

## Codex

Codex uses its native Local/Worktree model rather than Claude's create/remove
hooks:

- **Local** means the user's foreground checkout. Work there only when the
  session is in Local.
- **Worktree** means the managed checkout assigned to the chat, normally under
  `$CODEX_HOME/worktrees` and initially on a detached HEAD.
- Use Codex **Handoff** to move the chat and its changes between Local and the
  associated Worktree. Do not reproduce Handoff with `git checkout`,
  `git switch`, `git worktree add`, or `git worktree remove`.
- If a long-lived branch is wanted, the user chooses **Create branch here** or
  creates a permanent worktree. Do not commit merely because the worktree is
  detached; the no-commit rule still applies.

Tracked files—including relative symlinks—arrive through the Git checkout.
Ignored files do not. When a managed worktree needs ignored, non-secret local
setup files, list them in root `.worktreeinclude`. Never put credentials,
tokens, `.env` files, or other secrets there under this repository policy.

## Finishing

Run the project's verification in the same checkout. Dependencies and build
artifacts are checkout-local unless the project explicitly shares them, and
parallel worktrees may contend for the same dev-server port. Pick another port
when safe and report it. Leave branch integration and worktree cleanup to the
user or the agent's native lifecycle unless explicitly requested.
