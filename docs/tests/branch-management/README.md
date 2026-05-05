# Branch Management — Test Scenario Catalog (014)

**Feature**: `specs/014-branch-management/`
**Audience**: a developer or testing agent who wants to verify the entire 014 feature surface end-to-end through the running app, repeatedly and deterministically.

This catalog covers every functional path in the 014 feature: delete, clean-merge promote, AI conflict resolution, and the failure-escape modal. Each scenario specifies its **start state**, the **actions** to drive, the **final state** (both observable in the UI and verifiable via `git`), and **what the testing agent should see on screen**.

## Test target — the `dex-ecommerce` repo

> **Hard rule**: every scenario must start from a pristine `dex-ecommerce` repo synced to `origin/main`. Run `bash scripts/reset-example-to.sh pristine` before each scenario unless the scenario explicitly asks otherwise.

| | |
|---|---|
| **Filesystem path** | `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` |
| **GitHub URL** | <https://github.com/lukaskellerstein/dex-ecommerce> |
| **Canonical "starting state"** | `origin/main` HEAD, no local commits ahead, no `dex/*` / `selected-*` / `attempt-*` / `feature/*` branches, working tree clean (gitignored files wiped via `-fdx`). |
| **Reset command** | `bash scripts/reset-example-to.sh pristine` (014 mode — fetches origin, resets to `origin/main`, prunes test branches). |

### Why pristine, not just `clean`

The legacy `clean` mode of `reset-example-to.sh` does `git reset --hard HEAD` + `git clean -fdx` + `git checkout main` — but it **does not sync local main to `origin/main`**. After running 014 scenarios, local main accumulates commits (test fixtures, AI-resolved merges) and `dex/*`/`selected-*`/`attempt-*` test branches pile up. Without resetting to origin/main between scenarios, you'd be testing against drift, not against the canonical starting point.

The `pristine` mode (added in this catalog) does:

```sh
git fetch -q origin
git merge --abort 2>/dev/null || true            # in case a previous test left a half-merge
git checkout -q main
git reset --hard origin/main                      # discard ALL local commits ahead of origin
git clean -fdx                                    # wipe everything including gitignored
# Then delete every dex/* / selected-* / attempt-* / feature/* branch left over from tests.
```

This is the **only authorized destructive operation** against `dex-ecommerce` per `.claude/rules/06-testing.md` § 4c.1, alongside `prune-example-branches.sh` and `promote-checkpoint.sh`.

### Verifying the starting state

After `bash scripts/reset-example-to.sh pristine`, every scenario can rely on:

```sh
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git rev-parse --abbrev-ref HEAD                   # → "main"
git rev-list --count origin/main..main            # → 0
git status --short                                # → empty
git branch --list 'dex/*' 'selected-*' 'attempt-*' 'feature/*'  # → empty
```

If any of these fails, the scenario's preconditions are wrong and the test must be aborted, not bent to fit the drift.

## Layout

```text
docs/tests/branch-management/
├── README.md                    ← this file (run conventions, tooling, glossary)
├── fixtures.md                  ← reusable git fixture-staging recipes (referenced by scenarios)
├── us1-delete.md                ← Scenarios 1A–1J — Remove a saved version
├── us2-promote-clean.md         ← Scenarios 2A–2Q — Promote (clean merge)
├── us3-conflict-resolution.md   ← Scenarios 3A–3J — AI conflict resolution
├── us4-failure-escape.md        ← Scenarios 4A–4H — Failure-modal escape paths
├── cross-cutting.md             ← Scenarios 5A–5D — copy hygiene, build gate, IPC routing
└── screenshots/                 ← target directory for visual catalogue (filled during runs)
```

## How to use this catalog

Each scenario is a self-contained recipe. Pick the scenario you want, work through it linearly. Every scenario lists:

1. **Goal** — one sentence: what behaviour is being verified.
2. **Maps to** — the spec FR / acceptance scenario / DoD recipe references.
3. **Pre-flight** — what must be true *before* you start (fixture name, app state, dex-config).
4. **Actions** — exact CDP/MCP/git commands in the order they should run.
5. **Expected final state** — git-side and UI-side, with concrete assertions.
6. **Visual cues** — what the testing agent should see on the screen at each step (modal title, button labels, toast text).
7. **Common failures** — known ways this scenario can fail and how to diagnose them.

Most scenarios complete in under 60 seconds end-to-end. Scenarios that exercise the live AI resolver (US3 happy-path, US4 max-iterations) take longer (10–60s) and incur a small Claude API charge per run (typically $0.05–$0.20 with the Sonnet model).

## Tooling

### CDP driver — `scripts/test-014-cdp.mjs`

A standalone Node script that drives the running Electron renderer through Chrome DevTools Protocol on port 9333. **Use this instead of the MCP `electron-chrome` server**: the driver is more deterministic, reconnects cleanly, and survives Electron restarts.

Subcommands:

| Subcommand | Purpose |
|---|---|
| `open` | Click the welcome screen submit button → wait for project to load → return badges + delete-control testids. |
| `snap` | Return a JSON snapshot of every `data-testid` on the page (badges, delete controls, modals, context menus, alerts, toasts). |
| `eval <expr>` | Evaluate a JS body inside an async wrapper. Caller must `return` the result. |
| `click <testid>` | Synthetic `click` event on the element with that testid. |
| `rclick <testid>` | Synthetic `contextmenu` on the badge's `<rect>` child (where the React handler lives). |
| `modal <testid>` | Return text + html snippet of the element. |
| `wait <testid> [ms] [--gone]` | Poll for an element to appear (or, with `--gone`, disappear). Returns `{ ok, elapsed }`. |
| `reload` | Trigger `location.reload()` in the renderer (does NOT restart the main process — code changes there require a full `dev-setup.sh` restart). |

All output is single-line JSON on stdout. Exit codes: 0 on success, 1 on eval error, 2 on unknown subcommand.

### Reset script — `scripts/reset-example-to.sh`

Restores `dex-ecommerce` to a known checkpoint. Used at the start of any scenario that needs a fresh state. Modes: `clean`, `list`, `<checkpoint-name>`. The `clean` mode is destructive — it `git reset --hard HEAD` + `git clean -fdx` + `git checkout main` on the example project. **Only authorized against `dex-ecommerce`.**

### Conflict-staging fixtures — `fixtures.md`

For scenarios that need a contrived git state (a branch with a unique commit, a content-conflicting branch, a binary-file conflict, etc.), the fixture-staging shell snippets live in `fixtures.md` so each scenario can reference them by name without duplicating the setup. Every fixture is idempotent: running it twice on a clean repo produces the same final state.

### Pre-flight checklist (every scenario starts with this)

Before any scenario:

1. **Dev server running**: `~/.dex/dev-logs/electron.log` recent + `curl -fs http://localhost:9333/json/version` returns 200. If not, restart with `bash dev-setup.sh`.
2. **Test repo at PRISTINE state** (canonical start — this is non-negotiable):

   ```sh
   bash scripts/reset-example-to.sh pristine
   ```

   This re-syncs `dex-ecommerce` to `origin/main` (<https://github.com/lukaskellerstein/dex-ecommerce>), wipes the working tree, and prunes every test-fixture branch.

3. **Verify the pristine state took effect** — run the four assertions from the "Verifying the starting state" subsection above. If any fails, abort and re-run pristine.

4. **Apply the scenario's fixture** (if any). Each scenario's "Pre-flight" section names the fixture from `fixtures.md` to apply on top of the pristine state. Fixtures are designed to be applied to a freshly-pristine repo and are idempotent — running the same fixture twice in a row produces the same end state.

5. **Resolver config present**: `cat dex-ecommerce/.dex/dex-config.json` shows whatever resolver settings the scenario calls for. The fixtures `[run cleanup helper]` block (in `fixtures.md`) re-writes this to the catalog default after every scenario:

   ```json
   {
     "agent": "claude",
     "conflictResolver": {
       "model": "claude-sonnet-4-6",
       "maxIterations": 5,
       "maxTurnsPerIteration": 10,
       "costCapUsd": 0.50,
       "verifyCommand": null
     }
   }
   ```

   Each scenario's "Pre-flight" section lists deviations from this default (US3-G uses `costCapUsd: 0.001`; US4-A uses `maxTurnsPerIteration: 1`; etc.).

### One-liner: full pre-flight reset

For an automated runner, the full pre-flight is:

```sh
bash /home/lukas/Projects/Github/lukaskellerstein/dex/scripts/reset-example-to.sh pristine \
  && cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce \
  && mkdir -p .dex \
  && cat > .dex/dex-config.json <<'EOF'
{
  "agent": "claude",
  "conflictResolver": {
    "model": "claude-sonnet-4-6",
    "maxIterations": 5,
    "maxTurnsPerIteration": 10,
    "costCapUsd": 0.50,
    "verifyCommand": null
  }
}
EOF
```

This block can be inlined at the start of every scenario's "Pre-flight" actions.

## Glossary

| Term | Meaning in the context of these tests |
|---|---|
| **Saved version** | The user-facing name for a branch the timeline shows. Internally a `dex/*` or `selected-*` branch. |
| **Primary version** | The user-facing name for `main` (or `master` when `main` is absent). |
| **Step-commit** | A commit whose subject matches `dex: <step> completed [cycle:N] [feature:slug]` and whose body contains a `[checkpoint:<step>:<cycle>]` trailer. The timeline only renders these — fixtures that need timeline-visible commits MUST use this format. |
| **Lost work** | Step-commits unique to a branch (not reachable from any other tracked `dex/*`/`selected-*`/`main`/`master`). The lost-work modal lists these by their plain-English label + 7-char SHA. |
| **Resolver** | The AI conflict-resolution harness in `src/core/conflict-resolver.ts`, invoked by `mergeToMain` when content conflicts are detected. Each iteration calls `runOneShot` once on a single file. |
| **Non-content conflict** | Rename/delete pairs, binary-file conflicts, both-added, both-deleted, and submodule conflicts. The resolver does NOT attempt these — `mergeToMain` aborts and returns `non_content_conflict` immediately. |

## Test-run reporting

Each scenario produces three artifacts in `screenshots/` when run by an automated agent:

1. **Pre-state snapshot** — git state + UI snapshot before the action (`<scenario>-pre.json`).
2. **Action transcript** — every command run, in order (`<scenario>-actions.txt`).
3. **Post-state snapshot** — git state + UI snapshot + any toast/error text (`<scenario>-post.json`).

Optionally, a screenshot of the final modal (`<scenario>.png`) via the agent's screenshot tool.

## Failure-mode glossary

When a scenario doesn't produce its expected final state, common root causes:

| Symptom | Likely cause |
|---|---|
| `MCP electron-chrome` tools return empty / disconnected | Electron main process crashed; restart `dev-setup.sh`. The CDP driver `scripts/test-014-cdp.mjs` is robust against this — prefer it. |
| `MaxListenersExceededWarning: 11 orchestrator:event listeners` in `electron.log` | Renderer hot-reloaded without unmounting cleanup; restart the renderer (`scripts/test-014-cdp.mjs reload`). Not fatal. |
| Resolver returns `agent_gave_up` even on simple conflicts | Most likely `error_max_turns` — the agent exhausted `maxTurnsPerIteration` before producing an Edit call. Bump that ceiling in `dex-config.json` (try 10–15) or switch to a more capable model. |
| Resolver returns `cost_cap` after one iteration | `costCapUsd` is too low; bump it (default 0.50 is reasonable for Sonnet single-file). |
| Resolver returns `verify_failed` | Configured verify command (`verifyCommand` in dex-config) returned non-zero. Either your conflict produced a syntactically invalid file, or the verify command itself has a bug. |
| `mergeToMain` returns `git_error: nothing to commit` | The two branches' content was actually identical at merge time — fixture was set up wrong. |

## Known limitations of the v1 implementation

These are NOT bugs to be fixed during a test run — they are documented behaviour:

- **No mid-resolver cancel signal**: clicking Cancel on `<ConflictResolverProgress>` calls `abortResolverMerge` *immediately* (resets the working tree), but the in-flight `runOneShot` call doesn't see an abort signal — it will continue running for up to `maxTurnsPerIteration` turns and the `mergeToMain` promise will eventually resolve with `resolver_failed`. This is acceptable behaviour for v1.
- **Single attempt per file**: each conflicted file gets exactly one `runOneShot` iteration. If the agent fails to produce a marker-free file in one iteration, the resolver halts the whole promotion with `max_iterations`. This is intentional in v1 — multi-attempt-per-file is a future enhancement.
- **Toast persistence**: success/error toasts persist on screen until dismissed by clicking the ✕ button. Tests that drive multiple flows in sequence MUST dismiss leftover toasts between scenarios, otherwise polling logic that watches for new toasts will see stale ones.
- **`acceptResolverResult` parses MERGE_MSG **after** the commit**: by the time the IPC reads it, `git commit` has consumed it. The handler falls back to parsing the just-created merge commit's subject. This works in normal flow but may fail if the merge commit subject was customised away from the `dex: promoted X to Y` template.
