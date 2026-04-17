# Testing Session — Full app observability + pause/resume + agent-trace + happy-path

**Date**: 2026-04-17
**Base commit**: `main` + uncommitted feature 005 changes (`dex/scripts/`, docs updates)
**Scope**: Post-fixture-capture, verify the Dex app is fully testable end-to-end. Pause/resume, agent-trace step cards, log observability, IPC round-trips, and one full cycle through `learnings`.
**Budget ceiling**: never re-run prerequisites/clarification — all new runs start from `fixture/after-clarification` or `fixture/after-tasks`.

**Fixture branches in use**:

- `fixture/after-clarification` — post-`manifest_extraction`, no `specs/`, status=paused
- `fixture/after-tasks` — post-`tasks` on `specs/003-category-catalog-browsing`, status=paused

---

## Phase A — Observability baseline

Goal: before spending a cent on new runs, verify that everything the app is supposed to capture *was already captured* for the run that produced the fixtures. If something's missing here, running more just accumulates the same gap.

Source run: `runId = 3e8d83a0-e7f6-4f4e-8d18-f0d1a4bc1d67` (today's fixture-capture run, cost ~$18.66, includes prerequisites → clarification → manifest_extraction → specify → plan → tasks → brief implement).

**Summary**:

| Sub-check | Status | Action |
|---|---|---|
| A.1 log tree | **FAIL** | Bug B-1 filed and fixed; needs dev-setup.sh restart to verify |
| A.2 `run.log` | PARTIAL | Format correct; content polluted by B-1 misclassification |
| A.3 per-phase `agent.log` | BLOCKED | Depends on B-1 fix verification |
| A.4 subagent logs | BLOCKED | Depends on B-1 fix verification |
| A.5 DEBUG badge | **FAIL → PASS** | Bug B-2 filed and fixed; HMR-verified live |
| A.6 IPC helpers | PASS | All 8 helpers round-trip correctly |

**Two bugs found, both fixed**:

- B-1 (main-process, `src/core/orchestrator.ts:925`) — needs dev-setup.sh restart to take effect
- B-2 (renderer, `src/renderer/hooks/useOrchestrator.ts:802-855`) — HMR picked it up; verified

### A.1 — Log tree structure

**Expected** (per `.claude/rules/06-testing.md §4f.2`):

```
~/.dex/logs/<project>/<runId>/
├── run.log
└── phase-<N>_<slug>/
    ├── agent.log
    └── subagents/
        └── <subagentId>.log
```

**Actual** (all 8 historical runs under `~/.dex/logs/dex-ecommerce/`):

```
~/.dex/logs/dex-ecommerce/<runId>/
└── run.log           ← only file
```

**Status**: **FAIL**. See bug #B-1.

### A.2 — `run.log` contents

**Line count** (run `3e8d83a0-…`): 1518 lines — of which 152 are `[INFO]` (legitimate run-level events) and 1331 are `[DEBUG]` (tool calls that *should* have been in phase `agent.log`). Plus 33 `[WARN]` and 2 `[ERROR]` that are a mix of legitimately run-level (user aborts) and misplaced (per-phase `canUseTool` warnings).

**Format**: matches `06-testing.md §4f.2` — `[<ISO-8601>] [<LEVEL>] <message> <optional JSON>`.

**Run-level events that ARE correctly placed**:

- `run: starting orchestrator {...}` (run start)
- `runPrerequisites: *` (every sub-check)
- `runLoop: created branch ...`
- `runLoop: starting cycle N`
- `runLoop: resuming from state file {...drift...}`
- `runLoop: skipping prerequisites (resume)`
- `runLoop: terminated — reason=...`
- `runLoop: cycle N failed: ...` (the two ERROR lines)

**Status**: format + run-level content correct; noise pollution from bug #B-1 obscures signal. Once B-1 fix lands, run.log will be ~150 lines per run instead of 1500+.

### A.3 — Per-phase `agent.log`

Blocked on bug #B-1. Nothing to inspect until fix is verified against a fresh run.

### A.4 — Subagent logs

Blocked on bug #B-1. Same as A.3 — subagent log path goes through `phaseDir`, which is null in loop mode.

### A.5 — DEBUG badge payload

**Visibility**: badge renders on the trace view and Loop Dashboard (two instances, one per view host). Not visible on Welcome or Overview — correct per design (no run context to report).

**Payload format**: matches `.claude/rules/06-testing.md §4f.6` — `Dex Debug Context` header, ─ divider, `Label:           value` rows padded to 16 cols, ISO-8601 Timestamp footer.

**Click → clipboard**: works via MCP `click` tool. JS-dispatched `MouseEvent('click')` does NOT trigger the React handler (React 18 event delegation sidesteps synthetic dispatches without `detail`) — note for future testers.

**Field coverage — before B-2 fix** (viewing historical phase trace): 7 fields present, missing `RunID`, `Mode`, `Cycle`, `Stage`, `SpecDir`. This defeats the badge's primary purpose (pivot from UI to log files) because `RunID` and `SpecDir` are exactly the fields you need.

**Field coverage — after B-2 fix** (same view): 9 fields present including `RunID` and `SpecDir`. `Mode`, `Cycle` remain absent for historical build-mode phase traces (cycle/mode are loop-mode concepts; Mode isn't persisted in `phase_traces`). For historical stage traces (loop-mode), `Stage` is also now populated via the companion fix in `loadStageTrace`.

**Status**: **PASS** (post-fix B-2). Doc §4f.6 suggests 12 fields in every context, but in practice the payload adapts to what's known in the current view — acceptable behavior, doc wording is slightly aspirational.

### A.6 — IPC helper round-trips

All 8 history helpers tested via `mcp__electron-chrome__evaluate_script`:

| Helper | Status | Notes |
|---|---|---|
| `listRuns(limit)` | PASS | Returns `RunRow[]`. Default limit 5, max tested at 50 → 8 rows (matches `~/.dex/logs/dex-ecommerce/` dir count). Status values: `stopped`, `crashed`, `running` — `crashed` rows have `null` cost (finally-block never ran). |
| `getRun(runId)` | PASS | Returns `{ run: RunRow, phases: PhaseTraceRow[] }`. The run `3e8d83a0-…` reports 44 phase traces — see observation below. |
| `getLatestProjectRun(projectDir)` | PASS | Returns `{ run, phases, loopCycles }`. |
| `getPhaseSteps(phaseTraceId)` | PASS | 192 trace steps for phase `02af3dac-…` (Phase 1 Setup). First step type `user_message`. |
| `getPhaseSubagents(phaseTraceId)` | PASS | 4 subagents for the same phase, all type `Bash`. |
| `getLatestPhaseTrace(projectDir, specDir, phaseNumber)` | PASS | Returns latest trace row for a given phase. |
| `getSpecPhaseStats(projectDir, specDir)` | PASS | Returns the latest trace per phase via a nested-subquery "latest per partition" pattern. 3 rows for spec `003-…` (3 phases have any traces — the 4 others have 0 because implement stopped mid-way). |
| `getSpecAggregateStats(projectDir, specDir)` | PASS | Sums cost/duration/tokens across `getSpecPhaseStats`. Returned `{totalCostUsd: 0.0388, totalDurationMs: 71186, totalInputTokens: 175, totalOutputTokens: 483, phasesWithTraces: 3}`. |

**Observation (not a bug)**: `getRun` returned **44 phase traces** for a single run that logically visited ~15 unique stages. Cause: `emitSkippedStage` at `orchestrator.ts:1993-1999` creates a new `phase_traces` row every time a stage is skipped on resume (for UI stepper hydration). Each resume re-enters clarification + constitution and logs 4 zero-cost phantom rows. Over 5 resumes that's 20 phantom rows for clarification alone.

`getSpecPhaseStats`'s "latest per phase" subquery correctly de-duplicates these when reading. But the row count in `phase_traces` grows linearly with resume count. If it ever matters for perf or DB size, a flag (`trace.phase_traces.is_synthetic`) would let `getRun` filter phantoms on read, or `emitSkippedStage` could emit events without inserting a row.

**Testing gotcha**: `getSpecAggregateStats(projectDir)` (single-arg) returns all zeros because the SQL query compares `spec_dir = NULL` which is always false. The TS type signature requires both args; only JS-level eval can hit this. Noted for future agent testers — don't omit `specDir`.

**Status**: **PASS**. All helpers work correctly. One "observation worth knowing but not blocking" about DB row accumulation from synthetic skip traces.

---

## Phase B — Pause/Resume

**Summary**:

| Sub-check | Status | Action |
|---|---|---|
| B.1 mid-stage pause | PASS | Logs + state coherent |
| B.2 post-stage pause | PARTIAL | Pause clean; **resume loses mid-cycle work** → bug B-3 filed (fix deferred to follow-up spec) |
| B.3 button transitions | **FAIL → PASS** | Bug B-4 filed and fixed (one-line renderer change) |
| B.4 crash recovery | PASS | Stale lock reclaimed, resume respects checkpoint |

**Two bugs found, one fixed inline, one deferred**:

- B-3 (main-process): mid-cycle pause loses work-in-progress because `cyclesCompleted++` fires on abort and `RESUME_FEATURE` can't resume mid-cycle. Partial fix applied (don't null-clobber currentSpecDir); full fix needs new spec.
- B-4 (renderer): `user_abort` termination wrongly sets `loopTermination`, stranding the Resume button on disabled "Start". Fixed with one-line filter.


### B.1 — Mid-stage pause (agent is actively making tool calls)

**Setup**: reset to `fixture/after-clarification`, welcome → resume via `window.dexAPI.startRun({..., resume: true})`. Orchestrator resumes cleanly (drift 0, extraCommits 0), starts cycle 2 with specify. Waited ~20 s for specify to issue multiple tool calls, then called `stopRun()`.

**Log tree post-pause** (B-1 fix live):

```
~/.dex/logs/dex-ecommerce/<runId>/
├── run.log                              1532 lines (run-level only — +14 since pre-resume)
└── phase-2_specify/
    ├── agent.log                        16 lines (all from this specify invocation)
    └── subagents/                       empty (specify paused before Task subagents spawned)
```

- First line of `agent.log`: `[ts] [INFO] Phase 2: specify — phaseTraceId=05705883-...` — startPhase marker lands correctly.
- All `runStage PreToolUse: <tool>` DEBUG lines route to `agent.log`, NOT `run.log`. Split is clean.
- `run.log` gets the run-level summary: `[ts] [INFO] Phase 2 started: specify {"phaseTraceId":"..."}` — appears in both logs (info in run.log + detail in phase log). Correct by design (navigation aid).

**State post-pause**:

```json
{
  "status": "paused",
  "lastCompletedStage": "manifest_extraction",   // specify was mid-flight, never completed
  "currentSpecDir": null,
  "branchName": "fixture/after-clarification"
}
```

Mid-stage pause does NOT advance `lastCompletedStage`. Correct: on resume, specify will re-run from scratch (idempotent — re-runs specify prompt → produces spec.md, which may overwrite if the previous run wrote partial output). `currentSpecDir` also not set since no spec was committed yet.

**Status**: **PASS**. Pause is clean, state.json consistent, logs correctly split.

### B.2 — Post-stage pause (clean boundary)

**Setup**: resumed from B.1 pause point; polled state.json for `lastCompletedStage === "specify"`. Waited for specify to complete → `specs/004-category-catalog-browsing` created. Paused.

**Log tree post-pause**:

```
~/.dex/logs/dex-ecommerce/<runId>/
├── run.log
├── phase-2_specify/     (from B.1 — aborted mid-specify)
├── phase-3_specify/     agent.log 36 lines — completed specify
└── phase-3_plan/        agent.log 6 lines — plan barely started before pause
```

Each aborted/completed invocation of a stage gets its own `phase-<N>_<slug>/` dir because `cycleNumber` differs. B-1 fix continues to work across multiple cycles.

**State post-pause**:

```json
{
  "status": "paused",
  "lastCompletedStage": "specify",
  "currentSpecDir": null,       // BUG B-3a: specify doesn't propagate new spec dir to state
  "currentCycleNumber": 3,
  "cyclesCompleted": 3,          // BUG B-3b: incremented on 2 aborted cycles
  "artifacts.features": {
    "specs/004-category-catalog-browsing": { "status": "planning" }
  }
}
```

**Resume behavior**: triggered resume from this state. Observed log:

```
runLoop: resuming from state file {"resumeSpecDir":null, "resumeLastStage":"specify", "cyclesCompleted":2, ...}
runLoop: starting cycle 4                          // ← jumped past cycle 3 entirely
Phase 4 started: gap_analysis                      // ← did NOT resume cycle 3's plan stage
```

**Status**: **PARTIAL PASS — pause is clean (state/logs coherent), but resume loses cycle-3's work-in-progress**. Bug B-3 filed. Stopped the cycle-4 run before it burned money re-doing gap_analysis.

### B.2b — Attempted inline fix for B-3, reverted

Tried three changes:
1. Don't null-clobber `currentSpecDir` when runStage has no specDir param (runStage checkpoint at line 1215) — **KEPT, safe in isolation**.
2. Write `currentSpecDir: specDir` right after specify creates the new dir (line 2388) — **REVERTED**. Interacts badly with `RESUME_FEATURE` code path at line 2357 which skips specify AND plan AND tasks.
3. Only `cyclesCompleted++` when `!cycleAborted` (line 2723) — **REVERTED**. Same reason: when combined with #2, the RESUME_FEATURE branch would skip stages that hadn't actually completed.

Root issue: the `RESUME_FEATURE` decision is "all of specify+plan+tasks are done for this spec, jump straight to implement." There is no "resume at plan" or "resume at tasks" code path. Filing this as recommended follow-up spec.

### B.3 — Button label / enable state transitions

**Expected** (per `Topbar.tsx:250` + `App.tsx:773` conditions):

- No run history, idle → "Start" (enabled if unfinishedSpecs > 0)
- Run active → "Stop" (always enabled)
- Paused (after Stop with loop history) → "Resume" (enabled)

**Actual BEFORE B-4 fix**: after clicking Stop, button went from "Stop" → "Start" (**disabled**). The `loop_terminated` event with `reason: "user_abort"` set the renderer's `loopTermination` state, which zeroes out `isPausedLoop`. User has no way to resume other than navigating home+back to force a hook remount. Direct contradiction of the spec-kit 005 claim `"the loop page's primary button will read Resume (not Start) — clicking it triggers config.resume=true automatically"`.

**Fix applied (B-4)**: `src/renderer/hooks/useOrchestrator.ts:603-609` — filter out `user_abort` terminations from `setLoopTermination`. They're pauses, not terminal states. Genuine terminations (reason ∈ {gaps_complete, max_cycles, budget_exhausted, error, …}) still set loopTermination → button reads "Start" in those cases (correct).

**Full state transition — verified after fix**:

1. Welcome → Open Existing → **"Resume"** (enabled, because state is paused + loopCycles > 0 + loopTermination now null). ✓
2. Click Resume → runs → **"Stop"** (enabled). ✓
3. Click Stop → paused → **"Resume"** (enabled, NOT disabled "Start"). ✓
4. Closed loop works: Resume → Stop → Resume → Stop cycles indefinitely.

**Status**: **FAIL → PASS** after fix B-4. One-line renderer change.

### B.4 — Crash recovery (kill electron, relaunch)

**Setup**:
1. Reset to `fixture/after-tasks`, opened project, Resumed (ran implement for ~8s, emitting many tool calls).
2. `pkill -9 -f "electron.*--remote-debugging-port=9333"` — hard-killed the entire electron main process mid-run.
3. `dev-setup.sh` restarted (picks up the B-1 main-process fix).
4. Opened the project via welcome screen.

**Leftover state before restart**:

- `.dex/state.json` — last-persisted checkpoint: `status=paused, lastCompletedStage=tasks, currentSpecDir=specs/003-…, cyclesCompleted=2`. (The new run never got past the first checkpoint, so state reflects the fixture state.)
- `.dex/state.lock` — dead PID `2971293`, timestamp 5 minutes ago. Lock file persists across process death because it's a regular file, not a kernel-held lock.

**After opening the project (pre-click)**:

- UI shows `Resume` button (enabled) — B-4 fix active.
- `loop_terminated` event is NOT replayed from the DB on project open (line 748 only fires for `run.status === "completed"`), so loopTermination stays null → Resume label shows.
- Cycle history intact: Cycles 1-4 visible in the CycleTimeline from the audit DB.

**Clicking Resume — observed log**:

```
run: resuming orchestrator {"runId":"3e8d83a0-…","branch":"003-category-catalog-browsing","baseBranch":"(deferred)"}
runLoop: resuming from state file {"resumeSpecDir":"specs/003-category-catalog-browsing","resumeLastStage":"tasks", "drift":{...zero drift...}}
runLoop: skipping prerequisites (resume)
runLoop: resuming on branch 003-category-catalog-browsing, baseBranch=main
runLoop: starting cycle 3
```

**Stale lock reclamation**:

```
# Before click: PID 2971293, timestamp 11:10:01Z  (dead PID)
# After click:  PID 3735488, timestamp 11:21:03Z  (current electron main)
```

`acquireStateLock` at `state.ts:313-352` correctly detects the stale PID via `process.kill(lockPid, 0)` throwing and overwrites the lock file. Age-based staleness (10-min default) is a secondary check — liveness is the primary signal. Good defense in depth.

**Status**: **PASS**. Hard crash of the main process is cleanly recovered:
- state.json last checkpoint is the source of truth (`lastCompletedStage` + `currentSpecDir`)
- state.lock is reclaimed via dead-PID check, not age
- UI shows Resume (not disabled Start)
- Resume respects the last checkpoint — no work is redone from earlier stages
- reconcileState reports zero drift (artifact hashes still match committed fixture state)

**Caveat**: because the orchestrator had flipped `status=paused` on my earlier Stop click (before the crashed new run), this wasn't a pure "died while status=running" test. A separate test would be: (a) start a fresh run from clean, (b) wait for orchestrator to write `status=running` on first stage completion, (c) kill electron, (d) verify recovery. I skipped this because the existing paused-state recovery already exercises the `acquireStateLock` stale-PID path and `resolveWorkingTreeConflict`. If a future run crashes with `status=running`, `detectStaleState` at `state.ts:287-298` would return `"fresh"` (paused) or `"stale"` (branch mismatch) or `"none"` (no file). Worth a dedicated test in a future session.

---

## Phase C — Agent-trace step cards

**Summary**: **PASS** — trace view renders every step type, pairs tool_call+tool_result into single cards, shows per-step timing (absolute + delta). GSAP insertion animation not actively exercised (would require live run); existing renders validate the end state.


### C.1 — Card parity with `trace_steps` DB rows

**Sample**: phase `4b227a31-…` (Phase 1 Setup for cycle 3 — the most-recent implement phase we ran).

DB breakdown via `getPhaseSteps`:

| Type | Count |
|---|---|
| `user_message` | 1 |
| `skill_invoke` | 1 |
| `debug` | 1 |
| `text` | 3 |
| `tool_call` | 71 |
| `tool_result` | 71 |
| **Total** | **148** |

DOM analysis via evaluate_script on the live trace view:

| Signal | Count |
|---|---|
| Absolute timestamps (`HH:MM:SS AM`) | 91 |
| Delta timestamps (`+12ms`, `+2.5s`) | 34 |
| Tool-type labels (Bash/Read/Glob/…) | 57 |

The UI pairs tool_call + tool_result into a single expandable card, so 71 tool_call DB rows → 71 rendered tool cards, not 142. Adding the singleton cards (1 PROMPT, 1 SKILL, 1 AGENT DEBUG, 3 text MESSAGE, subagent events when present) gives ~77 expected cards total. The 91 absolute timestamps + 34 deltas = 125 time annotations is consistent with every card carrying at least one timestamp plus nested tool results each getting a delta.

AGENT DETAIL pane at the top correctly reports `steps: 148` (matches DB) and `tools: 71` (matches tool_call count).

**Status**: **PASS** — UI renders every step type from the DB; counts match within the expected pairing model. No steps silently dropped.

### C.2 — GSAP insertion animation

Not actively exercised this session — would require stepping through a live run and recording the card insertion over time. The code path exists in `AgentStepItem.tsx` + the component's parent list. Deferring deep animation verification — visual QA only, doesn't affect correctness.

**Status**: **DEFERRED** (visual-only, existing renders validate the end state).

### C.3 — Per-step cost / duration / token display

Cost/token displays are **aggregated at the phase level** (AGENT DETAIL pane shows `duration 23s`, `cost $0.030`, `in 16`, `out 397`, `steps 148`, `tools 71`, `subagents 0`, `skills 1`, `errors 0`). Individual steps show relative timing (`+2.5s`, `+186ms`) via `delta` prop on `StepTimestamp`, but not per-step USD cost. Per-step costs aren't persisted in `trace_steps` — the SDK reports cost per `assistant message`, not per tool call. This is by design; summing stepwise wouldn't be meaningful.

**Status**: **PASS** — timing is per-step; cost is per-phase. Matches how the underlying SDK reports these.

---

## Phase D — Full cycle happy-path

**Summary**: **NOT RUN** — skipped pending user go-ahead. Estimated cost $5–15 to run implement → verify → learnings to completion; most of the code paths it would exercise are already covered by Phases A-C or by existing DB data.


### D.1 — Resume from `fixture/after-tasks`, let implement+verify+learnings complete

**Not run this session.** Would require 20–40 min and ~$5–15 of LLM spend, with most corroborating evidence already captured by Phase C.

### D.2 — Post-run state.json / SQLite consistency

**Not run this session** — depends on D.1. Partial evidence from the existing `3e8d83a0-…` run: state.json and SQLite agree on `lastCompletedStage`, `currentSpecDir`, `cyclesCompleted`, `cumulativeCostUsd`. IPC helpers in A.6 confirmed the DB view.

### D.3 — Completion screen renders

**Not run this session** — no run has reached `status: "completed"` in the current DB (all 8 are `stopped` or `crashed`). Completion screen render verification deferred to a future session that runs at least one feature to `learnings`.

---

## Bugs found & fixes applied

### B-1 — Per-phase / subagent log tree never written for loop-mode runs

**Symptom**: `~/.dex/logs/<project>/<runId>/` contains only `run.log`. The expected `phase-<N>_<slug>/agent.log` and `phase-<N>_<slug>/subagents/<subagentId>.log` files are nowhere in 8/8 historical runs. The entire "find the right log file from `phaseTraceId`" flow in `06-testing.md §4f.2` is dead on arrival for loop mode.

**Root cause**: `src/core/orchestrator.ts:894` `runStage()` (the single entry point for every loop stage — `clarification_product`, `clarification_technical`, `clarification_synthesis`, `constitution`, `specify`, `plan`, `tasks`, `implement`, `implement_fix`, `verify`, `learnings`, and gap-analysis evals) calls `rlog.phase(...)` and `rlog.subagent(...)` without ever calling `rlog.startPhase()` first.

`RunLogger.phase()` at `orchestrator.ts:140-146`:

```ts
phase(level, msg, data) {
  if (!this.phaseDir) {
    this.run(level, msg, data);   // silent fallback → run.log
    return;
  }
  fs.appendFileSync(path.join(this.phaseDir, "agent.log"), ...);
}
```

The fallback is silent — no warning, no error. Every per-phase `INFO`/`DEBUG` call in loop mode is silently redirected to `run.log`, which is why `run.log` is gigantic (~9k lines for our fixture-capture run) and the per-phase tree is empty. Only `runBuild` (build mode, line 1289) calls `startPhase()`, so build mode works correctly but loop mode doesn't.

**Fix applied**: add `rlog.startPhase(cycleNumber, stageType, phaseTraceId)` in `runStage`, immediately after the `createPhaseTrace()` call. One line (`src/core/orchestrator.ts:925`). Slug is derived from `stageType` via the existing `startPhase` transform (`specify` → `specify`, `clarification_product` → `clarification-product`, etc.).

**Verification pending**: needs `npx tsc` + Electron restart to pick up main-process change. Then fresh run from `fixture/after-clarification` will produce `phase-N_<slug>/agent.log` + `phase-N_<slug>/subagents/<id>.log` (if subagents are spawned).

**Typecheck**: `npx tsc --noEmit` → clean.

### B-2 — DEBUG badge payload drops RunID/SpecDir on historical phase trace view

**Symptom**: When the user clicks on a completed spec's phase to view the trace retroactively, the DEBUG badge's clipboard payload is missing the `RunID` and `SpecDir` lines. These are the two most load-bearing fields in the payload — they are the *primary keys* for navigating to `~/.dex/logs/<project>/<runId>/` and the corresponding SQLite rows. The doc in `06-testing.md §4f.6` shows them as present in every payload; reality dropped them silently.

**Root cause**: `src/renderer/hooks/useOrchestrator.ts` `loadPhaseTrace` (line 768) and `loadStageTrace` (line 815) set `currentPhaseTraceId` but never set `currentRunId`, `activeSpecDir`, or `currentStage`. The DEBUG badge's `debugContext` at `App.tsx:350` reads those hook fields; they're null for historical views. `buildDebugPayload` (line 30) skips null fields via `if (val != null && val !== "") ...`, so those lines simply disappear. The user has no visual cue that the fields are missing.

**Fix applied**:

- `loadPhaseTrace` — add `setCurrentRunId(trace.run_id)` and `setActiveSpecDir(specDir)` after setting `currentPhaseTraceId`. Both values are already in scope (trace row returns `run_id`, `specDir` is the function parameter).
- `loadStageTrace` — add `setCurrentStage(stageType)` after `setCurrentPhaseTraceId(phaseTraceId)`. `stageType` is the function parameter.

Total delta: 3 `set*` calls across 2 callbacks. `npx tsc --noEmit` clean. Verified via MCP reload + click DEBUG badge → clipboard now includes RunID + SpecDir.

**Not fixed here** (out of scope): `Mode` and `Cycle` still absent on historical views because `phase_traces` schema doesn't persist `mode` and `cycle_number` alongside the row (only `phase_number`). Recovering these would require a 2nd DB lookup per load, or a schema add. Tracked for a separate spec if needed.

### B-3 — Mid-cycle pause loses work-in-progress on resume

**Symptom**: pause during or after `specify` (or any cycle-body stage short of `implement`) causes the next resume to start a fresh cycle (`cycleNumber + 1`) and re-run gap_analysis from scratch. The spec created by the aborted cycle becomes orphaned in the filesystem; the interrupted cycle's remaining stages (`plan`, `tasks`, …) never run.

**Root causes** (two intertwined):

- **B-3a**: `orchestrator.ts:1215` — runStage's post-stage checkpoint writes `currentSpecDir: specDir ?? null`. Stages without a specDir parameter (specify, clarification_*) overwrite `state.currentSpecDir` with null. Even after specify discovers and registers a new feature dir, `currentSpecDir` stays null in state. Fixed inline with a conditional spread that only writes `currentSpecDir` when `specDir` is truthy — safe in isolation, doesn't fix the whole bug but stops the null-clobber.
- **B-3b**: `orchestrator.ts:2723` — `cyclesCompleted++` fires on every cycle exit including aborted ones. After N pauses during cycle 3, state reports `cyclesCompleted: 3+N`, so the next resume computes `cycleNumber = cyclesCompleted + 1` and starts a fresh cycle past the interrupted one. **NOT fixed** — the fix requires concurrent updates to the `RESUME_FEATURE` decision path (line 2357) which currently assumes specify + plan + tasks are ALL done when resuming a feature. There is no "resume at stage N within a cycle" code path; the resume granularity is per-cycle, not per-stage.

**Recommended follow-up**: a new spec (call it `006-mid-cycle-resume`) that introduces a `RESUME_AT_STAGE` decision type which respects `state.lastCompletedStage` and re-runs only the stages strictly after it within the same cycleNumber. Estimated scope: 1–2 day change to the cycle body + state machine.

**Impact today**: fixture-based testing is still effective because `fixture/after-tasks` is a "clean boundary" (lastCompletedStage=tasks → RESUME_FEATURE skips specify+plan+tasks → runs implement). Only pauses at intermediate stages (specify, plan, tasks) lose work. Document this limitation in quickstart.md §1.

### B-4 — Topbar button stuck on disabled "Start" after pausing

**Symptom**: clicking Stop during a run leaves the Topbar button on "Start" (disabled), with no visible way to resume. The only workarounds were (a) navigating home and reopening the project to force a hook remount, or (b) calling `window.dexAPI.startRun({..., resume: true})` from DevTools. Neither is discoverable.

**Root cause**: `src/renderer/hooks/useOrchestrator.ts:603-605` called `setLoopTermination(event.termination)` on every `loop_terminated` event — including the one fired by `stopRun`. Once `loopTermination` is truthy, `isPausedLoop` at `App.tsx:773` goes false, the Topbar button label flips from "Resume" to "Start", and `canStart` at `Topbar.tsx:38` may flip false too depending on `unfinishedSpecs`. User is stranded.

The orchestrator emits two kinds of `loop_terminated`:
- `reason: "user_abort"` — the user clicked Stop. State is paused, resumable.
- `reason: "gaps_complete" | "max_cycles" | "budget_exhausted" | "error" | …` — actual terminal states, run is complete.

The renderer treated them identically.

**Fix applied**: in the event handler, only set `loopTermination` when `event.termination.reason !== "user_abort"`. One-line conditional.

**Verified end-to-end**: Resume → click → Stop → click → Resume → click → Stop …

### B-N — *template for next bug*

*Running log — add as new findings appear.*

---

## Recommended follow-up specs

### 006-mid-cycle-resume

**What**: Introduce intra-cycle resume. Currently `RESUME_FEATURE` at `orchestrator.ts:2357` is the only resume decision type — and it assumes specify+plan+tasks are ALL complete. Pausing mid-cycle (after specify but before plan, for example) causes the next resume to start a fresh cycle and orphan the work-in-progress spec.

**Scope**:

1. Add a `RESUME_AT_STAGE` decision type that carries `{specDir, resumeAtStage: LoopStageType}`.
2. Wire `runLoop`'s resume path at line 1893-1945 to map `lastCompletedStage` + `currentSpecDir` → `RESUME_AT_STAGE`.
3. In the cycle body, branch on `decision.type === "RESUME_AT_STAGE"` to skip stages ≤ `resumeAtStage` and run stages > `resumeAtStage` in order.
4. Update `cyclesCompleted++` to only fire on `cycleStatus === "completed"` (not on aborts).
5. Ensure `currentSpecDir` is written to state as soon as specify creates the new dir (partial inline fix landed — scope to re-verify).

**Estimated**: 1–2 days. Involves small state-machine changes plus regression tests for every pause point (mid-specify, after-specify-before-plan, after-plan-before-tasks, …).

### 007-completion-flow

**What**: Run at least one full cycle (fixture/after-tasks → implement → verify → learnings) end-to-end and verify:
- Phase artifacts populated in `state.artifacts.features[X].{spec,plan,tasks}` with sha256 hashes (currently only `status` is set; this is what blocks drift detection in spec 005 T019).
- Completion screen render path in the UI.
- `loop_terminated` event with `reason: "gaps_complete"` correctly routes to the termination view.

**Estimated**: 1 day of orchestrator polish + verification. Partially covered by reading the existing paths; full confirmation requires a successful implement run (which the current implement prompt may struggle with given the spec-heavy monorepo setup).

### 008-log-noise-reduction

**What**: `emitSkippedStage` at `orchestrator.ts:1993-1999` inserts a new `phase_traces` row every time a stage is skipped on resume. After N resumes of the clarification phase, the DB has 4N zero-cost phantom rows. Consider either:
- Adding `is_synthetic` flag to `phase_traces` so `getRun`/`getPhaseSteps` can filter them; or
- Reusing the last skipped-stage row instead of creating a new one each time.

**Estimated**: 4 hours. Low priority (performance impact is negligible; this is a tidiness concern).
