# Quickstart: checking the grounded loop (016)

How to prove each success criterion. Paths are from the Dex repo root unless a
step says otherwise. `dex` means `node dist/core/cli.js` after `npx tsc`.

## 1. The suite (SC-001, SC-002, SC-010)

```bash
npm test             # core (node --test) + renderer (vitest) + check:size
npm run typecheck    # all three tsconfigs; not a bare tsc --noEmit
```

- `src/core/__tests__/gates.test.ts` is table-driven: one case per row of the
  gates table, plus flaky, the fingerprint and each stage's write scope.
- `src/core/__tests__/grounded-scenarios.test.ts` and
  `grounded-protection.test.ts` run every fixture in `fixtures/mock/grounded/`
  under the mock and check the end in
  [contracts/mock-config.md](contracts/mock-config.md).

## 2. A mock loop on dex-ecommerce (SC-003, SC-005, SC-008)

On a scratch clone, so dex-ecommerce itself and its GitHub remote stay as they
are:

```bash
S=<a scratch folder>
git clone --no-local ~/Projects/Github/lukaskellerstein/dex-ecommerce $S/ex
git init --bare $S/ex.git
git -C $S/ex remote set-url origin $S/ex.git
git -C $S/ex push origin main
E=$S/ex
mkdir -p $E/.dex/fake
cp fixtures/mock/grounded/fake-check.mjs $E/.dex/fake/check.mjs
printf '*\n' > $E/.dex/fake/.gitignore
cp fixtures/mock/grounded/policy.json $E/.dex/policy.json
cp fixtures/mock/new-project.json $E/.dex/mock-config.json
npx tsc
node dist/core/cli.js run $E --agent mock
```

The clone's `main` holds `GOAL.md` and three specs whose tasks are all ticked,
and no queue, so this is a new-project run (research § Phase 9). Expect, for
every entry: `clarify` → `tests` → `verify` (diagnose, a fix phase) →
`implement` → `verify` (review); a `tests-1.json`, a `red-first-1.json` whose
gate is `pass`, a `done.json` with `gate: "passed"`, and a digest in
`$E/.dex/digests/`. The last line `dex run` prints is `digest: <path>`, and
`git -C $E status --short` is empty.

Then commit on a done entry's branch and run `dex run $E --status`: the entry is
back at `verify`. Run once more, and `verify-2.json` shows the acceptance run
again (SC-005).

## 3. The dry run and the owner's sign-off (SC-009)

On a second scratch clone of dex-ecommerce (made as in step 2, without the
fake sensors), draft the queue and the policy, put the real checks in
`.dex/policy.json`, and commit both in the clone:

```bash
dex queue init <clone>
dex run <clone> --dry-run
```

`queue init` sorts the entries by id. Mark `001-initialization` `done` (the v1
store, built as `specs/001…003`) and move `003-promo-codes` first, so it is the
next open entry (research § Phase 9). dex-ecommerce has no `package.json` and
no test runner yet, so there are no fast or standing checks to declare: the
`tests` stage sets up the runner (R19).

Every open entry lists its fast checks, standing checks and acceptance
commands. Nothing runs, and `git status` stays clean. The owner reads it and
signs off before step 4.

## 4. One real entry (SC-004)

In the clone, set `.dex/dex-config.json` to `{"agent": "claude"}`. Run the next
open entry (`003-promo-codes`) with the owner watching. It has no spec yet, so
the first real stage is `specify`:

```bash
dex run <clone> --once      # specify only; read the spec before going on
dex run <clone>             # clarify, plan, tasks, tests + red-first, implement … verify, to done
```

Check the evidence for the same acceptance command:

```bash
jq '.gate.outcome, .runs[0].exitCode' <clone>/.dex/evidence/003-promo-codes/red-first-1.json
jq '.gate, .acceptance[0].exitCode' <clone>/.dex/evidence/003-promo-codes/done.json
```

The first is `pass` with a non-zero exit code; the second is `passed` with `0`.

## 5. No gate passes on an agent's word (SC-006, SC-007)

```bash
grep -rn "structuredOutput\|structured_output" src/core --include=*.ts | grep -v __tests__
```

Each hit must be one of: the verifier's findings feeding `gates.done` (it can
only add a blocking reason), the tests stage's summary feeding the attempt log,
or the 015 clarification and manifest steps. None may set a gate's outcome to
`pass`. `gates.test.ts` holds the matching case: a verifier output of `passed`
with red acceptance yields `fail`.

## 6. The UI (FR-038)

With `dev-setup.sh` running (CDP on 9333), open the step 2 clone in the app and
start its mock run:

- the live trace shows a gate card (`gate-card`) for every gate: the baseline
  card opens the stage it guards, and the red-first, progress and done cards
  close theirs. A run read from history shows none (the cards are not in
  `steps.jsonl`);
- a paused run's pause card links its digest (`pause-digest-link`) when the
  pause wrote one;
- the queue panel's "Digest" button (`queue-row-digest`) shows only for an
  entry with a digest, and opens the digest view (`digest-view`).

The renderer tests cover the same three: `GateCard.test.tsx`,
`DigestView.test.tsx`, `QueuePanel.test.tsx` and `ClarificationPanel.test.tsx`.
