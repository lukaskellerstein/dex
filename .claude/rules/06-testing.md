---
description: "Step 4: Testing — define DoD, reset the example project, drive the app via electron-chrome MCP, fix and repeat until passing"
---

# Step 4: Testing

**Every code change must be tested before reporting completion. No exceptions.**

## 4a. Define your Definition of Done

Before testing, **write out your DoD checklist in the conversation** so the user can see what you intend to verify. Example:

> **Definition of Done for this task:**
> - [ ] The new component renders correctly in the app
> - [ ] Clicking the button triggers the expected action
> - [ ] Status updates are reflected in the UI

## 4b. MCP Server & CDP Port

One chrome-devtools MCP server is configured in `.mcp.json`:

| MCP Server | CDP Port | Target | Use For |
|---|---|---|---|
| `electron-chrome` | 9333 | Electron app | All UI changes (renderer pages, components, IPC-driven UI) |

Tools available: `mcp__electron-chrome__take_snapshot`, `mcp__electron-chrome__take_screenshot`, `mcp__electron-chrome__click`, `mcp__electron-chrome__evaluate_script`, `mcp__electron-chrome__fill`, `mcp__electron-chrome__navigate_page`, etc.

## 4c. Example project for end-to-end testing

For any test that exercises the full loop (welcome screen → loop start → autonomous run), drive the app against the **dex-ecommerce** example project.

| Field | Value |
|---|---|
| Parent path | `/home/lukas/Projects/Github/lukaskellerstein` |
| Project name | `dex-ecommerce` |
| Full path | `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` |

### Step 1 — Reset the example project

Before every test run, restore `dex-ecommerce` to a known state. The project ships a single entry point for this — `dex/scripts/reset-example-to.sh` — which supports three checkpoints:

```bash
./dex/scripts/reset-example-to.sh <checkpoint>
```

| Checkpoint | Skips | Approx. time saved |
|---|---|---|
| `clean` | nothing — full run from `prerequisites` | baseline |
| `after-clarification` | `prerequisites`, `clarification_*`, `constitution`, `manifest_extraction` | ~5–10 min |
| `after-tasks` | everything above plus `gap_analysis`, `specify`, `plan`, `tasks` | ~15–20 min |

**Picking a checkpoint**:

- Your change only touches the implement loop or later (`implement`, `implement_fix`, `verify`, `learnings`) → use `after-tasks`.
- Your change only touches `gap_analysis`, `specify`, `plan`, or `tasks` → use `after-clarification`.
- Your change touches `prerequisites`, any `clarification_*`, `constitution`, or `manifest_extraction`, or you're validating non-regression → use `clean`.

After restoring a fixture, the welcome submit button reads **Open Existing** (because the folder exists) and the loop page's primary button reads **Resume** (because loop history is present). Clicking **Resume** auto-routes to `config.resume=true` — the orchestrator skips `prerequisites`, reuses the existing `runId`, and resumes from the next stage after `state.lastCompletedStage`.

Sanity check — after reset, inspect the workspace:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
```

For `clean`, `ls` must show only `GOAL.md` and `.git/`. For fixtures, the tree matches the committed fixture branch.

**Fixture branch reservation**: `fixture/*` is a reserved branch namespace on `dex-ecommerce`. Exactly two fixtures exist at all times: `fixture/after-clarification` and `fixture/after-tasks`. They are refreshed by force-moving the pointer in place (`git branch -f`) — versioned variants (`fixture/after-tasks-v2`, etc.) are not created. See [specs/005-testing-improvements/quickstart.md §1](../../specs/005-testing-improvements/quickstart.md) for the full refresh workflow and [contracts/README.md](../../specs/005-testing-improvements/contracts/README.md) for the script's exit-code contract.

**Branch hygiene**: autonomous runs leave behind `dex/YYYY-MM-DD-xxxxxx` branches. Run `./dex/scripts/prune-example-branches.sh` periodically to delete `dex/*` branches older than 7 days (`main`, `fixture/*`, and `lukas/*` are always preserved).

`reset-example-to.sh` and `prune-example-branches.sh` are the **only authorized destructive paths** against `dex-ecommerce` — they inherit the trust boundary of the legacy reset procedure. You do not need to ask before running them against `dex-ecommerce`. Never run them against any other repo.

### Step 2 — Ensure the dev server is running

Check `electron-chrome` MCP connectivity via `mcp__electron-chrome__list_pages`. If it fails, `dev-setup.sh` is not running.

### Step 3 — Fill the welcome screen

The welcome screen inputs have stable `data-testid` attributes:

| Testid | Purpose |
|---|---|
| `welcome-path` | Parent path input |
| `welcome-name` | Project name input |
| `welcome-pick-folder` | Native folder-picker button (do not click — native dialog is opaque to MCP) |
| `welcome-submit` | Dynamic submit button (label toggles `New` / `Open Existing` based on `fs.existsSync(path/name)`) |

Fill and submit:

1. Snapshot with `mcp__electron-chrome__take_snapshot` to resolve uids for the inputs.
2. `mcp__electron-chrome__fill` the `welcome-path` input with `/home/lukas/Projects/Github/lukaskellerstein`.
3. `mcp__electron-chrome__fill` the `welcome-name` input with `dex-ecommerce`.
4. The submit button label should now read `Open Existing` (because the folder exists after reset). Click it.

### Step 4 — Start the autonomous loop

On the Autonomous Loop page:

1. `GOAL.md` is auto-detected — no need to write it.
2. Toggle **Automatic Clarification** on (the switch next to "Skip interactive Q&A — agent auto-selects recommended options based on GOAL.md context").
3. Click **Start Autonomous Loop**.

From here the orchestrator takes over: it creates its own branch, runs clarification, planning, and the implement loop. Observe via snapshots, screenshots, `~/.dex/dev-logs/*.log`, and the live trace view.

## 4d. Test

**UI / Renderer changes** — use `electron-chrome` MCP (CDP port 9333):
1. Ensure `dev-setup.sh` is running.
2. For any flow that requires an open project, follow section **4c** first.
3. Use `mcp__electron-chrome__*` tools to verify the change is visible and functional.

**Core engine changes** (`src/core/`):
1. Run `npx tsc --noEmit` to verify types compile.
2. If unit tests exist, run them.
3. If the change affects UI behavior, verify via `electron-chrome` MCP following section **4c**.

**IPC / Main process changes**:
1. Verify the Electron app starts without errors (check `~/.dex/dev-logs/electron.log`).
2. Test IPC round-trips via `mcp__electron-chrome__evaluate_script` calling `window.dexAPI.*` methods.

**Non-testable changes** (docs, config, build scripts): explicitly state why no runtime test is needed.

## 4e. Fix and repeat

If a test fails: fix the issue, then retest. Repeat until all DoD items pass. If you encounter a problem that you repeatedly cannot resolve, ask the user for help.

## 4f. Diagnostics — logs, state, audit DB, and the DEBUG badge

When something looks wrong, check these sources in order. They are listed from cheapest to most expensive, and each one answers a different class of question. **The fastest path from "something's wrong" to the right log file is: click the DEBUG badge (4f.6) → copy the `RunID` and `PhaseTraceID` → open `~/.dex/logs/<project>/<RunID>/phase-<N>_<slug>/agent.log`.**

### 4f.1 Process logs — `~/.dex/dev-logs/`

`dev-setup.sh` truncates both files on every restart, so they always reflect the current session. Read them with the `Read` tool (don't `tail -f` — they're static snapshots).

| File | Source | Contains |
|---|---|---|
| `~/.dex/dev-logs/vite.log` | Vite dev server | Bundler output, HMR events, build errors, the `ready in …` banner and `Local: http://localhost:5500/` line |
| `~/.dex/dev-logs/electron.log` | Electron main process stdout/stderr | `DevTools listening on ws://127.0.0.1:9333/...`, unhandled errors, IPC handler throws, `console.*` from anything in `src/main/`, orchestrator stdout |

**What to look for:**

- **App won't load** → `vite.log` for a build error, then `electron.log` for a "Failed to load URL" line.
- **IPC call returns undefined / throws** → `electron.log`, grep for the handler name (e.g. `project:open-path`) or the error class.
- **Orchestrator crashes mid-run** → cross-reference `electron.log` and the per-run log tree in 4f.2.
- **Renderer-side errors** (React render exceptions, unhandled promises in the UI) — these do **not** appear in `electron.log`. Use the DevTools console via MCP: `mcp__electron-chrome__list_console_messages`.

### 4f.2 Per-run orchestrator logs — `~/.dex/logs/<project>/<run-id>/`

This is the **authoritative log tree for anything the orchestrator does**. Structured per run, per phase, and per subagent — exactly the granularity you need when debugging a specific agent's behavior. Persisted forever (no truncation on restart).

```
~/.dex/logs/<project-name>/<run-id>/
├── run.log                              — run-level lifecycle (prerequisites, branch creation, stage transitions, termination)
└── phase-<N>_<slug>/                    — one dir per phase the orchestrator opened
    ├── agent.log                        — everything the main agent of this phase did (events, tool calls, SDK stream)
    └── subagents/
        └── <subagent-id>.log            — one file per spawned subagent, raw SDK input + lifecycle
```

Every line is `[<ISO-timestamp>] [<LEVEL>] <message> <optional JSON>`:

```
[2026-04-16T20:38:42.431Z] [INFO] run: starting orchestrator {"mode":"loop","model":"claude-opus-4-6",...}
[2026-04-16T20:38:42.580Z] [INFO] runLoop: created branch con/2026-04-16-3b084c from main
```

**How to find the right file from an ID:**

| You have… | Path |
|---|---|
| `runId` | `~/.dex/logs/<project>/<runId>/run.log` — run-level events only |
| `runId` + phase number | `~/.dex/logs/<project>/<runId>/phase-<N>_*/agent.log` — the main agent for that phase |
| `phaseTraceId` | grep `run.log` for the ID to find its phase number, then open `phase-<N>_*/agent.log`. `phaseTraceId` is logged at phase start. |
| `subagentId` | `~/.dex/logs/<project>/<runId>/phase-*/subagents/<subagentId>.log` — glob across phases if you don't know which one spawned it |

**How to get a `runId` / `phaseTraceId` in the first place:**

- From the running app — click the **DEBUG badge** (4f.6); both IDs are in the payload.
- From the on-disk audit JSON (4f.4) — `ls -t <projectDir>/.dex/runs/*.json | head -1` for the latest run; `jq '.phases[].phaseTraceId' <projectDir>/.dex/runs/<runId>.json` for its phases.
- From the orchestrator event stream — every event carries `runId` / `phaseTraceId`.

**`~/.dex/logs/_orchestrator.log`** — fallback log written when the orchestrator is in a pre-run state and no run directory exists yet. Rarely interesting; consult only if startup dies before a run directory is created. The underscore prefix keeps it sorted above the per-project run directories inside `~/.dex/logs/`.

### 4f.3 Per-project state — `<projectDir>/.dex/`

Each project gets its own state directory. For the example project that's `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/`. After a reset (section 4c.1), this directory is gone; the loop recreates it on start.

| File | Contains |
|---|---|
| `.dex/state.json` | Primary filesystem state — current cycle, stage, branch, pending clarification, active feature |
| `.dex/state.lock` | PID file guarding against concurrent orchestrator processes on the same project. Gitignored. |
| `.dex/feature-manifest.json` | Feature manifest produced by the structured-outputs flow |
| `.dex/learnings.md` | Accumulated per-project insights from the loop's learnings phase |
| `.dex/runs/<runId>.json` | One file per Dex run — full audit summary (phases, subagents, costs). See § 4f.4. Default-not-gitignored; opt in to ignoring per-project. |

`cat` / `jq` the JSON files to answer "what cycle is the loop on?", "what branch did the orchestrator cut?", "which feature is in progress?". Everything in this directory except `state.lock` is committable.

### 4f.4 Audit trail — per-project JSON files

Retired SQLite in 007-sqlite-removal. Audit data now lives **per project** at `<projectDir>/.dex/runs/<runId>.json` — one file per run. Tool-call-level detail is in `~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl` (one JSON object per line).

Schema (see `specs/007-sqlite-removal/contracts/json-schemas.md` for the authoritative shape):

| File | Contains |
|---|---|
| `<projectDir>/.dex/runs/<runId>.json` | One full `RunRecord` — mode, status, total cost, duration, all phases (each with subagents, costs, timings, status). |
| `~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl` | Append-only stream of `StepRecord`s for that phase — one JSON object per line. |

**From the agent** — prefer the IPC helpers; they return typed records:

- `window.dexAPI.listRuns(projectDir, 10)` — recent runs for one project
- `window.dexAPI.getRun(projectDir, runId)` — full `RunRecord` (phases inline)
- `window.dexAPI.getPhaseSteps(projectDir, runId, phaseTraceId)` — steps for one phase (parsed from `steps.jsonl`)
- `window.dexAPI.getPhaseSubagents(projectDir, runId, phaseTraceId)` — subagents of one phase

Invoke via `mcp__electron-chrome__evaluate_script`:

```js
async () => await window.dexAPI.listRuns("/abs/path/to/project", 5)
```

**Plain-shell fallback** (when the app isn't running):

```bash
# Latest run
ls -t <projectDir>/.dex/runs/*.json | head -1 | xargs cat | jq

# Just the cost / status / phase count
cat <projectDir>/.dex/runs/<runId>.json | jq '{mode, status, totalCostUsd, phases: .phases | length}'

# Steps for one phase
jq -c '.' ~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl | head
```

Cycle-level summaries (`loop_cycles` in the old SQL world) are derivable from `phases[]` grouped by `cycleNumber` — the renderer computes them via `runs.cycleSummary(run)`.

The JSON files and the per-run log tree in 4f.2 share the same IDs — `runId`, `phaseTraceId`, `subagent.id`. Use the JSON to *find* an ID, then open the corresponding log file for the full event stream.

**Legacy `~/.dex/db/`** — removed on first launch post-007. If still present, that means the app hasn't run since the upgrade; it is safe to `rm -rf` manually.

### 4f.5 Renderer DevTools console

For errors that happen in the React app (render exceptions, unhandled rejections in hooks, etc.):

- `mcp__electron-chrome__list_console_messages` — all console output the page has emitted this session.
- `mcp__electron-chrome__get_console_message` — inspect a single entry.

This is the **only** place renderer errors surface — they are not in `~/.dex/dev-logs/electron.log` and not in the per-run orchestrator logs.

### 4f.6 The DEBUG badge in the UI

The UI exposes a one-click diagnostic snapshot. Look for a small badge labelled **`debug`** (bug icon) in:

- The **breadcrumb bar of the trace view** (top-right, next to any live run indicators).
- The **Loop Dashboard** header.

Clicking it copies the current debug context to the clipboard and briefly flips the label to `copied` (with a check icon) for 1.5 seconds.

The payload is plain text, formatted like:

```
Dex Debug Context
─────────────────
RunID:           <uuid>
PhaseTraceID:    <uuid>
Mode:            loop | build
Cycle:           <n>
Stage:           specify | plan | tasks | implement | ...
SpecDir:         <relative path>
Phase:           <number> - <name>
ProjectDir:      <absolute path>
View:            overview | tasks | trace | loop-dashboard | ...
IsRunning:       true | false
ViewHistory:     true | false
Timestamp:       <ISO-8601>
```

`RunID` and `PhaseTraceID` are the **primary keys** for both the SQLite audit tables (4f.4) and the per-run log directory (4f.2). This makes the badge the quickest way to pivot from "the UI is showing something weird" to "the exact log file that contains the answer".

**When to use it:**

- **Ask the user to click it and paste** when you need the exact orchestrator state mid-flight and don't want to interrupt the running app with IPC probes.
- **Don't read the clipboard yourself via MCP** — clipboard access is flaky under remote debugging. Every field in the payload is reachable programmatically via `window.dexAPI.getRunState()` or the orchestrator event stream if you need the data directly.

Treat the badge as the canonical "what is the app actually doing right now?" probe — before asking a clarifying question about state, check whether the DEBUG payload would answer it.
