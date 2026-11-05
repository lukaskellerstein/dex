# Grounded-loop scenarios (016)

Mock configs for every unhappy path of the grounded loop (D-016-11, FR-044).
Each one runs the real loop, the real sensor runner, the real gates and the real
records, at zero cost. The sensors are fake but real commands:
`node .dex/fake/check.mjs <name>` exits with the next code in `.dex/fake/<name>`.

`src/core/__tests__/grounded-scenarios.test.ts` and
`grounded-protection.test.ts` run each fixture on the existing-project fixture
(entry `900-fixture-a`). `helpers/grounded.ts` checks each end against one
table (`ENDS`). That table and this one must name the same files.

## The files

| File | Scenario | Expected end |
|---|---|---|
| `fake-check.mjs` | the fake sensor, copied to `.dex/fake/check.mjs` | — |
| `policy.json` | two fake fast checks (`unit`, `lint`), one re-run on a failure | — |
| `ticks-while-red.json` | implement ticks while `unit` is red | progress fails; the next run is a restore run; then done |
| `rewords-task.json` | implement rewrites a task line | pause `plan_changed`, naming the task |
| `edits-frozen-test.json` | implement writes a frozen test | write denied, `policy_denied` (rule `scope`); then done |
| `tests-already-pass.json` | acceptance exits 0 at red-first | pause `red_first_green` |
| `tests-crash.json` | acceptance exits 2 at red-first (not in `failExitCodes`) | `tests` once more, then pause `no_progress` |
| `same-fingerprint.json` | three implement runs, same failure, no diff | pause `stalled` |
| `flaky-check.json` | `unit` is `1` then `0` | recorded `flaky`, the gate passes; then done |
| `verifier-passes-red.json` | acceptance red, the verifier says `passed` | done gate fails, diagnose mode, fix phase; then done |
| `blocking-finding.json` | acceptance green, one blocking finding | done gate fails, fix phase; then done |
| `skip-tests-no-acceptance.json` | `skip: ["tests"]`, no `acceptance` | pause `invalid_input` |
| `happy-path.json` | tests → red-first → implement → verify | entry done, digest written |
| `test-amendment.json` | implement asks `Amend <path>: <reason>` | waits in every question mode; approve → `tests` in amend mode; reject → the implementer reads it |

The fields these configs use are in
[`specs/016-grounded-loop/contracts/mock-config.md`](../../../specs/016-grounded-loop/contracts/mock-config.md).

## Use one on a dex-ecommerce clone

The mock writes the fake sensors' switch files, so the project needs the fake
sensor and the grounded policy first. On a scratch clone of dex-ecommerce, from
the dex repo root (quickstart § 2 makes the clone):

```bash
E=<the scratch clone>
mkdir -p $E/.dex/fake
cp fixtures/mock/grounded/fake-check.mjs $E/.dex/fake/check.mjs
printf '*\n' > $E/.dex/fake/.gitignore
cp fixtures/mock/grounded/policy.json $E/.dex/policy.json
cp fixtures/mock/new-project.json $E/.dex/mock-config.json
node dist/core/cli.js run $E --agent mock
```

The clone's `main` is a new project (a `GOAL.md`, no queue), so it takes
`fixtures/mock/new-project.json`. The configs in this folder script entry
`900-fixture-a` of `fixtures/existing-project/` and fit only that queue.

- Without `.dex/fake/check.mjs`, every fake sensor fails to start and the done
  gate never passes.
- `.dex/fake/` ignores itself, so `git status` stays clean.
- `scripts/reset-example-to.sh` is the only script that may reset
  dex-ecommerce. Never point these commands at another project.
