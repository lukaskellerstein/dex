# Quickstart — 010 Interactive Timeline

End-to-end verification recipe for this feature. Runs the spec's DoD against the `dex-ecommerce` example project. Mirrors `.claude/rules/06-testing.md` section 4c.

## Prerequisites

- `dev-setup.sh` running (vite + electron). Confirm via `mcp__electron-chrome__list_pages`.
- `dex-ecommerce` example project at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce`.

## 0 — Reset to clean slate

```bash
./scripts/reset-example-to.sh clean
```

Verify the project tree contains only `GOAL.md` and `.git/`:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git status --short && ls
```

## 1 — Open the project

In the welcome screen (via `mcp__electron-chrome__*`):

1. `welcome-path` → `/home/lukas/Projects/Github/lukaskellerstein`
2. `welcome-name` → `dex-ecommerce`
3. Click `welcome-submit` (label: **Open Existing**).

## 2 — Seed three agent profiles

Before kicking off the run, create three profile folders the test will exercise:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce

mkdir -p .dex/agents/conservative/.claude
cat > .dex/agents/conservative/dex.json <<'EOF'
{
  "agentRunner": "claude-sdk",
  "model": "claude-opus-4-7",
  "systemPromptAppend": "Minimize change. Prefer the smallest diff that satisfies the requirement.",
  "allowedTools": ["Read", "Edit", "Write", "Grep", "Bash"]
}
EOF
cat > .dex/agents/conservative/.claude/CLAUDE.md <<'EOF'
# Conservative profile
- Avoid introducing new dependencies.
- Prefer existing helpers over new ones.
EOF

mkdir -p .dex/agents/standard
cat > .dex/agents/standard/dex.json <<'EOF'
{
  "agentRunner": "claude-sdk",
  "model": "claude-sonnet-4-6"
}
EOF

mkdir -p .dex/agents/innovative/.claude/agents
cat > .dex/agents/innovative/dex.json <<'EOF'
{
  "agentRunner": "claude-sdk",
  "model": "claude-haiku-4-5",
  "systemPromptAppend": "Use modern libraries and idioms. Refactor freely."
}
EOF
cat > .dex/agents/innovative/.claude/agents/code-reviewer.md <<'EOF'
---
name: code-reviewer
description: Review code for clarity and modern idioms before commit.
---
You are a strict code reviewer. Suggest clearer, more modern alternatives.
EOF
```

## 3 — Run the autonomous loop

In the Loop page:

1. `GOAL.md` is auto-detected — leave as is.
2. Toggle **Automatic Clarification** on.
3. Click **Start Autonomous Loop**.

Wait for the run to produce at least one full cycle (typically prerequisites → clarification → constitution → manifest_extraction → gap_analysis → specify → plan → tasks → implement → verify → learnings).

## 4 — Verify Timeline canvas

`mcp__electron-chrome__take_snapshot` on the Timeline tab. Confirm:

- One column per branch: `main` and `dex/<date>-<id>` (and any `attempt-*` columns if forks exist).
- Each step-commit renders a node with short SHA + stage label + cycle number visible without hover.
- Edges connect consecutive step-commits in the run column; a branch-off edge connects `main`'s tip (the starting point) to the run column's first commit.
- The right-side detail panel and the bottom past-attempts list are gone — the graph is full-width.
- Hover any node — the tooltip shows the full commit subject + timestamp.

## 5 — Click-to-jump (mid-branch fork)

Left-click a step-commit two stages back. Confirm:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git branch | grep attempt-
```

A new `attempt-<ts>` branch exists. The Timeline now has an additional column for it. The Steps tab redraws — fewer rows are `done`; no `pause-pending` indicator.

## 6 — Click-to-jump (branch tip checkout)

Left-click the tip of `main`. Confirm:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git rev-parse --abbrev-ref HEAD
```

Returns `main`. No new branch was created. Steps shows every stage as `pending`. The macro-stepper shows the pipeline as not yet started.

## 7 — Dirty-tree refusal

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && echo "dirty" >> README.md
```

In the Timeline, click any non-HEAD step-commit. Confirm `<GoBackConfirm>` modal opens with the dirty file listed. Click **Save** → confirm the modal closes, the dirty change is preserved on a new `attempt-<ts>-saved` branch, and the original click target is checked out. Click **Discard** instead → confirm the file's change is reverted.

Reset the dirty change before continuing:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git restore README.md
```

## 8 — Right-click → Keep this

`mcp__electron-chrome__click` with `button: "right"` on any step-commit. Confirm context menu appears with **Keep this** and **Try N ways from here**. Click **Keep this**.

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && git tag --list 'checkpoint/*'
```

Confirm a new `checkpoint/<auto-name>` tag exists at the SHA. The node now renders with a red ring on the canvas.

Right-click the same node again → confirm the menu now shows **Unmark kept** instead of Keep this. Click **Unmark kept** → confirm the tag is gone and the red ring disappears.

## 9 — Right-click → Try N ways with three profiles

Right-click a step-commit at the boundary of a worktree-friendly stage (e.g., a step-commit landed for `tasks` — the next stage `implement` is sequential, but `gap_analysis`, `specify`, `plan`, `tasks`, `learnings` are parallel). To exercise the parallel path, pick a step-commit whose **next** stage is one of those — for example, the `[checkpoint:specify:1]` commit, whose next stage is `plan`.

Click **Try N ways from here**. The modal opens with N=3 default.

In the per-variant form:

- **A**: Profile = `conservative`. Verify the runner / model / persona / allowed-tools fields populate from `.dex/agents/conservative/dex.json`. The overlay chip reads `1 (CLAUDE.md only)` (or similar — depends on overlay summary wording).
- **B**: Profile = `standard`. Chip reads `(no .claude/ overlay)`.
- **C**: Profile = `innovative`. Chip reads `1 subagent`.
- Verify the cost estimate at the footer is the sum of three model-specific estimates (Opus + Sonnet + Haiku).

Click **Run variants**. Confirm:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
git branch | grep attempt-       # 3 new attempt-<ts>-{a,b,c} branches
ls .dex/worktrees/                # 3 worktrees
ls .dex/worktrees/attempt-*-a/.claude/   # contains overlaid CLAUDE.md from conservative
ls .dex/worktrees/attempt-*-c/.claude/agents/   # contains overlaid code-reviewer.md
```

Project root unchanged:

```bash
shasum -a 256 .claude/CLAUDE.md   # take this hash now and after the run completes — must match
```

## 10 — Sequential-stage warning

Right-click a step-commit whose **next** stage is sequential (e.g., a `[checkpoint:tasks:1]` is followed by `implement`). Click **Try N ways from here**. Confirm the modal shows the warning banner at the top: "`.claude/` overlays will not apply on this stage in v1 — only Dex-side knobs (model / persona / allowed-tools) will." The banner is non-dismissable for this modal session.

## 11 — Empty-profiles stub

Temporarily move `.dex/agents/` aside:

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce && mv .dex/agents .dex/agents.bak
```

Re-open the Try-N-ways modal. Confirm the stub message: "No agents defined for this project. Run with project default for all variants, or create a folder under `.dex/agents/<name>/` and reopen this modal." Cancel.

Restore:

```bash
mv .dex/agents.bak .dex/agents
```

## 12 — Save changes to profile

Open the Try-N-ways modal again. Pick **conservative** in slot A. Change the model field to `claude-sonnet-4-6`. Click **Save changes to profile**. Confirm:

```bash
cat /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/agents/conservative/dex.json
```

The model field is now `claude-sonnet-4-6`. The other fields (`agentRunner`, `systemPromptAppend`, `allowedTools`) are unchanged. Restore via:

```bash
sed -i 's/"claude-sonnet-4-6"/"claude-opus-4-7"/' /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/agents/conservative/dex.json
```

## 13 — Pause + resume

Stop the run mid-cycle (interactive checkpoint mode if available, or simulate via the existing pause control). Open the Steps tab. Confirm:

- Stages with their step-commit on the active path → `done`.
- The orchestrator's `currentStage` if present → `paused` (purple).
- The next unstarted stage → `pause-pending` (orange pause-circle). This is the new state introduced by this feature.

Click **Resume**. Confirm the run continues without starting a new run record (existing `runId` reused).

## 14 — Type/build/tests

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex
npx tsc --noEmit
npx tsx --test src/core/__tests__/timelineLayout.test.ts \
                src/core/__tests__/jumpTo.test.ts \
                src/core/__tests__/agentProfile.test.ts \
                src/core/__tests__/agentOverlay.test.ts
```

All pass.

## 15 — Project-root invariant (SC-007)

```bash
cd /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
shasum -a 256 .claude/CLAUDE.md   # matches the hash from step 9
```

The project root's `.claude/` is byte-for-byte identical to its pre-spawn state.

---

## What "done" means

All 15 steps pass without manual workarounds. Any failure points to a regression in the corresponding spec'd behavior — file the diff against the spec's FR / SC numbering before fixing.
