# Quickstart: Verify the SQLite removal end-to-end

**Purpose**: Walk through the manual verification steps that prove the feature ships correctly. These are the steps a reviewer (or you, before reporting completion under Constitution Principle III) executes against the example project.

**Test target**: `dex-ecommerce` at the `after-tasks` checkpoint (the change touches storage and IPC, not the early stages — `after-tasks` keeps the iteration cheap while still exercising the full implement loop).

**Time budget**: ~15 minutes including the loop cycle.

---

## Definition of Done

- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] `node --test src/core/runs.test.ts` passes (round-trip, atomicity, corruption-skip, crash-recovery sweep).
- [ ] `npm install` on a fresh `node_modules/` produces a tree without `better-sqlite3` or `@types/better-sqlite3`.
- [ ] First app launch with a pre-existing `~/.dex/db/` removes the directory and logs one `[dex] removed legacy SQLite directory: …` line to `~/.dex/dev-logs/electron.log`.
- [ ] After one loop cycle on `dex-ecommerce`, `<projectDir>/.dex/runs/<runId>.json` exists, parses, and contains ≥4 phases (specify, plan, tasks, implement) — verified via `cat … | jq`.
- [ ] After the same cycle, `~/.dex/logs/dex-ecommerce/<runId>/phase-<N>_*/steps.jsonl` exists for each phase and contains one line per step.
- [ ] Runs list, run detail, per-phase cost/duration, subagent breakdown, and trace view render in the Electron UI with values matching the JSON files.
- [ ] Two consecutive cycles in two different projects produce two disjoint `.dex/runs/` directories — no cross-contamination.
- [ ] Deleting `dex-ecommerce/` after a cycle leaves zero audit artifacts under `~/.dex/db/` (it never existed) and only the log tree under `~/.dex/logs/dex-ecommerce/` (intentional).

---

## 0. Pre-conditions

- `dev-setup.sh` is running (Vite + Electron with HMR; `~/.dex/dev-logs/electron.log` is writable).
- `dex-ecommerce` exists at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` and the `fixture/after-tasks` branch exists per `.claude/rules/06-testing.md § 4c`.
- The build is current — main process picks up edits to `src/main/index.ts` and `src/main/ipc/history.ts`. If in doubt, restart `dev-setup.sh`.

---

## 1. Reset the example project to `after-tasks`

```bash
./dex/scripts/reset-example-to.sh after-tasks
```

Sanity check:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce \
  && git status --short \
  && ls .dex/
```

Expect a clean tree on `fixture/after-tasks` with `state.json`, `feature-manifest.json`, and an empty (or absent) `runs/` directory.

---

## 2. Confirm legacy DB cleanup happened on app launch

```bash
ls ~/.dex/db/ 2>&1
# expected: ls: cannot access '/home/lukas/.dex/db/': No such file or directory
grep "removed legacy SQLite directory" ~/.dex/dev-logs/electron.log
# expected: one line per app launch since the upgrade
```

If this is the first launch with the new build, the line should be present. Subsequent launches with the directory absent produce no line.

---

## 3. Run one loop cycle in the UI

Drive the welcome screen and start the loop per `.claude/rules/06-testing.md § 4c.3` and `§ 4c.4` — fill the path/name, submit, toggle Automatic Clarification on, click Start Autonomous Loop.

Wait for cycle 1 to reach the `verify` or `learnings` phase (≈3–5 minutes from the `after-tasks` start).

---

## 4. Inspect the run JSON from a plain shell

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
ls .dex/runs/
# expected: <runId>.json (and possibly an old run from prior testing — pick the newest)

RUN_ID=$(ls -t .dex/runs/*.json | head -1 | xargs basename | sed 's/\.json$//')
cat ".dex/runs/${RUN_ID}.json" | jq '{runId, mode, status, totalCostUsd, phases: .phases | length}'
```

Expected output (numbers will vary):

```json
{
  "runId": "<uuid>",
  "mode": "loop",
  "status": "running" | "completed",
  "totalCostUsd": 0.42,
  "phases": 4
}
```

Story 1 / SC-001 verification — answered "what did the run cost / how many phases?" without opening the UI.

---

## 5. Inspect the per-phase steps.jsonl

```bash
ls ~/.dex/logs/dex-ecommerce/${RUN_ID}/
# expected: run.log, phase-1_loop-implement/, phase-2_loop-tasks/, ...
ls ~/.dex/logs/dex-ecommerce/${RUN_ID}/phase-1_*/
# expected: agent.log, steps.jsonl, subagents/
wc -l ~/.dex/logs/dex-ecommerce/${RUN_ID}/phase-1_*/steps.jsonl
# expected: a positive integer matching the number of steps the trace view shows
head -1 ~/.dex/logs/dex-ecommerce/${RUN_ID}/phase-1_*/steps.jsonl | jq
# expected: one StepRecord with sequenceIndex 0
```

FR-004 verification — steps live in the log tree, not the run JSON.

---

## 6. UI parity check via electron-chrome MCP

Open the runs list, navigate into the latest run, drill into a phase. Use:

- `mcp__electron-chrome__take_snapshot` to capture the runs list — verify the latest run id matches `${RUN_ID}` and the displayed cost equals what `jq '.totalCostUsd' .dex/runs/${RUN_ID}.json` reports (within rounding).
- `mcp__electron-chrome__take_snapshot` on the run detail — verify phase count and per-phase cost/duration match the JSON.
- `mcp__electron-chrome__take_snapshot` on the trace view of one phase — verify step rows render and match `wc -l` of `steps.jsonl`.

SC-007 verification — UI renders the same fields as the JSON.

---

## 7. Cross-project isolation

```bash
# In a second project — pick any directory with a GOAL.md or create a throwaway one
cd ~/tmp/test-project-b
ls .dex/runs/ 2>&1
# expected: no such directory, OR contains only the new project's runs

# Run a tiny cycle (or just `dex` open + abort to create a run record)
# Then check disjointness:
diff <(ls /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/runs/) <(ls ~/tmp/test-project-b/.dex/runs/)
# expected: every line different (no shared runId)
```

SC-005 verification.

---

## 8. Crash-recovery sweep

Simulate an orchestrator crash:

```bash
# Start a cycle, then interrupt the orchestrator process while it's running
# (find the PID via `ps aux | grep electron`, kill -9)

# Restart the app. On the next orchestrator entry point, the run should transition
cat /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/runs/<runId>.json | jq '.status'
# expected: "crashed"
cat ".dex/runs/${RUN_ID}.json" | jq '.phases[] | select(.status == "running")'
# expected: empty (any running phases were also reconciled to "crashed")
```

R-007 verification.

---

## 9. Lockfile check

```bash
grep -c "better-sqlite3" package-lock.json
# expected: 0
grep -c "better-sqlite3" package.json
# expected: 0
```

SC-008 verification.

---

## 10. Typecheck and unit tests

```bash
npx tsc --noEmit
# expected: no output, exit 0
node --test src/core/runs.test.ts
# expected: all tests pass
```

---

## Cleanup

Branch hygiene per `.claude/rules/06-testing.md § 4c`:

```bash
./dex/scripts/prune-example-branches.sh
```

(Only deletes `dex/*` branches older than 7 days. Safe to run anytime.)

---

## What's not in this checklist (by design)

- Performance microbenchmarks (`listRuns` <50 ms, etc.) — these are envelope estimates in `research.md`, not runtime gates. If the UI feels slow after the change, instrument via `performance.now()` around the IPC call; do not block the feature on synthetic numbers.
- Multi-machine git-clone test for Story 2 acceptance — covered conceptually but not part of the local DoD; manually verifiable when needed.
- Cross-project aggregate ("total cost across all projects") — explicitly out of scope per spec.
