# Test: implement and merge the first two Eshopy features

End-to-end test of the autonomous loop on a clean slate. Two specs are implemented back-to-back, each followed by an in-app merge to `main`.

**Target project:** `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`

**Follow `.claude/rules/06-testing.md`** for the standard test mechanics — dev server startup, welcome screen flow, autonomous-loop kickoff, log/state diagnostics. This file specifies only what is unique to this scenario.

## Configuration

| Param | Default | Override |
|---|---|---|
| Agent backend | `mock` | reply with `agent: claude` (or any other supported backend, e.g. `codex`, `copilot` once landed) |

The agent backend is controlled by `<projectDir>/.dex/dex-config.json` (`{ "agent": "<name>" }`). Because every reset mode wipes gitignored files (`git clean -fdx`), `.dex/dex-config.json` does **not** survive a reset — the executing agent must seed it after reset.

Before kicking off the run, the executing agent **must**:

1. **Confirm the agent choice with the user** — mention the default (`mock`) and accept any override the user provides. Skip this confirmation only if the user has already specified an agent in the prompt that started the test.
2. **Seed `<projectDir>/.dex/dex-config.json`** with the chosen backend. Minimal valid contents: `{ "agent": "mock" }` or `{ "agent": "claude" }`.
3. **Do not pre-seed `mock-config.json`** — if mock is chosen, let the mock runner use whatever default behavior it has when no scripted config is present.

## Definition of Done

- [ ] Agent backend is confirmed with the user and `<projectDir>/.dex/dex-config.json` is seeded accordingly before the run starts.
- [ ] `dex-ecommerce` is reset to the repo's initial commit on both local and `origin` before the test starts.
- [ ] Spec **001-Initialization** is implemented end-to-end by the autonomous loop. Run reaches a terminal stage with status `succeeded` and produces a `dex/<date>-<id>` branch.
- [ ] The `dex/*` branch from spec 001 is merged into `main` **via the in-app merge UI** (not a terminal `git merge`).
- [ ] Spec **002-improvements-1** is implemented end-to-end by the autonomous loop, layered on the post-merge `main` from the previous step. Run completes successfully and produces its own `dex/*` branch.
- [ ] The `dex/*` branch from spec 002 is merged into `main` via the in-app merge UI.
- [ ] After both merges, `main` contains the implementation of both specs, with no orphaned working-tree changes and no unresolved conflicts.

## Pass / Fail criteria

- **PASS** — every Definition-of-Done item above is satisfied AND no failure mode called out in the Steps section was observed.
- **FAIL** — any DoD item is unsatisfied, OR any failure mode triggered, OR execution was aborted before all steps completed.

The Reporting section below MUST conclude with an explicit `PASS` or `FAIL` verdict on its own line. Do not omit the verdict, even if the run ended early — in that case report `FAIL` and explain where it stopped.

## Reset

Use the `initial` mode — this scenario needs a fully clean slate including `origin`:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex
./scripts/reset-example-to.sh initial
```

After this runs, `dex-ecommerce/main` is at its root commit, and no other branches exist locally or on the GitHub remote. See `06-testing.md` § 4c Step 1 for the full decision table on which reset mode to use.

Sanity check:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
```

`ls` should show only `GOAL.md` (plus whatever else is in the root commit) and `.git/`. Note: `.dex/` is gone — that's expected, it gets seeded next.

## Configure the agent backend

Per the **Configuration** block above:

1. Confirm the agent choice with the user (default `mock`; accept overrides like `agent: claude`).
2. Write the chosen value into `<projectDir>/.dex/dex-config.json`:

   ```bash
   mkdir -p /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex
   echo '{ "agent": "<chosen>" }' > /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
   ```

3. Move on to step 1.

## Steps

### 1. Implement spec 001-Initialization

Spec to implement: `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/docs/my-specs/001-Initialization/README.md`

Drive the app per `06-testing.md` § 4c — ensure the dev server is up, fill the welcome screen for `dex-ecommerce` and click **Open Existing**, then on the Autonomous Loop page toggle **Automatic Clarification** on and click **Start Autonomous Loop**.

The orchestrator picks up `GOAL.md` and the spec from `docs/my-specs/001-Initialization/`. Observe the run via UI snapshots, `~/.dex/dev-logs/electron.log`, the per-run log tree at `~/.dex/logs/dex-ecommerce/<runId>/`, and the live trace view.

Wait for the loop to reach a terminal stage. Confirm via the DEBUG badge (06-testing.md § 4f.6) or `<projectDir>/.dex/runs/<runId>.json` that `status` is `succeeded`.

### 2. Merge spec 001's branch to main — via the UI

Use the **in-app merge flow** added in `014-branch-management`. Do **not** run `git merge` from a terminal — the point of this step is to exercise the UI path.

Find the merge action in the running app (Branch Management page or wherever the merge affordance is surfaced for the active `dex/*` branch), select the `dex/*` branch produced by step 1, and merge it into `main`.

Confirm:

- The merge succeeds (or, if conflicts arise, the in-app conflict resolver handles them).
- After the merge, `main` contains the spec 001 implementation.
- No stuck merge state (`git status` shows a clean tree on `main`).

### 3. Implement spec 002-improvements-1

Spec to implement: `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/docs/my-specs/002-improvements-1/README.md`

Spec 002 extends spec 001 (it explicitly references the Eshopy v1 schema). **Do not reset between features** — the loop must run on top of the post-merge `main` from step 2.

Kick off the autonomous loop again (same procedure as step 1). The orchestrator should cut a fresh `dex/*` branch from the now-updated `main`, so spec 001's code is available as a starting point.

Wait for the loop to finish; confirm `status` is `succeeded`.

### 4. Merge spec 002's branch to main — via the UI

Same as step 2, but for the `dex/*` branch produced by step 3.

Confirm:

- The merge succeeds via the in-app UI.
- `main` now contains both specs' implementations.
- No leftover unresolved conflicts and no orphaned working-tree changes.

## Reporting

For each step, capture:

- Run id, branch name, terminal stage, run status.
- Any failures, retries, or surprising behaviour observed (with log paths).
- Confirmation that the DoD item for that step is satisfied.

At the end, report which DoD items pass and which (if any) fail, with pointers to the specific log files or UI screenshots that support each claim. Conclude with an explicit `PASS` or `FAIL` verdict on its own line, per the Pass / Fail criteria above.
