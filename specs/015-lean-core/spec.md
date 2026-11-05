# Feature Specification: Lean Core — Keep the Loop, Drop the Time Machine, Run on Existing Projects

**Feature Branch**: `015-lean-core`
**Created**: 2026-11-05
**Status**: Implemented on the branch (tasks.md: 109 of 114 done). Open: the live checks that spend money (T012, T067) and the owner's dogfood steps (T112, T113). SC-007 is not met; see [Outcomes](#outcomes-as-built).
**Input**: User description: "docs/my-specs/015-lean-core/README.md" — the brief, draft v1.0 of 2026-11-04. The brief is the source of truth; this spec restates it as outcomes and requirements. It supersedes the never-numbered `01X-state-reconciliation` brief.

## Overview

Dex does one valuable thing: it drives spec-kit through fresh agent sessions, stage by stage, and shows what each agent does. Most of its code does something else — git time travel (stage checkpoint commits, a timeline, jump-to-version, promote-to-main with an AI conflict resolver), keeping its own state file in step with git, variant agent profiles, and an AI gap analysis that decides how to resume. Today that is about 28.1k lines of source, and the loop itself is about 5.5k of them.

Three problems follow:

1. **Every feature pays for time travel.** Dex's state rides git checkouts, so every stage commits, every jump re-syncs, and three views of the run (the state file, git, and the UI's own event log) must agree. A single Stop has been seen to leave all three disagreeing.
2. **Dex can only start new projects.** The only way in is goal file → clarification → constitution → manifest. A project that already has specs, briefs, branch conventions and its own Claude Code setup cannot use Dex.
3. **It runs with no brakes.** Agents run with permission checks bypassed and with the user's own settings, hooks and `ask`/`deny` rules skipped. That is acceptable on the throwaway example project. It is not acceptable on a project where an agent can deploy to a shared cluster.

After this feature, Dex is: a **queue** of features, a **picker** that reads the project's files to choose the next stage, one fresh agent per stage, a **policy** the project owns and Dex enforces, and a human who is asked only when it matters. The first real user is the `onion-demo-01` project; this feature is done when Dex runs that project's queue.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Resume from the project's files, not from history (Priority: P1)

An operator stops a run, or resets the project to an earlier commit, and then resumes. Dex looks only at the project's files — the spec folder, `spec.md`, `plan.md`, `tasks.md` and the verification record — and starts the stage that is actually next. Nothing needs to be repaired or reconciled first.

**Why this priority**: Every other story depends on this. It removes the class of bugs where Dex's remembered state disagrees with the files, and it makes Stop a plain pause. It also replaces the AI gap analysis with a rule anyone can predict.

**Independent Test**: Prepare one fixture folder for each row of the decision table in FR-001. For each, ask Dex for its next-stage decision and check that it matches the row. Then run the mock loop on the example project, stop it during `implement`, resume, and check that it continues on the same task phase.

**Acceptance Scenarios**:

1. **Given** a queue entry whose spec folder does not exist, **When** the picker runs, **Then** the next stage is `specify`.
2. **Given** a `spec.md` with no `## Clarifications` section, **When** the picker runs, **Then** the next stage is `clarify`; and after `clarify` finishes, the section exists even when there were no questions.
3. **Given** `plan.md` and `tasks.md` exist and an in-scope task is unchecked, **When** the picker runs, **Then** the next stage is `implement` on the first task phase that has an unchecked in-scope task.
4. **Given** every in-scope task is checked and no verification record exists for the current `tasks.md`, **When** the picker runs, **Then** the next stage is `verify`.
5. **Given** a run is stopped in the middle of `implement`, **When** the operator presses Resume, **Then** the run continues on the same task phase with no repair step.
6. **Given** the example project is reset to any saved checkpoint, **When** the operator presses Resume, **Then** the run continues from the stage the files imply, with no repair step.
7. **Given** the operator deletes `plan.md` and `tasks.md`, **When** the picker runs, **Then** the next stage is `plan` — re-planning is a human act, not an AI decision.

---

### User Story 2 — Run under the project's own policy, with a human approving what the project marks "ask" (Priority: P1)

A project owner writes a policy file for the project and commits it. Dex loads the project's own Claude Code settings and rules, never bypasses them, and adds the policy's own `deny`, `ask`, write-root and frozen-file checks on top. When a tool call needs approval, the agent waits and the human approves or denies it.

**Why this priority**: Without this, Dex must not run on any project where an agent can do real damage. It is the precondition for the first real user, whose own settings already mark `kubectl delete`, `helm uninstall`, `terraform apply` and `git push --force` as `ask`.

**Independent Test**: Run the policy rules as a table of cases (tool, input, policy → expected decision) without starting any agent. Then make one live check: a project whose own settings mark a command as `ask` shows that tool call in the approval panel instead of running it.

**Acceptance Scenarios**:

1. **Given** a policy `deny` rule that matches `git push` with `--force`, **When** an agent tries `cd repo && git push -f origin x`, **Then** the call is denied with the rule's reason, the agent sees the reason, and the trace shows the denial.
2. **Given** a policy `ask` rule matches a tool call, **When** the agent makes the call, **Then** the call is held, the human sees the tool and its full input, and the agent continues only after the human approves; a denial is returned to the agent as a denial.
3. **Given** the project's own settings mark a command as `ask`, **When** an agent runs it, **Then** the human is asked — Dex does not auto-approve it.
4. **Given** a policy that sets write roots, **When** an agent tries to write a file outside them, **Then** the write is denied with a reason.
5. **Given** a file listed as frozen and committed, **When** a stage finishes and that file differs from the commit the stage started from, **Then** the run pauses and tells the human which file changed. *(As built, the baseline is the commit at the start of each stage, not of the entry: it catches every agent change, needs no stored state, and does not re-pause forever when the human resumes on purpose. Research R13.)*
6. **Given** a policy that requests bypassed permissions for an existing project, **When** a run starts, **Then** Dex refuses to start and says why.
7. **Given** no policy rule has an opinion on a tool call, **When** the agent makes it, **Then** Dex adds no decision of its own, and the project's own permission rules decide.
8. **Given** a tool call that no policy rule and no project `ask` or `deny` rule matched, **When** the session's permission mode would otherwise need an answer, **Then** Dex allows it. *(Added in the plan, research R6 option A: in SDK sessions the project's `allow` rules apply only in a trusted folder, so sending every unmatched call to the human would make an unattended run impossible. The policy and the project's `deny`/`ask` rules have already run.)*

---

### User Story 3 — Run a queue on an existing project without Dex touching its git history (Priority: P1)

An operator has a project that already has specs, briefs, branch conventions and its own rules. They write a queue file by hand (or have Dex propose one), and Dex works through it entry by entry. Agents commit as the project's rules say. Dex itself never commits, never creates a run branch and never pushes in that project; it only switches to the branch an entry needs, and only when the tree is clean.

**Why this priority**: This is the reason for the feature — Dex can only start new projects today. It is the first real user's whole need.

**Independent Test**: Copy the example project, write a queue by hand with one entry that starts at `implement` with a task filter and one entry that starts at `specify` with a base branch, and run it under the mock agent. Check that both entries reach `done`, and that the run created no Dex branch, no Dex commit and no push.

**Acceptance Scenarios**:

1. **Given** an entry whose `skip` lists every stage up to `tasks` and whose task filter names `T110` and `T122-T134`, **When** the run starts, **Then** `implement` runs only on phases that hold those tasks, and tasks outside the filter never block `verify`.
2. **Given** an entry about to run `brief` or `specify` whose own branch does not exist yet, **When** the project is not on the entry's base branch and the tree is clean, **Then** Dex switches to the base branch first, and spec-kit creates the entry's branch and spec folder with the exact names from the queue. *(If the entry's branch already exists, the stage runs on that branch: the picker read it, and spec-kit's `git switch -c` would fail on an existing name. Research, Phase 5 gate.)*
3. **Given** an entry whose next stage is after `specify`, **When** the project is not on the entry's branch and the tree is clean, **Then** Dex switches to that branch before the stage.
4. **Given** a branch switch is needed, **When** the tree has uncommitted changes, **Then** the run pauses with a question instead of switching.
5. **Given** a stage finishes and leaves uncommitted changes, **When** the next stage would start, **Then** the trace reports the dirty tree, and Dex does not commit it.
6. **Given** an existing project, **When** the run ends, **Then** Dex does not push and does not open a pull request unless the policy turns that on.
7. **Given** an existing project, **When** prerequisites run, **Then** Dex only checks them; it never initializes a repository, re-initializes spec-kit, or creates a remote repository.
8. **Given** a project with spec and brief folders but no queue, **When** the operator runs `dex queue init`, **Then** Dex proposes one entry per folder for the human to edit, and writes nothing else.
9. **Given** a project that still has the old feature-manifest file, **When** Dex loads the project, **Then** it migrates the manifest to the queue format and the run behaves the same.

---

### User Story 4 — An independent agent checks the work, and a stuck feature stops (Priority: P2)

When an entry's in-scope tasks are all checked, a fresh agent that did not do the implementing checks the work against the brief's acceptance criteria and the spec's success criteria. It runs the acceptance commands, never edits code, and writes a verification record. If verification fails, it appends a phase of concrete fix tasks, and the loop implements them. If the feature stops making progress, the run pauses for the human instead of spending more.

**Why this priority**: Without an independent check, "all tasks checked" means only that the implementing agent says it is done. Without counters, a stuck feature burns budget. This replaces the AI-based feature evaluation and the replan decision.

**Independent Test**: Under the mock agent, make verification fail once and then pass. Check that a fix phase is appended to `tasks.md`, that `implement` runs it, that verification runs again against the new `tasks.md`, and that the entry ends `done`. Separately, make `implement` check no new task twice and check that the run pauses with a question.

**Acceptance Scenarios**:

1. **Given** all in-scope tasks are checked, **When** `verify` runs, **Then** it writes `specs/<id>/verify.md` with the verdict, a fingerprint of the `tasks.md` it checked, and each command it ran with its exit code.
2. **Given** verification fails, **When** the verify stage ends, **Then** `tasks.md` ends with a new `## Phase <N>: Verify fixes V<k>` section of concrete tasks (`N` the next phase number, `k` the round), and the picker sends the loop back to `implement`. *(The brief's literal `## Phase Vn:` would not parse as a task phase, so the phase keeps a numeric number; research R8.)*
3. **Given** `verify.md` records a pass for the current `tasks.md`, **When** the picker runs, **Then** the entry counts as `done` and the picker moves to the next entry.
4. **Given** `tasks.md` changed after the last verification, **When** the picker runs, **Then** the old record no longer counts and `verify` runs again.
5. **Given** two `implement` runs in a row checked no new task, **When** the next stage would start, **Then** the run pauses with a question.
6. **Given** three verify rounds failed for one entry, **When** the next stage would start, **Then** the run pauses with a question. The rounds are counted from the `Verify fixes V*` phases in `tasks.md`, so the count survives a reset.
7. **Given** any other stage ran and the picker then asks for the same stage of the same entry, **When** the next stage would start, **Then** the run pauses (`no_progress`) instead of running it again. *(Added, research R9: it covers a `clarify` that wrote no `## Clarifications` section and a `plan` that wrote no `plan.md`.)*

---

### User Story 5 — Questions have defaults, so the loop does not stall on easy ones (Priority: P2)

Agents ask questions. In the default mode, a question that comes with a recommended option is answered with it, the run goes on, and the question is kept in a list for the human to review later. A question with no recommended option waits for the human. A project can choose to wait on every question instead.

**Why this priority**: The first real user's owner is not watching the run. Stopping on every question would make an unattended run impossible; answering every question blindly would hide decisions from the owner.

**Independent Test**: Under the mock agent, raise one question with a recommended option and one without. In the default mode, check that the first is answered and listed for review and the second waits. In `wait` mode, check that both wait.

**Acceptance Scenarios**:

1. **Given** the default mode and a question with a recommended option, **When** an agent asks it, **Then** the recommended option is the answer, the run continues, and the question appears in the review list.
2. **Given** the default mode and a question with no recommended option, **When** an agent asks it, **Then** the run waits for the human.
3. **Given** `wait` mode, **When** an agent asks any question, **Then** the run waits for the human.
4. **Given** a pending question, **When** Dex is restarted, **Then** the question is still pending, and it is also readable as plain text in `.dex/questions.md`. *(The app restores a held question or approval only while a run is live; a request left by a crashed process is not offered. A resumed run drops every pending request and asks again.)*
5. **Given** a new project, **When** a clarification step (clarification, constitution, manifest extraction) asks a question, **Then** the Automatic Clarification switch decides (on: recommended-then-review; off: wait). Every other stage follows the policy's `questions` mode.
6. **Given** the autonomous `clarify` stage, **When** a question can be answered from the brief, the repo or its docs, **Then** the agent answers it and records the question and the answer in the spec; it asks the human only when nothing in the repo answers it and a wrong guess would cost more than a day.

---

### User Story 6 — Run headless from a terminal, and preview a run before it spends anything (Priority: P2)

An operator runs Dex from a terminal without the desktop app. Before the first real stage, they ask for a dry run: for every remaining queue entry, Dex prints the stage it would run next and the full prompt it would send, and starts no agent. During a real run, questions and tool approvals are asked on the terminal.

**Why this priority**: The dry run is the owner's safety review before Dex touches a real project. The headless runner also lets Dex run where no desktop session is open.

**Independent Test**: Run the dry run against the example project and against a copy with a hand-written queue. Check that it prints one decision and one prompt per remaining entry, starts no agent and spends nothing. Run one entry with `--once` under the mock and check that it stops after one stage.

**Acceptance Scenarios**:

1. **Given** a project with a queue, **When** the operator runs `dex run <projectDir> --dry-run`, **Then** Dex prints, for each remaining entry, the next-stage decision and the full prompt, and starts no agent.
2. **Given** a project, **When** the operator runs `dex run <projectDir> --status`, **Then** Dex prints the queue, each entry's status and stage, and the pending questions, and starts no agent.
3. **Given** a headless run with a terminal, **When** a question or a tool approval comes up, **Then** it is asked on the terminal and the answer goes back to the agent.
4. **Given** a headless run with no terminal, **When** a question or a tool approval comes up, **Then** the run pauses and writes the question to `.dex/questions.md`; the process exits with code 3.
5. **Given** a state file exists, **When** the operator runs `dex run <projectDir>` again, **Then** it resumes, also after a completed run (a new project has one run branch, and Resume follows the checkout). A resume at a terminal first asks the requests the last run left and books the answers; the stage that asks again gets them from the book.
6. **Given** any `error` event during a run, **When** the run ends, **Then** `dex run` exits 1, even if the loop carried on.

---

### User Story 7 — Write a missing brief from sources, and pause where the owner wants to look (Priority: P3)

Some queue entries have no brief yet, only a list of source documents. Dex writes the brief first, using the previous entry's brief as the format example. Because a brief is the source of truth for every later stage, the run pauses after it by default so the owner can review it. Any stage can be marked as such a gate.

**Why this priority**: The first real user's later entries (Months 2–4) need this, but the first two entries do not. It can ship after the core loop works.

**Independent Test**: Under the mock agent, run an entry that has `generate` sources and no brief. Check that the brief is written, that the run pauses after it, and that after the owner approves, the next stage is `specify`.

**Acceptance Scenarios**:

1. **Given** an entry whose brief file is missing and which lists `generate` sources, **When** the picker runs, **Then** the next stage is `brief`.
2. **Given** the `brief` stage finishes, **When** `brief` is in the entry's gates (the default for generated briefs), **Then** the run pauses for the owner's approval before `specify`.
3. **Given** an entry lists any stage in its gates, **When** that stage finishes, **Then** the run pauses for approval. A gate applies only to a stage that finished, not to one that Stop or a limit cut short; Resume is the approval and nothing is stored.

---

### User Story 8 — A slimmer app that shows what you need while a run goes (Priority: P3)

The desktop app keeps the project picker, the run controls with a new queue panel (entry, stage, task phase, cost), the task board, the agent trace, and the questions panel — which now also handles tool approvals. The timeline, branch operations, conflict-resolver progress, the leftovers of "try N ways" and agent profiles are gone. After every stage, the app re-reads the run state and the queue from disk, so what it shows always matches the files.

**Why this priority**: The UI is the largest remaining weight, and it is where the "three views disagree" bugs showed up. The headless runner already covers a run without it, so this can run in parallel with the dogfood run.

**Independent Test**: Open the example project in the app, start a mock run, and check that the queue panel shows each entry's stage and cost, that a tool approval appears in the questions panel and can be approved, and that no timeline or branch controls appear anywhere.

**Acceptance Scenarios**:

1. **Given** a run is going, **When** a stage starts or ends, **Then** the queue panel shows the current entry, stage, task phase and cost, read from disk.
2. **Given** a tool call is held for approval, **When** the operator opens the questions panel, **Then** they see the tool and its input and can approve or deny it.
3. **Given** the app after this feature, **When** the operator looks at any screen, **Then** there is no timeline, no jump-to-version, no promote-to-main, no branch delete and no agent-profile control.
4. **Given** the app was closed during a run, **When** it opens again, **Then** it shows the same queue and stage the files say, with no reconcile step.
5. **Given** a snapshot of the project, **When** the operator presses Start, **Then** the action follows the snapshot: an invalid queue or policy disables it; a paused run, or an open entry with a run state, resumes; an open entry without one starts the queue loop; a project with no queue runs its unfinished spec folders in build mode.
6. **Given** a run paused on a gate, a limit, a dirty tree, a frozen file, a failed preflight, no progress or bad input, **When** the operator opens the questions panel, **Then** a pause card shows the reason and detail. Continue is Resume; Stop closes the card and leaves the run paused.
7. **Given** questions answered by default, **When** the operator looks at the queue panel, **Then** the review list is there (nothing waits on them, so they are not in the questions panel).
8. **Given** a queue, **When** the app shows the cycle count and the timeline placeholders, **Then** they come from the queue view (done of the entries that will run; one placeholder per entry not started, at most three).

---

### Edge Cases

- **Spec folder exists but `spec.md` does not** (for example, `specify` crashed early): treated as a missing spec, so the next stage is `specify`.
- **Every queue entry is `done` or `skipped`**: the run ends and reports that the queue is complete.
- **All in-scope tasks are checked, but tasks outside the filter are not**: the entry goes to `verify`; out-of-scope tasks never block it.
- **The task filter names a task id that `tasks.md` does not contain**: Dex reports the unknown ids and pauses before that entry's `implement`; it does not guess.
- **A brief path is set, the file is missing, and the entry has no `generate`**: the run pauses (`invalid_input`) naming the missing file.
- **An entry has `generate` but no `brief`**: the queue is invalid, because `brief` is the path `generate` writes. Dex refuses to start and names the entry.
- **An existing-project entry has neither its own branch nor its base branch**, or its branch is missing but its base already holds the spec folder: the run pauses (`invalid_input`) with the reason; Dex creates no branch.
- **A new-project entry has no brief** (it came from the goal file through manifest extraction): `specify` uses the entry's description and `verify` uses the spec's success criteria.
- **Both the old manifest and the new queue exist**: the queue wins; the manifest is not migrated over it.
- **The policy file is missing**: the defaults in FR-020 apply.
- **The policy file does not parse or has an unknown field value**: Dex refuses to start and names the problem; it never runs on a half-read policy. The CLI exits 2 for an invalid or refused queue or policy.
- **A stage finishes but the picker still asks for it**: the run pauses (`no_progress`) rather than running it again (FR-036).
- **A tool call is held and no human can answer** (`dex run` with no terminal): the held request is parked, the stage is aborted, and the run pauses with `question` or `tool_approval` and exit code 3. The next `dex run` asks the parked requests first.
- **A `deny` rule hides inside a chained or wrapped command** (`a && b`, `bash -c "…"`): the rule matches the whole command string, so it still applies. This is a guardrail against an agent's mistakes, not a sandbox against a hostile agent.
- **The human is away while a tool call waits for approval**: the agent keeps waiting; Stop denies the held call and pauses the run.
- **A stage hits its budget or turn limit**: the stage stops and the run pauses (`limit_reached`) naming the limit.
- **The run hits its total budget limit**: the run stops before the next stage; the state is `paused` with `limit_reached`.
- **A stage is stopped by Stop**: it leaves nothing behind (the mock writes, ticks and commits nothing) and does not count toward the implement-without-progress counter; Resume runs the same task phase.
- **A `tasks.md` task line uses `[X]`** (spec-kit writes it) **or `[x]`**: both mean done.
- **A preflight command exits non-zero**: the run (or the next `implement` / `verify`) does not start, and the operator sees the command and its exit code.
- **An extra checkout listed in `repos` has uncommitted changes**: preflight fails and the status panel shows which checkout is dirty.
- **Dex's own runtime files change during a run** (run state, run records, the questions list): they never count as a dirty tree for the branch-switch check. Dex writes no tracked file during a run. Untracked files do count as dirty, listed one by one, because an agent's leftovers would ride onto another branch.

## Requirements *(mandatory)*

### Functional Requirements

#### Next-stage picker (D-015-1)

- **FR-001**: Dex MUST choose the next stage only from the project's files. It MUST take the first queue entry that is not `done` or `skipped`, and check, in this order:

  | Check | Next stage |
  |---|---|
  | The brief file is missing and the entry has `generate` | `brief` |
  | The spec folder (or its `spec.md`) is missing | `specify` |
  | `spec.md` has no `## Clarifications` section | `clarify` |
  | `plan.md` is missing | `plan` |
  | `tasks.md` is missing | `tasks` |
  | An in-scope task is unchecked | `implement`, on the first task phase that has one |
  | `verify.md` is missing, or records a different `tasks.md` fingerprint | `verify` |
  | `verify.md` records a pass for the current `tasks.md` fingerprint | the entry counts as `done`; go to the next entry |

  An entry's files are read from the entry's own branch when it exists, without switching to it, so the decision never depends on which branch happens to be checked out. The branch the current checkout is on is read from the working tree, so uncommitted progress counts. A `verify.md` that says `failed` for the current `tasks.md` also sends the loop to `verify`; the no-progress guard (FR-036) stops that from looping. A gate (FR-002 and the entry's `gates`) applies only to a stage that finished.

- **FR-002**: Stages listed in an entry's `skip` MUST be treated as done.
- **FR-003**: Resume MUST mean "run the picker again". There MUST be no reconcile, repair or state-sync step before it.
- **FR-004**: Dex's run state MUST no longer be tracked in the project's git. It MUST keep only what the files cannot say: run id and status, cost, attempt counters, pending questions and the configuration snapshot.
- **FR-005**: The AI gap analysis (resume / replan / resume-at-step) MUST be removed. Re-planning MUST happen only when a human deletes `plan.md` and `tasks.md`.

#### Git behavior (D-015-2)

- **FR-006**: Dex MUST NOT make stage checkpoint commits in any project. Agents commit as the project's rules say.
- **FR-007**: In an existing project, Dex MUST NOT create a run branch, commit, push or open a pull request on its own.
- **FR-008**: Before a stage, Dex MUST make sure the project is on the branch the picker read for it, and switch to it if the tree is clean. That is the entry's own branch once it exists, else its base branch (only `brief` and `specify` can run on the base; the picker pauses any later stage of an entry whose branch is missing). *(Amended from "before `specify`, the base branch": spec-kit's branch creation fails on a name that already exists. Research, Phase 5 gate.)*
- **FR-009**: If a branch switch is needed and the tree is dirty, the run MUST pause with a question. Changes to Dex's own runtime files MUST NOT count as dirty.
- **FR-010**: After each stage, Dex MUST report a dirty tree in the trace (`tree_dirty`) and MUST NOT commit it. The only commit Dex still makes anywhere is the GitHub-repo setup in a new project's prerequisites, after the human picks "create a new repo".
- **FR-011**: A new project MUST keep its single Dex run branch. Opening a pull request at the end of a run MUST be opt-in for both kinds of project, and off by default; it opens only when the queue ended complete (or a build-mode run finished) and the run has a base branch to compare against.

#### Policy and permissions (D-015-3)

- **FR-012**: The policy MUST live in `.dex/policy.json`, tracked in the project's git, with the fields and defaults in FR-020.
- **FR-013**: Agents MUST load the Claude Code settings the policy names (default: user, project and local), so the project's own hooks and `ask`/`deny` rules apply. Every agent MUST run with Claude Code's preset system prompt (plus the policy's append file), and with the process environment merged under the policy's and the stage's `env`, because the SDK replaces the child's environment.
- **FR-014**: Dex MUST refuse to run an existing project with permission checks bypassed.
- **FR-015**: Before every tool call, Dex MUST check the policy:
  - a `deny` match MUST be denied with its reason and shown in the trace;
  - an `ask` match MUST be held for the human (FR-017);
  - a file write (Edit, Write, MultiEdit, NotebookEdit) outside the write roots, or to a frozen file that is committed at HEAD, MUST be denied with a reason;
  - with no match, Dex MUST add no decision, so the project's own rules decide.
- **FR-016**: `deny` and `ask` patterns MUST match against the whole shell command string, so chained and wrapped commands are covered.
- **FR-017**: When the project's settings or a policy `ask` rule need a human decision on a tool call, the agent MUST wait while the app or the terminal shows the tool call; the human approves or denies it. Dex MUST NOT auto-approve these calls. The existing interception of agent questions MUST keep working.
- **FR-018**: After each stage, every frozen file MUST be compared with the commit the stage started from (committed or not); a modified, deleted or renamed frozen file MUST pause the run. A frozen file created during the stage does not pause it ("frozen" means once committed). *(Amended from "the commit the entry started from", research R13: a per-stage baseline catches every agent change, needs no stored state and does not re-pause forever when the human resumes on purpose.)*
- **FR-019**: The policy decisions MUST be computable without starting an agent, so they can be tested from tables of cases.
- **FR-020**: The policy fields and their defaults MUST be:

  | Field | Meaning | Default |
  |---|---|---|
  | `settingSources` | Which Claude Code settings load | user, project, local |
  | `permissionMode` | Permission mode for agents | `default`; bypass is refused for an existing project |
  | `env` | Extra environment for every agent | none |
  | `deny` | `{tool, pattern, reason}` rules | none |
  | `ask` | Same shape; a match holds the call for the human | none |
  | `writeRoots` | The only paths file writes may target | the project folder and the OS temp folder |
  | `frozen` | Files no agent may change once committed | none |
  | `preflight` | Commands that must exit 0 before a run and before each `implement` and `verify` | none |
  | `repos` | Extra checkouts (globs) that must be clean; shown in the status panel | none |
  | `systemPromptAppend` | A Markdown file (project-relative) appended to every agent's system prompt; `null` means none | none |
  | `questions` | `recommended-then-review` or `wait` | `recommended-then-review` |
  | `openPullRequest` | Push and open a PR at the end of the run | off |
  | `limits` | Budget per stage, budget per run, turns per stage, implement runs without progress (2), verify rounds (3) | as shown |

  Unknown fields are rejected. Limits come from the policy only: the run configuration carries no budget, retry or cycle-count field of its own.

#### Queue (D-015-4)

- **FR-021**: The feature list MUST be one queue, `.dex/queue.json`, for both kinds of project. Dex MUST read the old feature-manifest format and migrate it.
- **FR-022**: A new project MUST still fill the queue through manifest extraction. An existing project MUST be able to write it by hand.
- **FR-023**: `dex queue init` MUST list the project's spec folders and brief folders and propose one entry for each, for the human to edit. It MUST NOT start a run, run git or overwrite an existing queue. It also writes `.dex/policy.json` (every default spelled out) and `.dex/.gitignore`, each only when absent, and refuses a project with no feature folder.
- **FR-024**: A queue entry MUST support: `id` (also the default spec folder and branch name), `title`, `description`, `status` (optional and human-owned: `done` or `skipped` overrides; every other status — `pending`, `active`, `done` — is derived from files, and Dex MUST NOT write the queue file during a run), `brief`, `generate` (`{sources, instructions}`), `specDir` and `branch` (defaults `specs/<id>` and `<id>`), `baseBranch` (default: the previous entry's branch, else the current branch), `tasks` (scope filter with single ids and ranges such as `T122-T134`), `skip` and `gates`. Unknown fields are rejected, and `generate` requires `brief`. In a `new` queue every entry's branch is the run branch. `dex queue init` makes a lowercase id from a folder name that is not a valid id, and keeps the real folder name in `brief` and `specDir`.

#### Stages (D-015-5)

- **FR-025**: `brief` MUST write the entry's brief from its `generate` sources, using the previous entry's brief as the format example. The brief MUST have an acceptance section the verify stage can check. It MUST be gated by default. It runs through the same generic file-stage path as `specify`; it has no module of its own.
- **FR-026**: `specify` MUST run spec-kit's specify command with the entry's exact branch name and spec folder, and the prompt MUST say that the brief is the source of truth.
- **FR-027**: `clarify` MUST run autonomously: it answers each question from the brief, the repo and its docs, records each question and answer in the spec, always writes the `## Clarifications` section, and asks the human only when nothing in the repo answers the question and a wrong guess would cost more than a day.
- **FR-028**: Before every per-entry stage except `brief`, Dex MUST point spec-kit at the entry's spec folder through the agent's environment (`SPECIFY_FEATURE_DIRECTORY`), not by writing a tracked file; for `specify` in an existing project it also sets `GIT_BRANCH_NAME` to the entry's exact branch (research R5).
- **FR-029**: `implement` MUST run one task phase per agent, pass the in-scope task ids when the entry has a filter, and tell the agent to commit as the project's rules say instead of Dex's own commit instruction.
- **FR-030**: `verify` MUST run in a fresh agent that did not implement the work. It MUST read the brief's acceptance criteria and the spec's success criteria, run the acceptance commands, never edit code, and write `specs/<id>/verify.md` with the verdict, the `tasks.md` fingerprint it checked, and each command with its exit code. On failure it MUST append `## Phase <N>: Verify fixes V<k>` to `tasks.md` with concrete tasks (a numeric phase number, because the task parser needs one; fix phases are always in scope). Dex computes the `tasks.md` fingerprint and hands it to the agent, which copies it verbatim.
- **FR-031**: The `learnings` stage MUST be removed. The implement prompt keeps asking the agent to record what it learned in the project's own agent instructions.
- **FR-032**: In an existing project, the prerequisites stage MUST only check; it MUST NOT initialize git, re-initialize spec-kit, or create a repository.
- **FR-033**: Every stage MUST run under the mock agent, so a whole queue runs at zero cost. The mock is entry-keyed (`entries`, with a `"*"` fallback), ticks the tasks of the phase it is given, may ask questions, writes `verify.md` from the fingerprint in the prompt, and commits `mock(<stage>): <entry>` as an agent following the project's rules would.

#### Questions (D-015-6)

- **FR-034**: In `recommended-then-review` mode, a question with a recommended option MUST be answered with it and listed for review; a question without one MUST wait for the human. In `wait` mode, every question MUST wait. An option is recommended when its label ends in `(Recommended)` (the question tool has no `recommended` field); the old fallback "pick the first option" is gone.
- **FR-035**: Pending questions MUST persist across a restart in the run state and in `.dex/questions.md`. The question mode is per stage: a new project's clarification steps (clarification, constitution, manifest extraction) follow the Automatic Clarification setting; every other stage follows `policy.questions`. `.dex/questions.md` MUST exist while anything waits or the review list is not empty, and MUST be removed otherwise. Answers given while no agent waits (a terminal `dex run` after a parked run) go to an answer book that the re-run stage reads.

#### Failure policy (D-015-7)

- **FR-036**: Dex MUST count, per entry, the `implement` runs that checked no new task and the verify rounds. When either reaches its limit, the run MUST pause with a question. This MUST replace the AI-based feature evaluation and the replan decision. The verify-round count MUST come from the `Verify fixes V*` phases in `tasks.md`; only the implement counter lives in the run state. A stage stopped by Stop MUST NOT count toward the implement counter. When the picker asks for the same stage of the same entry right after it ran (any stage but `implement`), the run MUST pause (`no_progress`) instead of running it again.
- **FR-037**: When a stage reaches its budget or turn limit, the stage MUST stop and the run MUST pause with a question that names the limit. When the run reaches its budget limit, the run MUST stop before the next stage (state `paused`, reason `limit_reached`).

#### Headless runner (D-015-8)

- **FR-038**: `dex run <projectDir>` MUST run the same loop as the app, with `--once` (one stage, then stop; it applies to queue stages, not to a new project's prerequisites and clarification steps), `--dry-run`, `--status` and `--agent`. It MUST resume whenever `.dex/state.json` exists, use the app's run settings (model `claude-opus-4-6`, 75 turns, 50 iterations), and start a new run with Automatic Clarification off.
- **FR-039**: `--dry-run` MUST print the picker's decision and the full prompt for every remaining entry, and MUST NOT start an agent or write any file (a v2 manifest migrates in memory only, and git is read with `--no-optional-locks`). `--status` prints the same snapshot the app reads.
- **FR-040**: With a terminal, questions and tool approvals MUST be asked on the terminal. Without one, the run MUST pause and write `.dex/questions.md`. Exit codes: 0 done (or a finished `--once`, `--dry-run`, `--status`); 1 failed, including any `error` event; 2 a usage error or an invalid or refused queue or policy; 3 the run paused and needs a human (also Ctrl-C).

#### App (D-015-9)

- **FR-041**: The app MUST keep the project picker, the run controls with a queue panel (entry, stage, task phase, cost), the task board, the agent trace, and the questions panel, which MUST also handle tool approvals.
- **FR-042**: The app MUST lose the timeline, jump-to-version, branch operations, promote-to-main, conflict-resolver progress, the "try N ways" leftovers and agent profiles.
- **FR-043**: After each stage-boundary event (`run_started`, `step_started`, `step_completed`, `paused`, `run_completed`, `loop_terminated`), the app MUST re-read the run state and the queue from disk (`project:get-run-snapshot`) instead of building its own state from events. It MUST NOT guess the next stage: `currentStage` moves only on `step_started`. The live trace stays event-driven, and a failed read keeps the last snapshot.

#### Removed capabilities

- **FR-044**: Dex MUST remove: stage checkpoint commits, the timeline, jump-to-version and its temporary fork branches, promote-to-main with the AI conflict resolver, branch delete, variant agent profiles (including the Codex and Copilot runner kinds and worktree overlays), the AI gap analysis, the `learnings` stage, and the code that keeps the run state in step with git. The docs for removed features (the branch-management test plans, the 01X brief, the Timeline sections of the README, SOLUTION and FINAL_PLAN) and the `d3-*` packages that only the timeline used go with them.
- **FR-045**: Every event, app-to-engine interface and test that only served a removed capability MUST be removed with it. An event MUST be checked for other consumers before it is removed.
- **FR-046**: The example-project fixture scripts (reset, promote-checkpoint, prune-branches) MUST be kept and trimmed to the branch families that still exist.

#### Delivery constraints

- **FR-047**: The agent toolkit Dex builds on MUST be upgraded to its current release, and the loop MUST work on it, before any capability is removed, so toolkit changes do not mix into the removal changes. As built, the SDK is `0.3.318` (from `0.1.77`), the two `query()` call sites share one options builder, and the dead TodoWrite progress path is replaced by a re-parse of `tasks.md` after a write to it (research R1).
- **FR-048**: After every implementation phase, the test suite, the type check and the size check MUST pass, and a mock loop on the example project MUST finish.

### Key Entities

- **Queue**: the ordered list of features to build, one per project, tracked in the project's git. Replaces the feature manifest.
- **Queue entry**: one feature — its id, brief, spec folder, branch, base branch, task scope, skipped stages, gates and status.
- **Brief**: the human-owned description of a feature; the source of truth for every stage of that entry.
- **Policy**: the project-owned rules for a run — which settings load, the permission mode, `deny`/`ask` rules, write roots, frozen files, preflight commands, extra checkouts, prompt additions, the question mode, PR opt-in and limits. Tracked in the project's git.
- **Policy rule**: a `{tool, pattern, reason}` triple in `deny` or `ask`.
- **Verification record** (`verify.md`): the verdict for one entry, the `tasks.md` fingerprint it applies to, and each command with its exit code.
- **Run state**: what the files cannot say — run id and status, cost, attempt counters per entry, pending questions, the configuration snapshot. Not tracked in git.
- **Pending question / tool approval**: something the human must answer before the agent continues; persisted across restarts and mirrored to `.dex/questions.md`. A **pause** is a third kind of request: the run has already ended, and Resume answers it.
- **Review list**: the questions answered by default in `recommended-then-review`, kept in the run state and in `.dex/questions.md` until the human has looked at them.
- **Answer book**: answers given while no agent waited (a terminal run after a parked run); the re-run stage reads them.
- **Run snapshot**: the one read the app and `dex run --status` share: the run state, the queue view with each entry's derived status and cost, and every queue or policy error.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For each of the 8 rows of the next-stage table, plus the task filter, `skip`, gates and the manifest migration, a fixture produces the expected decision — 100% pass.
- **SC-002**: A mock run of the example new project takes every feature to `done` at zero cost. Stop and Resume during `implement` continues on the same task phase.
- **SC-003**: After resetting the example project to any saved checkpoint, Resume continues from the stage the files imply, with zero repair steps.
- **SC-004**: An existing-project fixture (one entry starting at `implement` with a task filter, one at `specify` with a base branch) runs to `done` under the mock and creates 0 Dex branches, 0 Dex commits and 0 pushes.
- **SC-005**: Policy cases for `deny`, `ask`, write roots, frozen files and the no-opinion case all pass, and one live check shows a project-settings `ask` rule reaching the approval panel instead of running.
- **SC-006**: No agent in an existing project can run with permission checks bypassed; the only remaining reference to bypass mode in the source is the refusal check.
- **SC-007**: Source size drops from 28.1k lines to 21k or less (at least 25% smaller), measured per area against the Phase 0 baseline and reported in the pull request.
- **SC-008**: A stuck entry (2 `implement` runs with no new task checked, or 3 failed verify rounds) pauses for the human in 100% of cases, with no further agent spend on that entry.
- **SC-009**: A dry run over the `onion-demo-01` queue prints exactly one decision and one prompt for each of its 5 entries, starts no agent, and the owner signs it off before any real stage runs.
- **SC-010**: Dex runs the first real stage on `onion-demo-01` (`specify` for `021-agent-entry`) with the owner watching, with no policy breach and no Dex-made commit, branch or push.

### Outcomes (as built)

Recorded at the end of the implementation, from the evidence in [research.md](research.md) (the phase gates and "Final checks"). Nothing here changes a target above.

| Criterion | Outcome |
|---|---|
| SC-001 | Met. One passing case per row of the next-stage table, plus task filter, `skip`, gates and the manifest migration (`picker`, `queue` and `loop` tests). |
| SC-002 | Met. The mock run of a new project takes all three entries to `done`: 27 steps, 0 Dex commits, a clean tree. Stop in `implement` and Resume runs the same task phase. |
| SC-003 | Met on a scratch clone: a reset to the `mock(tasks)` commit resumes on `implement` phase 1 with no repair step. |
| SC-004 | Met. The existing-project fixture ends `queue_complete`; the only new branch is the one the mock `specify` made; every new commit is `mock(...)`; exit 0 proves no push was tried. |
| SC-005 | Policy table cases met. The live check (a project `ask` rule reaching the approval card) is **open** (T067, needs the owner's approval). The approval card has component tests, and the live UI check (T106) covered everything but that card, because the mock makes no tool calls. |
| SC-006 | Met. `bypassPermissions` appears in `policy.ts` and its test only. |
| SC-007 | **Not met.** 22,086 lines after the format pass (22,116 at the end of the branch), which is 21.4% below the 28,110 baseline, not 25%. The additions came out larger than estimated (the CLI, the snapshot path, the approval UI). The target is unchanged; research § R14 has the table and the candidate cut for the owner's open decision 8. |
| SC-008 | Met by tests (`failure-policy`, `loop`): two implement runs with no new task, or three failed verify rounds, pause with no further agent run. |
| SC-009 | **Open** (T112, owner step: the owner writes the onion-demo-01 queue and policy first). |
| SC-010 | **Open** (T113, owner step, real spend). |

## Assumptions

- **Open decisions from the brief take the proposed default.** The brief marks a default for each; this spec adopts all eight:
  1. Keep the desktop app, slimmed (User Story 8), plus the headless runner.
  2. Drop the `learnings` stage.
  3. Keep the new-project entry (clarification → constitution → manifest), now writing the queue.
  4. Questions default to `recommended-then-review` for an existing project.
  5. Only `queue.json` and `policy.json` are tracked in the project's git; run state, run records and `questions.md` are ignored.
  6. Delete the Codex/Copilot runner kinds and variant profiles entirely.
  7. Delete the `01X-state-reconciliation` brief folder in Phase 1.
  8. Decide after the dogfood run whether to cut further (the next cut would be the loop UI, about 3.4k lines).
- **Entry status is derived, not written** (plan research R2, amending the brief). The brief has Dex write each entry's `status` into the tracked queue file. Because Dex never commits, that edit would make the tree dirty, block the next branch switch, and go stale after a reset. So `done` is derived from `verify.md`, and the queue's `status` field is a human-owned override (`done` / `skipped`). Dex writes no tracked file during a run. For the same reason, spec-kit is pointed at the entry's spec folder through the agent's environment, not by writing `.specify/feature.json` (research R5).
- **Ignore rules for Dex's runtime files are part of setup.** In a new project Dex writes them as today. In an existing project they come with the queue and policy files that the human reviews and commits; Dex does not silently edit the project's ignore file.
- **The checkout is single-writer.** Dex runs in the project's main checkout (the first real user's sibling clones do not exist in a worktree), and nobody else edits that checkout while Dex runs.
- **Owner authorization is the project's business.** What agents may commit, push or deploy in an existing project comes from that project's own rules plus its policy file and prompt additions — not from Dex.
- **A tool approval waits with no timeout.** Stop is the way out.
- **The example project `dex-ecommerce` stays the end-to-end test bed**, reset through the existing fixture scripts, and a copy of it with a hand-written queue is the existing-project fixture.
- **The first real user's queue and policy are written in that project**, not in this repo. Appendix A of the brief records their content; this feature only has to support it.

## Out of Scope

- A terminal dashboard (TUI). A status board can come later, on top of the headless runner.
- Parallel features or parallel task phases.
- Codex and Copilot runners.
- Mirroring a feature branch into sibling repos. Projects that need it keep it in their own rules; Dex only checks that the listed extra checkouts are clean.
- Merging a finished entry into the default branch.
- A sandbox against a hostile agent. The policy is a guardrail against an agent's mistakes.
