# Research: 015 Lean Core

Each entry: **Decision**, **Rationale**, **Alternatives considered**. Line
references are to the tree at commit `7ec23aa`.

## R1 — Agent SDK upgrade (D-015-10)

**Decision.** Upgrade `@anthropic-ai/claude-agent-sdk` from 0.1.77 (lockfile)
to **0.3.318** (published 2026-11-03, bundles Claude Code 2.1.318) in Phase 0.
Fix only what the upgrade breaks, then make one real `specify` run before
deleting anything.

**What the upgrade alone breaks or changes** (changelog entries in brackets):

| Change | Effect on Dex | Fix in Phase 0 |
|---|---|---|
| SDK sessions use `TaskCreate`/`TaskUpdate`, not `TodoWrite` [0.3.142, 0.3.233, 0.3.268] | `onTodoWrite` never fires (`ClaudeAgentRunner.ts:516–533`) | Drop the TodoWrite path. A PostToolUse on a write to `<specDir>/tasks.md` re-parses the file and emits `tasks_updated`. This is file-derived, and it removes `RunTaskState.updateFromTodoWrite` and its promote-only merge. |
| About 29 `system` message subtypes now arrive [0.3.142] | every `type === "system"` frame is treated as init (`:624`) | check `subtype === "init"` |
| `options.env` **replaces** `process.env` [0.2.113] | — | always `{ ...process.env, ...policy.env, ...stageEnv }` |
| Default `systemPrompt` is still `""` | Dex agents run **without** the Claude Code preset today | use `{ type: "preset", preset: "claude_code", append? }` always. This changes behaviour, so the Phase 0 real `specify` run is the check. |
| `result.usage` covers the main loop only; use `modelUsage` [0.3.223] | token totals undercount (`:299–305`, `:733–739`) | sum `modelUsage`; keep `total_cost_usd` |
| `canUseTool` + `bypassPermissions` warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` [0.3.198] | warning on every `runStep` | gone in Phase 3, when bypass goes |
| `runTaskPhase` never passes `abortController` to `query()` (`:441–447`) | an existing bug: Stop leaves the CLI running | one `buildQueryOptions()` for both call sites |
| Peer dependencies `zod ^4`, `@anthropic-ai/sdk >=0.93`, `@modelcontextprotocol/sdk ^1.29` | npm installs them | none |
| The bundled `cli.js` is replaced by a per-platform native binary (~320 MB on darwin-arm64) [0.2.113] | `node_modules` grows a lot; a packaged Electron build would need it outside asar | none for dev; note it for packaging |

Found during the Phase 0 upgrade (2026-11-05), not in the table above:

| Change | Effect on Dex | Fix in Phase 0 |
|---|---|---|
| `permissionMode: "bypassPermissions"` needs `allowDangerouslySkipPermissions: true` [`Options` docs, 0.3.318] | without it the session refuses the mode | set the flag next to bypass in `buildQueryOptions`; both go in Phase 3 |
| — (Dex's own table, `agent/steps.ts`) | the running cost estimate priced `claude-opus-4-6` at $15/$75 (the real price is $5/$25) and matched the shortest prefix first | current price list, longest prefix first; the result's `total_cost_usd` still replaces the estimate |

`npm run typecheck` needed no change for the 0.3 hook and `canUseTool`
signatures. The runner's two `query()` call sites now share one module,
`agent/claudeSession.ts` (`buildQueryOptions` + one message loop), so
`runStep` also gets the init debug step and a real `sessionId`.

Still compatible: the hook input fields Dex reads (`tool_name`, `tool_input`,
`tool_use_id`, `tool_response`, `agent_id`), `outputFormat` → `structured_output`,
and the AskUserQuestion `answers` shape.

**Alternatives considered.** Staying on 0.1.x: the permission work (R6) needs
the hook `ask` → `canUseTool` routing fixed in 0.2.85, and the changes above
would land later inside the deletion diffs, which is what D-015-10 exists to
avoid.

**Live stage, T012 (2026-11-05, SDK 0.3.318).** One real `specify` stage with
`scripts/smoke-stage.mjs` on a scratch clone of dex-ecommerce `main` (spec-kit
set up, `GOAL_clarified.md` present, origin a scratch bare repo).

| What | Result |
|:--|:--|
| Model, limits | `claude-haiku-5-5`, `maxTurns` 25, `maxBudgetUsdPerStage` 0.5 from the clone's policy |
| Outcome | `success`, no limit hit, 7 turns |
| Cost, time | $0.0132, 36.1 s, 6,721 output tokens |
| Written | `specs/004-promo-codes/spec.md` and `checklists/requirements.md`, via `/speckit-specify` |
| System prompt | the `claude_code` preset: `buildQueryOptions` sets it whenever the policy has no append file |

Odd things, all fixed or recorded:

- The shell carried an `ANTHROPIC_API_KEY` that the API rejects (`Invalid API
  key`). Every agent Dex starts inherits it, because `env` passes
  `process.env` through. The runs here drop that one variable
  (`env -u ANTHROPIC_API_KEY`), so the agents use the Claude Code login.
- `smoke-stage.mjs` was stale: it printed `result.subtype`, which `limitHit`
  replaced, and it gave the runner no `policy`. It now loads the project's
  policy, so the stage limits apply, and reads `DEX_MODEL` and
  `DEX_MAX_TURNS`.

## R2 — Entry status is derived from files; Dex never writes `queue.json` during a run

**Decision.** `status` in `queue.json` is human-owned and optional (`done` /
`skipped` overrides). The picker derives `done` from `verify.md` and `active` /
`pending` from position. Dex writes `queue.json` only in three setup moments:
manifest extraction, the v2 migration, and `dex queue init`. The run's own view
of status lives in the picker's output, never in a tracked file.

**Rationale.**

- The brief has Dex "mark the entry done in the queue". But `queue.json` is
  tracked and Dex never commits (D-015-2). An uncommitted status edit makes the
  tree dirty, which blocks the next branch switch (D-015-2 pauses on a dirty
  tree), and a checkout to a branch whose committed `queue.json` differs refuses
  outright.
- A written status also breaks D-015-1's own promise: after a reset to an older
  commit, the file says `done` for an entry whose `verify.md` no longer exists.
  A derived status cannot go stale.
- The spec's first draft papered over this with "the clean-tree check ignores
  `.dex/`". That rule does not survive a checkout that would overwrite the
  file, so the spec's FR-024 and its Assumptions are amended to match this
  decision.

**Alternatives considered.**

- *Dex writes status, `.dex/` changes do not count as dirty* — fails on
  `git switch` when the target branch's `queue.json` differs; stale after reset.
- *Status in `state.json`* — untracked, so it survives a reset and goes stale:
  the reconciliation problem again.

## R3 — The picker reads each entry's own branch through git, not a checkout

**Decision.** For each entry the picker reads files from a *tree*:

| Entry state | Tree |
|---|---|
| `kind: "new"` | the working tree (one run branch for all entries) |
| `kind: "existing"`, `branch` exists | the working tree if it is the current branch, else `git show <branch>:<path>` |
| `kind: "existing"`, `branch` does not exist | the resolved `baseBranch` (working tree if current, else `git show`) — only `brief` and `specify` can be next |

A small `TreeReader` interface (`exists(path)`, `read(path)`) has two
implementations: `workingTree(dir)` and `gitRef(dir, ref)` (`git cat-file -e` /
`git show`). The picker walks entries in order and returns the first
non-done entry's decision; it switches no branch.

**Rationale.**

- In `onion-demo-01`, entry N's `verify.md` lives on branch N. Deciding whether
  N is done while the checkout is on N+1 needs N's files without a checkout, or
  every picker call would flip branches.
- The working tree is used for the current branch so that uncommitted progress
  (checked tasks after a Stop mid-`implement`) counts. That is what makes "Stop
  is a pause" true.
- `describeQueue` (queue panel, `--status`, `--dry-run`) is the same code, and
  it must never switch branches.

**Alternatives considered.** Checking out each entry's branch to evaluate it —
slow, needs a clean tree just to look, and mutates the user's checkout from a
read-only view.

## R4 — Branch handling (D-015-2): switch only right before a stage

**Decision.** After the picker returns `{stage}`, `prepareBranch(entry, stage)`
runs for an existing project:

- `stage` is `brief` or `specify` → the target is the resolved `baseBranch`;
- any later stage → the target is the entry's `branch`.

If HEAD is already the target, nothing happens. Otherwise, if the tree is
clean, `git switch <target>`; if it is dirty, the run pauses (`dirty_tree`)
with the list of dirty files. A new project creates its `dex/<date>-<id>` run
branch once at the first run (as today) and never switches after that.

**Clean** = `git status --porcelain=v1 --untracked-files=normal` is empty after
dropping Dex's runtime paths (`.dex/state.json`, `.dex/state.lock`,
`.dex/runs/`, `.dex/questions.md`, `.dex/ui.json`). Untracked files count as
dirty, because an agent's leftovers would ride along onto another branch.

`createBranch` stays only in the new-project path. The build-mode call at
`run-lifecycle.ts:78` and `createPullRequest` at `:303` become conditional:
`createPullRequest` runs only when `policy.openPullRequest` is true, for either
kind.

**Rationale.** It is the brief's two rules and nothing more. Read-only picking
(R3) means the switch happens exactly once per stage, right before the agent
needs the files.

## R5 — `SPECIFY_FEATURE_DIRECTORY` through the agent's environment, not `.specify/feature.json`

**Decision.** For `specify`, `clarify`, `plan`, `tasks`, `implement` and
`verify`, Dex sets `SPECIFY_FEATURE_DIRECTORY=<specDir>` in the agent's `env`
and puts the absolute spec path in the command arguments (as today). For
`specify` in an existing project it also sets `GIT_BRANCH_NAME=<branch>`. Dex
does not write `.specify/feature.json`.

**Rationale.**

- spec-kit's `common.sh` resolves the feature folder from
  `SPECIFY_FEATURE_DIRECTORY` first and `.specify/feature.json` second (lines
  198–215). The env variable wins and writes nothing.
- `.specify/feature.json` is tracked in spec-kit projects (it is modified in
  this very checkout). Writing it before each stage would make the tree dirty
  and block the next branch switch, which is the R2 problem again.
- `GIT_BRANCH_NAME` is read by the git extension's `create-new-feature.sh`
  (line 306), so the branch gets the exact queue name.
- The check-only prerequisites (R12) confirm the project's `common.sh` knows
  `SPECIFY_FEATURE_DIRECTORY`, and fail with a clear message on an older
  spec-kit.

**Alternatives considered.** Writing `feature.json` as the brief says — rejected
for the dirty-tree reason above. Setting the variables only in the prompt text —
the hook script reads the process environment, not the prompt.

## R6 — Policy enforcement and the permission chain (D-015-3)

**The SDK's order** (0.3.318 docs and `.d.ts`): PreToolUse hooks → settings
`deny` rules → settings `ask` rules → permission mode → settings `allow` rules
→ `canUseTool`.

- A hook `allow` skips mode, allow rules and the callback, but **not** deny or
  ask rules. A hook `deny` wins in every mode.
- A hook `ask` routes to `canUseTool`.
- `{}` means no opinion.
- Hooks time out after 600 s, and a timed-out PreToolUse blocks the tool.
- `canUseTool` "can stay pending indefinitely".

**Decision.**

1. **PreToolUse (Dex's hook, every tool):** `decideToolUse(policy, call)`.
   - `deny` → `permissionDecision: "deny"` with the rule's reason, plus a
     `policy_denied` event.
   - `ask` → `permissionDecision: "ask"`.
   - no opinion → `{}`.
   - Stop pressed → `deny` "Run stopped by user", as today.
   - The hook never returns `allow`, because that is the line (`:185–190`) that
     skips the project's own rules today.
2. **`canUseTool`:** `AskUserQuestion` → `humanInput` question (R7). Any other
   tool →
   - the policy says `ask` → human approval, source `policy`;
   - else a settings ask rule forced the call → human approval, source
     `settings`. The SDK says so in one of two ways: `options.matchedAskRule`,
     or `decisionReasonType: "rule"` (see the T067 measurement below);
   - else → **allow**. This is a call that matched no allow rule in `default`
     mode. The policy and the project's deny and ask rules have already run, so
     nothing that either of them guards reaches this branch — except a compound
     command, below.

**Measured, T067 (2026-11-05, SDK 0.3.318).** The plan assumed that
`matchedAskRule` is set whenever a settings ask rule matches. It is not. The
`.d.ts` sets it only "while the ask carries the tool's own decisionReason". So
the first live run auto-allowed `git push` under `Bash(git push:*)`. Logging
every `canUseTool` call (Haiku 5.5, about $0.01 a run) showed what the SDK
sends:

| Call | `decisionReasonType` | `matchedAskRule` | Suggestions |
|:--|:--|:--|:--|
| `git push origin HEAD`, project ask rule | `"rule"` | absent | none |
| `Edit`, no rule (project settings only) | absent | absent | yes |
| `git add … && git commit …`, no rule | `"subcommandResults"` | absent | yes |
| `git add -A && git push origin HEAD` | `"subcommandResults"` | absent | `git add *` only |

`decisionReasonType` is forwarded by the SDK from the CLI's control request
but is not in its types, so `permissions.ts` reads it through a narrow cast.
With the fix, the live run held `git push origin HEAD` on the approval card,
nothing reached the remote, Deny returned "Denied by the human", and the agent
left T001 open with the note "denied by the human … Not retried".

**Known gap: compound commands.** A settings ask rule that matches one part of
a compound command (`git add -A && git push`) arrives as
`"subcommandResults"`, the same as a compound with no rule at all. Dex cannot
tell the two apart from the options, so it allows both. Only the suggestions
differ: they leave out the part an ask rule covers. A policy `ask` rule does
not have this gap, because its pattern is a regex over the whole command.
3. **Options from the policy:** `settingSources`, `permissionMode` (bypass is
   refused for `existing`, FR-014), `env` (R1), the preset `systemPrompt` with
   the `systemPromptAppend` file, `maxTurns = min(config.maxTurns, limits.maxTurnsPerStage)`,
   and `maxBudgetUsd = limits.maxBudgetUsdPerStage`. The `error_max_budget_usd`
   result → pause `limit_reached`.

**Why step 2 allows unmatched calls.**

- In SDK sessions, the project's `.claude/settings.json` **allow** rules apply
  only when the folder is trusted (`~/.claude.json`,
  `projects[<root>].hasTrustDialogAccepted`). `Options` has no trust switch.
  Deny rules, ask rules and settings hooks always apply.
- Sending every unmatched call to a human would therefore ask about every Edit
  and every `ls` in an untrusted project, and an unattended run is impossible.
- Allowing them gives exactly what the brief asks for: the project's deny and
  ask rules work, Dex's policy works, and the rest runs.
- The prerequisites report the trust state as information, not as a failure.

**Other gotchas, recorded for the plan.**

- `settingSources` with `"user"` loads `~/.claude` hooks, plugins and
  `CLAUDE.md` into every agent. A worktree guard there will fire, which is why
  `onion-demo-01`'s policy sets `CLAUDE_NO_WORKTREE=1`. A project that wants
  isolation drops `"user"`.
- `AskUserQuestion` options carry only `label` and `description`; there is
  **no `recommended` field**. So today's `o.recommended` (`:111`) is always
  false, and `autoClarification` always picks the first option. The Claude Code
  convention is a label ending in `(Recommended)` on the first option. Dex
  detects a recommended option by `/\(recommended\)\s*$/i` on the label (R7).
- The approval wait is held in `canUseTool`, never in the hook, because of the
  600 s hook timeout.

**Alternatives considered.**

- *Hold `ask` inside PreToolUse and return allow/deny* — the 600 s timeout, and
  `allow` would skip the project's own rules.
- *Require a trusted folder and send unmatched calls to the human* — every
  tool call becomes a question; unattended runs die.
- *Copy the project's allow rules into `allowedTools`* — Dex would reimplement
  Claude Code's rule syntax, and that behaviour is unverified.
- *`defer`* (ends the turn with `tool_deferred`, resumable later) — it would
  resume a session across stages, which works against the fresh-context
  principle. Not needed for a human who is present; the headless no-TTY case
  uses pause + answer book (R7).

Contract: [`contracts/policy-json.md`](contracts/policy-json.md).

## R7 — Human input: one request queue for questions, approvals and pauses

**Decision.** `userInput.ts` becomes `humanInput.ts` with one pending-request
map keyed by `requestId` and three kinds (`question`, `tool_approval`, `pause`;
data-model.md § Pending request). Each request is persisted to
`state.json.pendingRequests` and rendered to `.dex/questions.md`. Resolution
comes from the app (`orchestrator:answer-request`), the terminal (`cli.ts`
readline), the answer book, or Stop (which denies every held request).

- `recommended-then-review`: a question whose every sub-question has a
  recommended option is answered at once, and the pair goes to `reviewList`.
  An option is **recommended** when its label ends in `(Recommended)`
  (case-insensitive), because AskUserQuestion has no `recommended` field (R6).
  Today's fallback "pick the first option" (`ClaudeAgentRunner.ts:126`) is
  removed: no recommended option means wait.
- `autoClarification` keeps today's meaning, but only for the new-project
  clarification stages.
- On reload the renderer reads `pendingRequests` from the run snapshot. Today
  the pending question is persisted but never read back, so it is lost on
  reload. *(As built: `useUserQuestion` reads `state.pendingRequests` through
  `getRunState()` + `getProjectState()`, not through the snapshot, and only while
  a live run exists — Phase 4 gate. The snapshot carries the same state for the
  queue panel's review list.)*

**Rationale.** Questions, tool approvals, gates, limits, a dirty tree and a
frozen file all reduce to "show something, wait for one of N answers". One
mechanism serves the app, the CLI and the persisted file.

**Alternatives considered.** A separate approval subsystem next to the
question one — duplicate persistence and UI, and two places for Stop to clean
up.

## R8 — The verify fix phase keeps a numeric phase number

**Decision.** The fix phase header is
`## Phase <max+1>: Verify fixes V<k>` (contracts/verify-md.md). The verify-round
counter is the number of `Verify fixes V*` phases in `tasks.md`.

**Rationale.** `parser.ts` `PHASE_HEADER` is `/^## (?:TaskPhase|Phase) (\d+): (.+)$/`.
A literal `## Phase V1: …` (the brief's wording) would not parse, so its
tasks would be invisible to the picker, the task board and `--phase N`. Putting
`V<k>` in the name keeps the brief's label. Counting phases makes the round
counter file-derived, so it survives a reset (FR-036 without state).

**Alternatives considered.** Extending the parser to accept `V\d+` phase
numbers — `/speckit-implement --phase` takes a number, and the board sorts by
number.

## R9 — Failure policy and the no-progress guard (D-015-7)

**Decision.**

- **Implement without progress.** Before each `implement` run Dex counts the
  checked in-scope tasks; after it, again. No increase → `counters[entryId]`
  +1; an increase resets it to 0. At `maxImplementRunsWithoutProgress` (2) → pause
  `limit_reached`.
- **Verify rounds.** File-derived (R8). When the count reaches
  `maxVerifyRounds` (3) and the entry is not done → pause `limit_reached`.
- **No-progress guard for every other stage.** If the picker returns the same
  `(entry, stage)` right after that stage ran, the stage produced nothing the
  picker can see (for example `clarify` did not write `## Clarifications`, or
  `plan` wrote no `plan.md`). Dex pauses with `no_progress` at once instead of
  re-running it.
- **Stage and run limits.** `maxTurnsPerStage` → the SDK's `maxTurns`;
  `maxBudgetUsdPerStage` → the SDK budget option (R1); `maxBudgetUsdPerRun` →
  checked before each stage against `cumulativeCostUsd`. A limit pauses with a
  question naming it.

**Rationale.** Counting checked tasks is the brief's definition, and it is
cheap. The guard replaces `MAX_CONSECUTIVE_FAILURES` (`main-loop.ts:79`) with a
rule that explains itself, and it catches the one stage whose skill does not
always write its own marker: `speckit-clarify` adds `## Clarifications` only
when it asks a question (its `SKILL.md` lines 176–181), so the Dex prompt must
demand the section (R11), and the guard covers the case where it is ignored.

**Alternatives considered.** Keying "progress" on the `tasks.md` hash — an
agent rewording a task would count as progress.

## R10 — Gates are a pause after the gated stage; Resume is the approval

**Decision.** After a stage listed in `entry.gates` finishes, `post-stage` pauses
the run (`gate`) with a `pause` request whose options are `Continue` and `Stop`.
Nothing about the approval is stored. On Resume the picker runs and returns the
next stage, because the gated stage's artefact now exists.

**Rationale.** No approval state means nothing goes stale after a reset. The
human can edit the brief while paused, and the edited brief is what `specify`
reads.

## R11 — Stage prompts

**Decision.** One builder per stage in `prompts.ts`, each a pure function of
`(resolvedEntry, projectDir, extras)`, so `--dry-run` prints exactly what runs.

| Stage | Prompt core | Notes |
|---|---|---|
| `brief` | write `entry.brief` from `generate.sources`, using the previous entry's brief as the format example | gated by default |
| `specify` | `/speckit-specify <brief path or description>` + "the brief is the source of truth" | env from R5 |
| `clarify` | `/speckit-clarify` + autonomous rules: answer from the brief, repo and docs; record Q and A; **always** write `## Clarifications` with a `### Session <date>` (write "No critical ambiguities" when there are none); ask only when nothing answers and a wrong guess costs more than a day | R9 guard backs it up |
| `plan`, `tasks` | `/speckit-plan <specPath>`, `/speckit-tasks <specPath>` | as today |
| `implement` | `/speckit-implement <specPath> --phase N`; in-scope ids when filtered; "commit as this project's rules say" | replaces Dex's `git add -A -- ':!.dex/' && git commit` line (`run-phase.ts:129`, `prompts.ts:454`) |
| `verify` | brief Acceptance/DoD + spec success criteria; run the acceptance commands; never edit code; write `verify.md` with the given `Tasks-SHA256` line; on failure append the fix phase; commit as the project's rules say | fresh agent (always: one query per stage) |

`buildImplementPrompt` (`prompts.ts:432`, the loop variant) and `buildPrompt`
(`run-phase.ts:105`, the build variant) merge into one builder. The learnings,
feature-evaluation and verify-fix prompts and their schemas go. The new-project
clarification, constitution and manifest prompts stay.

## R12 — Prerequisites and preflight

**Decision.**

- **New project:** today's five checks with auto-fix stay (`git init`,
  `specify init`, GitHub repo).
- **Existing project:** check-only. `claude` on PATH, `specify` on PATH, a git
  repo, `.specify/` present, and `common.sh` knowing `SPECIFY_FEATURE_DIRECTORY`.
  A failure pauses with the list. No `git init`, no `specify init --force`, no
  repo creation.
- **Preflight** (`policy.preflight`, `policy.repos`): before the run and before
  each `implement` and `verify`. Each command runs with `bash -c` in the project
  dir, a 60 s timeout, and its stdout/stderr tail logged. Each `repos` glob is
  expanded (`fs.globSync`, Node 26) and every match must be a clean git
  checkout. A failure pauses with `preflight_failed`, naming the command and its
  exit code.

## R13 — Frozen files are checked per stage, and at write time

**Decision.**

1. **At write time** (PreToolUse, write tools): a target path matching a
   `frozen` glob (`path.matchesGlob`) that is tracked at HEAD
   (`git ls-files --error-unmatch`) is denied.
2. **After each stage**: `git diff --name-only --diff-filter=MDR <stageStartSha> -- <frozen pathspecs>`
   plus the same against the working tree. Any hit pauses `frozen_changed`.

`stageStartSha` is HEAD before the stage, held in memory only.

**Rationale.** Step 1 stops the common case (Edit / Write) before it happens.
Step 2 catches Bash edits (`sed -i`, `cp`). The brief compares against "the
commit the entry started from". A per-stage baseline catches every agent change
too, needs no stored state, and does not re-pause forever if the human resumes
on purpose without reverting. `--diff-filter=MDR` honours "once committed": a
frozen file that did not exist at the baseline may be created.

## R14 — Baseline and size target (FR-048, SC-007)

**Decision.** `scripts/loc-by-area.sh` (a few lines of `find | wc -l`) prints
the brief's areas. Phase 0 records its output here.

Baseline at `7ec23aa` (non-test `.ts`/`.tsx` under `src/`): **28,110**, of which
core 11,740, renderer 15,266, main 1,104.

| Removed (approx.) | Lines |
|---|---|
| core `checkpoints/` + `checkpoints.ts` | 2,054 |
| `conflict-resolver.ts`, `agent-profile.ts`, `gap-analysis.ts`, `stages/cycle-gap-analysis.ts`, `stages/finalize.ts` | 1,091 |
| `state.ts` reconcile, `runOneShot`, `dexConfig` resolver config, learnings, old main loop | ~1,300 |
| main `ipc/checkpoints.ts`, `ipc/profiles.ts`, `lock-utils.ts`, `logger.ts`, 2 preload modules | 571 |
| renderer `components/checkpoints/`, 2 services, timeline parts of `App`/`LoopDashboard`/`StageList`, duplicated history rebuild | ~3,900 |
| **total removed** | **~8,900** |
| added: queue, picker, policy, humanInput, branching, post-stage, preflight, brief, cli, QueuePanel, approvals UI | ~+1,900 |
| **expected after** | **~21,100** |

The target (21k) is at the edge. If Phase 6 ends above it, the brief's open
decision 8 applies: decide after the dogfood run.

**Final measurement** (2026-11-05, after Phase 11 and the biome format pass,
T110; `bash scripts/loc-by-area.sh`, non-test `.ts`/`.tsx` under `src/`). The
Phase 0 tree was biome-formatted, so the count after the format pass is the
one to compare; before it, the same code counted 21,439.

| Area | Baseline | After | Change |
|---|---:|---:|---:|
| core total | 11,740 | 9,778 | −1,962 (−17%) |
| core time machine | 2,360 | 0 | −2,360 |
| core `state.ts` | 759 | 262 | −497 |
| core loop (`stages/`, `prompts.ts`, `parser.ts`, `agent/`) | 5,345 | 4,399 | −946 |
| main total | 1,104 | 524 | −580 (−53%) |
| renderer total | 15,266 | 11,784 | −3,482 (−23%) |
| renderer `components/checkpoints/` | 3,096 | 0 | −3,096 |
| **grand total** | **28,110** | **22,086** | **−6,024 (−21.4%)** |

**SC-007 is not met:** 22,086 is 1,086 lines above the 21k target, and the
drop is 21.4%, not 25%. The additions came out larger than the ~1,900 estimated:
the `dex` CLI (`cli.ts` + `cli/`, ~610 lines with the dry run, the terminal
input and the event printer), the snapshot path (`run-snapshot.ts`,
`useRunSnapshot`, `QueuePanel`, `PauseCard`) and the approval UI. The brief's
open decision 8 applies: decide after the dogfood run (T112, T113). One
candidate the owner can weigh: the renderer's event-built stage history
(`useLoopState` + `buildLoopStateFromRun`, ~400 lines) could read the run
record through the snapshot instead.

**At the end of the branch** (after the cycle-count fix, `b0f5082`, and the
removal of the test-only `statusPorcelain` helper; `bash scripts/loc-by-area.sh`):
core 9,771 (−7), main 524, renderer 11,821 (+37, `queueProgress` and the
snapshot-driven cycle count); **grand total 22,116**. The table above is the
T110 measurement.

**After the dead-code cut** (the T012/T067 session): `uiPrefs.ts` and 13
exports with no caller left the tree — `countCommitsBetween`,
`getCommittedFileContent` and `createLoopPullRequest` (git.ts),
`discoverNewSpecDir` (parser.ts), `updateRunCyclesCompleted` and
`upsertFailureCount` (runs.ts), `AgentRunnerFactory`, and six style
fragments in `renderer/styles/tokens.ts`. Core 9,586, main 524, renderer
11,766; **grand total 21,876** (−22.2%). SC-007 stays unmet by 876 lines.

### Phase 0 measurements (2026-11-05, tree at `7ec23aa`)

**Tests before any change.** `npm test`: core 187 pass / 0 fail, renderer 40
pass / 0 fail, `check:size` pass. `npm run typecheck`: clean. Nothing was
pre-existing broken.

**`bash scripts/loc-by-area.sh`:**

| Area | Lines |
|---|---|
| core total | 11,740 |
| core time machine (`checkpoints/`, `checkpoints.ts`, `conflict-resolver.ts`) | 2,360 |
| core `state.ts` | 759 |
| core loop (`stages/`, `prompts.ts`, `parser.ts`, `agent/`) | 5,345 |
| main total | 1,104 |
| renderer total | 15,266 |
| renderer `components/checkpoints/` | 3,096 |
| **grand total** | **28,110** |

**`nvim-tools --json --all`** (the lint / format / type baseline): 4 findings,
all under `.claude/` — shfmt 3 warnings (`.claude/hooks/playwright-launch.sh`,
`worktree-create.sh`, `worktree-remove.sh`), biome 1 error
(`.claude/settings.json`). tsc, biome on `src/`, markdownlint, shellcheck,
ruff: 0. stylua, hadolint, golangci-lint, basedpyright: gated-off.

**Baseline mock run** (`scripts/run-mock-headless.mjs` on a scratch clone of
`dex-ecommerce` at its root commit, with `GOAL.md` and `$EX/.dex/mock-config.json`
copied in, and `origin` pointed at a scratch bare repo so the GitHub
prerequisite passes without a prompt): 75.5 s, 27 steps, `gaps_complete`.

```text
prerequisites → clarification_product → clarification_technical →
clarification_synthesis → constitution → manifest_extraction (3 features)
cycle 1..3: gap_analysis → specify → plan → tasks → implement → verify → learnings
cycle 4: gap_analysis → terminated: gaps_complete
events: agent_step 78, step_started/completed 27, step_candidate 23,
task_phase_started/completed 6, tasks_updated 9, loop_cycle_started/completed 4
```

Note for the quickstart: the root commit of `dex-ecommerce` holds
`.dex/dex-config.json`, `.dex/mock-config.json`, `.gitignore` and
`docs/my-specs/`, but **no `GOAL.md`** — a scratch clone needs it copied in.

### Phase 2 gate (2026-11-05, after the deletions, T036)

- **Tests:** core 112 pass (86 kept + 26 new in `queue.test.ts` and
  `tree-reader.test.ts`), renderer 29 pass, `check:size` pass, typecheck clean.
  The 101 core cases that left are exactly the deleted files (99) plus the 6
  `conflictResolver` cases cut from `dexConfig.test.ts`, minus the 4
  `claudeSession` cases added in Phase 0. Renderer lost the 11
  `checkpointService` cases.
- **LOC:** core 8,655 (−3,085), main 525 (−579), renderer 11,381 (−3,885),
  grand total 20,561 (−7,549). Time machine and `components/checkpoints/`: 0.
- **Mock run** on a fresh clone: 74.2 s, 27 steps, `gaps_complete` — the same
  stage sequence as the baseline, minus the 23 `step_candidate` events. The
  clone has **0 tags** and 19 commits, every one `mock(<stage>): <entry>`; no
  commit is Dex's. `.dex/.gitignore` keeps `state.json` and `runs/` out of git.
- **Known leftover until T047:** `appendLearnings` (Dex, after the learnings
  stage) writes the tracked `.dex/learnings.md` after the agent's commit, so the
  run ends with that one file modified. Before 015 the checkpoint commit swept
  it up. FR-031 deletes the learnings stage, which removes the write.
- **Tree reader:** `gitRef` uses `git cat-file -t` / `git cat-file blob` with
  `<ref>:./<rel>`, not `cat-file -e` / `git show`: `-t` tells a file from a
  folder, `blob` returns the bytes untouched (the Tasks-SHA256 check needs
  them), and `./` keeps paths relative to the project, not the repo root.
- **`git.ts`:** `headSha` was not added — `getHeadSha` already exists. The new
  `branchExists` / `switchBranch` use `execFileSync` with an argument list:
  branch names come from the tracked `queue.json`, so they never pass through
  a shell. *(A `statusPorcelain` helper was added here too, but only a test
  called it — `branching.dirtyFiles` reads the status itself with
  `-z --untracked-files=all` — so it was removed after the spec sync.)*

### Phase 3 gate (2026-11-05, the loop runs from files, T056)

- **Tests:** core 120 pass (+25 `picker.test.ts`, +3 `loop.test.ts`, +2 in
  `MockConfig.test.ts` (9 → 11), −22 with the deleted `gap-analysis.test.ts`),
  renderer 29 pass, `check:size` pass, typecheck clean on all three configs.
- **LOC:** core 7,079 (−1,576 against Phase 2), main 514, renderer 11,326,
  grand total 18,919 (−1,642).
- **Quickstart § 2** on a scratch clone with `fixtures/mock/new-project.json`:
  exit 0 in 16.6 s (the fixture's entry stages wait 300 ms, the old config
  1–2 s, so the time is not comparable with Phase 2), 27 steps — the same
  count as the baseline (6 project steps + 3 entries × 7 stages). 3 entries,
  every `verify.md` `passed`, 0 tags, 0 `[checkpoint:` / `dex:` commits, a clean
  tree at the end.
- **§ 3:** `--stop-on task_phase_started` paused `user_abort` with
  `current = {001-catalog-and-search, implement, 1}`; `--resume` ran
  `implement` task phase 1 of the same entry first and ended `queue_complete`.
- **§ 4:** run on a scratch clone, not on `$EX`: `git switch -c attempt-p3
  <mock(tasks) commit>` stands in for `reset-example-to.sh <checkpoint>` (both
  leave HEAD on a new branch at that commit). `--resume` picked `implement`
  task phase 1 of entry 1, logged no reconcile or repair line, and ended
  `queue_complete`. `$EX/.dex/mock-config.json` is still the pre-015
  `dex_loop` shape, and the loader now refuses it with a pointer to
  `fixtures/mock/new-project.json`.
- **Resume follows the checkout.** Dex never switches a new project's branch,
  so on Resume the run branch is the current branch (`attempt-p3` above), and
  `state.runBranch` is updated. Without that the final PR would push the old
  branch while the work sat on the new one.
- **The mock honours Stop:** an aborted mock stage writes, ticks and commits
  nothing, as a real session aborted mid-stream. That is what makes "Resume
  runs the same task phase" testable. An aborted `implement` does not count
  toward `implementRunsWithoutProgress`.
- **Run record and PR:** a paused or failed loop writes `status: "paused"` /
  `"failed"` to `runs/<runId>.json` (it wrote `completed`), and the PR opens
  only when the loop ends `queue_complete` (or a build-mode run finishes).
- **Build mode** now uses the loop's implement prompt (`entryForSpecDir` makes
  a one-off entry from the spec folder), so no prompt in Dex carries a fixed
  commit command any more. The one Dex commit left is the GitHub-repo setup in
  prerequisites, which runs only for a new project and only after the human
  picks "create a new repo".
- **Names that differ from tasks.md:** `humanInput.ts` exports `askQuestions`
  (an agent's questions, held) and `recordPause` (a pause request) rather
  than one `requestHuman()`; the queue loop's entry point is
  `runQueueLoop`.

### Phase 4 gate (2026-11-05, the policy and approvals, T066)

- **Tests:** core 152 pass (+26 `policy.test.ts`, +9 `runner-options.test.ts`,
  +1 frozen case in `loop.test.ts`, −3 `claudeSession` option cases moved into
  `runner-options`, −1 dead `pendingQuestion` context case), renderer 32 pass
  (+3 `ToolApprovalCard.test.tsx`; `useUserQuestion` 5 → 8 for approvals,
  `request_resolved` and the reload restore), `check:size` pass, typecheck clean.
- **LOC:** core 7,662, main 512, renderer 11,541, grand total 19,715 (+796
  against Phase 3: the policy, the permission chain and the approval card).
- **SC-006:** `grep -rn bypassPermissions src` → one constant in `policy.ts`
  and two lines of its test. The runner reads `skipsPermissionChecks(policy)`.
- **Mock run** (quickstart § 2) still exit 0, 27 steps, with the policy loaded
  (the defaults; the mock ignores it).
- **Where the chain lives:** `agent/permissions.ts` holds `preToolUseDecision`
  and `makeCanUseTool` (the AskUserQuestion handler moved there from
  `ClaudeAgentRunner.ts`), so both are tested without the SDK. `SessionParams`
  carries `policy` and `entryId` instead of a `canUseTool`.
- **Write tools** are `Edit`, `Write`, `MultiEdit` and `NotebookEdit`: the
  contract lists three, and `MultiEdit` writes files the same way.
- **Tracked at HEAD** is `git cat-file -e HEAD:./<rel>`, not
  `git ls-files --error-unmatch`: a frozen file counts once it is committed,
  and a file that is only staged is not.
- **The frozen check after a stage** pauses with `pauseDetail` naming the
  files; a frozen glob that matches a file created during the stage does not
  pause (`--diff-filter=MDR`).
- **Approvals on reload:** the renderer restores a held question or approval
  from `state.pendingRequests` only while `getRunState()` reports a live run,
  so a request left behind by a crashed process is not offered.
- **Not done here:** the live check (T067, quickstart § 9) needs the owner's
  go-ahead, and the app did not start in this worktree (the Electron binary
  download in `node_modules/electron/dist` is incomplete), so the approval
  card is covered by its component test only.

### Phase 5 gate (2026-11-05, an existing project, T080)

- **Tests:** core 176 pass (+9 `branching`, +6 `queue-init`, +4 `preflight`,
  +4 `existing-project`, +1 policy `null` case), renderer 35 pass,
  `check:size` pass, typecheck clean.
- **LOC:** core 8,189, main 512, renderer 11,541, grand total 20,242.
- **Quickstart § 5** on a scratch clone of `$EX` at its root commit, with no
  remote and real `specify init` (spec-kit 1.2.5): exit 0, `queue_complete`,
  10 stages; the only new branch is `901-fixture-b` (made by the mock
  `specify` from `GIT_BRANCH_NAME`); every new commit is `mock(…)`; 0
  checkpoint commits, 0 tags; `.specify/feature.json` unchanged; clean tree;
  T006 (out of scope) still open. § 5 now spells out the human's setup:
  `specify init`, feature A's branch and spec folder, `dex queue init`.
- **Branch target:** `prepareBranch(projectDir, entry, kind)` targets the
  tree the picker read — the entry's branch once it exists, else its base. R4
  read literally sends `brief`/`specify` to the base even when the entry's
  branch exists; spec-kit's `git switch -c` then fails. Only `brief` and
  `specify` can reach the base: the picker pauses any later stage without the
  entry's branch.
- **Clean tree** uses `--untracked-files=all`, so an untracked `.dex/` that
  holds only runtime files is not one dirty folder. The runtime list is
  `RUNTIME_IGNORE_ENTRIES` (one list for `.dex/.gitignore` and the check).
- **`dex queue init` lives in `queue-init.ts`**, not `queue.ts`: it writes the
  policy and `.dex/.gitignore` too. Folder names become lowercase ids
  (`docs/my-specs/001-Initialization` in `$EX` → `001-initialization`); `brief`
  and `specDir` keep the real name. No feature folder → refused (a queue needs
  an entry). The policy it writes parses back to the defaults, so
  `systemPromptAppend: null` is now accepted as "none".
- **Prerequisites for an existing project** run check-only and report through
  the same four check names; a failure pauses `preflight_failed` with the
  list. The trust state reads one field of `~/.claude.json` and goes into the
  `claude_cli` check message.
- **Preflight** runs before the run and before each `implement` and `verify`;
  a `repos` glob that matches nothing passes, a match that is a plain folder
  fails. Commands run with async `execFile`, so a 60 s command does not block
  the Electron main process.
- **Build mode** keeps the queue entry's `tasks` scope for a queued spec
  folder (`buildEntry`) and makes no branch for an existing project. The scope
  rule is one function, `queue.isInScope` (with `isFixPhase`), used by the
  picker, the implement counter, the prompt and build mode.
- **Pull requests** need `policy.openPullRequest` and a base branch, for both
  kinds. An existing project's base is the queue base of the branch the run
  ended on. A new project now opens no PR by default (FR-011).
- **The mock config** needs only `entries`; `prerequisites` and
  `clarification` are optional, since an existing project runs neither.

### Phase 6 gate (2026-11-05, the failure policy, T086)

- **Tests:** core 183 pass (+5 `failure-policy`, +2 `loop`: a verify that
  fails once, and an implement that never ticks), renderer 35, typecheck
  clean.
- **Limits come from the policy only.** `RunConfig` loses `maxLoopCycles`,
  `maxBudgetUsd`, `maxVerifyRetries` and `maxLearningsPerCategory`;
  `maxBudgetUsd` had no writer left. The run record keeps `maxBudgetUsd`, read
  from `limits.maxBudgetUsdPerRun`.
- **`limitHit` replaces the SDK `subtype`** on `StepResult` and
  `TaskPhaseResult`: `"turns"` (`error_max_turns`) or `"budget"`
  (`error_max_budget_usd`), mapped once in `limitHitOf`. A stage that hits one
  pauses `limit_reached` and names the limit in the detail.
- **Verify rounds** are counted from the tree the picker reads
  (`verifyRoundsOf`), so they survive a reset, as R8 says. The mock renders
  `fixTasks` through the same template as its other content.

### Phase 7 gate (2026-11-05, questions have defaults, T089)

- **Tests:** core 191 pass (+6 `humanInput`, +1 `runner-options`
  `questionModeFor`, +1 `loop` question run), renderer 35, typecheck clean.
- **One place answers a question:** `humanInput.askQuestions` tries the
  answer book, then (in `recommended-then-review`) the recommended options,
  then waits. The "first option" fallback is gone from `permissions.ts`; the
  `recommended` flag on an option is now derived from its label.
- **The question mode is per stage** (`questionModeFor`): the new-project
  clarification steps follow `autoClarification` (on → recommended-then-review,
  off → wait); every other stage follows `policy.questions`.
- **`ReviewItem.stage` is a `StepType`**, not a `StageName`: a new project's
  clarification steps are not queue stages, and they default answers too.
- **`.dex/questions.md`** keeps the file while the review list is not empty,
  with "Nothing waits for you right now." above the review section.
- **The mock asks:** a stage descriptor takes `asks` (AskUserQuestion-shaped),
  answered through the same `askQuestions` call as the real agent.

### Phase 8 gate (2026-11-05, `dex run` headless, T095)

- **Tests:** core 197 pass (+6 `cli`), renderer 35, `check:size` pass,
  typecheck clean. LOC: core 9,142, main 512, renderer 11,541, total 21,195.
- **Quickstart § 2–5 with `node dist/core/cli.js run`** on scratch clones:
  § 2 exit 0, every entry done, 0 Dex-made commits, clean tree; § 3 Ctrl-C in
  `implement` exits 3 and pauses `user_abort`, `--status` names implement
  phase 1, `--once` runs that phase and exits 0; § 4 a reset to the
  `mock(tasks)` commit resumes on the reset branch with no repair step; § 5
  as in the Phase 5 gate (exit 0, only `901-fixture-b` is new, no non-agent
  commit, T006 open). `scripts/run-mock-headless.mjs` is deleted.
- **`dex run` resumes whenever `.dex/state.json` exists**, even after a
  completed run. Starting fresh would cut a second run branch for a new
  project; a reset to an earlier commit continues on the checkout.
- **No TTY:** a request an agent waits on is parked (`parkAll`: the agent gets
  the stop answer, the request stays in the state and in `.dex/questions.md`),
  and the run aborts with `WaitingForHuman` as the reason. `finalizeRun` reads
  it: the state pauses `question` or `tool_approval`, the run record says
  paused (not stopped), exit 3.
- **Resume drops every pending request** (`clearStaleRequests`), not only the
  pauses: no agent waits when a run starts. A TTY `dex run` first asks the
  parked requests and moves the answers to the answer book (`bookAnswers`);
  the re-run stage gets them from there.
- **Any `error` event exits 1**, also when the loop carried on (a failed push,
  a broken mock config), as the deleted script did. Quickstart § 5 depends on
  it: exit 0 proves no push was tried.
- **A dry run writes nothing:** a v2 manifest migrates in memory only
  (`loadQueue(…, { persistMigration: false })`), and `dirtyFiles` uses
  `git --no-optional-locks status`, so no read refreshes `.git/index`. The
  SDK options line comes from `buildQueryOptions`, the builder the run uses.
  The env line shows the policy env and the stage env, never `process.env`.
- **`--once`** is `RunConfig.once`: the queue loop breaks after one stage and
  the run pauses `user_abort`. It applies to queue stages, not to a new
  project's prerequisites and clarification steps.
- **The CLI's run settings** (`LOOP_DEFAULTS` in `config.ts`) match the app's
  run buttons: model `claude-opus-4-6`, 75 turns, 50 iterations. A new run
  asks the clarification questions (`autoClarification` off); a resumed run
  keeps the setting in its state.

### Phase 9 gate (2026-11-05, brief and gates, T098)

- **Tests:** core 199 pass (+2 `loop`: a generated brief pauses at the
  default gate and Resume runs `specify`; `gates: ["plan"]` pauses after
  `plan` and Resume runs `tasks`), renderer 35, typecheck clean.
- **No `stages/brief.ts`.** `brief` is a file stage like `specify`: the generic
  path (`buildStagePrompt` + `runStage`) serves it, so a separate module would
  only repeat that path.
- **`gateCheck` runs only after a finished stage** — not after a Stop or a
  limit, which pause for their own reason. It pauses `gate` with the options
  Continue / Stop; Resume is the approval (R10). The default gate list is
  `["brief"]` when `generate` is set.
- **The mock writes the brief** (`writeBrief`: title, sources, Goal,
  Acceptance) at `entry.brief`, so the picker sees it as the agent would
  leave it.

### Phase 10 gate (2026-11-05, the app reads a snapshot, T106)

- **Tests:** core 201 pass (+2 `run-snapshot`), renderer 56 (+21:
  `useRunSnapshot` and `startActionFor` 10, `ClarificationPanel` 4,
  `QueuePanel` 3, `buildLoopStateFromRun` 3, `useLoopState` 1), `check:size`
  pass, typecheck clean. LOC: total 21,439 before the format pass, 22,086 after (§ R14).
- **One read for the CLI and the app:** `run-snapshot.ts` serves both
  `project:get-run-snapshot` and `dex run --status`. Per-entry cost sums the
  run record's agent runs by `featureSlug`, which `run-stage.ts` now sets to
  the entry id.
- **The renderer re-reads on six boundary events** (`run_started`,
  `step_started`, `step_completed`, `paused`, `run_completed`,
  `loop_terminated`); the newest answer wins and a failed read keeps the last
  snapshot. `useProject` drops its own `dexStatus` polling, and the Topbar
  drops `isPausedLoop`.
- **Start follows the snapshot** (`startActionFor`): an invalid queue or
  policy disables it; a paused run, or an open entry with a run state,
  resumes; an open entry without one starts the queue loop; no queue runs the
  unfinished spec folders in build mode. Before, a project with a queue and no
  run history fell back to build mode.
- **The pause card does not go through `answer-request`:** no agent waits on
  a pause, the run already ended. Continue is Resume (R10); Stop closes the
  card and leaves the run paused. A request an agent waits on comes first.
- **The answers given by default are listed in the queue panel**, not in the
  questions panel: they wait for nobody.
- **No stage guess:** `NEXT_STAGE_AFTER` and the optimistic advance in
  `useLoopState` are gone; `currentStage` moves only on `step_started`.
- **One rebuild of a run's stage history:** `loadRunHistory` uses
  `buildLoopStateFromRun`, as the mount sync does. The builder now counts the
  implement phases in a cycle's cost and every agent run in the total, shows
  an open record of a run that ended as stopped, and takes the last cycle of
  an unfinished run as the one to resume.
- **T106, the live UI check** (2026-11-05, electron-playwright on this
  worktree's `dev-setup.sh`, mock stages slowed to 2.5 s, two scratch clones):
  - New project (§ 2 fixture, `questions: "wait"`, one mock question on the
    first entry's `clarify`): the queue panel rows follow every stage; the
    question card shows; a renderer reload keeps it; the answer resumes the
    stage; the run ends with all three entries done.
  - Existing project (§ 5 fixture, `gates: ["plan"]` on `901-fixture-b`): the
    app's Start runs the queue loop; the run pauses at the gate with the pause
    card and Resume in the top bar; Continue resumes and the run completes.
  - `browser_find` for Timeline, "Make this the new main", Delete and Profile
    finds nothing. No console errors.
  - **Not checked live:** the tool-approval card. The mock makes no tool
    calls; the card has unit tests, and T067 checks it with a real agent.
  - **Fixed on the way:** the cycle count and the placeholder cycles were
    guesses (`completed/seen cycles`, always three placeholders). They now come
    from the snapshot (`queueProgress`): done of the entries that will run, and
    one placeholder per entry not started, at most three.
  - **Seen, not changed:** a renderer reload goes back to the welcome screen
    while the run goes on (the open project lives in renderer state); the
    pending request survives it.
  - The worktree's Electron binary was missing: `@electron/get`'s cached zip
    was whole, but its extract step wrote one file and stopped. A plain
    `unzip` of the same zip plus `path.txt` fixed it.

### Final checks (2026-11-05, T111)

- `npm test`: core 201 pass, renderer 56 pass, `check:size` pass.
  `npm run typecheck`: clean.
- Quickstart § 1–8 on scratch clones with `node dist/core/cli.js`: § 2–5 as
  in the Phase 8 gate; § 6 73 tests pass (the command now puts
  `--test-name-pattern` before the file glob — through `npm run test:core --`
  the flag did not filter); § 7 `bypassPermissions` only in `policy.ts` and
  its test; § 8 in § R14.
- `nvim-tools --json --all` against the Phase 0 baseline: lint, types
  (`tsc` ok), markdown and shell add no finding. 65 files this branch
  changed were not biome-formatted; after the owner's go-ahead they were
  committed, then formatted in a separate commit (`nvim-tools -t biome --fix`
  per file, so the 4 baseline findings under `.claude/` stay as they were).
  Tests and typecheck pass after it.

## R15 — Mock runner: entry-keyed fixtures, real task ticks, agent-style commits

**Decision.** `.dex/mock-config.json` keeps `prerequisites` and `clarification`,
and replaces `dex_loop.cycles[]` (cycle-index keyed, with `gap_analysis` and
`learnings` required) by:

```json
{ "entries": { "*": { …per-stage descriptors… }, "021-agent-entry": { … } } }
```

- Lookup by entry id, falling back to `"*"`.
- `implement` ticks every task of the phase it is given, in `tasks.md`
  (today's mock never ticks, so a filter or resume cannot be tested).
- `verify` takes a list of rounds (`[{ "verdict": "failed", "fixTasks": [...] }, { "verdict": "passed" }]`)
  and writes `verify.md` with the `Tasks-SHA256` line it parses **from the
  prompt** — so the mock tests the contract the real agent follows.
- After each stage the mock commits `mock(<stage>): <entryId>` with `git add -A`,
  as an agent following the project's rules would. Today's `git add -A`
  (`MockAgentRunner.ts:426`) without a commit goes. Tests tell agent commits from
  Dex commits by that prefix.

Fixtures live in `fixtures/mock/` and `fixtures/existing-project/` in this repo.

## R16 — `kind` decides the project rules

**Decision.** `queue.kind` (`new` / `existing`) is the single switch for the
differences between the two kinds of project: run branch, prerequisites
auto-fix, the bypass refusal, and the default question mode.
`autoClarification` stays a new-project-only setting.

**Rationale.** The UI's "New" and "Open Existing" labels only say whether a
folder exists; they do not say who owns the project. The queue file is written
by the flow that created the project, so it knows.

## R17 — The renderer reads a snapshot, not an event-built model

**Decision.** `project:get-run-snapshot` (contracts/ipc-events.md) returns the
fresh `state.json` and the `describeQueue` view. The renderer replaces its
queue and status model on every stage-boundary event. `useLoopState`'s
next-stage guessing (`NEXT_STAGE_AFTER`, lines 20–36) and the duplicated cycle
rebuild in `useOrchestrator.ts` `loadRunHistory` (lines 185–336) go. The live
trace stays event-driven.

**Rationale.** This closes the class of bug the 01X brief recorded (three views
disagreeing after Stop): there is one source, and the renderer just shows it.

## R18 — What stays as is

- **`build` and `plan` modes.** Not in the brief. They inherit the policy, lose
  the run branch in an existing project (R4), and keep their UI.
- **`runs.ts` audit records and the log tree.** `cycleNumber` becomes the entry's
  1-based position, so paths and IPC are unchanged.
- **`gsap`.** Unused (no imports), but the constitution names it as the
  animation library; removing it is a constitution change, out of scope. The
  three `d3-*` packages, used only by the timeline, are removed.
