# Quickstart: validating 015 Lean Core

Every phase in [`plan.md`](plan.md) ends with steps 1–3. Steps 4–8 prove the
success criteria. All mock runs cost nothing; steps 9–10 spend real money and
need the owner's go-ahead.

Paths: `$DEX` is this checkout, `$EX` is
`$HOME/Projects/Github/lukaskellerstein/dex-ecommerce`, `$SCRATCH` is a fresh
`mktemp -d`.

## 1. Install, test, typecheck

```bash
cd "$DEX" && npm install          # the worktree starts with no node_modules
npm test                          # core (node --test) + renderer (vitest) + check:size
npm run typecheck                 # all three tsconfigs; never a bare `npx tsc --noEmit`
nvim-tools --json --all           # no findings added against the Phase 0 baseline
```

## 2. Mock loop, new project (SC-002)

A scratch clone at the root commit, so `origin` of `dex-ecommerce` is never
touched:

```bash
git clone -q --no-local "$EX" "$SCRATCH/new" && cd "$SCRATCH/new"
git reset -q --hard "$(git rev-list --max-parents=0 HEAD)"     # GOAL.md only
mkdir -p .dex && cp "$DEX/fixtures/mock/new-project.json" .dex/mock-config.json
echo '{"agent":"mock"}' > .dex/dex-config.json
node "$DEX/dist/core/cli.js" run "$SCRATCH/new"; echo "exit=$?"   # expect exit=0
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --status          # every entry: done
git log --format=%s | grep -cE '^\[checkpoint:|^dex:' || true     # expect 0
```

## 3. Stop and Resume during `implement` (SC-002)

```bash
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --once   # repeat until --status shows implement
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --status # note entry + task phase
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --once   # same entry, same task phase
```

## 4. Reset to a checkpoint, then Resume (SC-003)

```bash
cd "$EX" && "$DEX/scripts/reset-example-to.sh" pristine
# run step 2 against $EX itself (mock), then tag a mid-run agent commit:
"$DEX/scripts/promote-checkpoint.sh" "$EX" cycle-1-after-tasks <sha-of-mock(tasks)-commit>
"$DEX/scripts/reset-example-to.sh" cycle-1-after-tasks
node "$DEX/dist/core/cli.js" run "$EX" --status    # entry 1: implement, no repair step logged
node "$DEX/dist/core/cli.js" run "$EX"; echo "exit=$?"
```

## 5. Existing-project fixture (SC-004)

```bash
git clone -q --no-local "$EX" "$SCRATCH/existing" && cd "$SCRATCH/existing"
git reset -q --hard "$(git rev-list --max-parents=0 HEAD)"        # a known start: GOAL.md + docs/my-specs/
git remote remove origin                                          # any push attempt now fails loudly
# The human's setup: a project that already uses spec-kit, with feature A half done on its own branch.
specify init . --force --integration claude --script sh
git add -A && git commit -qm "spec-kit setup"
git switch -qc 900-fixture-a
cp -R "$DEX/fixtures/existing-project/specs" .                    # A: 3 phases, T002 and T004–T005 open, T006 out of scope
node "$DEX/dist/core/cli.js" queue init .                         # writes .dex/queue.json, policy.json, .gitignore
cp "$DEX/fixtures/existing-project/queue.json"  .dex/queue.json   # entry A: skip→implement, tasks filter; entry B: specify, baseBranch A
cp "$DEX/fixtures/existing-project/policy.json" .dex/policy.json
cp "$DEX/fixtures/mock/existing-project.json"   .dex/mock-config.json
echo '{"agent":"mock"}' > .dex/dex-config.json
git add -A && git commit -qm "fixture: queue + policy"            # the human's setup commit
before=$(git rev-parse HEAD); branches_before=$(git branch --format='%(refname:short)' | sort)
node "$DEX/dist/core/cli.js" run "$SCRATCH/existing"; echo "exit=$?"   # expect 0
git branch --format='%(refname:short)' | sort | comm -13 <(echo "$branches_before") -   # only spec-kit's entry B branch
git log --format=%s "$before"..HEAD --all | grep -vE '^mock\(' || echo "no non-agent commits"
git log --all --format=%s | grep -c '^\[checkpoint:' || true      # 0
git show 900-fixture-a:specs/900-fixture-a/tasks.md | grep T006   # still "- [ ]": out of scope
```

The clone has no remote, so a push by Dex would fail with an `error` event,
which `dex run` prints as a `✗` line and turns into exit 1. Exit 0 proves no
push was tried. `dex queue init`
on this clone also queues `docs/my-specs/001-Initialization` as
`001-initialization` (ids are lowercase branch names); the fixture queue then
replaces that first draft.

## 6. Picker, queue, policy, approvals — unit tables (SC-001, SC-005)

```bash
node --import ./scripts/ts-resolve-hook.mjs --test --experimental-strip-types \
  --test-name-pattern='picker|queue|policy|approvals|branching|post-stage' 'src/core/**/*.test.ts'
```

Expect one passing test per D-015-1 row, plus task filter, `skip`, gates,
migration, every policy rule kind, and the no-opinion case (73 tests on
2026-11-05). The flag goes before the file glob: `npm run test:core -- …`
puts it after the glob, where node does not read it, so all tests run.

## 7. Bypass is gone (SC-006)

```bash
grep -rn bypassPermissions src   # only policy.ts (the refusal) and its test
```

## 8. Size (SC-007)

```bash
bash scripts/loc-by-area.sh      # prints lines per area; compare with research.md § R14 baseline
```

## 9. Live permission check (SC-005, real agent, small cost)

On a scratch clone with `.claude/settings.json` containing
`{"permissions":{"ask":["Bash(git push:*)"]}}` and an entry whose `implement`
prompt leads to a `git push`, start the app (`dev-setup.sh`), open the clone,
and Start. Expect the approval card in the questions panel, with the command
held. Deny it; expect the agent to report the denial.

## 10. Dogfood on onion-demo-01 (SC-009, SC-010)

```bash
node "$DEX/dist/core/cli.js" run ~/Projects/Github/onion-ai-eu/onion-demo-01 --dry-run > /tmp/onion-dry-run.txt
grep -c '^━━ ' /tmp/onion-dry-run.txt     # 5 — one block per entry
```

The owner reads every prompt and signs off. Then, with the owner watching:
`dex run … --once` for `021-agent-entry` `specify`.
