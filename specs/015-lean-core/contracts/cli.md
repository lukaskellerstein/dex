# Contract: the `dex` CLI

`package.json` gains `"bin": { "dex": "dist/core/cli.js" }`. `cli.ts` imports
only `src/core` (no Electron) and drives the same `run()` the app does. The
parser is `cli/args.ts`, the dry-run and status views `cli/describe.ts`, the run
driver `cli/run.ts` and the terminal I/O `cli/terminal.ts`.

## Commands

```text
dex run <projectDir> [--once] [--dry-run] [--status] [--agent mock|claude]
dex queue init <projectDir>
```

| Flag | Behaviour |
|---|---|
| (none) | Resume-or-start: runs the picker loop until the queue is complete or the run pauses. It **resumes whenever `.dex/state.json` exists**, also after a completed run: a new project has one run branch, and Resume follows the checkout, so a reset to an earlier commit continues there. A new run uses `LOOP_DEFAULTS` (model `claude-opus-4-6`, 75 turns, 50 iterations) and starts with Automatic Clarification off; a resumed run keeps the setting in its state. |
| `--once` | Runs exactly one queue stage (one task phase for `implement`), then stops with `status: "paused"`, `pauseReason: "user_abort"`. It does not count a new project's prerequisites and clarification steps (`RunConfig.once`). |
| `--dry-run` | Loads queue + policy, prints a summary and one block per remaining entry, starts no agent, writes nothing (a v2 manifest migrates in memory only; git is read with `--no-optional-locks`). |
| `--status` | Prints the queue with derived status, the current stage, cost so far, and pending requests: the same `RunSnapshot` the app reads. Writes nothing. |
| `--agent` | `mock` or `claude`. Overrides `.dex/dex-config.json` `agent` (same precedence as `RunConfig.agent` today). |

`--dry-run`, `--status` and `--once` are mutually exclusive. Exactly one `<projectDir>` is required; anything else is a usage error (exit 2, with the usage text).

## `--dry-run` output (one block per remaining entry)

```text
queue    : .dex/queue.json · existing project
policy   : .dex/policy.json · deny 7 · ask 1 · frozen 2 · preflight 1 · questions recommended-then-review · pull request off
limits   : maxBudgetUsdPerStage=2 maxBudgetUsdPerRun=20 maxImplementRunsWithoutProgress=2 maxVerifyRounds=3

━━ 004-product-recommendations ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
decision : specify — specs/004-product-recommendations/spec.md is missing
branch   : switch to 003-customer-accounts (base), spec-kit creates 004-product-recommendations
env      : GIT_BRANCH_NAME=004-product-recommendations SPECIFY_FEATURE_DIRECTORY=specs/004-product-recommendations CLAUDE_NO_WORKTREE=1
options  : settingSources=user,project,local permissionMode=default maxTurns=… budget/stage=…
system   : claude_code preset + append .dex/loop-rules.md (1,204 chars)
prompt   :
  /speckit-specify …
  (full text, indented)
```

- Only entries that are `active` or `pending` get a block; with none, the output
  ends with "every entry is done or skipped". Each entry is judged on its own tree
  (its branch when it exists, else its base), so a later entry shows its *first*
  stage (`brief` or `specify`, or the first stage not in `skip`). An entry that
  cannot proceed prints `decision : pause — <reason>` and no prompt.
- The `branch` line says whether a switch would be refused now because the tree
  has uncommitted files. The `env` line shows the policy env and the stage env,
  never `process.env`. The `options` line comes from `buildQueryOptions`, the
  builder a real run uses.
- Policy and queue validation errors print first and exit 2 — a dry run is also
  the validation pass.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | queue complete, or `--dry-run` / `--status` / `--once` finished |
| 1 | the run failed (unhandled error), **or any `error` event was emitted** even if the loop carried on (a failed push, a broken mock config); exit 0 therefore proves nothing tried to push |
| 2 | usage error, invalid queue / policy, policy refused, or `dex queue init` over an existing queue |
| 3 | the run paused and needs a human (question, approval, gate, limit, dirty tree, frozen file, preflight), or Ctrl-C. A `--once` that ends with `user_abort` and was not interrupted is 0 |

## Human input on the terminal

- **TTY** (`process.stdin.isTTY`): questions print with numbered options; the
  recommended one is marked and is the default on Enter. Tool approvals print
  the tool, the subject (full Bash command or path), the rule or "project
  settings", and read `y` / `n`.
- **No TTY**: the request is parked (`parkAll`): the agent gets the stop answer so
  the stage can unwind, the request stays in `state.json` and `.dex/questions.md`,
  and the run aborts with `WaitingForHuman`. The state pauses `question` or
  `tool_approval`, the run record says paused (not stopped), exit 3.
- **Ctrl-C** is Stop: held requests are denied or released, the run pauses
  `user_abort`, exit 3.
- **Resume with a TTY after a no-TTY pause**: `dex run` first prints the pause
  requests from the last run and reads the parked questions and approvals into the
  answer book. Resume then drops every pending request (`clearStaleRequests`), and
  the re-run stage's matching request is answered from the book (data-model.md
  § Pending request). The recommended option is the Enter default; typed text is
  taken as the answer.
- A terminal-answered question is printed as `? <question> → <answer>` when it
  was answered by default or from the book, so the trace shows it.

## `.dex/questions.md` (runtime, regenerated on every change)

````markdown
# Dex — waiting for you

Run: 3f1c… · paused 2026-11-12T09:41:00.000Z · reason: tool_approval

## 1 · Approve a tool call (004-product-recommendations)

**Bash** (settings — project settings ask rule Bash(git push:*))

```text
git push -u origin 004-product-recommendations
```

Options: Approve / Deny

Answer in the Dex app, or with `dex run <projectDir>` in a terminal.

## Answered by default — review (recommended-then-review)

- (004-product-recommendations · clarify) "Which signal ranks recommendations first?" → **purchase history** (recommended)
````

A question renders as `## n · Question (<entry>)` with numbered options, a pause as
`## n · Paused: <reason> (<entry>)` with its detail and options. With nothing
waiting but a non-empty review list the file says "Nothing waits for you right
now." above the review section. The file is removed when there is neither.
