---
description: "Step 4: Testing — define DoD, reset the example project, drive the app via electron-playwright MCP, fix and repeat until passing"
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

One Playwright MCP server is configured in `.mcp.json`. It attaches to the
running Electron app over CDP rather than launching its own browser, which is
why the server carries `--cdp-endpoint` and not `--isolated`:

| MCP Server | CDP Port | Target | Use For |
|---|---|---|---|
| `electron-playwright` | 9333 | Electron app | All UI changes (renderer pages, components, IPC-driven UI) |

The tools are `@playwright/mcp`'s, all prefixed `mcp__electron-playwright__`:

| Tool | Does |
|---|---|
| `browser_snapshot` | Accessibility snapshot — the source of the `ref=` handles every interaction needs. Prefer it over a screenshot. |
| `browser_find` | Search the snapshot for text and get back just the matching nodes plus their `ref`s — cheaper than a full snapshot when you only need one element. |
| `browser_click` | Click by `ref` |
| `browser_type` | Type into one element by `ref` |
| `browser_fill_form` | Fill several fields in one call — takes a `fields` array |
| `browser_evaluate` | Run `() => { … }` in the page (or `(element) => { … }` with a `ref`) |
| `browser_console_messages` | All console output; pass `all: true` for the whole session rather than since last navigation |
| `browser_take_screenshot` | Pixels, for visual confirmation only — you cannot act on a screenshot |
| `browser_navigate` | Navigate the attached page |
| `browser_tabs` | List / select / close tabs |

> Playwright MCP identifies elements by **`ref`** taken from a snapshot, not by
> `uid` and not by CSS selector. Snapshot (or `browser_find`) first, then act on
> the `ref` it returned — refs go stale after the page changes, so re-snapshot
> after anything that re-renders.

### Whose instance it is

If a `browser_*` call is denied because the instance on the CDP port was
started by the user: that instance is theirs. Do not touch it, and do not
restart the dev environment over it — ask the user for permission, and only
after an explicit yes run the `touch` command from the denial message.

**The no-touch rule covers every attach path, not just MCP tools.** A
`connectOverCDP` in your own script, a raw CDP request from `curl` — same
rule. The MCP gate cannot see inside a script, so before any script attaches
to a CDP port, run `python3 .claude/hooks/pw.py owns-port <port>` yourself:
exit 0 means proceed, exit 1 means the instance is the user's — ask.

The browser is placed on its own desktop space by the shared Playwright hooks
(`.claude/hooks/`) — never switch to it, focus it, or move it. Session-end
cleanup is a safety net, not a substitute for closing it yourself.

**A headed browser your own script launches goes through the launch script
too** — `.claude/hooks/playwright-launch.sh npx tsx <script>` — so its window
is born on the scratch space like every other agent browser. Never launch a
headed browser bare: macOS creates new windows on whatever space the user is
looking at. A headless browser needs no placement — run that script directly.

## 4c. Example project for end-to-end testing

For any test that exercises the full loop (welcome screen → loop start → autonomous run), drive the app against the **dex-ecommerce** example project.

| Field | Value |
|---|---|
| Parent path | `~/Projects/Github/lukaskellerstein` |
| Project name | `dex-ecommerce` |
| Full path | `~/Projects/Github/lukaskellerstein/dex-ecommerce` |

> `~` is a shell expansion. It works unquoted in the `bash` blocks below, but a
> value **typed into one of the app's inputs** is read by `fs.existsSync`, which
> treats `~` as a literal directory name. Expand it first —
> `echo $HOME/Projects/Github/lukaskellerstein` — and type the result.

### Step 1 — Reset the example project

Before every test run, restore `dex-ecommerce` to a known state. A single entry point — `scripts/reset-example-to.sh` — covers every reset shape via its mode argument. Pick the mode that matches what your test needs.

**When to use what:**

| You want to… | Use |
|---|---|
| Run the loop on a totally empty repo **including the remote** — `origin/main` rolled back to root commit, all branches deleted, force-pushed | `./scripts/reset-example-to.sh initial` |
| Run a fresh loop but **keep whatever `origin/main` already has** on GitHub; just clean up local clutter | `./scripts/reset-example-to.sh pristine` |
| Replay a test starting from a saved mid-loop point without re-running earlier stages | `./scripts/reset-example-to.sh <checkpoint-name>` |
| Discard local working-tree changes without touching commit history | `./scripts/reset-example-to.sh clean` |
| See what checkpoint replay points are available | `./scripts/reset-example-to.sh list` |

```bash
./scripts/reset-example-to.sh initial                # total nuke incl. origin/main → root commit + force-push
./scripts/reset-example-to.sh pristine               # resync local main to origin/main + prune local test branches
./scripts/reset-example-to.sh clean                  # wipe working tree on local main (history preserved)
./scripts/reset-example-to.sh <checkpoint-name>      # mint attempt-* branch from checkpoint/<name>
./scripts/reset-example-to.sh list                   # list all available checkpoint tags
```

#### Mode details

`initial` — **destructive on origin.** Resets `main` to the repo's root commit, deletes every other local branch, deletes every non-main branch on `origin`, and force-pushes `origin/main` back to root. Use when you genuinely want the GitHub-side state wiped, so a fresh run starts against a clean remote with no leftover history. Reach for this only when the scenario calls for a true blank slate; otherwise prefer `pristine`.

`pristine` — `git fetch origin → reset --hard origin/main → clean -fdx → delete dex/* / attempt-* / feature/* local branches → checkout main`. Strongest local-only reset — discards every local commit ahead of origin and every leftover test branch, then resyncs local main to whatever `origin/main` currently is. Does **not** rewrite origin.

`clean` — `git reset --hard HEAD → clean -fdx → checkout main`. Doesn't sync to origin; doesn't prune `dex/*` branches.

`<checkpoint-name>` — resolves to `checkpoint/<name>` (or pass the full ref if it already starts with `checkpoint/`). The script creates a fresh `attempt-<ts>` branch and restores the working tree to exactly that checkpoint's state, preserving gitignored files (`.env`, build output, editor state — `git clean -fd`, never `-fdx`). The app never creates `attempt-*` branches itself; on Resume it runs on whatever branch is checked out, so the run continues on this one.

**Checkpoint tags are fixture tags.** The app creates no tags and makes no stage commits. A `checkpoint/<name>` tag exists only because someone ran `scripts/promote-checkpoint.sh <project-dir> <name> [<sha>]`, which tags any commit (default `HEAD`). Under the mock agent every stage commits as `mock(<stage>): <entry>`, so a mock run gives you a commit per stage to tag:

```bash
git log --oneline --grep='^mock('                       # one commit per mock stage
./scripts/promote-checkpoint.sh ~/Projects/Github/lukaskellerstein/dex-ecommerce cycle-1-after-tasks <sha>
```

**Picking a checkpoint**:

- Your change only touches `implement` or `verify` → a tag at the entry's `tasks` commit (e.g. `cycle-N-after-tasks`).
- Your change touches `specify`, `clarify`, `plan`, or `tasks` → a tag at the commit after manifest extraction (e.g. `cycle-N-after-manifest-extraction`, or `after-manifest-extraction` for the first entry).
- Your change touches `prerequisites`, any `clarification_*`, `constitution`, `manifest_extraction`, or you're validating non-regression → use `clean` or `pristine` (or `initial` if origin needs wiping too).

A tag minted before 015 points at a pre-015 tree, whose `.dex/mock-config.json` may still use the `dex_loop` shape the mock loader now refuses. For a mock run, copy `fixtures/mock/new-project.json` over it, or mint a fresh tag from a current mock run (`specs/015-lean-core/quickstart.md` § 4).

**Grounded mock runs (016)**: every gate runs real sensor commands, also under the mock agent. The mock's sensors are `node .dex/fake/check.mjs <name>`, which exits with the next code in `.dex/fake/<name>`. Before a mock run, copy `fixtures/mock/grounded/fake-check.mjs` to `<project>/.dex/fake/check.mjs`, give `.dex/fake/` a `.gitignore` of `*`, and copy `fixtures/mock/grounded/policy.json` over `.dex/policy.json` — the steps are in `specs/016-grounded-loop/quickstart.md` § 2. Without them every fake sensor fails to start and no entry reaches done. `fixtures/mock/grounded/README.md` lists one fixture per unhappy path (stall, flaky check, frozen-test edit, test amendment, and others) with its expected end.

**Legacy fixtures**: `fixture/after-clarification` and `fixture/after-tasks` have been deleted — they're fully replaced by the `checkpoint/*` tags. Any references to `fixture/*` in older docs are obsolete.

After restoring a checkpoint, the welcome submit button reads **Open Existing** (because the folder exists) and the topbar's run button reads **Resume** while a run state exists and a queue entry is still open. Clicking **Resume** starts with `config.resume=true` — the orchestrator skips `prerequisites`, reuses the existing `runId`, and runs the picker again: the next stage comes from the project's files, with no repair step.

Sanity check — after reset, inspect the workspace:

```bash
cd ~/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
```

For `initial`, `ls -A` must show only the root commit's contents and `.git/`: `.dex/` (with `dex-config.json` and `mock-config.json`), `.gitignore` and `docs/`. The root commit has **no `GOAL.md`**. For `pristine` the tree matches `origin/main`, for `clean` the local `HEAD`, and for a checkpoint reset that checkpoint's commit.

**Branch hygiene**: each autonomous run of a new project leaves behind one `dex/YYYY-MM-DD-xxxxxx` branch; Dex itself creates no other branch. `attempt-*` branches come only from `reset-example-to.sh <checkpoint-name>`. Run `./scripts/prune-example-branches.sh` periodically — it deletes `dex/*` branches older than 7 days. `main`, `fixture/*` (if any linger), `lukas/*`, `checkpoint/*` (tags are immune), `attempt-*` (fixture remnants), and any pre-existing `capture/*` (legacy refs) are always preserved.

`reset-example-to.sh`, `prune-example-branches.sh`, and `promote-checkpoint.sh` are the **only authorized destructive paths** against `dex-ecommerce`. You do not need to ask before running them against `dex-ecommerce`. Never run them against any other repo.

### Step 2 — Ensure the dev server is running

Check `electron-playwright` MCP connectivity via `mcp__electron-playwright__browser_tabs` with `action: "list"` (or `curl -fs http://localhost:9333/json/version`). If it fails, `dev-setup.sh` is not running.

**You are authorized to start the dev server yourself.** Do not ask the user to run it. Run it in the background and continue:

```sh
bash ~/Projects/Github/lukaskellerstein/dex/dev-setup.sh    # run_in_background=true
```

Then poll `~/.dex/dev-logs/vite.log` and `~/.dex/dev-logs/electron.log` (truncated on every start) until you see `ready in` (Vite) and `DevTools listening on ws://127.0.0.1:9333` (Electron) — typically 5–15 seconds. After that, CDP is reachable and you can drive the app. **Never** background the script and immediately fire CDP commands; wait for the readiness lines.

The same authorization applies to **restarting** the dev server when it's already running but stale (e.g. main-process changes need a restart). Kill it and re-run.

If the server fails to start (port collision, Electron crash on boot), surface the relevant log lines and ask — don't loop on retries.

### Step 3 — Fill the welcome screen

The welcome screen inputs have stable `data-testid` attributes:

| Testid | Purpose |
|---|---|
| `welcome-path` | Parent path input |
| `welcome-name` | Project name input |
| `welcome-pick-folder` | Native folder-picker button (do not click — native dialog is opaque to MCP) |
| `welcome-submit` | Dynamic submit button (label toggles `New` / `Open Existing` based on `fs.existsSync(path/name)`) |

Fill and submit:

1. `mcp__electron-playwright__browser_snapshot` to resolve the `ref` for each input.
2. `mcp__electron-playwright__browser_fill_form` with both fields in one call — `welcome-path` set to the **expanded** parent path (`echo $HOME/Projects/Github/lukaskellerstein`; the input does not expand `~`), `welcome-name` set to `dex-ecommerce`.
3. Re-snapshot — the submit button label should now read `Open Existing` (because the folder exists after reset).
4. `mcp__electron-playwright__browser_click` on the `welcome-submit` ref.

### Step 4 — Start the autonomous loop

On the Autonomous Loop page:

1. `GOAL.md` is auto-detected when it is in the project root. After an `initial` reset it is not there (the root commit has none), so write one first.
2. Toggle **Automatic Clarification** on (the switch next to "Skip interactive Q&A — agent auto-selects recommended options based on the goal-file context").
3. Click **Start Autonomous Loop**.

From here the orchestrator takes over: it creates its own `dex/*` branch, runs clarification, constitution and manifest extraction (which writes `.dex/queue.json`), then works through the queue entry by entry. Observe via snapshots, screenshots, `~/.dex/dev-logs/*.log`, and the live trace view.

**Headless alternative for mock runs** — the same loop without the app: `node dist/core/cli.js run <projectDir>` (build with `npx tsc` first; `--once`, `--dry-run`, `--status`, `--agent mock|claude`). Exit code 0 means the queue is complete (or `--once` / `--dry-run` / `--status` finished), 1 a failed run, 2 a usage or queue / policy error, 3 a pause that needs a human. Use it for engine checks; anything about the UI still goes through the app over CDP.

## 4d. Test

**UI / Renderer changes** — use `electron-playwright` MCP (CDP port 9333):
1. Ensure `dev-setup.sh` is running.
2. For any flow that requires an open project, follow section **4c** first.
3. Use `mcp__electron-playwright__*` tools to verify the change is visible and functional.

**Core engine changes** (`src/core/`):
1. Run `npm run typecheck` to verify types compile — **not** a bare `npx tsc --noEmit`, which
   uses the build config and therefore skips both the renderer and every `*.test.ts`.
2. Run the project's tests: `npm test` (core via `node --test`, renderer via `vitest`, plus `check:size`).
3. If the change affects UI behavior, verify via `electron-playwright` MCP following section **4c**.

**IPC / Main process changes**:
1. Verify the Electron app starts without errors (check `~/.dex/dev-logs/electron.log`).
2. Test IPC round-trips via `mcp__electron-playwright__browser_evaluate` calling `window.dexAPI.*` methods.

**Every code change** — repo-wide lint / format / type check:

```bash
nvim-tools --json --all
```

Your change must not add findings, measured against the baseline you took in the
Understand step. How to read the output (including `gated-off`), and why this
never replaces `npm test`: [`machine-tools.md`](machine-tools.md).

**Non-testable changes** (docs, config, build scripts): explicitly state why no runtime test is needed.

## 4e. Fix and repeat

If a test fails: fix the issue, then retest. Repeat until all DoD items pass. If you encounter a problem that you repeatedly cannot resolve, ask the user for help.

## 4f. Diagnostics — logs, state, audit DB, and the DEBUG badge

When something looks wrong, check these sources in order. They are listed from cheapest to most expensive, and each one answers a different class of question. **The fastest path from "something's wrong" to the right log file is: click the DEBUG badge (4f.6) → copy the `RunID` and `AgentRunID` (the badge already prints the resolved `RunLog` / `PhaseLog` paths too) → open `~/.dex/logs/<project>/<RunID>/phase-<N>_<slug>/agent.log`.**

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
- **Renderer-side errors** (React render exceptions, unhandled promises in the UI) — these do **not** appear in `electron.log`. Use the DevTools console via MCP: `mcp__electron-playwright__browser_console_messages`.

### 4f.2 Per-run orchestrator logs — `~/.dex/logs/<project>/<run-id>/`

This is the **authoritative log tree for anything the orchestrator does**. Structured per run, per phase, and per subagent — exactly the granularity you need when debugging a specific agent's behavior. Persisted forever (no truncation on restart).

```text
~/.dex/logs/<project-name>/<run-id>/
├── run.log                              — run-level lifecycle (prerequisites, branch creation, stage transitions, termination)
└── phase-<N>_<slug>/                    — one dir per phase the orchestrator opened
    ├── agent.log                        — everything the main agent of this phase did (events, tool calls, SDK stream)
    └── subagents/
        └── <subagent-id>.log            — one file per spawned subagent, raw SDK input + lifecycle
```

Every line is `[<ISO-timestamp>] [<LEVEL>] <message> <optional JSON>`:

```text
[2026-04-16T20:38:42.431Z] [INFO] run: starting orchestrator {"mode":"loop","model":"claude-opus-4-6",...}
[2026-04-16T20:38:42.580Z] [INFO] runLoop: created branch con/2026-04-16-3b084c from main
```

**How to find the right file from an ID:**

| You have… | Path |
|---|---|
| `runId` | `~/.dex/logs/<project>/<runId>/run.log` — run-level events only |
| `runId` + phase number | `~/.dex/logs/<project>/<runId>/phase-<N>_*/agent.log` — the main agent for that phase (on-disk dirs are still `phase-<N>_*` for backward-compat) |
| `agentRunId` | grep `run.log` for the ID to find its phase number, then open `phase-<N>_*/agent.log`. `agentRunId` is logged at agent-run start. |
| `subagentId` | `~/.dex/logs/<project>/<runId>/phase-*/subagents/<subagentId>.log` — glob across phases if you don't know which one spawned it |

**How to get a `runId` / `agentRunId` in the first place:**

- From the running app — click the **DEBUG badge** (4f.6); both IDs are in the payload, alongside the resolved `RunLog` and `PhaseLog` paths.
- From the on-disk audit JSON (4f.4) — `ls -t <projectDir>/.dex/runs/*.json | head -1` for the latest run; `jq '.agentRuns[].agentRunId' <projectDir>/.dex/runs/<runId>.json` for its agent runs.
- From the orchestrator event stream — every event carries `runId` / `agentRunId`.

**`~/.dex/logs/_orchestrator.log`** — fallback log written when the orchestrator is in a pre-run state and no run directory exists yet. Rarely interesting; consult only if startup dies before a run directory is created. The underscore prefix keeps it sorted above the per-project run directories inside `~/.dex/logs/`.

### 4f.3 Per-project state — `<projectDir>/.dex/`

Each project gets its own state directory. For the example project that's `~/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/`. After an `initial`, `pristine` or `clean` reset (section 4c.1, `git clean -fdx`), only its tracked files stay — on the root commit `dex-config.json` and `mock-config.json`. The loop recreates the run state on start.

| File | Contains |
|---|---|
| `.dex/queue.json` | The feature queue (v3) — one entry per feature, written by manifest extraction, by hand, or drafted by `dex queue init`. Tracked. |
| `.dex/policy.json` | The project's policy — settings sources, `deny` / `ask` rules, write roots, frozen files, preflight, question mode, limits. Tracked. |
| `.dex/.gitignore` | Keeps the runtime files below out of git. Tracked. |
| `.dex/state.json` | Runtime run state — only what the files cannot say: run id, status and pause reason, `runBranch`, the last stage run (`current`), cost, counters, pending requests, the review list. Gitignored. |
| `.dex/questions.md` | Runtime — pending questions and tool approvals as plain text, plus the questions answered by default for review. Gitignored. |
| `.dex/state.lock` | PID file guarding against concurrent orchestrator processes on the same project. Gitignored. |
| `.dex/runs/<runId>.json` | One file per Dex run — full audit summary (phases, subagents, costs). See § 4f.4. Gitignored. |
| `.dex/evidence/<id>/<stage>-<n>.json` | One gate record per stage run of an entry (016): `tests-1`, `red-first-1`, `baseline-<n>`, `implement-<n>`, `verify-<n>` — the sensor runs, their tails, the gate's outcome and reason, the plan and test changes. Gitignored. |
| `.dex/evidence/<id>/done.json` | The done gate's record (replaces 015's `verify.json`): the acceptance runs, the verifier's mode, findings or hypotheses, and `gate: "passed"` or `"failed"`. The picker reads it to decide if the entry is done. Gitignored. |
| `.dex/evidence/<id>/amendments.json` | Test amendments the implementer asked for, each `approved`, `rejected` or `applied`. Gitignored. |
| `.dex/evidence/<id>/progress.md` | The attempt log: one section per agent stage (agent summary, notes, gate, first failing line). The next prompt gets its newest 8,000 characters; it moves to `archive/` when the done gate passes. Gitignored. |
| `.dex/digests/<id>.md` | The one-page digest of an entry, written at every pause and at done; `dex digest <projectDir> <id>` prints it. The folder carries its own `.gitignore` (`*`). |
| `<specDir>/acceptance.json` | The acceptance command and the frozen test files, written by the `tests` stage. Tracked, and frozen for implement and verify. |

`cat` / `jq` the JSON files to answer "what did the run last do?", "which branch is the run on?", "what is waiting for a human?". Which stage runs next is not stored anywhere: ask the picker with `node dist/core/cli.js run <projectDir> --status`, which writes nothing. A project that still has the old `.dex/feature-manifest.json` is migrated to `queue.json` when Dex loads it.

### 4f.4 Audit trail — per-project JSON files

Retired SQLite in 007-sqlite-removal. Audit data now lives **per project** at `<projectDir>/.dex/runs/<runId>.json` — one file per run. Tool-call-level detail is in `~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl` (one JSON object per line).

Schema (see `specs/007-sqlite-removal/contracts/json-schemas.md` for the authoritative shape):

| File | Contains |
|---|---|
| `<projectDir>/.dex/runs/<runId>.json` | One full `RunRecord` — mode, status, total cost, duration, all phases (each with subagents, costs, timings, status). |
| `~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl` | Append-only stream of `StepRecord`s for that phase — one JSON object per line. |

**From the agent** — prefer the IPC helpers; they return typed records:

- `window.dexAPI.getLatestProjectRun(projectDir)` — latest `RunRecord` for one project (use this instead of the retired `listRuns`)
- `window.dexAPI.getRun(projectDir, runId)` — full `RunRecord` (agent runs inline)
- `window.dexAPI.getAgentSteps(projectDir, runId, agentRunId)` — steps for one agent run (parsed from `steps.jsonl`)
- `window.dexAPI.getAgentRunSubagents(projectDir, runId, agentRunId)` — subagents of one agent run
- `window.dexAPI.getSpecAgentRuns(projectDir, specDir)` / `getSpecAggregateStats(projectDir, specDir)` — spec-folder roll-ups

Invoke via `mcp__electron-playwright__browser_evaluate` — the `function` parameter takes the arrow function itself:

```js
async () => await window.dexAPI.getLatestProjectRun("/abs/path/to/project")
```

**Plain-shell fallback** (when the app isn't running):

```bash
# Latest run
ls -t <projectDir>/.dex/runs/*.json | head -1 | xargs cat | jq

# Just the cost / status / agent-run count
cat <projectDir>/.dex/runs/<runId>.json | jq '{mode, status, totalCostUsd, agentRuns: .agentRuns | length}'

# Steps for one agent run
jq -c '.' ~/.dex/logs/<project>/<runId>/phase-<N>_*/steps.jsonl | head
```

Cycle-level summaries (`loop_cycles` in the old SQL world) are derivable from `agentRuns[]` grouped by `cycleNumber` — the renderer computes them via `runs.cycleSummary(run)`.

The JSON files and the per-run log tree in 4f.2 share the same IDs — `runId`, `agentRunId`, `subagent.id`. Use the JSON to *find* an ID, then open the corresponding log file for the full event stream.

**Legacy `~/.dex/db/`** — removed on first launch post-007. If still present, that means the app hasn't run since the upgrade; it is safe to `rm -rf` manually.

### 4f.5 Renderer DevTools console

For errors that happen in the React app (render exceptions, unhandled rejections in hooks, etc.):

- `mcp__electron-playwright__browser_console_messages` — console output. It returns messages since the last navigation by default; pass `all: true` for everything since the session started, and `level` to filter by severity.

This is the **only** place renderer errors surface — they are not in `~/.dex/dev-logs/electron.log` and not in the per-run orchestrator logs.

### 4f.6 The DEBUG badge in the UI

The UI exposes a one-click diagnostic snapshot. Look for a small badge labelled **`debug`** (bug icon) in:

- The **breadcrumb bar of the trace view** (top-right, next to any live run indicators).
- The **Loop Dashboard** header.

Clicking it copies the current debug context to the clipboard and briefly flips the label to `copied` (with a check icon) for 1.5 seconds.

The payload is plain text, formatted like:

```text
Dex Debug Context
─────────────────
RunID:           <uuid>
AgentRunID:      <uuid>
Mode:            loop | build
Cycle:           <n>
Stage:           specify | clarify | plan | tasks | implement | verify | ...
SpecDir:         <relative path>
TaskPhase:       <number> - <name>
ProjectDir:      <absolute path>
View:            overview | tasks | trace | loop-dashboard | ...
IsRunning:       true | false
ViewHistory:     true | false
RunDir:          ~/.dex/logs/<project>/<runId>/
RunLog:          ~/.dex/logs/<project>/<runId>/run.log
PhaseLog:        ~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/agent.log
RunRecord:       <projectDir>/.dex/runs/<runId>.json
Timestamp:       <ISO-8601>
```

Those are all the fields (`buildDebugPayload` in `src/renderer/App.tsx`). The payload carries no git branch: run `git branch --show-current` in the project, or read `runBranch` from `.dex/state.json`. Empty / null fields are omitted from the payload (e.g. `AgentRunID` is missing pre-run, the `RunDir`/`RunLog`/`RunRecord` block only appears once a `runId` exists, and `PhaseLog` only once a task phase is known). Field labels follow the post-rename vocabulary (`AgentRunID` is the renamed `phaseTraceId`; `TaskPhase` is the user-facing name for what the loop calls a "phase").

`RunID` and `AgentRunID` are the **primary keys** for both the JSON audit files (4f.4) and the per-run log directory (4f.2). This makes the badge the quickest way to pivot from "the UI is showing something weird" to "the exact log file that contains the answer" — and the resolved `RunLog` / `PhaseLog` / `RunRecord` lines mean you usually do not even need to assemble the path yourself.

**When to use it:**

- **Ask the user to click it and paste** when you need the exact orchestrator state mid-flight and don't want to interrupt the running app with IPC probes.
- **Don't read the clipboard yourself via MCP** — clipboard access is flaky under remote debugging. Every field in the payload is reachable programmatically via `window.dexAPI.getRunState()` or the orchestrator event stream if you need the data directly.

Treat the badge as the canonical "what is the app actually doing right now?" probe — before asking a clarifying question about state, check whether the DEBUG payload would answer it.
