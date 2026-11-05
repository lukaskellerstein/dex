# Feature Specification: Grounded Loop — Tests and Checks Decide, Not the Agent

**Feature Branch**: `016-grounded-loop`
**Created**: 2026-11-05
**Status**: Implemented under the mock (2026-11-05). The first real run (SC-004) is pending — see Outcomes (as built).
**Input**: User description: "docs/my-specs/016-grounded-loop/README.md" — the brief, draft v1.0 of 2026-11-05. The brief is the source of truth; this spec restates it as outcomes and requirements. It builds on [015-lean-core](../015-lean-core/spec.md) (the queue, the picker, the policy, the evidence records and the `dex run` CLI), amends 015's picker table (D-015-1) and `verify` stage (D-015-5), and replaces 015's failure counter (D-015-7).

## Overview

After 015, Dex measures progress by the boxes an agent ticked in `tasks.md`, and calls an entry done when the verify agent says `passed`. In both cases the agent grades its own work. Published evidence says that is not enough: agents claim improvement on cycles that changed nothing or made things worse, they declare victory early, and an AI judge reading the full diff still accepts real regressions. Where success is checked from outside the agent, the false progress goes away.

So this feature puts tests and checks into the loop in two roles:

1. **Tests are written first, as their own stage**, by an agent that does not implement. They are the oracle, and they exist before the code does.
2. **Dex runs the tests and checks itself**, outside any agent, and Dex alone decides whether a gate passed. What an agent says about its own work is input to that decision, never the decision.

Four gates carry this:

| Gate | When | Passes when | On failure |
|---|---|---|---|
| **red-first** | after the `tests` stage | the new acceptance tests fail by an assertion, not by a crash | already green → pause; crash → run `tests` again |
| **baseline** | before every `implement` and `verify` | the fast checks are green | the stage becomes "restore green first, no new tasks" |
| **progress** | after every `implement` run | a new in-scope task is ticked, checks are green, plan and tests are intact | the run does not count as progress |
| **done** | after `verify` | acceptance is green **and** the verifier has no blocking finding | a fix phase is appended; back to `implement` |

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Progress counts only when Dex's own checks agree (Priority: P1)

A project owner declares the project's fast checks (for example, the unit tests and the type check) in the policy. After every `implement` run, Dex runs those checks itself and compares `tasks.md` with how it was before the run. The run counts as progress only when a new in-scope task is ticked **and** the checks are green **and** the plan is intact. Before every `implement` and `verify`, Dex runs the same checks as a baseline; if they are red, the next agent is told to restore green first, with the failing output in its prompt. A check that fails and then passes on a re-run is reported as flaky, not obeyed. A feature that keeps failing the same way stops.

**Why this priority**: This is the cheapest gate and the one that runs most often. It closes the main hole — ticked boxes with broken code — and every later story builds on the sensor runs and evidence records it introduces.

**Independent Test**: Under the mock agent, with fake checks that can be switched red or green per run: (a) let the agent tick a task while a check is red and confirm the run does not count as progress and the next run's prompt says "restore green first"; (b) make a check fail once and pass on its re-run and confirm it is recorded `flaky` and does not block; (c) make two runs in a row repeat the run before them exactly and confirm the run pauses with the evidence.

**Acceptance Scenarios**:

1. **Given** an `implement` run ticks a new in-scope task and every fast check is green, **When** the run ends, **Then** the progress gate passes and the evidence record lists each check with its exit code, duration and output tail.
2. **Given** an `implement` run ticks a task while a fast check is red, **When** the run ends, **Then** the progress gate fails, the run does not count as progress, and the next stage's prompt is "restore green first, no new tasks" with the failing check's evidence.
3. **Given** the fast checks are red before an `implement` stage, **When** the stage starts, **Then** its prompt is "restore green first, no new tasks" and includes the failing evidence.
4. **Given** a check fails and passes on its re-run, **When** the gate decides, **Then** the check is recorded `flaky`, does not block, and is listed in the digest.
5. **Given** the same check was flaky three times in one entry, **When** the next gate would use it, **Then** the run pauses and asks the human to fix the check or retire it.
6. **Given** two `implement` runs in a row each produce the same fingerprint as the run before them (the same failing checks, the same first error line of each, the same diff), **When** the next stage would start, **Then** the run pauses with the evidence.
7. **Given** the policy declares no fast checks, **When** the progress gate decides, **Then** it rests on the plan diff alone, and the digest says that no checks ran.

---

### User Story 2 — An entry is done only when Dex's acceptance run is green and no blocking issue is open (Priority: P1)

When an entry's in-scope tasks are all ticked, Dex first runs the entry's acceptance commands itself. If they are red, a fresh verifier agent diagnoses the failure from the evidence Dex collected and appends a phase of concrete fix tasks. If they are green, the verifier reviews the work against the spec and the brief — in a browser, as a user would, when the policy asks for it — and reports findings as `blocking` or `minor`. The entry is done only when acceptance is green **and** no finding is blocking. The verifier can block an entry; it can never pass one on its own. A later commit makes the entry verify again.

**Why this priority**: This is the change that makes "done" mean done. Without it, the verifier's own word is still the verdict.

**Independent Test**: Under the mock agent: (a) make acceptance red while the scripted verifier says `passed` and confirm the entry is not done and a fix phase is appended; (b) make acceptance green and script a blocking finding and confirm the entry is not done and a fix phase is appended; (c) make acceptance green with only minor findings and confirm the entry is done; (d) commit on a done entry's branch and confirm the picker sends it to `verify` and acceptance runs again.

**Acceptance Scenarios**:

1. **Given** all in-scope tasks are ticked and the baseline is green, **When** `verify` starts, **Then** Dex runs every acceptance command for the entry before any verifier agent starts, and records the results.
2. **Given** acceptance is red, **When** the verifier runs, **Then** it runs in diagnose mode with Dex's evidence and diff, and appends a verify-fix phase of concrete tasks to `tasks.md`.
3. **Given** acceptance is green, **When** the verifier runs, **Then** it runs in review mode against the spec and the brief, and returns findings marked `blocking` or `minor`.
4. **Given** acceptance is red and the verifier's output says `passed`, **When** the done gate decides, **Then** the gate fails.
5. **Given** acceptance is green and the verifier reports a blocking finding, **When** the done gate decides, **Then** the gate fails and a fix phase for the finding is appended.
6. **Given** acceptance is green and every finding is minor, **When** the done gate decides, **Then** the entry is done and the minor findings are listed in the digest.
7. **Given** an entry is done, **When** anyone commits on its branch (or, in a new project, changes its spec folder), **Then** the picker sends it back to `verify` and acceptance runs again.
8. **Given** the policy sets `verify.browser`, **When** the verifier reviews, **Then** it works the feature end to end in a browser.
9. **Given** the verifier runs in either mode, **When** it tries to write any file other than the entry's `tasks.md`, **Then** the write is denied.

---

### User Story 3 — Acceptance tests are written first, by an agent that does not implement (Priority: P1)

After `tasks` and before the first `implement`, a `tests` stage runs. Its fresh agent writes acceptance tests at the feature's boundary — a command line, an HTTP API, the UI in a browser, or the project's own evidence tool — from the spec's success criteria, the brief's acceptance section and the plan's contracts. It reports the test files, the acceptance command, and which success criterion each test covers. Dex then runs the acceptance command itself: the tests must fail, by an assertion, before the feature exists. Tests that already pass test nothing, and the run pauses to say so.

**Why this priority**: Without an oracle written before the code, the acceptance run in User Story 2 has nothing independent to run for a feature that ships no commands of its own.

**Independent Test**: Under the mock agent with fake sensors: (a) a `tests` stage whose acceptance command fails by an assertion passes the red-first gate and the loop goes on to `implement`; (b) one whose command already passes pauses the run; (c) one whose command crashes sends the loop back to `tests`; (d) an entry with `skip: ["tests"]` and no `acceptance` command pauses with a question.

**Acceptance Scenarios**:

1. **Given** an entry whose `tasks.md` exists and which has no acceptance test record and does not skip `tests`, **When** the picker runs, **Then** the next stage is `tests`.
2. **Given** the `tests` stage finishes, **When** Dex records its output, **Then** the acceptance command becomes one of the entry's acceptance sensors and the test files become the entry's frozen test set.
3. **Given** the acceptance command fails by an assertion, **When** the red-first gate decides, **Then** it passes and the next stage is `implement`.
4. **Given** the acceptance command passes before any implementation, **When** the red-first gate decides, **Then** the run pauses with "the tests pass before the feature exists".
5. **Given** the acceptance command crashes, times out, or finds no tests, **When** the red-first gate decides, **Then** the gate fails and `tests` runs again, with the evidence.
6. **Given** an entry with `skip: ["tests"]` and an `acceptance` command in its queue entry, **When** the picker runs, **Then** `tests` is skipped and the queue's command is the acceptance sensor.
7. **Given** an entry with `skip: ["tests"]` and no `acceptance` command, **When** the picker reaches that entry's first `implement`, **Then** the run pauses with a question instead of guessing.

---

### User Story 4 — The implementer cannot weaken the plan or the tests (Priority: P2)

The acceptance tests are frozen for the implementer and the verifier. Each stage gets its own write scope: the test author writes tests and its own spec folder, the implementer writes anything in the project's write roots except the frozen tests, and the verifier writes only `tasks.md`. After every `implement` run, Dex checks that only checkboxes changed in `tasks.md`. If the implementer believes a test is wrong, it asks; the human decides, and only the test author changes the test.

**Why this priority**: The gates in Stories 1–3 are only as strong as the plan and tests they read. Without this story an agent can pass a gate by rewording a task or editing a test. It ships after the gates exist, because it protects them.

**Independent Test**: Under the mock agent: script an edit to a frozen test and confirm it is denied with `policy_denied` in the trace; script a reworded task and confirm the run pauses; script a deleted test file and confirm the run pauses; script a new skip marker and confirm it is reported in the digest and does not pause; script a test-amendment question and confirm it waits for the human even in `recommended-then-review` mode.

**Acceptance Scenarios**:

1. **Given** an entry with a frozen test set, **When** the implementer or the verifier tries to edit, move or delete one of those files, **Then** the call is denied with a reason and the trace shows `policy_denied`.
2. **Given** an `implement` run removes, rewords or renumbers a task in `tasks.md`, **When** the run ends, **Then** the run pauses and names the changed task.
3. **Given** an `implement` run deletes or renames a file that matches the test patterns, **When** the run ends, **Then** the run pauses and names the file.
4. **Given** an `implement` run adds a skip or expected-failure marker to a test, **When** the run ends, **Then** the marker is listed in the digest and the run does not pause.
5. **Given** the implementer asks to amend a test, with its reason, **When** the question reaches Dex, **Then** Dex offers "approve amendment" and "reject", and the question waits for the human in every question mode.
6. **Given** the human approves an amendment, **When** the loop goes on, **Then** the `tests` stage runs again as the test author, scoped to that test, and the frozen test set is updated.
7. **Given** the human rejects an amendment, **When** the loop goes on, **Then** the implementer gets the rejection and the test stays as it is.
8. **Given** the `tests` stage runs, **When** its agent tries to write outside the test patterns and its own spec folder, **Then** the write is denied.

---

### User Story 5 — A one-page digest tells the owner what the loop made, and an attempt log tells the next agent what was tried (Priority: P2)

At every gate pause, and when an entry is done, Dex writes a one-page digest: the diff stat per repo, the tasks done, the check and acceptance results with any flaky checks, the verifier's findings, the questions answered by default, and the cost. The app shows it, and the CLI prints its path. Separately, Dex keeps an attempt log per entry — what was tried, what happened, the failing evidence and the open hypotheses — and gives its latest part to the next stage, so a fresh agent does not repeat a failed attempt.

**Why this priority**: The gates decide; the digest is how the human understands and trusts what they decided, without reading every trace. The attempt log reduces repeated failures. Both read the evidence that Stories 1–3 produce.

**Independent Test**: Under the mock agent, pause a run on a gate and confirm the digest exists with every listed section, that the app shows it, and that `dex run` prints its path. Run two `implement` runs and confirm the second prompt contains the first run's attempt entry. Finish the entry and confirm the attempt log is cleared and its archive stays in the evidence.

**Acceptance Scenarios**:

1. **Given** a run pauses on any gate, **When** the pause happens, **Then** Dex writes the entry's digest, and `dex run` prints its path.
2. **Given** an entry is done, **When** the done gate passes, **Then** Dex writes the final digest for it.
3. **Given** a digest exists, **When** the operator runs `dex digest <id>`, **Then** the digest is printed.
4. **Given** a digest exists, **When** the operator opens the entry in the app, **Then** the app shows the digest, and the trace shows the evidence of each stage.
5. **Given** a stage ends, **When** Dex writes the attempt log, **Then** the log gets an entry built from the stage's structured output and Dex's evidence.
6. **Given** an attempt log exists, **When** the next stage of that entry starts, **Then** its prompt contains the latest entries of the log, capped at about 2,000 tokens.
7. **Given** an entry is done, **When** the done gate passes, **Then** the attempt log is cleared and its content is kept in the entry's evidence archive.

---

### User Story 6 — Every unhappy path can be rehearsed at zero cost (Priority: P2)

A Dex developer can run each way the loop can go wrong under the mock agent, with fake checks that pass or fail on demand, and see the documented outcome every time.

**Why this priority**: The gates exist for the bad runs. If the bad runs are tested only on real projects, they are tested late and at real cost.

**Independent Test**: Run each scenario in FR-044 under the mock and compare the outcome with the table.

**Acceptance Scenarios**:

1. **Given** the mock with a scenario from FR-044, **When** the loop runs, **Then** it ends as the table says, at zero cost.
2. **Given** a mock configuration, **When** a scenario needs a check to be red on one run and green on the next, **Then** the fake check can be switched per run.

---

### User Story 7 — The first real grounded run on a project with checks of its own (Priority: P3)

Before Dex runs grounded on a real project, the owner configures the project's fast checks, standing checks and acceptance commands, runs a dry run, and reads, for every open entry, the checks and acceptance commands Dex will run. After the owner signs off, one real entry runs end to end: its `tests` stage writes boundary tests (HTTP or browser) that fail before the implementation, and pass after it.

**Why this priority**: It proves the whole design on a real agent and real tests. It comes last because it needs every other story.

**Independent Test**: On a scratch clone of the dex-ecommerce example project, configure the checks, run the dry run, and get the owner's sign-off. Run one real entry and read its evidence records: the red-first run fails and the final acceptance run passes, for the same tests.

**Acceptance Scenarios**:

1. **Given** a project with checks and acceptance commands configured, **When** the operator runs `dex run <projectDir> --dry-run`, **Then** the output lists, for each open entry, its fast checks, its standing checks and its acceptance commands, and nothing runs.
2. **Given** a real (non-mock) entry, **When** it runs to done, **Then** the evidence shows the same acceptance tests failing at the red-first gate and passing at the done gate.

---

### Edge Cases

- **A sensor runs past its timeout**: Dex stops it and records `timeout`. It counts as red for the gate, and as a crash for the red-first gate.
- **A sensor's program does not exist, or it cannot start**: recorded as an error, red for the gate, a crash for the red-first gate.
- **A sensor prints more than 200 lines**: only the last 200 lines are kept in the evidence.
- **The baseline is red before `verify`** (for example, after a flaky run or a change in the environment): the verifier does not start. The loop runs a "restore green first" `implement` run instead, because the verifier may write only `tasks.md`.
- **The standing checks are red before `verify`**: the same as a red baseline.
- **An entry has both a queue `acceptance` command and the command the `tests` stage recorded**: both run at the done gate. Only the `tests` stage's command takes part in the red-first gate, because a queue command can test behavior that already exists.
- **An entry's queue `checks` add fast checks**: they run with the policy's fast checks for that entry only.
- **An approved test amendment**: the red-first gate does not run again for it, because the implementation can already exist. The amended file stays frozen.
- **The evidence folder is lost** (a fresh clone, or a manual delete): no gate counts as passed. The picker sends a ticked entry to `verify`, and the acceptance run starts again. The acceptance test record is in the spec folder, so the `tests` stage does not run again.
- **An `implement` run ticks a task and also reverts a ticked one**: the reverted tick is a change other than a new tick, so the run pauses.
- **The fast checks are green but nothing new is ticked**: the run does not count as progress; the 015 limit of implement runs without progress still applies.
- **A flaky check that is green on its re-run, in a stall fingerprint**: flaky checks are not failing checks, so they are not in the fingerprint.
- **The verifier stage is stopped before it ends**: no done-gate decision is recorded; the picker runs `verify` again.
- **A digest for a project with extra checkouts** (the policy's `repos`): the diff stat lists each checkout.

## Requirements *(mandatory)*

### Functional Requirements

#### Sensors and evidence (D-016-1)

- **FR-001**: A sensor MUST be a command the project declares: a fast or standing check in the policy, an `acceptance` command or extra check in a queue entry, or the acceptance command the `tests` stage recorded.
- **FR-002**: Dex MUST run every sensor in its own process, not through an agent, with the sensor's timeout.
- **FR-003**: For every sensor run, Dex MUST record the exit code, the duration, the result (`pass`, `fail`, `error`, `timeout` or `flaky`) and the last 200 lines of output, in `.dex/evidence/<id>/<stage>-<n>.json`. The record MUST be keyed by the entry's evidence key (015's key: the entry branch's HEAD in an existing project, a hash of the spec folder in a new one) and the `tasks.md` hash.
- **FR-004**: Every gate decision MUST be computable from evidence alone, without starting an agent, so it can be tested from tables of cases.
- **FR-005**: A gate MUST NOT pass on an agent's structured output alone. An agent's claim MAY block a gate; it MUST NOT pass one.

#### Picker (amends D-015-1)

- **FR-006**: The picker table MUST gain these rows between `tasks` and `implement`, in this order: an entry that skips `tests` and has no queue `acceptance` pauses (FR-008); an approved test amendment that is still pending sends the entry to `tests` in amend mode (FR-016); an entry that does not skip `tests` goes to `tests` when its acceptance test record is missing, or when the last red-first run for that record crashed (FR-013). *(Amended in the plan, research R4.)*
- **FR-007**: The picker's done row MUST become "the done gate passed for the entry as it is now" (the same key and `tasks.md` hash). A later commit on the entry's branch (or, in a new project, a change in its spec folder) MUST invalidate it, so the picker sends the entry to `verify` again.
- **FR-008**: An entry with `skip: ["tests"]` and no `acceptance` command MUST pause with a question before its first `implement`, because it can never pass the done gate.

#### The `tests` stage and the red-first gate (D-016-2)

- **FR-009**: The `tests` stage MUST run after `tasks` and before the first `implement`, in a fresh agent that does not implement the entry.
- **FR-010**: The `tests` agent MUST write acceptance tests from the spec's success criteria, the brief's acceptance section and the plan's contracts, at the feature's boundary (a command line, an HTTP API, the UI in a browser, or the project's evidence tool). It MUST NOT unit-test code that does not exist yet.
- **FR-011**: The `tests` agent MUST leave a tracked acceptance test record in the entry's spec folder (`acceptance.json`): the test files, the acceptance command, the exit codes that mean "tests ran and some failed", and the success criterion each test covers. The record survives a reset and is reviewed in git. Dex validates it; the stage's structured output carries only the summary for the attempt log. *(Amended in the plan, research R3: one canonical record, not a file plus a structured copy.)*
- **FR-012**: Dex MUST make the recorded acceptance command one of the entry's acceptance sensors and the recorded test files the entry's frozen test set.
- **FR-013**: Right after the `tests` stage, Dex MUST run the red-first gate: it passes when the acceptance command fails by an assertion. When the command passes, the run MUST pause ("the tests pass before the feature exists"); Resume accepts the tests, and deleting the record makes the stage run again. When it crashes, times out, collects no tests, or the record is missing or invalid, the `tests` stage MUST run again once with the evidence; a second crash in a row MUST pause the run. *(Amended in the plan, research R4 and R20.)*

#### Frozen tests and amendments (D-016-3)

- **FR-014**: During `implement` and `verify`, Dex MUST deny any edit, move or delete of a file in the entry's frozen test set, with a reason shown in the trace. This extends 015's `frozen` mechanism with one set per entry.
- **FR-015**: When the implementer asks to amend a test, Dex MUST offer "approve amendment" and "reject" options, and the question MUST wait for the human in every question mode.
- **FR-016**: An approved amendment MUST re-run the `tests` stage as the test author, scoped to that test; a rejected one MUST be returned to the implementer as a rejection.

#### Backpressure (D-016-4)

- **FR-017**: The policy's fast checks MUST be run cheapest first, and every check MUST run even after one fails, so the evidence is complete.
- **FR-018**: After every `implement` run, Dex MUST run the progress gate. It passes only when at least one in-scope task is newly ticked, every fast check is green (flaky counts as green), and the plan and the tests are intact (FR-025, FR-026). A run that fails the gate MUST NOT count as progress. A "restore green" run (FR-019) ticks nothing, so for it progress means: every check that was red at its baseline is now green, and the plan and the tests are intact. *(Amended in the plan, research R7.)*
- **FR-019**: Before every `implement` and `verify`, Dex MUST run the fast checks as a baseline; before `verify` it MUST also run the standing checks. When the baseline is red, the stage MUST become a "restore green" `implement` run: its prompt is "restore green first, no new tasks" with the failing evidence. Before `verify`, a red baseline MUST run that instead of the verifier. The baseline MAY reuse the last progress-gate run when the working tree has not changed since (research R6).
- **FR-020**: When the policy declares no fast checks, the progress gate MUST rest on the plan diff alone, and the digest MUST say that no checks ran.

#### Verify and the done gate (amends D-015-5)

- **FR-021**: The `verify` stage MUST start with Dex running every acceptance sensor of the entry.
- **FR-022**: When acceptance is red, the verifier MUST run in diagnose mode: it reads Dex's evidence and diff and appends a verify-fix phase of concrete tasks to `tasks.md` (015's numbering, `## Phase <N>: Verify fixes V<k>`).
- **FR-023**: When acceptance is green, the verifier MUST run in review mode: it checks the work against the spec and the brief and returns findings with a `blocking` or `minor` severity. When the policy sets `verify.browser`, it MUST work the feature end to end in a browser. A blocking finding MUST become a verify-fix phase.
- **FR-024**: The done gate MUST pass only when every acceptance sensor is green **and** no finding is blocking. Dex MUST record the decision in the entry's evidence, with the key it applies to.

#### Write scopes and plan protection (D-016-6)

- **FR-025**: Each stage MUST have its own write scope:

  | Stage | May write |
  |---|---|
  | `tests` | files that match the test patterns or the test-support patterns (runner configs, package manifests and lock files), and its own spec folder; in amend mode, only the amended test and its spec folder |
  | `implement` | anything in the policy's write roots, except the frozen test set |
  | `verify` | the entry's `tasks.md` only |

- **FR-026**: After every `implement` run, Dex MUST compare `tasks.md` with its state at the start of the run. The comparison covers task lines and phase headings, by task id. Only checkbox flips from open to done are allowed; any removed, reworded, renumbered, added or re-opened task, or a changed phase heading, MUST pause the run, naming the task. Other lines are ignored, and the implement prompt sends failure notes to the stage's output (and so to the attempt log), not into `tasks.md`. *(Amended in the plan, research R8.)*
- **FR-027**: After every `implement` run, a deleted or renamed file that matches the test patterns MUST pause the run, naming the file.
- **FR-028**: A new skip or expected-failure marker in the run's diff (for example `@pytest.mark.skip`, `.skip(`, `xit(`) MUST be listed in the digest and MUST NOT pause the run.

#### Stall detection (replaces D-015-7)

- **FR-029**: Dex MUST give every `implement` run a fingerprint: the names of the failing checks, the first error line of each, and a hash of the run's diff.
- **FR-030**: When two `implement` runs in a row each have the same fingerprint as the run before them, the run MUST pause with the evidence.
- **FR-031**: The 015 limits for implement runs without progress and for verify rounds MUST stay as upper limits. "Without progress" MUST now mean "did not pass the progress gate".

#### Flaky sensors (D-016-8)

- **FR-032**: A red check MUST be re-run up to `checks.rerunOnFail` times (default 1). A check that is green on a re-run MUST be recorded `flaky`, MUST NOT block, and MUST be listed in the digest.
- **FR-033**: When the same check is flaky three times in one entry, the run MUST pause and ask the human to fix the check or retire it.

#### Attempt log (D-016-9)

- **FR-034**: Dex MUST keep a per-entry attempt log, `.dex/evidence/<id>/progress.md` (not tracked), written from each stage's structured output and Dex's evidence: what was tried, what happened, the failing evidence and the open hypotheses.
- **FR-035**: The next stage of the entry MUST get the latest log entries in its prompt, capped at about 2,000 tokens.
- **FR-036**: When the entry is done, the attempt log MUST be cleared and its content kept in the entry's evidence archive.

#### Review digest (D-016-10)

- **FR-037**: At every gate pause, and when an entry is done, Dex MUST write a one-page digest to `.dex/digests/<id>.md` (not tracked) with: the diff stat per repo (including the policy's `repos`), the tasks done, the check and acceptance results with any flaky checks, the verifier's findings, any new skip markers, the questions answered with their recommended option, and the cost.
- **FR-038**: The app MUST show the digest, and the trace MUST show each stage's evidence. `dex run` MUST print the digest's path when it writes one, and `dex digest <projectDir> <id>` MUST print the digest.

#### Configuration

- **FR-039**: The policy MUST gain these fields (unknown fields stay rejected):

  | Field | Meaning | Default |
  |---|---|---|
  | `checks.fast` | `[{name, command, timeoutSec}]`, run at baseline and after every `implement` run | none — the progress gate then rests on the plan diff |
  | `checks.standing` | slower checks of the same shape, run at baseline before `verify` only | none |
  | `checks.rerunOnFail` | re-runs of a red check | `1` |
  | `testGlobs` | what counts as a test file | the common Python, TypeScript and Go test patterns |
  | `testSupport` | what else the `tests` stage may write, so it can set up its own test runner | runner configs, package manifests and lock files *(added in the plan, research R19, confirmed by the owner on 2026-11-05: spec-kit's Setup phase runs after `tests`)* |
  | `verify.browser` | the verifier works the feature in a browser | `false` |

- **FR-040**: A queue entry MUST gain `acceptance` (`[{name, command, timeoutSec}]`, merged with the command the `tests` stage records) and `checks` (extra fast checks for that entry only).
- **FR-041**: `dex run --dry-run` MUST list, for each open entry, its fast checks, standing checks and acceptance commands, and MUST still run no sensor and no agent.

#### Mock and unhappy paths (D-016-11)

- **FR-042**: The mock agent MUST be able to script the `tests` stage, the verifier's two modes and its findings, task rewording, frozen-file edits, test-file deletions and test-amendment questions.
- **FR-043**: The mock configuration MUST support fake sensors whose result can be switched per run, so every scenario costs nothing.
- **FR-044**: Each of these scenarios MUST end as documented, under the mock:

  | Scenario | Expected outcome |
  |---|---|
  | The agent ticks tasks while fast checks are red | progress gate fails; the next run is "restore green" |
  | The agent rewords a task in `tasks.md` | the run pauses |
  | The agent edits a frozen acceptance test | the edit is denied; `policy_denied` in the trace |
  | The `tests` stage writes tests that already pass | red-first gate pauses |
  | Two runs in a row repeat the fingerprint of the run before | the run pauses with the evidence |
  | A check fails, then passes on its re-run | recorded `flaky`, not blocking |
  | The verifier says `passed` while acceptance is red | done gate fails; the verifier diagnoses |
  | Acceptance is green and the verifier finds a blocking issue | done gate fails; a fix phase is appended |
  | An entry with `skip: ["tests"]` and no `acceptance` | the picker pauses with a question |

#### Delivery constraints

- **FR-045**: Before any 016 change, the 015 queue, picker, policy, evidence records and CLI MUST be confirmed present, with their tests passing.
- **FR-046**: After every implementation phase, the test suite, the type check and the size check MUST pass.

### Key Entities

- **Sensor**: a command the project declares, with a name and a timeout; Dex runs it. Kinds: fast check, standing check, acceptance command.
- **Sensor run record**: one run of one sensor — exit code, duration, result, output tail, re-runs — keyed by the entry's evidence key and the `tasks.md` hash.
- **Gate decision**: the outcome of one gate (red-first, baseline, progress, done) for one entry and one key, with the evidence it was decided from.
- **Acceptance test record**: what the `tests` stage wrote — the test files, the acceptance command, and the success criterion each test covers. Tracked in the entry's spec folder.
- **Frozen test set**: the entry's acceptance test files; no agent but the test author may change them.
- **Finding**: one issue the verifier reports, with a `blocking` or `minor` severity.
- **Run fingerprint**: the failing checks, their first error lines and the diff hash of one `implement` run.
- **Attempt log**: the per-entry working memory of what was tried; not tracked, cleared when the entry is done.
- **Digest**: the one-page summary for the human, written at every gate pause and when an entry is done; not tracked.
- **Stage write scope**: the paths one stage may write.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Gate decisions pass a table of cases with at least one case per row of the gates table, plus flaky checks, the stall fingerprint and each stage's write scope — 100% pass, with no agent started.
- **SC-002**: Every scenario in FR-044 ends as documented under the mock — 9 of 9.
- **SC-003**: A mock loop on the dex-ecommerce example project runs `tests` → red-first → `implement` → done for every feature, at zero cost.
- **SC-004**: On a real (non-mock) dex-ecommerce entry, the `tests` stage writes boundary tests (HTTP or browser) that fail at the red-first gate and pass at the done gate, and the evidence records show both runs.
- **SC-005**: A commit on a done entry's branch makes the picker verify it again, and the acceptance commands run again — in 100% of cases.
- **SC-006**: A review of the source finds no code path where an agent's structured output alone marks a gate passed.
- **SC-007**: In 100% of the mock scenarios where an agent's claim and Dex's evidence disagree, the evidence decides.
- **SC-008**: Every gate pause produces a digest that the owner can read on one page, with every section in FR-037.
- **SC-009**: On a scratch clone of the dex-ecommerce example project, the dry run lists each open entry's fast checks and acceptance commands, runs nothing, and the owner signs off.
- **SC-010**: The test suite, the type check and the size check pass after every implementation phase.

### Outcomes (as built)

Recorded at the end of the implementation, from the evidence in [research.md](research.md) (§ Phase 9 and § Final checks). Nothing here changes a target above.

| Criterion | Outcome |
|---|---|
| SC-001 | Met. `gates.test.ts` is table-driven: one case per row of the gates table, plus flaky checks, the fingerprint and the stall; `policy.test.ts` holds the scope table for every stage. No agent starts. |
| SC-002 | Met, 9 of 9. `grounded-scenarios.test.ts` and `grounded-protection.test.ts` check every fixture in `fixtures/mock/grounded/` against one table of ends (`ENDS`), and fails if a fixture has no row. The table also holds `happy-path`, `test-amendment` and `tests-crash` (R20), plus two variants (a deleted test file, a new skip marker). Every run costs $0. |
| SC-003 | Met on a scratch clone (T087): three entries, each `clarify` → `tests` → red-first (`pass`) → `verify` (diagnose) → `implement` (fix phase) → `verify` (review) → done; `queue_complete`, $0.00, a digest per entry, `git status` empty. The clone's tasks were all ticked, so `implement` ran as the fix phase. |
| SC-004 | **Not met yet.** The owner approved the real run. Its first stage, `specify` on `003-promo-codes`, failed at $0.00 with `Invalid API key`: the session's `ANTHROPIC_API_KEY` wins over the machine's login, and the API rejects it (research § Phase 9, T090). The next real stage is `specify`, not `tests` (T089). |
| SC-005 | Met by tests: `picker.test.ts` sends a done entry back to `verify` after a commit on its branch (existing project) and after a change in its spec folder (new project). `verify` runs the acceptance commands again every time. |
| SC-006 | Met (T092): every `structuredOutput` read in `src/core` is listed in research § Final checks with why it cannot pass a gate. `gates.done` has no verdict parameter. |
| SC-007 | Met by the scenarios: a verifier that says `passed` on red acceptance (`verifier-passes-red`), a frozen-test edit (`edits-frozen-test`), a reworded task (`rewords-task`) and ticks with red checks (`ticks-while-red`) all end as the evidence says, not as the agent says. |
| SC-008 | Met by tests: `digest.test.ts` checks every FR-037 section; the `rewords-task` scenario finds the digest written before the `paused` event; `dex digest` and `project:get-digest` read it. On the clone, every entry got a done digest. |
| SC-009 | Met (T089): on a scratch clone, the dry run lists each open entry's sensors and runs nothing (exit 0). The clone has no checks to declare yet (no `package.json`, no runner), so only the acceptance line shows. The owner signed off on 2026-11-05. |
| SC-010 | Met. `npm test`, `npm run typecheck` and `check:size` passed at every phase gate. At the end: 393 core tests, 68 renderer tests, no file over 600 lines. |

## Assumptions

- **Open decisions from the brief take the proposed default.** This spec adopts all six:
  1. A separate `tests` stage writes the acceptance tests, frozen for the implementer.
  2. The red-first gate pauses when acceptance passes before the implementation.
  3. A test amendment always waits for the human.
  4. Fast checks run after every `implement` run.
  5. Evidence and digests are not tracked, under `.dex/`.
  6. `implement` may change only checkboxes in `tasks.md`.
- **The first real run is on a scratch clone of dex-ecommerce**, Dex's only real-project playground (brief, Appendix A). The sensors map to the clone's own checks: its unit tests and type check as fast checks, its full suite as a standing check, and an HTTP or browser acceptance run per entry.
- **The acceptance test record is tracked in the spec folder** (a reading of the brief, confirmed by the owner on 2026-11-05). The brief says Dex "records" the acceptance command and the frozen test set, but does not say where. The rest of the evidence is not tracked, and losing it is safe: the gates run again. Losing this record is not safe, because the `tests` stage would run again on code that already exists, and its red-first gate would pause. 015 also rules that Dex writes no tracked file during a run. So the `tests` agent writes the record in its own spec folder (inside its write scope), Dex checks it against the stage's structured output, and the record is reviewed in git like the tests.
- **The done-gate key is 015's evidence key.** The brief says "the entry branch's current HEAD". That is 015's key for an existing project. A new project keeps 015's spec-folder hash, because its entries share one run branch.
- **The verify-fix phase keeps 015's numbering** (`## Phase <N>: Verify fixes V<k>`), not the brief's `## Phase Vn:`, because the task parser needs a numeric phase (015 research R8).
- **An assertion failure is told apart from a crash by the exit code.** The `tests` stage records which exit codes of its test runner mean "tests ran and some failed" (default `1`). Any other non-zero exit, a timeout, or a command that cannot start is a crash. Some runners (vitest, jest) use `1` for a collection error too; such a misread crash still cannot pass a gate, because the done gate stays red (research R2).
- **The acceptance command the `tests` stage records runs only that entry's tests.** So a red result means a test aimed at this entry failed.
- **A red baseline before `verify` becomes a "restore green" `implement` run**, because the verifier may write only `tasks.md` and cannot fix code (research R7).
- **"Two such runs" means two runs in a row that each repeat the fingerprint of the run before** (three equal fingerprints), which matches D-016-7's wording. The brief's scenario table says "two runs with the same fingerprint"; FR-044 follows the decision text.
- **The skip-marker list is a starting set** for Python, TypeScript and Go; it reports, it does not block, so a missed marker costs a line in the digest, not a wrong gate.
- **The attempt log replaces nothing tracked.** It is not 015's dropped `learnings` stage: it holds this entry's attempts, not general insights. Lasting knowledge goes into the project's docs (017).

## Out of Scope

- Coverage thresholds.
- Mutation testing.
- Visual regression.
- Sharding or parallel test runs.
- Running in CI: CI stays the project's own; Dex runs locally beside it.
- An LLM judge as a gate. The verifier can block an entry, never pass one.
- The project's docs as lasting memory, and a lessons review in the digest (017).
