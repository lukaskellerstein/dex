# Quickstart: validating 015 Lean Core

Every phase in [`plan.md`](plan.md) ends with steps 1–3. Steps 4–8 prove the
success criteria. All mock runs cost nothing; steps 9–10 spend real money and
need the owner's go-ahead.

Status on 2026-11-05 (research.md, "Final checks"): steps 1–8 were run end to end
on scratch clones with `node dist/core/cli.js`. Step 9 (T067) and step 10 (T112,
T113) are open. The UI check that tasks.md calls T106 is step 11.

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

Observed: exit 0, 3 entries, every `verify.md` `passed`, 27 steps (6 project steps
+ 3 entries × 7 stages), 0 tags, a clean tree. `dist/core/cli.js` comes from the
`tsc` build (`npm run build`). A `.dex/mock-config.json` in the old
`dex_loop.cycles` shape is refused with a pointer to the fixture. The clone needs
`GOAL.md` copied in if it is reset to the root commit of `dex-ecommerce`, and an
`origin` that passes the GitHub prerequisite without a prompt.

## 3. Stop and Resume during `implement` (SC-002)

```bash
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --once   # repeat until --status shows implement
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --status # note entry + task phase
node "$DEX/dist/core/cli.js" run "$SCRATCH/new" --once   # same entry, same task phase
```

`--once` exits 0 when it ends on its own `user_abort`; Ctrl-C in a stage exits 3.

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
which `dex run` prints as a `✗` line and turns into exit 1 (any `error` event does,
even when the loop carried on). Exit 0 proves no push was tried. Expected: 10
stages, `queue_complete`, the only new branch is `901-fixture-b`, `.specify/feature.json`
unchanged, T006 still open. `dex queue init`
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
2026-11-05). The full suites on the same day: core 201, renderer 58 (56 at the
last phase gate, 58 after the cycle-count fix), `check:size` pass. The flag goes before the file glob: `npm run test:core -- …`
puts it after the glob, where node does not read it, so all tests run.

## 7. Bypass is gone (SC-006)

```bash
grep -rn bypassPermissions src   # only policy.ts (the refusal) and its test
```

## 8. Size (SC-007)

```bash
bash scripts/loc-by-area.sh      # prints lines per area; compare with research.md § R14 baseline
```

Result: 22,086 lines after the format pass (21,982 at the end of the branch, after a dead-code cut and the compound-command check)
against the 21k target. **SC-007 is not met**; research.md § R14 has the table.

## 9. Live permission check (SC-005, real agent, small cost)

On a scratch clone with `.claude/settings.json` containing
`{"permissions":{"ask":["Bash(git push:*)"]}}` and an entry whose `implement`
prompt leads to a `git push`, start the app (`dev-setup.sh`), open the clone,
and Start. Expect the approval card in the questions panel, with the command
held. Deny it; expect the agent to report the denial. **Not run yet** (T067: it needs a
real agent and the owner's go-ahead). Until then the approval card is covered by
`ToolApprovalCard.test.tsx`, the `permissions` / `runner-options` unit tests and the
mock-driven UI check in step 11.

## 10. Dogfood on onion-demo-01 (SC-009, SC-010)

```bash
node "$DEX/dist/core/cli.js" run ~/Projects/Github/onion-ai-eu/onion-demo-01 --dry-run > /tmp/onion-dry-run.txt
grep -c '^━━ ' /tmp/onion-dry-run.txt     # 5 — one block per entry
```

The owner reads every prompt and signs off. Then, with the owner watching:
`dex run … --once` for `021-agent-entry` `specify`.

## 11. UI check against a mock run (SC-005 partly, FR-041–043)

Done on 2026-11-05 with `dev-setup.sh` and electron-playwright, mock stages slowed
to 2.5 s, two scratch clones:

- New project (step 2 fixture, `questions: "wait"`, one mock question on the first
  entry's `clarify`): the queue panel rows follow every stage; the question card
  shows; a renderer reload keeps it; the answer resumes the stage; the run ends
  with all three entries done.
- Existing project (step 5 fixture, `gates: ["plan"]` on `901-fixture-b`): the app's
  Start runs the queue loop; the run pauses at the gate with the pause card and
  Resume in the top bar; Continue resumes and the run completes.
- `browser_find` for Timeline, "Make this the new main", Delete and Profile finds
  nothing. No console errors.
- Not checked live: the tool-approval card (the mock makes no tool calls).
- Seen, not changed: a renderer reload goes back to the welcome screen while the
  run goes on (the open project lives in renderer state); the pending request
  survives it.
