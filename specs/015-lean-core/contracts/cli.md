# Contract: the `dex` CLI

`package.json` gains `"bin": { "dex": "dist/core/cli.js" }`. `cli.ts` imports
only `src/core` (no Electron) and drives the same `run()` the app does.

## Commands

```text
dex run <projectDir> [--once] [--dry-run] [--status] [--agent mock|claude]
dex queue init <projectDir>
```

| Flag | Behaviour |
|---|---|
| (none) | Resume-or-start: runs the picker loop until the queue is complete or the run pauses. |
| `--once` | Runs exactly one stage (one task phase for `implement`), then stops with `status: "paused"`, `pauseReason: "user_abort"`. |
| `--dry-run` | Loads queue + policy, prints one block per remaining entry, starts no agent, writes nothing. |
| `--status` | Prints the queue with derived status, the current stage, cost so far, and pending requests. Writes nothing. |
| `--agent` | Overrides `.dex/dex-config.json` `agent` (same precedence as `RunConfig.agent` today). |

`--dry-run` and `--status` are mutually exclusive with each other and with `--once`.

## `--dry-run` output (one block per remaining entry)

```text
━━ 021-agent-entry ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
decision : specify — spec folder specs/021-agent-entry is missing
branch   : switch to 020-onion-thin-layer (base), spec-kit creates 021-agent-entry
env      : GIT_BRANCH_NAME=021-agent-entry SPECIFY_FEATURE_DIRECTORY=specs/021-agent-entry CLAUDE_NO_WORKTREE=1
options  : settingSources=user,project,local permissionMode=default maxTurns=… budget/stage=…
system   : claude_code preset + append .dex/loop-rules.md (1,204 chars)
prompt   :
  /speckit-specify …
  (full text, indented)
```

- Each entry is evaluated as if every earlier entry were done, so later entries
  show their *first* stage (`brief` or `specify`, or the first stage not in `skip`).
- Policy and queue validation errors print first and exit 2 — a dry run is also
  the validation pass.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | queue complete, or `--dry-run` / `--status` / `--once` finished |
| 1 | the run failed (unhandled error) |
| 2 | usage error, or invalid queue / policy / policy refused |
| 3 | the run paused and needs a human (question, approval, gate, limit, dirty tree, frozen file, preflight) |

## Human input on the terminal

- **TTY** (`process.stdin.isTTY`): questions print with numbered options; the
  recommended one is marked and is the default on Enter. Tool approvals print
  the tool, the subject (full Bash command or path), the rule or "project
  settings", and read `y` / `n`.
- **No TTY**: the request is persisted (`state.json` + `.dex/questions.md`), the
  stage is aborted, the run pauses, exit 3.
- **Resume with a TTY after a no-TTY pause**: `dex run` first prints the pending
  requests from the last pause and reads the answers into the answer book. The
  re-run stage's matching request is answered from the book (data-model.md
  § Pending request).

## `.dex/questions.md` (runtime, regenerated on every change)

```markdown
# Dex — waiting for you

Run: 3f1c… · paused 2026-11-12T09:41Z · reason: tool_approval

## 1 · Approve tool call? (021-agent-entry · implement · phase 3)

Bash: `helm upgrade --install postara ./charts/postara -n postara`
Source: project settings (ask)

Answer with `dex run <projectDir>` in a terminal.

## Answered by default — review (recommended-then-review)

- (021 · clarify) "Which namespace hosts the agent?" → **listovna** (recommended)
```
