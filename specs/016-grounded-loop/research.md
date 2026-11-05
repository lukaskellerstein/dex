# Research: Grounded Loop (016)

**Feature**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-11-05

Each decision below resolves an open point of the spec or the brief against the
code that 015 left on the branch (`src/core/picker.ts`, `evidence.ts`,
`policy.ts`, `agent/permissions.ts`, `stages/loop.ts`, `stages/post-stage.ts`,
`stages/cycle-stages.ts`, `agent/MockAgentRunner.ts`). Where a decision changes
the spec, the spec was amended in the same pass and says so.

## R1 — How Dex runs a sensor

**Decision**: `sensors.ts` spawns `/bin/sh -c <command>` with `cwd` at the
project, `env` = `process.env` merged under the policy's `env`, `detached: true`
so the sensor gets its own process group. A timeout or Stop sends `SIGTERM` to
the group, then `SIGKILL` after 5 s. Output (stdout and stderr, interleaved) goes
through a 200-line ring buffer; nothing else is kept. Each run returns
`{name, command, exitCode, signal, durationMs, result, tail}`.

**Rationale**: D-016-1 wants the sensors out of any agent. A process group is the
only way to kill a test runner's children (Playwright browsers, dev servers). The
ring buffer bounds memory for a chatty suite. Async `spawn` keeps Stop working
while a 10-minute standing suite runs.

**Alternatives considered**: `execSync` (015's `preflight.ts` style) blocks the
event loop, so Stop and the UI freeze for the whole suite — rejected. Running
sensors through the agent's Bash tool — rejected by D-016-1. Keeping full output
— rejected: the evidence would grow without bound, and 200 lines hold the
failure in every runner we know.

## R2 — Classifying a result, and the red-first gate

**Decision**: A run's `result` is one of:

| Result | When |
|---|---|
| `pass` | exit code 0 |
| `fail` | any other exit code |
| `timeout` | Dex killed it at `timeoutSec` |
| `error` | it could not start (spawn error), or exit code 126 or 127 |
| `flaky` | `fail` first, `pass` on a re-run (R12) |

For the red-first gate, the acceptance record (R3) declares `failExitCodes`: the
exit codes that mean "the tests ran and some failed" for its runner (default
`[1]`). Red-first passes when the exit code is in that list. `0` pauses
(`red_first_green`). Anything else — another exit code, `timeout`, `error` — is
a crash.

**Rationale**: Exit codes are the one signal every runner gives. pytest separates
the cases cleanly (1 failed, 2 interrupted, 4 usage, 5 no tests). For runners that
use 1 for both a failed assertion and a collection error (vitest, jest), a
misread crash costs little: the implementer then works against a broken test,
the done gate stays red, the verifier diagnoses it, and the implementer asks for
an amendment (R10). The gate never passes wrongly.

**Alternatives considered**: Parsing a JUnit XML report (pytest, vitest,
Playwright and Go's `gotestsum` all write one) tells assertion failures from
errors exactly. Rejected for now: each runner needs its reporter configured,
and Dex would need an XML reader. It is the natural next step if misread crashes
show up in practice. Parsing the output text — rejected: it differs per runner
and per version.

## R3 — Where the acceptance test record lives

**Decision**: The `tests` agent writes `<specDir>/acceptance.json` (tracked, in
its own write scope), and the agent commits it with the tests. Dex reads and
validates it: test files, command, `failExitCodes`, `timeoutSec`, and the
criterion each test covers. That file is the canonical record. The stage's
structured output carries only the summary, which goes to the attempt log.
Contract: [contracts/acceptance-json.md](contracts/acceptance-json.md). Confirmed
by the owner on 2026-11-05.

**Rationale**: The evidence folder is gitignored, and losing it must be safe.
Losing the gate results is safe (the gates run again). Losing the test record is
not: the picker would run `tests` again on code that already exists, and the
red-first gate would pause. 015 also rules that Dex writes no tracked file
during a run, so the agent writes it. One file, not a file plus a matching
structured output, avoids a disagreement case with no good answer.

**Spec change**: FR-011 now names the file as the record and the structured
output as the summary only.

**Alternatives considered**: Dex writes the record into `.dex/evidence/` from the
structured output — rejected (the loss case above). Both a file and a structured
copy that Dex compares — rejected: two copies of one fact (DRY), and a mismatch
would need its own pause.

## R4 — The picker's new rows

**Decision**: Between `tasks` and `implement`, in this order:

| Check | Next |
|---|---|
| `skip` has `tests` and the entry has no queue `acceptance` | pause `invalid_input` |
| an approved test amendment is pending in the evidence (R10) | `tests`, amend mode |
| `skip` lacks `tests`, and `acceptance.json` is missing | `tests` |
| `skip` lacks `tests`, and the last red-first record for this `acceptance.json` (by content hash) is a crash | `tests` |

The done row reads the done record (R5) instead of 015's verify verdict.

**Rationale**: The rows keep 015's rule that the next stage comes from files. The
red-first result is evidence, so it is read only to retry after a crash; when
the evidence is gone, the entry goes on to `implement`, which is the safe
direction. A red-first `pass` needs no row: the record exists, so `implement`
follows. A red-first "already green" pauses the run (`red_first_green`).
Resume then means "I accept these tests", like a gate: the picker finds the
record and goes on. To redo the tests, the owner deletes `acceptance.json`.

**Spec change**: FR-006 lists the rows. FR-013 gains the Resume meaning and the
retry limit (R20).

## R5 — The done record replaces the verify record

**Decision**: `.dex/evidence/<id>/verify.json` becomes `done.json` (version 2):
the 015 key and `tasksHash`, the acceptance runs, the verifier's mode and
findings, and the gate decision. The picker counts an entry done only when
`gate: "passed"` matches the key and `tasks.md` now. A version-1 `verify.json`
reads as absent, so each entry is verified once more after the upgrade.
Contract: [contracts/evidence.md](contracts/evidence.md).

**Rationale**: The agent's verdict field goes away entirely (FR-005), so the old
record has nothing the picker may still trust. Reading the old version as absent
is what `state.ts` already does for its own versions, and it costs one verify
per entry, once.

**Alternatives considered**: Keep `verify.json` and add fields — rejected: a
v1 record with `verdict: "passed"` would still mark an entry done on the agent's
word. A migration that keeps v1 passes — rejected for the same reason.

## R6 — Fast checks run once per tree, not twice

**Decision**: Every check run records a **tree stamp**: sha256 of HEAD, `git diff
HEAD --binary`, and the names and blob hashes of untracked, not-ignored files.
The baseline before a stage reuses the last progress-gate run when the stamp is
unchanged. Otherwise it runs the checks.

**Rationale**: Without reuse, an implement loop runs the fast checks twice per
run (after run N and before run N+1) on the same tree. The stamp is cheap (two
git calls) and exact. A human edit between runs changes the stamp, so the
baseline sees it.

**Alternatives considered**: Key on HEAD only — rejected: agents often leave
uncommitted work, and a dirty tree with red checks would read as green. Always
run — rejected: it doubles the cost of the most frequent gate.

## R7 — "Restore green first", and a red baseline before verify

**Decision**: `runImplement` gains a `restore` mode. Its prompt has no task
phase: "the fast checks below are red; make them green; add no feature work;
tick no task", plus the evidence. A restore run counts as progress when every
check that was red at its baseline is now green (flaky counts as green) and the
plan and tests are intact. A red baseline before an `implement` turns that stage
into a restore run. A red baseline (fast or standing) before `verify` runs a
restore run instead of the verifier.

**Rationale**: FR-018 as first written ("a newly ticked task") could never pass
for a run told to tick nothing, so every restore run would count as no
progress, and the run would pause after two. The verifier may write only
`tasks.md` (D-016-6), so it cannot fix a red build; a restore run can.

**Spec change**: FR-018 and FR-019 now define restore runs and their progress.

**Alternatives considered**: A red baseline before verify sends the verifier into
diagnose mode to append a fix phase — rejected: it adds a verify round (and a
step toward `maxVerifyRounds`) for what is usually a flaky or environmental
failure, and it costs a verifier session to write "make the checks green".

## R8 — The plan diff

**Decision**: `plan-diff.ts` compares the task lines and phase headings of
`tasks.md` before and after an `implement` run, by task id. Allowed: an open box
that becomes done (`[ ]` → `[x]` or `[X]`). A pause (`plan_changed`), naming the
task, for: a removed or added task id, a changed task text (the line minus its
checkbox), a changed order of ids, a re-opened task, or a changed phase heading.
Other lines (prose, notes) are ignored.

The implement prompt changes with it: 015 told the agent to "write the error
under the task in tasks.md". Failure notes now go into the stage's structured
output, and from there into the attempt log (R14).

**Rationale**: Decision 6 of the brief allows checkbox flips only. Comparing by
id is what makes "reworded" and "renumbered" detectable at all. Ignoring free
text avoids false pauses on a note, and a note cannot move a gate: the picker
reads only task lines.

**Alternatives considered**: A byte diff minus checkbox characters — rejected:
any note would pause the run. Allowing a "Discovered tasks" heading — rejected by
the owner's default for open decision 6.

## R9 — Stage write scopes and the frozen test set

**Decision**: `decideToolUse` gains a `StageScope` argument, built per stage by
`stageScope(policy, entry, stage, record)`:

| Stage | `writeOnly` (globs) | `protect` (paths) |
|---|---|---|
| `tests` (create) | `testGlobs` + `testSupport` + the spec folder | — |
| `tests` (amend) | the amended file + the spec folder | — |
| `implement` | — (the policy's `writeRoots` apply) | the frozen test set |
| `verify` | `<specDir>/tasks.md` | the frozen test set |
| other stages | — | — |

A write tool outside `writeOnly`, or to a `protect` path, is denied whether the
file is committed or not. A Bash command that names a `protect` path after
`rm`, `mv`, `git rm`, `git mv`, `unlink` or a `>` redirect is denied too. After
the stage, a name-status diff since the stage's start commit is the backstop:
a changed or deleted frozen test → `frozen_changed`; a deleted or renamed file
that matches `testGlobs` → `tests_changed`; a new skip marker → the digest.

**Rationale**: 015's `frozen` denies only files tracked at HEAD, and the tests
stage may leave its files uncommitted. The scope keeps `decideToolUse` pure, so
the D-016-6 table becomes table tests. The Bash check is a guardrail against
mistakes, not a sandbox (015's stance). The post-stage diff catches what slips
through, from any tool.

**Alternatives considered**: Add the test files to `policy.frozen` per stage —
rejected: the tracked-at-HEAD rule is wrong for them, and the policy object
would stop being the project's file. Block every Bash write — rejected: agents
run formatters and test runners that write.

## R10 — Test amendments

**Decision**: The implement prompt tells the agent to ask with header `Test
amendment`, naming the test file and the reason. `canUseTool` recognises the
header, replaces the options with `Approve amendment` and `Reject`, and holds
the question in `wait` mode whatever the policy says. An approval is written to
`.dex/evidence/<id>/amendments.json` and the implementer is told "approved; the
test author will change it; go on with the other tasks". The picker's amend row
(R4) then runs `tests` in amend mode, scoped to that file. A rejection goes back
to the implementer as the answer.

**Rationale**: It reuses 015's question path, persistence and UI unchanged. The
header is a stable marker; the mock can script it.

**Alternatives considered**: Detect amendments by a question that names a frozen
file — rejected: fragile, and it would also catch questions about tests. A new
tool — rejected: Claude-only (019 removes such interception).

## R11 — Stall detection

**Decision**: Each implement run's progress-gate record carries its fingerprint:
sha256 of the sorted failing check names, the first non-empty error line of
each tail, and the hash of the run's diff (R6's stamp, taken against the stage's
start commit). Before the next stage, when the last stage in this process was
an implement run, the guard reads the entry's last three implement records. When
all three fingerprints are equal, the run pauses (`stalled`) with the evidence.

**Rationale**: "Two runs that each repeat the run before" is three equal
fingerprints. Checking only after an implement run in this process copies 015's
`progressCheck`: a Resume always gets one more attempt. The records live in the
evidence, so the check needs no state field.

## R12 — Flaky checks

**Decision**: A `fail` is re-run up to `checks.rerunOnFail` times. A pass on a
re-run records `flaky`, which counts as green. When a check's flaky count in the
entry's records reaches 3, the run pauses (`flaky_check`) naming the check. The
count comes from the evidence, so it survives a restart.

## R13 — The verifier's two modes

**Decision**: `runVerify` first runs the acceptance sensors (the record's
command plus the queue's `acceptance`). Red → diagnose mode with
`DIAGNOSE_SCHEMA` (`summary`, `hypotheses`). Green → review mode with
`REVIEW_SCHEMA` (`summary`, `criteria`, `findings` with `severity`). Neither
schema has a verdict. Dex writes `done.json` with `gate: "passed"` only for green
acceptance and no blocking finding. In both modes the verifier appends the fix
phase itself (015's format), inside its `tasks.md` write scope. If it appends
nothing after a failed gate, the picker asks for `verify` again, and 015's
`no_progress` guard pauses the run.

**Rationale**: Without a verdict field there is nothing for the gate to obey by
mistake, and `grep` for a gate driven by agent output (SC-006) finds only the
blocking check. The mock's old `rounds[].verdict` stays readable, and the gate
ignores it, which is what the "verifier passes while acceptance is red" scenario
tests.

**Browser (as built)**: with `policy.verify.browser`, only the verify session gets
one MCP server, `browser`: `npx -y @playwright/mcp@0.0.83 --headless --isolated`
(`PLAYWRIGHT_MCP` in `src/core/agent/claudeSession.ts`). 0.0.83 was published on
2026-09-28; the newer 0.0.84 (2026-10-31) was less than two weeks old when this
was pinned on 2026-11-05, so it was not taken. `--isolated` gives each session a
fresh profile in memory, never the user's.

## R14 — The attempt log

**Decision**: After each stage Dex appends a section to
`.dex/evidence/<id>/progress.md`: time, stage, task phase, the agent's summary
and notes, the gate results and the failing tails' first lines. The next
stage's prompt gets the newest sections that fit in 8,000 characters (about
2,000 tokens at 4 characters per token). When the done gate passes, the file
moves to `.dex/evidence/<id>/archive/progress-<ISO>.md`.

**Rationale**: A character budget needs no tokenizer and is close enough for a
prompt section. The archive keeps history out of every later prompt (018's
"history is never fed back").

## R15 — The digest

**Decision**: `digest.ts` builds `.dex/digests/<id>.md` from the evidence and the
run state. The diff stat runs from the entry's first stage start commit (kept in
the entry's first stage record) to the working tree, per repo, including the
policy's `repos`. The folder carries its own `.gitignore` (`*`), like
`.dex/evidence/`.

**Rationale**: A start commit from the evidence works for both kinds of project;
a new project's entries share one branch, so a branch-base diff would mix
entries. A self-ignoring folder keeps an existing project's tree clean without
touching its `.dex/.gitignore` (015: a dirty tree blocks the next branch switch).

## R16 — The mock, and fake sensors

**Decision**: The mock runner's `writes` go through `decideToolUse` with the
stage's scope. A denied write is skipped, logged, and emits `policy_denied`,
exactly like a hook denial. New descriptor fields: `deletes` (paths), and for
`verify`: `findings` and `hypotheses` (structured output by mode). The `tests`
stage is scripted with `writes` (test files and `acceptance.json`).

Fake sensors are ordinary commands: `node .dex/fake/check.mjs <name>` reads
`.dex/fake/<name>`, a list of exit codes, consumes the first line, and exits
with it (the last line repeats). The mock agent switches a sensor per run by
writing that file in its `writes`. `fixtures/mock/grounded/` holds the script,
a policy and one mock config per D-016-11 scenario. `.dex/fake/` carries its own
`.gitignore`.

**Rationale**: Routing mock writes through the real decision is what lets the
"edit a frozen test" scenario test the real code at zero cost. Fake sensors that
are real commands test the real sensor runner, timeouts included; the mock needs
no sensor hook.

**Alternatives considered**: A mock-only sensor runner — rejected: it would test
a double, not `sensors.ts`.

## R17 — Events and the UI

**Decision**: Three events: `sensor_run` (one per sensor run), `gate_decided`
(gate, entry, pass or fail, reason, evidence file), `digest_written` (entry,
path). The trace renders a gate card with the check results under the stage. The
queue panel gets a digest view, read through a new IPC handler
`project:get-digest`. `paused` already carries the reason and detail; the pause
card shows the digest link when one exists.

## R18 — File sizes

**Decision**: `prompts.ts` (470 lines) and `stages/cycle-stages.ts` (223) would
pass the 600-line check with the new builders. The entry-stage prompt builders
move to `entry-prompts.ts`. `runVerify` and the tests stage move to
`stages/verify-stage.ts` and `stages/tests-stage.ts`. The gate wiring lives in
`stages/gate-runs.ts`, so `stages/loop.ts` (368) gains only dispatch lines.

## R19 — The tests stage may set up its own runner

**Decision**: The `tests` stage's scope includes `testSupport`: test-runner
configs, the package manifests and their lock files (`package.json`, the lock
files, `playwright.config.*`, `vitest.config.*`, `jest.config.*`, `pytest.ini`,
`pyproject.toml`, `conftest.py`, `go.mod`, `go.sum`). It is a policy field with
that default. Confirmed by the owner on 2026-11-05.

**Rationale**: spec-kit's own `tasks.md` usually installs the test tools in its
Setup phase, which runs **after** the `tests` stage. Without this, a boundary
test that needs Playwright cannot run at red-first, so red-first would read a
crash, and the run would pause on every new project. The test author is not the
implementer, so letting it install the test toolchain does not weaken the
oracle.

**Spec change**: FR-039 gains `testSupport`.

**Alternatives considered**: Run `tests` after the Setup phase — rejected:
"Setup" is a spec-kit convention, not a structure the picker can rely on. Pause
and ask the human to install the runner — rejected: it pauses almost every new
project.

## R20 — One retry after a red-first crash

**Decision**: A red-first crash sends the loop back to `tests` once, with the
evidence in the prompt. When the last two red-first records for the entry are
both crashes, the run pauses (`no_progress`) instead.

**Rationale**: 015's guard pauses when the picker asks for the stage that just
ran. A crash is often a typo the author fixes in one more try, so one retry is
worth its cost; a second crash means the setup is wrong, and a human must look.

**Spec change**: FR-013 says "once".

## R21 — No new dependency

**Decision**: Everything above uses Node's `child_process`, `crypto` and `fs`,
and git. No new npm package. The JUnit reader (R2) would have been the only
candidate.

## Phase 0 measurements

Taken on 2026-11-05 on the untouched `016-grounded-loop` tree (015 merged at
`ed8ad61`), after `npm install` in the fresh worktree. Every later failure or
finding is measured against these.

### Suites (T001)

| Suite | Result |
|---|---|
| `npm run test:core` (`node --test`) | 216 pass, 0 fail |
| `npm run test:renderer` (vitest) | 9 files, 58 pass |
| `npm run check:size` | pass (no file over 600 lines) |
| `npm run typecheck` (`tsconfig.test.json` + `tsconfig.renderer.json`) | pass |

### Lint and format baseline (T002)

`nvim-tools --json --all`: 6 findings in 5 files, none under `src/`.

| Tool | State | Findings |
|---|---|---|
| tsc | ok | 0 |
| biome | ok | 1 (`.claude/settings.json`, format) |
| shfmt | ok | 3 (`.claude/hooks/{playwright-launch,worktree-create,worktree-remove}.sh`) |
| markdownlint-cli2 | ok | 2 (`docs/my-specs/018-many-projects-any-agent/README.md`) |
| ruff, ruff-format, shellcheck | ok | 0 |
| stylua, hadolint, golangci-lint, basedpyright | gated-off | — |

### Size baseline (T003)

`bash scripts/loc-by-area.sh`:

| Area | Lines |
|---|---|
| core total | 9917 |
| core loop | 4515 |
| core state.ts | 263 |
| main total | 524 |
| renderer total | 11766 |
| grand total | 22207 |

### The 015 pieces 016 builds on (T004, FR-045)

`src/core/{queue,picker,policy,evidence,cli}.ts` all exist. Their tests —
`src/core/__tests__/{queue,picker,policy,evidence,cli,loop,existing-project,failure-policy}.test.ts`
— are part of the 216 passing core tests above; none fails.

### The 015 mock loop on a dex-ecommerce scratch clone (T005)

A `git clone --no-local` of dex-ecommerce into the session scratchpad, with
`origin` on a scratch bare repo, then `dex run <clone> --agent mock`:

- The clone's `main` (`44b0df2`, "dex: promoted dex/2026-07-30-ff81d5 to
  main") holds `GOAL.md` and its three clarified files, `specs/001…003` with
  `spec.md`, `plan.md` and a fully ticked `tasks.md` each, and `src/{catalog,cart,accounts}`.
  It has **no `.dex/queue.json`, no `package.json` and no test scripts**.
- Its `.dex/mock-config.json` still has the pre-015 `dex_loop` shape, so the
  first run refused it (`MockConfigInvalidError`). With
  `fixtures/mock/new-project.json` copied over it, the run went: prerequisites
  → clarification (product, technical, synthesis) → constitution → manifest
  extraction (a `kind: "new"` queue of three entries, `001-catalog-and-search`,
  `002-cart-and-checkout`, `003-customer-accounts`) → per entry `clarify` →
  `verify` (no `implement`: every task is ticked) → `queue_complete`, exit 0.
- So Phase 9's mock loop needs a new-project run with a `GOAL.md` and a
  fixture whose acceptance turns green without an `implement` run of the
  original phases: under 016 the first `verify` finds acceptance red, appends a
  fix phase, and the fix phase's `implement` run flips the fake acceptance to
  green. Phase 9 (T087) confirms this.

## Phase 9 — first real run

### The 016 mock loop on a dex-ecommerce scratch clone (T087, SC-003)

2026-11-05. A `git clone --no-local` of dex-ecommerce `main` (`44b0df2`) into the
session scratchpad, `origin` on a fresh scratch bare repo, then quickstart § 2:
the fake sensor in `.dex/fake/` (with its `.gitignore`), the grounded
`policy.json`, and `fixtures/mock/new-project.json` as the mock config.
`node dist/core/cli.js run <clone> --agent mock` exited 0 (`queue_complete`,
$0.00):

- Project stages as in T005: prerequisites, the three clarification steps,
  constitution, manifest extraction (`kind: "new"`, three entries).
- Each of `001-catalog-and-search`, `002-cart-and-checkout`,
  `003-customer-accounts` ran `clarify` → `tests` → `verify` (diagnose: the
  acceptance is red, every original task was ticked before the tests existed) →
  `implement` (task phase 3, `Verify fixes V1`) → `verify` (review, green).
- Evidence for each entry: `tests-1.json`; `red-first-1.json` with gate `pass`
  ("the acceptance tests fail by an assertion (exit 1)"); `baseline-1/2`,
  `implement-1`, `verify-1/2`; `done.json` with `gate: "passed"`, mode `review`,
  acceptance `pass`, no findings; the attempt log moved to `archive/`.
- One digest per entry in `.dex/digests/`; `dex run` printed the last one's path
  as its last line.
- `git status --short` on the clone was empty.

Two things the run showed:

- `new-project.json` needed a fix phase in its first verify round for this:
  `rounds[0]` now carries `hypotheses` and `fixTasks`. It changes nothing for a
  run that implements first: there the acceptance is green at verify, review
  mode appends a fix phase only for a blocking finding, and round 1 passes.
- The mock commits with `git add -A`, so the first project stage's commit takes
  the copied `.dex/policy.json` and `.dex/mock-config.json`. A new project
  tracks its policy anyway; the fake sensors stay out (`.dex/fake/` ignores
  itself).

### The real sensors on a second clone (T088)

A second `git clone --no-local` of dex-ecommerce `main` (`44b0df2`), `origin` on
its own scratch bare repo, so the mock run's results stay apart.
`dex queue init <clone>` wrote `.dex/queue.json`, `.dex/policy.json` and
`.dex/.gitignore`.

- **No checks to declare.** The clone has no `package.json`, no `tsconfig.json`,
  no test runner and no scripts: `src/{catalog,cart,accounts}` are plain
  TypeScript modules. So `checks.fast` and `checks.standing` stay empty, and the
  progress gate rests on the plan diff alone. The first entry's `tests` stage
  sets up the runner (`testSupport` covers `package.json` and the runner
  configs, R19). Once it has, the owner can add the runner's script as a fast
  check.
- **`verify.browser` stays `false`.** The clone has no UI and no server, so a
  browser has nothing to open. The boundary for `003-promo-codes` is the cart
  module's API, and the `tests` stage tests it there.
- **The queue.** `queue init` sorts the entries by id, so two open briefs came
  before `003-promo-codes`. On the clone, `001-initialization` (the v1 store
  brief, already built as `specs/001…003`) is marked `done`, and
  `003-promo-codes` moves before `002-improvements-1`. The three `specs/*`
  entries are `done`, with `specify`, `plan` and `tasks` skipped.

### The dry run (T089, SC-009)

`dex run <clone> --dry-run` exited 0. The open-entry blocks, without the
prompt bodies:

```text
queue    : .dex/queue.json · existing project
policy   : .dex/policy.json · deny 0 · ask 0 · frozen 0 · preflight 0 · questions recommended-then-review · pull request off
limits   : maxImplementRunsWithoutProgress=2 maxVerifyRounds=3

━━ 003-promo-codes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
decision : specify — specs/003-promo-codes/spec.md is missing
branch   : stay on main (base), spec-kit creates 003-promo-codes
env      : CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 SPECIFY_FEATURE=003-promo-codes SPECIFY_FEATURE_DIRECTORY=specs/003-promo-codes SPECIFY_FEATURE_NO_PERSIST=1 GIT_BRANCH_NAME=003-promo-codes
options  : settingSources=user,project,local permissionMode=default maxTurns=75 budget/stage=none
system   : claude_code preset
sensors  :
  acceptance (written by the tests stage)

━━ 002-improvements-1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
decision : specify — specs/002-improvements-1/spec.md is missing
branch   : stay on main (base), spec-kit creates 002-improvements-1
…
sensors  :
  acceptance (written by the tests stage)
```

What it tells the owner before the sign-off:

- The next real stage is `specify`, not `tests`. The first real entry pays
  for `specify`, `clarify`, `plan` and `tasks` before its `tests` stage and the
  red-first gate. `dex run --once` runs `specify` only.
- No sensor but the acceptance command will run, and that command does not
  exist until the `tests` stage writes `acceptance.json`.
- `budget/stage=none`: no stage has a cost cap.
- The owner signed off on 2026-11-05 (T089).

### The first real stage (T090)

2026-11-05. On the T088 clone: `.dex/dex-config.json` set to
`{"agent": "claude"}`, then the queue, the policy and the config committed in
the clone (`cc809e5`). `dex run <clone> --once` on `claude-opus-4-6` (Dex's
fixed default, `LOOP_DEFAULTS`):

```text
→ 003-promo-codes · specify: specs/003-promo-codes/spec.md is missing
   ▸ specify
✗ 003-promo-codes · specify failed: Claude Code returned an error result: Invalid API key · Fix external API key
■ failed · $0.00
```

- The session's environment sets `ANTHROPIC_API_KEY`, and the SDK passes it
  to the spawned Claude Code, so it wins over the login on the machine. The API
  rejects the key. This is the environment, not Dex.
- The run cost nothing and left the clone clean (`main`, one commit ahead of
  its scratch `origin`). SC-004 is still open.

The owner chose to run it again with the variable removed
(`env -u ANTHROPIC_API_KEY`), so Claude Code used the machine's login:

```text
   ▸ specify
   ✓ specify 161.2s · $0.70
   ⚠ left uncommitted: .specify/feature.json, specs/003-promo-codes/checklists/requirements.md, specs/003-promo-codes/spec.md
■ user_abort · $0.70
```

- The spec is 193 lines: 7 user stories (cart redemption, admin create, error
  messages, automatic discounts, admin edit, reporting, checkout
  re-validation) and more than 13 FRs, admin pages among them. The clone has
  no UI, so the `tests` stage must test the cart and promo modules' API.
- **The agent did not commit.** The policy's `settingSources` includes
  `user`, so the agent loaded the owner's global `CLAUDE.md` ("never commit
  unless asked"). It read that as the project's commit rule, which Dex's prompt
  tells it to follow, and skipped the commit. Every stage on this machine will
  do the same while `user` is loaded and the project says nothing about commits.
- **No entry branch.** The agent wrote the spec by hand and ran no spec-kit
  script. The clone has no `.specify/extensions.yml`, so spec-kit's git
  extension, which makes the branch, never ran. The picker now stops the entry:
  `branch "003-promo-codes" does not exist, but "main" already has
  specs/003-promo-codes/spec.md; create the branch or set "branch" in
  queue.json`.
- Both are setup gaps of the clone, not gate defects. They need the owner's
  call before `clarify` runs.

The owner's fix, in the clone only: a `CLAUDE.md` on `main` that asks every
stage to commit its own work (`2b713ed`), and the branch `003-promo-codes`
from `main` with the spec committed on it (`58d52c7`). Then one `--once` per
stage, the key removed each time:

| Stage | Time | Cost | Commit by the agent |
|---|---|---|---|
| `specify` | 161 s | $0.70 | none (before the rule) |
| `clarify` | 231 s | $1.39 | `cfee73e` |
| `plan` | 380 s | $1.33 | `60bcf9e` (7 files) |
| `tasks` | 342 s | $1.36 | `ac33773`: 42 tasks in 10 task phases |
| `tests` + red-first | 1027 s | $3.59 | `127abdf`: vitest, 7 test files, 2 helpers |
| **Total** | 36 min | **$8.37** | every tree clean after its stage |

The `tests` stage set up its own runner (R19): `package.json`, its lock file
and `vitest.config.ts`. `acceptance.json` runs
`npx vitest run tests/promotions/acceptance`, lists 9 files (7 tests and 2
helpers, all frozen now) and maps 27 tests to SC-001…SC-007. The tests call
the modules' API (`src/promotions/promotions.js`, `src/admin/promotions.js`),
because the clone has no server and no UI.

`red-first-1.json`: gate `pass`, "the acceptance tests fail by an assertion
(exit 1)". **That reason is not what happened.** The tail says
`Test Files 7 failed (7)`, `Tests no tests`: every file failed to load,
because the modules it imports do not exist yet (`Cannot find module
'../../src/admin/promotions.js'`). Vitest exits 1 for a load error as for a
failed assertion, so the exit-code rule (R2) cannot tell them apart. Here it
is the right red — the feature is missing. But a test file with a wrong import
path would pass red-first the same way, and stay red after a correct
implementation. Open finding for the owner; the gate is unchanged.

Then `implement`, one `--once` per task phase. The clone's policy declares no
fast checks, so the progress gate read the ticked tasks only:

| Stage | Time | Cost | Progress gate |
|---|---|---|---|
| `implement` phase 1 (Setup) | 96 s | $1.19 | pass: T001–T003 ticked |
| `implement` phase 2 (Foundational) | 334 s | $2.46 | pass |
| `implement` phase 3 (US1, cart) | 173 s | $1.62 | pass |
| `implement` phase 4 (US2, admin create) | 241 s | $1.57 | pass |

**The owner stopped the run during phase 5, for its cost.** The run record
says $15.21; the part of phase 5 that ran before the stop is not in it. The
done gate never ran, so SC-004 is half met: red-first on real tests, yes; the
same tests green at done, not shown. T091 (the rest of the queue) is skipped
by the owner.

The lesson for the next real run: pick the smallest entry that reaches every
gate, not the next one in the queue. `003-promo-codes` has 7 user stories and
42 tasks in 10 task phases. A one-function entry with one task phase goes
through the same gates (red-first, progress, done) at a fraction of the cost
and time.

### The UI over CDP (T083, FR-038)

2026-11-05, the dev server from this worktree, CDP on 9333. A fresh
dex-ecommerce clone set up as quickstart § 2, with two changes:

- `.dex/queue.json` copied from a § 2 run. Without a queue, a project whose
  specs are all done gets no Start button: `startActionFor` returns `none`
  (015, R17), and the overview shows the specs instead of the loop start panel.
- The mock config overrides one entry's `tests` stage to write `0` to
  `.dex/fake/acceptance`, so that entry pauses at red-first
  (`red_first_green`) and writes a digest. `002-cart-and-checkout` first, then
  a fourth entry `004-wishlist-sharing` added to the queue.

Started and resumed from the app. What showed:

| Check | Seen |
|---|---|
| Gate cards in the live trace (`gate-card`), by a DOM observer over one Resume run | baseline `pass` (unit, lint), red-first `pass` (exit 1), progress `pass` ("T008 ticked; every fast check is green"), done `fail` ("the acceptance run is red", 1 re-run), done `pass` |
| The trace of a finished stage, read from history | no gate cards, as designed |
| The pause card | "The new tests pass before the feature exists", with `pause-digest-link` "Read the digest for 004-wishlist-sharing" |
| The link | opens `digest-view` with `.dex/digests/004-wishlist-sharing.md`: "paused at tests: red_first_green", the diff, the tasks, the acceptance run |
| The queue panel | `queue-row-digest` on every done entry and on the paused one; none on `003` while it was pending |
| Console | 0 errors; 1 warning, Electron's dev-mode CSP note |

Two things for the owner, neither changed:

- A card that closes a stage (red-first, progress, done) stays in the live
  trace only until the next stage opens, because each stage starts a new step
  list (`useLiveTrace`). In a mock run that is milliseconds. It stays when the
  run pauses or ends on it.
- The stage list's "paused" mark goes to the first stage of the cycle with no
  record in this run. When `specify`, `plan` and `tasks` were done on `main`
  before the run, it marks `Specify`, though the run paused after `tests`.
  That rule is 015's; 016 only added the `Tests` row.

## Final checks

### No gate passes on an agent's word (T092, SC-006, SC-007)

`grep -rn "structuredOutput\|structured_output" src/core | grep -v __tests__`,
2026-11-05. Every hit, by what reads it:

| Where | Reads | Why it cannot pass a gate |
|---|---|---|
| `agent/{AgentRunner,ClaudeAgentRunner,MockAgentRunner,claudeSession,MockConfig}.ts`, `stages/run-stage.ts`, `stages/cycle-stages.ts:153,247` | carry the SDK's output to the stage, or validate the mock's | transport: they decide nothing |
| `stages/verify-stage.ts:216` | the review's `findings` and `summary` | `gates.done(acceptance, findings)` passes only when every acceptance run Dex made is green. A finding can only add a blocking reason. No `verdict` field is read |
| `stages/verify-stage.ts:217` | the diagnosis's `hypotheses` and fix tasks | diagnose mode runs only on red acceptance, and `done` gets `[]`: the gate fails on the red run. The fix tasks become a Dex-written fix phase |
| `stages/cycle-stages.ts:133` | the implementer's `summary` and `notes` | the attempt log and the gate record's summary only. `gates.progress` reads the plan diff and the fast checks |
| `stages/tests-stage.ts:126` | the test author's `summary` | the tests record and the attempt log only. `gates.redFirst` reads the acceptance run |
| `stages/manifest-extraction.ts:43`, `stages/clarification.ts:167` | the 015 manifest and synthesis outputs | project stages before any entry: no gate reads them |

`gates.test.ts` holds the case "a verifier that says passed while acceptance is
red changes nothing".

### Lint, format and types against the T002 baseline (T095)

`nvim-tools --json --all`, 2026-11-05. Every tool `ok` or `gated-off`, as in
T002; `tsc` 0 findings.

- The 6 baseline findings are unchanged (`.claude/settings.json`, the three
  `.claude/hooks/*.sh`, `docs/my-specs/018-…/README.md`). None is 016's.
- 016 added 11 lint findings. All are fixed by hand: 7 import orders
  (`organizeImports`), 2 regexes with adjacent spaces in `cli.test.ts`, 2
  unused `biome-ignore` comments in `DigestView.tsx` (this repo turns
  `noArrayIndexKey` off).
- 016 left 44 `format` findings in `src/` (lines over 100 characters and
  similar). The fixer skips files with uncommitted changes, so the owner chose
  to commit first (`da1d91f`). Then `nvim-tools --fix` on exactly those 44
  files fixed all of them; the baseline files were not touched.
- The format pass made `grounded-scenarios.test.ts` 656 lines, over the 600
  limit. The harness and the `ENDS` table moved to
  `src/core/__tests__/helpers/grounded.ts`, and the US4 and US5 scenarios to
  `grounded-protection.test.ts` (280 and 269 lines). The same 19 tests pass.
- After both: only the 6 baseline findings remain; `tsc` ok.

### Size (T096)

`bash scripts/loc-by-area.sh`, against T003:

| Area | T003 | Now | Delta |
|---|---|---|---|
| core total | 9917 | 13208 | +3291 |
| core loop | 4515 | 5366 | +851 |
| core state.ts | 263 | 269 | +6 |
| main total | 524 | 535 | +11 |
| renderer total | 11766 | 12188 | +422 |
| grand total | 22207 | 25931 | +3724 |

`npm test`'s `check:size` passes: no file is over 600 lines.

### Final gate (T097)

2026-11-05, after every code change: `npm test` (393 core, 68 renderer,
`check:size`) and `npm run typecheck` pass. A last mock loop on a fresh scratch
clone of dex-ecommerce `main`, set up as quickstart § 2, with `dist/` rebuilt:
exit 0, `queue_complete`, $0.00. Every entry has `red-first-1.json` with gate
`pass`, `done.json` with `gate: "passed"` and a digest; `git status --short` on
the clone is empty.
