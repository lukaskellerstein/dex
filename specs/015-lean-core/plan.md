# Implementation Plan: Lean Core — Keep the Loop, Drop the Time Machine, Run on Existing Projects

**Branch**: `015-lean-core` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/015-lean-core/spec.md`; brief `docs/my-specs/015-lean-core/README.md`
**Approved**: 2026-11-05 by the owner, including R2 (derived entry status), R5 (spec folder through the environment) and R6 option A (`canUseTool` allows a call that no policy or project ask rule matched)
**Status**: built on the branch (tasks.md: 109 of 114). This plan was synced to the build on 2026-11-05; where the build differs from the text first approved, the line says so and points to the research note. Open: T012, T067, T112, T113.

## Summary

Dex shrinks to its loop: a **queue** of features (`.dex/queue.json`), a
**picker** that reads only the project's files (and, for other branches,
`git show`) to choose the next stage, one fresh agent per stage, a **policy**
the project owns (`.dex/policy.json`) that Dex enforces in a PreToolUse hook and
in `canUseTool`, and a human who is asked through one request queue (questions,
tool approvals, gates, limits). The git time machine (checkpoint commits,
timeline, jump, promote, conflict resolver), agent profiles, the AI gap
analysis and the state reconciler are deleted. A headless `dex` CLI runs the
same core. The work runs in the brief's order: upgrade the SDK first, delete
second, then build the new parts on a smaller base.

Two research decisions amend the spec. Both make D-015-1 and D-015-2 hold
together:

- **R2:** entry status is derived from files, so Dex never writes the tracked
  queue file during a run.
- **R5:** spec-kit's feature folder is passed through the environment, not
  written into `.specify/feature.json`.

## Technical Context

**Language/Version**: TypeScript 5.6 (strict), Node v26.1.0 (type stripping on by default)
**Primary Dependencies**: Electron 41, React 18.3, Vite 6, `@anthropic-ai/claude-agent-sdk` 0.1.77 → **0.3.318** (R1; brings peers `zod ^4`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`), lucide-react; `d3-*` removed (done); `package.json` gains `bin: { dex: dist/core/cli.js }`
**Storage**: files only — `.dex/queue.json`, `.dex/policy.json` (tracked); `.dex/state.json`, `.dex/runs/`, `.dex/questions.md` (runtime); per-run log tree under `~/.dex/logs/`
**Testing**: `node --test` (core, `scripts/ts-resolve-hook.mjs`), vitest + jsdom (renderer), `scripts/check-size.sh`; `npm run typecheck` (3 tsconfigs); `nvim-tools --json --all`; mock-agent end-to-end runs on scratch clones of `dex-ecommerce`; electron-playwright over CDP 9333 for the UI
**Target Platform**: macOS / Linux desktop (Electron) and a headless Node CLI
**Project Type**: desktop app + CLI over a shared platform-agnostic core
**Performance Goals**: the picker answers in < 200 ms on a 5-entry queue (it is a few file reads and `git show` calls); a whole mock queue runs in under 2 minutes
**Constraints**:
- `src/core` imports nothing from Electron (constitution II);
- `policy.ts` imports no SDK;
- Dex makes no commit, branch or push in an existing project;
- no `bypassPermissions` outside the refusal check;
- every phase ends with the tests, the typecheck and a green mock loop
**Scale/Scope**: 28,110 → ≤ ~21k lines of source planned; **22,086 built (22,009 at the end of the branch, after a dead-code cut and the compound-command check)**, so SC-007 is not met (research § R14). 207 files changed: 71 deleted, 67 added (23 of them tests and test helpers), 69 modified; real-project check on a scratch clone of dex-ecommerce

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|---|---|---|
| I. Clean-Context Orchestration | ✅ pass | One `query()` per stage; `verify` always runs in a fresh agent that did not implement; context comes only from files (brief, spec, tasks, `verify.md`). |
| II. Platform-Agnostic Core | ✅ pass | `queue.ts`, `picker.ts`, `policy.ts`, `humanInput.ts`, `branching.ts`, `cli.ts` all live in `src/core` with no Electron import. The CLI is the proof: it runs core without Electron. |
| III. Test Before Report | ✅ pass | Each phase has a DoD in `quickstart.md`. The constitution still names `npx tsc --noEmit` and "chrome-devtools MCP"; the newer `.claude/rules/06-testing.md` (`npm run typecheck`, electron-playwright) is followed. That is an elaboration, not a conflict. |
| IV. Simplicity First | ⚠️ one justified exception | The v2 → v3 manifest migration is a compatibility shim, which the principle forbids. The brief requires it (D-015-4). See Complexity Tracking. Everything else removes code: there is no state v1 → v2 shim (old state is treated as absent, because position comes from files). |
| V. Mandatory Workflow | ✅ pass | Spec → plan (this) → tasks → implement per phase → test → report. |
| Tech constraints | ✅ pass | No new runtime dependency. The `d3-*` removal touches no named constraint. `gsap` stays (R18). |
| No commits unless asked | ✅ pass | Dex itself stops committing; only agents commit, under the project's rules. |

**Post-build re-check (2026-11-05):** unchanged. `src/core` imports no Electron (the CLI runs from `dist/core/cli.js` under plain Node); `policy.ts` imports no SDK; `bypassPermissions` appears in `policy.ts` and its test only; the one shim is `migrateManifest` in `queue.ts`.

**Post-design re-check (after Phase 1 artifacts):** unchanged. The contracts
add no Electron import to core and no new dependency. The only shim is still
the manifest migration.

## Project Structure

### Documentation (this feature)

```text
specs/015-lean-core/
├── spec.md              # /speckit-specify (amended by R2/R5)
├── plan.md              # this file
├── research.md          # R1–R18
├── data-model.md        # queue v3, policy, state v2, requests, verify record, picker decision
├── quickstart.md        # runnable validation, per phase and per success criterion
├── contracts/
│   ├── queue-json.md    # .dex/queue.json v3 + `dex queue init`
│   ├── policy-json.md   # .dex/policy.json + the permission chain
│   ├── verify-md.md     # specs/<id>/verify.md + the fix phase
│   ├── cli.md           # `dex run`, `dex queue init`, exit codes, questions.md
│   └── ipc-events.md    # IPC channels and orchestrator events: delete / change / add
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
src/core/
├── queue.ts                 # ADD  load / validate / resolve defaults / migrate v2 → v3 / save; isInScope, isFixPhase
├── queue-init.ts            # ADD  `dex queue init` (moved out of queue.ts: it also writes policy.json and .dex/.gitignore)
├── picker.ts                # ADD  pickNext + describeQueue/describeEntries over TreeReader (R2, R3); verify.md reader
├── tree-reader.ts           # ADD  workingTree(dir) | gitRef(dir, ref) via `git cat-file -t` / `cat-file blob` on `<ref>:./<rel>`
├── policy.ts                # ADD  parsePolicy, loadPolicy, decideToolUse, refusal (pure, no SDK)
├── branching.ts             # ADD  dirtyFiles / isTreeClean (minus runtime paths, `--untracked-files=all`, `--no-optional-locks`), prepareBranch, stageBranch (R4)
├── preflight.ts             # ADD  policy.preflight + repos checks (R12); first failure wins, async `execFile`
├── humanInput.ts            # ADD  (new file, not a rename of userInput.ts, which is deleted) question | tool_approval | pause; answer book; review list; parkAll; questionModeFor (R7)
├── run-snapshot.ts          # ADD  one read for IPC `project:get-run-snapshot` and `dex run --status` (R17)
├── cli.ts + cli/            # ADD  `dex run`, `dex queue init` (contracts/cli.md); cli/{args,describe,run,terminal}.ts hold the parser, the dry-run and status views, the run driver and the terminal I/O
├── config.ts                # CHANGE RunConfig loses maxLoopCycles / maxBudgetUsd / maxVerifyRetries / maxLearningsPerCategory; gains `once`; LOOP_DEFAULTS (model claude-opus-4-6, 75 turns, 50 iterations)
├── state.ts                 # SHRINK to v2 I/O + lock (drop reconcile, drift, artifacts, lastCommit); owns RUNTIME_IGNORE_ENTRIES and ensureRuntimeIgnore
├── manifest.ts              # DELETE (planned: shrink). Extraction (stages/manifest-extraction.ts) writes queue v3; the v2 migration lives in queue.ts
├── prompts.ts               # CHANGE stage builders (R11); drop learnings / gap / eval / verify-fix
├── run-lifecycle.ts         # CHANGE no run branch / PR in existing projects; policy load
├── orchestrator.ts          # CHANGE resume = picker; drop detect/resolve/reconcile calls
├── git.ts                   # CHANGE createPullRequest opt-in; add switchBranch, branchExists, isTrackedAtHead (`cat-file -e`), frozenChangesSince; `getHeadSha` already existed, `headSha` was not added; a test-only `statusPorcelain` helper was removed (branching.dirtyFiles is the status read)
├── events.ts, types.ts      # CHANGE per contracts/ipc-events.md
├── dexConfig.ts             # SHRINK drop conflictResolver
├── agent/
│   ├── claudeSession.ts     # ADD  buildQueryOptions(policy) + the one message loop for runStep and runTaskPhase; PostToolUse re-parse of tasks.md
│   ├── permissions.ts       # ADD  preToolUseDecision (PreToolUse hook) and makeCanUseTool (AskUserQuestion, approvals, else allow)
│   ├── ClaudeAgentRunner.ts # CHANGE thin: two entry points over claudeSession; drop runOneShot; `limitHitOf` maps result subtypes
│   ├── AgentRunner.ts       # CHANGE drop profile, worktreePath, OneShot*
│   ├── MockAgentRunner.ts   # CHANGE entry-keyed, ticks tasks, writes verify.md, agent-style commits (R15)
│   └── MockConfig.ts        # CHANGE entries map replaces cycles[]
├── stages/
│   ├── loop.ts              # ADD  replaces main-loop.ts: picker → guards → preflight → prepareBranch → stage → post-stage (`runQueueLoop`)
│   ├── post-stage.ts        # ADD  replaces finalize.ts: state, emit, dirty report, frozen, gates, no-progress
│   ├── (brief.ts)           # NOT BUILT: `brief` runs through the generic file-stage path (buildStagePrompt + runStage), like `specify`
│   ├── cycle-stages.ts      # CHANGE becomes implement + verify runners (verify.md, fix phase); learnings out
│   ├── run-phase.ts         # CHANGE scope filter, project commit rule, merged prompt builder;
│   │                        #        TodoWrite path out, tasks.md re-parse on write instead (R1)
│   ├── run-stage.ts         # CHANGE no finalize call (post-stage is the caller's)
│   ├── prerequisites.ts     # CHANGE check-only for existing projects
│   ├── manifest-extraction.ts # CHANGE writes queue.json v3
│   ├── clarification.ts, build.ts # keep
│   └── main-loop.ts, cycle-gap-analysis.ts, cycle-failure-policy.ts, finalize.ts   # DELETE
├── checkpoints/, checkpoints.ts, conflict-resolver.ts, agent-profile.ts, gap-analysis.ts   # DELETE
└── __tests__/               # ADD queue, picker, policy, humanInput, branching, post-stage, cli-dry-run;
                             #     helpers/git.ts (mkTmpRepo, copied out of branchOps.test.ts before deletion)
                             # DELETE checkpoints, jumpTo, branchOps, conflictResolver, timelineLayout,
                             #     agentProfile, gap-analysis, finalize; agent/__tests__/runOneShot

src/main/
├── ipc/orchestrator.ts      # CHANGE answer-request replaces answer-question (resolves a held question or approval only; a pause is answered by Resume)
├── ipc/project.ts           # CHANGE add get-run-snapshot
├── ipc/checkpoints.ts, ipc/profiles.ts, ipc/lock-utils.ts, ipc/logger.ts   # DELETE
├── preload-modules/checkpoints-api.ts, profiles-api.ts                     # DELETE
└── index.ts, preload.ts     # CHANGE registration

src/renderer/
├── components/queue/QueuePanel.tsx        # ADD  also lists the answers given by default (the review list)
├── components/loop/ClarificationPanel.tsx # CHANGE hosts the question, ToolApprovalCard and PauseCard
├── components/loop/ToolApprovalCard.tsx, PauseCard.tsx   # ADD  Continue on a pause card is Resume; Stop closes the card
├── hooks/useRunSnapshot.ts                # ADD  re-read on six stage-boundary events (R17); startActionFor (Start/Resume) and queueProgress (cycle count, placeholder cycles)
├── hooks/useLoopState.ts, useOrchestrator.ts, useProject.ts, useUserQuestion.ts   # SHRINK
├── App.tsx, LoopDashboard.tsx, StageList.logic.ts, StageList.tsx, CycleTimeline.tsx, LoopPhase.tsx   # CHANGE drop timeline/path parts
├── components/layout/TopTabBar.tsx        # DELETE (only Steps / Timeline tabs)
├── components/checkpoints/ (19 files), services/checkpointService.ts, services/profilesService.ts   # DELETE
└── electron.d.ts            # CHANGE DexAPI

scripts/
├── loc-by-area.sh           # ADD  (R14)
├── smoke-stage.mjs          # ADD  one real `runStep` for the Phase 0 check (T012)
├── run-mock-headless.mjs    # DELETE — replaced by `dex run` with the mock agent
├── test-014-cdp.mjs, validate-mock-config.mjs (stale `from`)   # DELETE
├── check-size.sh            # CHANGE drop dead allow-list entries
└── reset-example-to.sh, prune-example-branches.sh, trigger-mock-via-cdp.mjs   # CHANGE $HOME, not /home/lukas; trim branch families

fixtures/
├── mock/new-project.json, mock/existing-project.json, mock/verify-fails-once.json   # ADD
└── existing-project/queue.json, existing-project/policy.json, existing-project/specs/900-fixture-a/   # ADD
```

**Structure Decision**: the existing three-layer layout (`src/core`,
`src/main`, `src/renderer`) stays. The CLI is one more entry point in
`src/core` (`cli.ts` → `dist/core/cli.js`, `bin: dex`). Test fixtures that are
whole project files go in a top-level `fixtures/` folder, next to `scripts/`,
because both the core tests and the quickstart use them.

## Phases (the brief's implementation order)

After every phase: `npm test`, `npm run typecheck` and `check:size` pass, and a
mock loop on a `dex-ecommerce` scratch clone finishes (quickstart § 1–2).

| # | Phase | Delivers | Key risk |
|---|---|---|---|
| 0 | **Baseline + SDK** | `npm install`; `loc-by-area.sh` output recorded in R14; a mock-run trace kept; SDK 0.3.318 and the R1 fixes (TodoWrite → `tasks.md` re-parse, `init` subtype, `env` spread, preset system prompt, `modelUsage`, abort in `runTaskPhase`); one real `specify` on a `dex-ecommerce` scratch clone | the preset system prompt changes agent behaviour. The real stage costs money, so ask the owner first. |
| 1 | **Delete the time machine** | Files → Delete from the brief. Stage commits go, and the mock agent commits instead (R15). Resume still uses `lastCompletedStep` until Phase 2. Before deleting, copy the git test helpers out of `branchOps.test.ts`. | dangling imports in `App.tsx` / `LoopDashboard.tsx`. Typecheck after every deleted folder. |
| 2 | **Queue + picker** | `queue.ts`, `tree-reader.ts`, `picker.ts`, `stages/loop.ts`, state v2. Delete reconcile, gap analysis, `main-loop.ts`. Manifest extraction writes v3. Picker tests per D-015-1 row, plus filter, `skip` and migration. | new-project parity: the mock loop must still take every feature to `done` |
| 3 | **Policy + permissions** | `policy.ts` + table tests; `buildQueryOptions(policy)`; PreToolUse returns `{}` without an opinion; `canUseTool` → `humanInput` approvals; `bypassPermissions` gone | the SDK permission chain (R6). The live check (quickstart § 9) proves it. |
| 4 | **Existing-project entry** | `dex queue init`; `branching.ts`; gates; `brief` stage; autonomous `clarify`; `verify.md` + fix phase; failure policy; check-only prerequisites; preflight | dirty-tree pauses in the mock fixture: the mock commits, so the tree stays clean |
| 5 | **Headless CLI** | `cli.ts`, `bin`, TTY and no-TTY input, answer book, `--once` / `--dry-run` / `--status` | stdin handling under `node --test` |
| 6 | **UI** | `useRunSnapshot`, `QueuePanel`, approval and pause cards, timeline and profile UI removed, `d3-*` removed | runs in parallel with Phase 7 |
| 7 | **Real-project check** | `dex queue init` and `dex run --dry-run` on a scratch clone of dex-ecommerce, then one real `specify` | never on the original repo or any other project (owner's decision) |

### How the phases ran

The brief's Phases 0–7 above were carried out as tasks.md Phases 1–11 (the user stories were split out), and research.md's "Phase N gate" notes use the tasks.md numbers: Phase 2 deletes, 3 is the picker loop (US1), 4 the policy (US2), 5 the existing project (US3), 6 the failure policy (US4), 7 questions (US5), 8 the CLI (US6), 9 brief and gates (US7), 10 the app (US8), 11 polish. Each phase ended with the tests, the typecheck, `check:size` and a mock loop. All 114 tasks are done. T012, T067 and T113 are real agent runs on dex-ecommerce scratch clones, about $0.12 in all.

## Where the build differs from the approved plan

Every item below is recorded in research.md with its reason; this list is the index. The first block changes behaviour the spec states; the second is placement and naming.

**Behaviour**

| Plan said | Built | Why (research) |
|---|---|---|
| R4: `brief`/`specify` go to the base branch, later stages to the entry's branch | `prepareBranch` targets the tree the picker read: the entry's branch once it exists, else its base | spec-kit's `git switch -c` fails on an existing branch (Phase 5 gate) |
| R4: clean = `status --porcelain --untracked-files=normal` | `--untracked-files=all` with `--no-optional-locks`; runtime list is `RUNTIME_IGNORE_ENTRIES` | an untracked `.dex/` of runtime files must not be one dirty folder; a read must not write `.git/index` (Phase 5, Phase 8 gates) |
| R13: frozen at write time via `git ls-files --error-unmatch` | `isTrackedAtHead` uses `git cat-file -e HEAD:./<rel>`; write tools include `MultiEdit` | a staged-only file is not committed; MultiEdit writes files too (Phase 4 gate) |
| R8: fix phase `## Phase <max+1>: Verify fixes V<k>` | as planned. The spec's wording `## Phase Vn:` is amended to match | the parser needs a numeric phase number |
| R9: the picker re-issuing `(entry, stage)` pauses `no_progress` | as planned; `implement` is exempt (it has its own counter), and a Resume starts with no `last`, so it gets one more attempt | `progressCheck` in `post-stage.ts` |
| R7: question mode by `autoClarification` / policy | per stage via `questionModeFor`: the new-project clarification steps follow `autoClarification`, every other stage follows `policy.questions`; `ReviewItem.stage` is a `StepType` | a new project's clarification steps are not queue stages (Phase 7 gate) |
| R7: `.dex/questions.md` for pending requests | also kept while the review list is not empty ("Nothing waits for you right now.") | Phase 7 gate |
| R10: a gate pauses after the gated stage | only after a stage that finished, not after Stop or a limit | Phase 9 gate |
| Contract: `--once` runs one stage | `RunConfig.once`; the loop breaks after one queue stage and pauses `user_abort`; prerequisites and clarification of a new project are not counted | Phase 8 gate |
| Contract: no-TTY pauses with exit 3 | `parkAll` releases the agents with the stop answer, `WaitingForHuman` is the abort reason, `finalizeRun` reads it and pauses `question` / `tool_approval`; Resume drops every pending request (`clearStaleRequests`) | Phase 8 gate |
| `dex run` starts or resumes | resumes whenever `.dex/state.json` exists, also after a completed run; the CLI starts with Automatic Clarification off | one run branch per new project; Resume follows the checkout (Phase 3, Phase 8 gates) |
| Exit 1 on an unhandled error | on any `error` event, even if the loop went on | quickstart § 5 depends on it: exit 0 proves no push was tried |
| `RunConfig` budget fields | removed; limits come from `policy.limits` only; `limitHit` (`turns` / `budget`) replaces the SDK `subtype` on `StepResult` and `TaskPhaseResult` | Phase 6 gate |
| PR on every finished run | opt-in (`policy.openPullRequest`) for both kinds; a new project opens none by default | FR-011 |
| Run record status | a paused or failed loop writes `paused` / `failed` (it wrote `completed`) | Phase 3 gate |
| Start/Resume in the app | `startActionFor(snapshot)`; the pause card does not use `answer-request` | Phase 10 gate |
| Cycle count and placeholder cycles | `queueProgress(snapshot)`: done of the entries that will run; one placeholder per entry not started, at most three | the old rule divided finished cycles by cycles seen (commit `b0f5082`) |
| Mock fixtures | `entries` map; optional `prerequisites` and `clarification`; `asks`, `tick`, `rounds`; a stopped mock stage leaves nothing behind | R15; Phase 3, Phase 7 gates |
| `generate` without `brief` | invalid queue | `brief` is the path `generate` writes |
| `systemPromptAppend` default | `null` accepted as "none" (`dex queue init` writes the defaults spelled out) | Phase 5 gate |

**Placement and naming**

- `humanInput.ts` is a new file, not a rename of `userInput.ts`; it exports `askQuestions` and `recordPause` rather than one `requestHuman()`; the loop entry is `runQueueLoop`.
- `manifest.ts` was deleted, not shrunk; `queue-init.ts` holds `initQueue`; there is no `stages/brief.ts`.
- The permission chain lives in `agent/permissions.ts`, the options builder in `agent/claudeSession.ts`; `SessionParams` carries `policy` and `entryId`.
- `run-snapshot.ts` and `cli/` are new; `featureSlug` in the run record is the entry id.
- `.specify/feature.json` in this repo points at `specs/015-lean-core` (spec-kit's own pointer); Dex writes it nowhere.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| v2 `feature-manifest.json` → v3 `queue.json` migration (a compatibility shim; constitution IV) | D-015-4 requires it: `dex-ecommerce` and any project Dex built before carry a v2 manifest, and its `completed` statuses must survive, because v2 runs wrote no `verify.md` | *Ignore v2 and re-extract*: every finished feature would be re-verified, at real cost. *Keep both formats live*: two code paths forever. The shim is one function (~40 lines), runs once per project, and writes v3. |
