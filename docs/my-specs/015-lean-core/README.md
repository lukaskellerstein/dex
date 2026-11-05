# 015 — Lean core: keep the loop, drop the time machine, run on existing projects

> **Status:** draft v1.0 · 2026-11-04 · the brief for spec-kit. Feature, branch and spec folder: `015-lean-core`.
>
> **Supersedes** `01X-state-reconciliation` (never numbered). Once the next stage is derived from files, there is no second state machine left to reconcile.
>
> **Real-project check:** a scratch clone of `dex-ecommerce`, never another project. This spec ends with a dry run on that clone's queue.
>
> **Followed by** [`016-grounded-loop`](../016-grounded-loop/README.md): a tests stage, plus checks that Dex runs itself as gates. The verify verdict (D-015-5) and the failure counter (D-015-7) here are deliberately minimal, because 016 replaces them. A real run that may commit and deploy waits for 016: the loop doesn't get those rights before it can tell real progress from claimed progress.
>
> **Changes after the build started (2026-11-05) — build these on this branch.** The branch was specified from the brief as committed on 2026-11-04. Three later edits to this brief aren't built yet. Add them to `spec.md` and `tasks.md` as a new phase, then implement them. Everything else in this brief is built, in places as `spec.md` records it (for example, the queue's human-owned `status` override replaces `skipped`).
>
> 1. **Verify records live in `.dex/evidence/<id>/` (untracked), keyed by the entry branch's HEAD and the `tasks.md` hash** (D-015-1, D-015-5). They replace `specs/<id>/verify.md`.
>    - The verify agent returns its verdict as structured output, and Dex writes the record. The agent no longer writes a verdict file.
>    - The picker counts an entry as done only when a passing record matches the current HEAD, so any later commit on the branch sends it back to `verify`.
>    - `.dex/.gitignore` gains `evidence/`, and the mock writes records the same way.
>    - DoD: "A commit on an entry's branch after the entry is done makes the picker verify it again."
> 2. **Every spec-kit stage also gets `SPECIFY_FEATURE=<branch>` and `SPECIFY_FEATURE_NO_PERSIST=1`**, next to the `SPECIFY_FEATURE_DIRECTORY` (and `GIT_BRANCH_NAME` for `specify`) the build already sets. This keeps spec-kit from persisting `.specify/feature.json` in a real run, not only under the mock.
> 3. **The policy's default `env` is `{"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}`** (D-015-3), so loop agents neither read nor write the machine owner's personal auto memory. A project's own `env` is merged over it.
>
> Not for this branch: judging tool calls in a common vocabulary instead of Claude's tool names is 019's job (D-019-4).
>
> **How to start:** commit this brief on `main`, start `claude -w 015-lean-core` in this repo, run `/speckit-specify` with this file as the feature description, then the usual clarify → plan → tasks → implement.

## Why

Dex does one valuable thing: it drives spec-kit through fresh agent sessions, stage by stage, and shows what each agent does. Most of the code does something else.

| Area | Source lines | Specs that built it |
|---|---|---|
| Git time travel: stage checkpoint commits, timeline DAG, jump, `selected-*` forks, promote-to-main with an AI conflict resolver | ~5.9k: core `checkpoints/` 2.0k, `conflict-resolver.ts` 0.3k, `main/ipc/checkpoints.ts` 0.5k, `components/checkpoints/` 3.1k | 002, 008, 009, 010, 012, 013, 014 |
| Keeping `state.json` in step with git: `reconcileState`, `detectStaleState`, `resolveWorkingTreeConflict`, `syncStateFromHead` | most of `state.ts` (759) | 006, 01X |
| Variant agent profiles: Codex/Copilot runner kinds, worktree overlays | `agent-profile.ts` 268, plus the profiles IPC, preload and service | 010 |
| LLM gap analysis deciding RESUME / REPLAN / RESUME_AT_STEP | `gap-analysis.ts` + `stages/cycle-gap-analysis.ts` 373 | 003, 006 |
| **The loop itself:** stages, prompts, task parser, Claude and mock runners | **~5.5k** | 001, 003, 005 |

Today: 28.1k lines of source (core 11.7k, renderer 15.3k, Electron main 1.1k) and 5.0k lines of tests, 2.5k of which test the time machine.

Three problems follow from that.

1. **Every feature pays for time travel.** `state.json` rides git checkouts, so every stage must commit, every jump must re-sync, and every new feature must keep three views agreeing: `state.json`, git, and the renderer's own event log. 01X records all three disagreeing after a single Stop.
2. **Dex can only start new projects.** The entry is a goal file → clarification → constitution → manifest. A project that already has specs, briefs, branch conventions and its own Claude Code setup has no way in. `build` mode implements existing specs, but it has no loop, no verify and no queue.
3. **It runs with no brakes.** `ClaudeAgentRunner` sets `permissionMode: "bypassPermissions"` and `settingSources: ["project"]`. The user's hooks and every `ask`/`deny` rule are skipped, `canUseTool` allows everything, and the PreToolUse hook returns `allow`. That's acceptable on `dex-ecommerce`. It isn't on a project where the agent can push, publish or reach production.

## What Dex is after this spec

A queue of features, a picker that reads the project's files to choose the next stage, one fresh agent per stage, a policy the project owns, and a human who is asked only when it matters.

```mermaid
flowchart LR
  Q[".dex/queue.json"] --> P{"picker<br/>reads files only"}
  P -->|brief missing, generate set| B[brief]
  P -->|no spec folder| S[specify]
  P -->|no Clarifications section| C[clarify]
  P -->|no plan.md| PL[plan]
  P -->|no tasks.md| T[tasks]
  P -->|open in-scope task| I["implement<br/>one task phase"]
  P -->|no verify.md for this tasks.md| V[verify]
  P -->|verify passed| D["mark done,<br/>next entry"]
  V -->|failed: appends a fix phase| P
  B --> G{gate?}
  S --> G
  C --> G
  PL --> G
  T --> G
  I --> G
  G -->|yes| H[pause for the human]
  G -->|no| P
```

### D-015-1 — The next stage comes from the project's files, never from history

The picker takes the first queue entry that isn't `done` or `skipped` and checks, in this order:

| Check | Next stage |
|---|---|
| The `brief` file is missing and the entry has `generate` | `brief` |
| The spec folder is missing | `specify` |
| `spec.md` has no `## Clarifications` section | `clarify` (it always writes the section, even with no questions) |
| `plan.md` is missing | `plan` |
| `tasks.md` is missing | `tasks` |
| An in-scope task is unchecked | `implement`, on the first task phase that has one |
| No passing verify record for the entry branch's current HEAD | `verify` |
| A passing verify record for the entry branch's current HEAD | the entry is done; move on |

Stages listed in the entry's `skip` are treated as done. A verify record lives in `.dex/evidence/<id>/` and is keyed by HEAD and the `tasks.md` hash, so any later commit makes the picker verify again. 016 adds a `tests` row and replaces the verify record with the gates Dex runs itself.

What this buys:

- Stop is a pause, and Resume means running the picker again.
- Resetting the project to any commit, for example with the `reset-example-to.sh` fixtures, resumes correctly with nothing to repair.
- Re-planning is a human act: delete `plan.md` and `tasks.md`, and the picker plans again.

`state.json` stops being tracked in git. It keeps only what files can't say: run id and status, cost, attempt counters, pending questions, the config snapshot.

### D-015-2 — Dex never commits, branches or pushes on its own in an existing project

Agents commit as the project's rules say. Dex drops the `[checkpoint:<step>:<cycle>]` stage commits and `finalizeStageCheckpoint`. In an existing project it also drops the `dex/<date>-<id>` run branch (`createBranch`, called at `run-lifecycle.ts:78` and `orchestrator.ts:338`) and the end-of-run `git push -u` + `gh pr create` (`createPullRequest`, `run-lifecycle.ts:303`).

Dex does only two things with branches:

- before `specify`, it makes sure the project is on the entry's `baseBranch`, switching to it if the tree is clean;
- before any later stage, it switches to the entry's `branch` (spec-kit created it) if the tree is clean.

If a switch is needed and the tree is dirty, the run pauses with a question. After each stage Dex reports a dirty tree in the trace; it doesn't commit it. Nothing Dex writes is tracked in git (the queue and policy files are the human's), so Dex itself never dirties the tree.

A new project keeps its one `dex/<date>-<id>` run branch. Opening a PR becomes opt-in (`openPullRequest`) for both kinds of project.

### D-015-3 — The project owns the policy, and Dex enforces it in code

The policy lives in `.dex/policy.json`, tracked in the project's git.

| Field | Meaning | Default |
|---|---|---|
| `settingSources` | Which Claude Code settings load | `["user", "project", "local"]` |
| `permissionMode` | SDK permission mode | `"default"`; `bypassPermissions` is refused for an existing project |
| `env` | Extra environment for every agent | `{"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}`: loop agents neither read nor write the machine owner's personal auto memory. The project's lasting memory is its docs (018) |
| `deny` | `{tool, pattern, reason}` regexes, checked in the PreToolUse hook | `[]` |
| `ask` | Same shape; a match holds the tool call for the human | `[]` |
| `writeRoots` | The only paths Edit, Write and NotebookEdit may target | `["."]` plus the OS temp dir |
| `frozen` | Files no agent may change once they're committed | `[]` |
| `preflight` | Shell commands that must exit 0 before a run, and before each `implement` and `verify` | `[]` |
| `repos` | Extra git checkouts (globs) that must be clean; shown in the status panel | `[]` |
| `systemPromptAppend` | A Markdown file appended to every agent's system prompt (Claude Code preset + append) | none |
| `questions` | `"recommended-then-review"` or `"wait"` (D-015-6) | `"recommended-then-review"` |
| `openPullRequest` | Push and open a PR at the end of the run | `false` |
| `limits` | `maxBudgetUsdPerStage`, `maxBudgetUsdPerRun`, `maxTurnsPerStage`, `maxImplementRunsWithoutProgress` (2), `maxVerifyRounds` (3) | as shown |

Enforcement:

- **PreToolUse, all tools.** A `deny` match is denied with its reason and emitted as a `policy_denied` event. Edit, Write and NotebookEdit are checked against `writeRoots` and `frozen`. An `ask` match goes to the approval flow below. With no opinion, the hook returns `{}`. Returning `allow`, as today, would skip the project's own permission rules.
- **canUseTool.** The SDK calls it when the project's settings say `ask`. Today it auto-allows. After this spec it goes to the human: the UI or the CLI shows the tool call, the human approves or denies, and the agent waits. `AskUserQuestion` keeps its current interception.
- **After each stage.** Every `frozen` file is compared with the commit the entry started from; any change pauses the run.

`deny` and `ask` patterns match the whole Bash command string, so chained commands (`cd x && git push -f`) and `bash -c "…"` are covered. This is a guardrail against an agent's mistakes, not a sandbox against a hostile one. The rules engine is a pure module (`policy.ts`) with no SDK import, tested from tables.

### D-015-4 — One queue for both kinds of project

The feature manifest becomes the queue: `.dex/feature-manifest.json` v2 becomes `.dex/queue.json` v3. Dex reads a v2 file as a queue, and `dex queue migrate` writes the v3 file. A new project still fills the queue through `manifest_extraction`, whose agent writes and commits it. An existing project writes it by hand, or with `dex queue init`, which lists `specs/*` and `docs/my-specs/*` and proposes entries for the human to edit.

The queue file belongs to the human, and Dex never writes it. Whether an entry is done is derived from files (D-015-1), not stored.

| Entry field | Meaning |
|---|---|
| `id` | Also the spec folder name and branch name unless overridden, e.g. `004-product-recommendations` |
| `title`, `description` | Shown in the queue panel; `description` goes into `specify` |
| `status` | Optional human-owned override, `done` or `skipped`. Without it, whether an entry is done is derived from files |
| `brief` | Path to the brief, the source of truth for every stage |
| `generate` | Optional `{sources: [paths], instructions}`: write the brief first |
| `specDir`, `branch` | Optional; default `specs/<id>` and `<id>` |
| `baseBranch` | Optional; default is the previous entry's `branch`, else the current branch |
| `tasks` | Optional scope filter for `implement`, e.g. `["T005", "T007-T009"]` |
| `skip` | Optional stages that are already done or not wanted |
| `gates` | Stages after which the run pauses for approval, e.g. `["brief"]` |

### D-015-5 — Stage prompts that work in an existing project

- **`brief`** writes the entry's brief from `generate.sources`, using the previous entry's brief as the format example. It is gated by default.
- **`specify`** runs `/speckit-specify` with `GIT_BRANCH_NAME=<branch>` and `SPECIFY_FEATURE_DIRECTORY=<specDir>`, so spec-kit's git extension uses the exact names. The prompt says the brief is the source of truth.
- **`clarify`** runs `/speckit-clarify` in autonomous mode. It answers each question from the brief, the repo and its docs, and records the question and answer in the spec. It asks the human only when nothing in the repo answers the question *and* a wrong guess would cost more than a day.
- **`plan`** and **`tasks`** run the spec-kit commands as today.
- **Every spec-kit stage** gets `SPECIFY_FEATURE=<branch>`, `SPECIFY_FEATURE_DIRECTORY=<specDir>` and `SPECIFY_FEATURE_NO_PERSIST=1` in the agent's environment. spec-kit's scripts read these before `.specify/feature.json` and then don't rewrite that tracked file.
- **`implement`** works as `run-phase.ts` does today (`/speckit-implement <spec> --phase N`). It adds the in-scope task ids when `tasks` is set, and replaces Dex's own commit line with "commit as this project's rules say".
- **`verify`** runs a fresh agent that didn't do the implementing. It reads the brief's Acceptance/DoD and the spec's success criteria, runs the acceptance commands, and never edits code. It returns its verdict as structured output (today's `VERIFY_SCHEMA`), and Dex records it in `.dex/evidence/<id>/`. On failure the agent appends `## Phase Vn: verify fixes` to `tasks.md` with concrete tasks and commits. This is the interim verdict; 016 replaces it.
- **`learnings`** is dropped (open decision 2). The implement prompt already asks the agent to update `CLAUDE.md` with what it learned.

### D-015-6 — Questions have defaults

Agents ask through `AskUserQuestion`, which Dex already intercepts. In `recommended-then-review` mode, a question with a recommended option is answered with it, the run goes on, and the question is listed for the human to review. A question with no recommended option waits for the human. `wait` mode waits on every question. Pending questions persist in `state.json`, as today, and in `.dex/questions.md` for the CLI. `autoClarification` stays as it is for the new-project entry.

### D-015-7 — Failure policy without an LLM

Dex keeps two counters per entry in `state.json`: implement runs that checked no new task, and verify rounds. When either reaches its limit (`maxImplementRunsWithoutProgress`, `maxVerifyRounds`), the run pauses with a question. This replaces the REPLAN decisions and the LLM feature evaluation (`buildFeatureEvaluationPrompt`). It's interim: 016 replaces the counter with evidence fingerprints (D-016-7).

### D-015-8 — A headless runner

`dex run <projectDir> [--once] [--dry-run] [--status]` runs on the same core; `src/core` has no Electron imports already. It builds on `scripts/run-mock-headless.mjs`.

- `--dry-run` prints the picker's decision and the full prompt for every remaining entry without starting an agent.
- Questions and tool approvals prompt on the terminal. Without a terminal, the run pauses and writes `.dex/questions.md`.

### D-015-9 — The UI keeps what you use while a run goes

The UI keeps the project picker, the run controls with a queue panel (entry, stage, task phase, cost), the task board, the agent trace, and the questions panel, which now also handles tool approvals.

It loses the timeline, branch operations, conflict-resolver progress, the Try-N-ways remnants and profiles. The renderer re-reads `state.json` and the queue on every stage event instead of building its own state from events, which closes the class of bug 01X describes.

### D-015-10 — Upgrade the SDK first

Dex pins `@anthropic-ai/claude-agent-sdk` `^0.1.45` (0.1.77 installed); npm's current release is 0.3.318. Upgrade in Phase 0 and fix what breaks before deleting anything, so SDK churn doesn't mix into the later diffs. Read the SDK changelog for changes to `query()` options, hook output types and `canUseTool`.

## Files

### Delete

- **core:** `checkpoints/` (all of it), `checkpoints.ts`, `conflict-resolver.ts`, `agent-profile.ts`, `gap-analysis.ts`, `stages/cycle-gap-analysis.ts`, and `stages/finalize.ts` (replaced by a short post-stage function: update state, emit, check `frozen`, check gates). From `state.ts`: `reconcileState`, `detectStaleState`, `resolveWorkingTreeConflict`, `lastCommit`, `artifacts`.
- **main:** `ipc/checkpoints.ts`, `ipc/profiles.ts`, and their preload modules.
- **renderer:** `components/checkpoints/`, `services/checkpointService.ts`, `services/profilesService.ts`, and the timeline and profile parts of `App.tsx`, `LoopDashboard.tsx` and `StageList.logic.ts`.
- **events:** `step_candidate`, `head_changed`, `state_reconciling`, `state_reconciled`, `loop_reset`. Check each for other consumers first.
- **tests:** `checkpoints`, `jumpTo`, `branchOps`, `conflictResolver`, `timelineLayout`, `agentProfile` and `checkpointService` (2.5k lines). `gap-analysis` and `finalize` tests are replaced by picker and post-stage tests.
- **scripts:** `test-014-cdp.mjs`. Keep `reset-example-to.sh`, `promote-checkpoint.sh` and `prune-example-branches.sh` as fixture tools, trimmed to the branch families that still exist.

### Add

- **core:** `queue.ts` (load, read v2, `dex queue migrate`), `picker.ts` (D-015-1), `policy.ts` (D-015-3, pure), `evidence.ts` (verify records keyed by HEAD; 016 extends it), `stages/brief.ts`, `cli.ts` with a `dex` bin entry in `package.json`.
- **renderer:** `components/queue/QueuePanel.tsx`, and tool approvals in the existing questions panel.

### Change

- `agent/ClaudeAgentRunner.ts`: options come from the policy; the PreToolUse hook stops returning `allow`; `canUseTool` goes to approvals.
- `stages/main-loop.ts`: becomes the picker loop. This also pays off its KNOWN DEBT note (`runMainLoop` over 120 lines).
- `stages/cycle-stages.ts`: writes `verify.md`, appends the fix phase, drops learnings.
- `stages/run-phase.ts`: the task filter, and the project's commit rule instead of Dex's commit line.
- `stages/prerequisites.ts`: in an existing project, check only. Never `git init`, `specify init --force` or repo creation.
- `run-lifecycle.ts`: no run branch or PR in an existing project.
- `prompts.ts`, `state.ts`, `agent/MockAgentRunner.ts` and `agent/MockConfig.ts`: the new stages, so a whole queue runs under the mock at zero cost.
- The `.gitignore` block Dex writes (today `checkpoints/gitignore.ts`): `state.json`, `runs/`, `evidence/` and `questions.md` are ignored; `queue.json` and `policy.json` are tracked.

## Implementation order

After every phase, `npm test` and `npm run typecheck` pass and a mock loop on `dex-ecommerce` finishes.

0. **Baseline.** Record lines of source per area and a mock-run trace on `dex-ecommerce`. Upgrade the SDK (D-015-10) and run one real `specify` stage on `dex-ecommerce`.
1. **Delete the time machine** (Files → Delete). Stage commits go and agents commit. Until Phase 2, resume uses `lastCompletedStep`.
2. **Queue and picker** replace the manifest and the gap analysis. Delete the reconcile code; resume is now the picker. Add picker tests over fixture folders: one per row of the D-015-1 table, plus the task filter, `skip`, gates and the v2 → v3 migration.
3. **Policy and permissions** (D-015-3), with table tests. `ClaudeAgentRunner` stops using `bypassPermissions`.
4. **The existing-project entry:**
   - `dex queue init`;
   - branch handling;
   - gates;
   - the brief stage;
   - autonomous clarify;
   - `verify.md` with the fix phase;
   - the failure policy;
   - check-only prerequisites.
5. **Headless CLI** (D-015-8).
6. **UI** (D-015-9): the queue panel, approvals, deleting dead components, and the renderer re-reading state. This can run in parallel with Phase 7.
7. **Real-project check on a scratch clone of `dex-ecommerce`:** `dex queue init`, then `dex run --dry-run` over the whole queue, and the owner reviews the printed prompts. Then one real `specify`.

## Verification (DoD)

- [ ] `npm test`, `npm run typecheck` and `npm run check:size` pass.
- [ ] A mock loop on `dex-ecommerce` (new-project entry) runs every feature to `done`. Stop and Resume during `implement` continues on the same task phase.
- [ ] After `reset-example-to.sh <checkpoint>`, Resume continues from the files with no repair step.
- [ ] A commit on an entry's branch after the entry is done makes the picker verify it again.
- [ ] A whole mock run leaves `git status` clean apart from the agents' own work: Dex writes no tracked file, including `.specify/feature.json`.
- [ ] Picker tests pass, one per D-015-1 row, plus the task filter, `skip`, gates and migration.
- [ ] Policy tests pass for `deny`, `ask`, `writeRoots`, `frozen` and the no-opinion `{}`. One live check shows that a project `settings.json` `ask` rule reaches the approval panel instead of running.
- [ ] Existing-project fixture: a copy of `dex-ecommerce` with a hand-written queue runs to `done` under the mock. The queue has one entry starting at `implement` with a task filter, and one at `specify` with a `baseBranch`. The run creates no `dex/*` branch, no Dex commit and no push.
- [ ] `grep -rn bypassPermissions src` finds nothing outside the refusal check.
- [ ] Lines of source after this spec versus the Phase 0 baseline, by area, go in the PR description. Target: 21k or less (−25%), with the rest of the weight left in the renderer.
- [ ] `dex run --dry-run` on a scratch clone of `dex-ecommerce` prints one decision and one prompt per open queue entry, and the owner signs off before any real stage.

## Out of scope

- An Ink TUI. A status board can come later on top of the CLI.
- Parallel features or parallel task phases.
- Codex and Copilot runners. [019](../019-many-projects-any-agent/README.md) adds Codex and OpenCode, and runs several projects at once.
- Mirroring a feature branch into sibling repos. Projects that need it keep it in their own rules; Dex only checks that `repos` are clean.
- Merging a finished entry into the default branch.

## Open decisions

The proposed default is in bold.

1. **UI:** **keep Electron, slimmed (D-015-9), plus the CLI** | CLI only for now.
2. **Learnings stage:** **drop** | keep as an optional stage.
3. **New-project entry** (clarification → constitution → manifest): **keep, writing the queue** | drop it.
4. **Questions default for an existing project:** **`recommended-then-review`** | `wait`.
5. **What's tracked in the project's git:** **only `queue.json` and `policy.json`** | everything, as today.
6. **Codex/Copilot kinds and variant profiles:** **delete** | keep the type for later.
7. **The 01X brief:** **delete its folder in Phase 1** | keep it with a superseded banner.
8. **If 21k lines still feels heavy:** **decide after the real-project check**; the next cut would be the loop UI (3.4k).
