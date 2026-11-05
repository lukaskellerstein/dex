# Contract: `.dex/mock-config.json` — the 016 additions

Extends 015's mock (`src/core/agent/MockConfig.ts`, `entries` keyed by entry id
with a `"*"` fallback).

## What changes

| Field | Where | Meaning |
|---|---|---|
| `tests` | an entry's stages | a stage descriptor; its `writes` create the test files and `acceptance.json` |
| `runs` | `implement` | `StepDescriptor[]`: the k-th task-phase run of an entry uses `runs[k-1]`, else the last one; counted in memory, per entry, per process |
| `restore` | `implement` | a stage descriptor for a "restore green first" run (it reaches the mock through `runStep` with step `implement`, and ticks nothing); a restore run without one fails loudly |
| `deletes` | any stage descriptor | paths the mock deletes, like an agent's `rm` |
| `findings` | `verify`, or one of its `rounds[k]` (the round's wins) | `[{severity, summary, criterion?, where?}]`, returned in review mode |
| `hypotheses` | `verify`, or one of its `rounds[k]` (the round's wins) | `string[]`, returned in diagnose mode |
| `rounds[k].fixTasks` | `verify` | appended as the fix phase in diagnose mode, or in review mode when a returned finding is `blocking` |
| `rounds[k].verdict` | `verify` | still accepted; returned as structured output, and ignored by the done gate |

Every write, append and delete goes through `decideToolUse` with the stage's
scope. A denied one is skipped, logged and emitted as `policy_denied`, exactly
like a real hook denial. A write is checked as `Write`, an append as `Edit` and a
delete as `Bash` `rm <path>`. Writes to `.dex/fake/` are not checked: they are
the fake sensors' switch, not the agent's work.

The answers a stage's `asks` get back go to the trace as one `text` step,
`answers: {…}` (metadata `mockAnswers`), so a test sees what a real agent reads —
for a test amendment, the approval or the rejection.

## Fake sensors

`fixtures/mock/grounded/fake-check.mjs` (copied to `.dex/fake/check.mjs`):

```text
node .dex/fake/check.mjs <name>
  reads .dex/fake/<name>: one exit code per line
  exits with the first line, and removes it unless it is the last
  a missing file means exit 0
```

`.dex/fake/` carries its own `.gitignore` (`*`). A mock stage switches a sensor
for its next runs by writing the file:

```json
{ "path": ".dex/fake/unit", "content": "1\n0\n" }
```

That makes `unit` fail once and pass on the re-run: a flaky check.

## Scenario fixtures (D-016-11)

`fixtures/mock/grounded/` holds `policy.json` (two fake fast checks) and one
mock config per scenario:

| File | Scenario | Expected end |
|---|---|---|
| `ticks-while-red.json` | implement ticks while `unit` is red | progress fails; next run is a restore run |
| `rewords-task.json` | implement rewrites a task line | pause `plan_changed` |
| `edits-frozen-test.json` | implement writes a frozen test | write denied, `policy_denied` (rule `scope`) |
| `test-amendment.json` | implement asks `Amend <path>: <reason>` with header `Test amendment` | waits in every question mode; approve → `tests` in amend mode; reject → the implementer reads the rejection |
| `tests-already-pass.json` | acceptance exits 0 at red-first | pause `red_first_green` |
| `tests-crash.json` | acceptance exits 2 at red-first (not in `failExitCodes`) | `tests` once more, then pause `no_progress` |
| `same-fingerprint.json` | three implement runs, same failure, no diff | pause `stalled` |
| `flaky-check.json` | `unit` is `1` then `0` | recorded `flaky`, gate passes |
| `verifier-passes-red.json` | acceptance red, `verdict: passed` | done gate fails, diagnose mode, fix phase |
| `blocking-finding.json` | acceptance green, one blocking finding | done gate fails, fix phase |
| `skip-tests-no-acceptance.json` | `skip: ["tests"]`, no `acceptance` | pause `invalid_input` |
| `happy-path.json` | tests → red-first → implement → done | entry done, digest written |

`src/core/__tests__/helpers/grounded.ts` holds the same table (`ENDS`), and its
`scenario()` checks the end of every run against it. The runs are in
`grounded-scenarios.test.ts` (the table check, US1–US3) and
`grounded-protection.test.ts` (US4, US5). A fixture without a row fails the
suite. `fixtures/mock/grounded/README.md` repeats the table for a
human who copies a fixture into a dex-ecommerce clone.
