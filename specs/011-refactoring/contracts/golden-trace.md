# Contract: Golden-trace regression check

**Artefact**: `docs/my-specs/011-refactoring/golden-trace-pre-A.txt`
**Companion**: `docs/my-specs/011-refactoring/event-order.md` — tolerable-reorder list
**When**: Captured Pre-Wave (before Gate 0). Diffed at every Wave-A sub-gate (G0..G4).

## Purpose

Detect any change to the orchestrator's observable emit semantics during the refactor — without false positives from race-y SDK-stream/orchestrator-emit ordering that occur even on back-to-back runs of identical scenarios.

## Capture protocol (Pre-Wave, runs once)

```bash
# Two clean baselines:
for i in 1 2; do
  ./scripts/reset-example-to.sh clean
  # Run one full loop in the UI:
  #   Welcome → Open Existing → Steps tab → toggle Automatic Clarification → Start Autonomous Loop.
  #   Wait for the run to terminate (mock fixture runs 3 cycles and creates a PR — ~2 min).

  RUN_DIR=$(ls -td ~/.dex/logs/dex-ecommerce/*/ | head -1)
  sed -E '
    s/\[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\] //
    s/ \{.*\}$//
    s/dex\/20[0-9]{2}-[0-9]{2}-[0-9]{2}-[a-z0-9]+/dex\/<BRANCH>/g
    s/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g
  ' "$RUN_DIR/run.log" | sort -u > /tmp/golden-baseline-$i.txt
done

# Intersection — only lines present in both runs are stable signal:
comm -12 /tmp/golden-baseline-1.txt /tmp/golden-baseline-2.txt \
  > docs/my-specs/011-refactoring/golden-trace-pre-A.txt
```

The sed pipeline normalizes each log line by stripping:
- `[<ISO timestamp>]` at the start — pure noise (varies on every line).
- Trailing ` { ... }` JSON payload — payload contents legitimately reorder (cost numbers, durations, runIds).
- Auto-generated branch names `dex/YYYY-MM-DD-xxxxxx` → `dex/<BRANCH>` — different per run.
- UUIDs (run/agent IDs) → `<UUID>` — different per run.

What remains is the **structural skeleton**: function-name + message-prefix + log level. For example:
- `[INFO] runPrerequisites: claude CLI found`
- `[INFO] runLoop: starting cycle 1`
- `[INFO] TaskPhase 1 started: specify`
- `[WARN] runLoop: learnings structured output was null — skipping append`

`sort -u` converts the line-ordered log into a set; the intersection of two sets (one per baseline run) is the lines that fired in both — race-y emit ordering between SDK stream events and orchestrator emits is filtered automatically. If a line appears in only one of the two runs, it's flaky pre-refactor and not part of the protected baseline.

DEBUG-level entries are out of scope (the level filter is implicit — DEBUG isn't written to `run.log` at the current log level).

> **Note on the regex chosen.** An earlier draft used `grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+'`, but that regex truncates Dex's camelCase function names (`runPrerequisites` becomes just `run` because the regex character class stops at the capital P) and matches nothing for `TaskPhase`-prefixed lines (capital T also blocks the match). The sed pipeline above preserves the message-prefix words intact and produces a far richer baseline (~50 lines vs ~5 with the old regex on the mock fixture).

## Diff protocol (every Wave-A sub-gate)

```bash
./scripts/reset-example-to.sh clean
# Run one full loop in the UI (same scenario as the baseline).
RUN_ID=$(ls -t ~/.dex/logs/dex-ecommerce/ | head -1)
grep -oE '\] \[(INFO|WARN|ERROR)\] [a-z_]+' \
  ~/.dex/logs/dex-ecommerce/$RUN_ID/run.log \
  | sort -u > /tmp/golden-post.txt

diff docs/my-specs/011-refactoring/golden-trace-pre-A.txt /tmp/golden-post.txt
```

## Pass / fail

**Pass**:
- Empty diff, OR
- Diff entries are all listed in `event-order.md` as tolerable reorders for the current sub-gate.

**Fail** (regression — roll back):
- Diff contains entries not listed as tolerable.
- Diff contains *removed* events that are not justified by an explicit decision in this spec (a removed event implies a phase no longer fires, which is a behaviour change).

## What goes in `event-order.md` (B0 — but seeded in Pre-Wave)

A canonical emit sequence per stage:

```text
run_started
  prerequisites_started
    prerequisites_check (×5)
  prerequisites_completed
  clarification_started
    clarification_question (interactive)
    clarification_completed
  loop_cycle_started
    task_phase_started (×N — one per stage in cycle)
      step_started
        agent_step (×many)
      step_completed
    task_phase_completed
  loop_cycle_completed (or loop_terminated on stop)
run_completed
```

Plus the **tolerable-reorder list** (sub-gate-scoped) — e.g.:

> **G0 (A0 + A0.5)** — pure mechanical moves. Tolerable reorders: none expected.
> **G1 (A1 + A2)** — `prerequisites_started` may now emit *before* the lock-acquisition log line (was after). Tolerable.
> **G2 (A3 + A4)** — `clarification_completed` may emit before or after the `[INFO] full plan written to <path>` log line. Tolerable.
> **G3 (A5 + A6 + A7)** — none expected.
> **G4 (A8)** — none expected.

The list is short. If it grows past ~10 entries, the refactor is changing more behaviour than is justified — escalate to the user before proceeding.

## Why two baselines (R-004 expanded)

A single baseline produces false positives. The orchestrator emits some events as the SDK stream resolves; depending on how the event loop schedules a microtask, two events can swap order between back-to-back runs of an identical scenario. Without intersection, every gate's diff is "is this race-y or real?" — review fatigue eats discipline within the first wave.

The intersection is exactly the stable subset: events that fire in the same relative position across two independent runs. The trade-off: an event that fires only on one run might be filtered out — but if it fires only sporadically pre-refactor, it's already not a load-bearing part of the public emit contract.

## Operational note

Re-capture the baseline only if a load-bearing event is intentionally added or removed by an explicit spec change (rare during this refactor; never during Wave A). Document the re-capture in the wave's PR description with the new SHA of `golden-trace-pre-A.txt`.

## References

- Spec FR-012, SC-008.
- Research R-004 — full rationale.
- `.claude/rules/06-testing.md` §4c — smoke procedure on `dex-ecommerce`.
- `.claude/rules/06-testing.md` §4f.2 — `~/.dex/logs/<project>/<runId>/` log layout.
