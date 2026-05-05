# Branch Management — Test Fixtures

Reusable git fixture-staging recipes. Each fixture leaves `dex-ecommerce` in a precise, deterministic state so a scenario can drive a specific code path. **Every fixture is idempotent** — running it on a freshly-pristine repo produces the same end state every time.

## All fixtures assume the **pristine start state**

The canonical starting point — applied via `bash scripts/reset-example-to.sh pristine`:

- `dex-ecommerce` is at `/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce` (GitHub: <https://github.com/lukaskellerstein/dex-ecommerce>).
- HEAD is on local `main`, which is at the same SHA as `origin/main` (no local commits ahead).
- Working tree is clean (`-fdx` wiped, including gitignored runtime cache).
- No `dex/*`, `selected-*`, `attempt-*`, or `feature/*` branches exist locally.
- `.dex/dex-config.json` has been written with the scenario's required resolver settings.

Run the pre-flight one-liner from `README.md` § "One-liner: full pre-flight reset" before applying any fixture.

If the pristine assertions fail (`git rev-list --count origin/main..main != 0`, etc.), abort the scenario — fixtures are NOT designed to handle drift.

A common helper at the top of each fixture:

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
```

## Fixture catalog

| ID | Name | Used by | Final state |
|---|---|---|---|
| **F1** | `empty-dex-branch` | 1A | One `dex/*` branch sharing `main`'s tip — no unique commits, deletable cleanly. |
| **F2** | `dex-with-unique-step` | 1B, 1C | One `dex/*` branch with one step-commit not reachable from `main`. Triggers lost-work modal. |
| **F3** | `head-on-dex-branch` | 1D | HEAD checked out on a `dex/*` branch with no unique commits. Used to verify HEAD-switch-to-main on delete. |
| **F4** | `master-only-no-main` | 1E, 1F, 2I | Repo with `master` instead of `main`, plus a `dex/*` branch. Verifies fallback to master. |
| **F5** | `user-branch-and-dex` | 1H, 2O | Both a Dex `dex/*` branch and a user `feature/foo` branch. Used to verify user branches are rejected. |
| **F6** | `mid-run-state` | 1I, 2G, 2H | A `dex/*` branch + `.dex/state.json` reporting `status: "running"` with HEAD on the branch. Verifies mid-run refusal. |
| **F7** | `clean-promote` | 2A–2F, 2J–2L, 2P, 2Q | A `dex/*` branch ahead of `main` with multiple step-commits + diverse file changes. Conflict-free promote. |
| **F8** | `single-file-content-conflict` | 3A, 4A, 4B, 4C | A `dex/*` and `main` both modify the same line of one file → triggers AI resolver. |
| **F9** | `multi-file-content-conflict` | 3B | A `dex/*` and `main` conflict on two files. |
| **F10** | `rename-delete-conflict` | 3D | A `dex/*` renames `foo.txt` → `bar.txt`; `main` deletes `foo.txt`. Non-content conflict abort. |
| **F11** | `binary-file-conflict` | 3E | A `dex/*` and `main` both modify a binary file (PNG). Non-content abort. |
| **F12** | `both-added-conflict` | 3F | A `dex/*` and `main` both add `new.txt` with different content. Non-content abort. |

---

## F1 — empty-dex-branch

A `dex/*` branch sharing main's tip exactly. Deletable cleanly without lost-work modal.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git branch dex/2026-05-04-empty
```

Verify:

```sh
git branch --list 'dex/*'              # → dex/2026-05-04-empty
git rev-parse main dex/2026-05-04-empty  # both → same SHA
```

---

## F2 — dex-with-unique-step

A `dex/*` branch with one step-commit not on main — triggers the lost-work modal on delete.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git checkout -q -b dex/2026-05-04-unique main
echo "step output" > step-output.md
git add step-output.md
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/test]" \
                 -m "[checkpoint:plan:1]"
git checkout -q main
```

Verify:

```sh
# The branch has one step-commit unique to it.
git log dex/2026-05-04-unique --not main --format=%s
# → "dex: plan completed [cycle:1] [feature:specs/test]"
```

---

## F3 — head-on-dex-branch

HEAD on a `dex/*` branch sharing main's tip. Delete must switch HEAD to main first.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git checkout -q -b dex/2026-05-04-head-here
```

Verify:

```sh
git rev-parse --abbrev-ref HEAD   # → dex/2026-05-04-head-here
```

---

## F4 — master-only-no-main

Repo where the primary is `master`, not `main`. Used to verify `findPrimaryFallback` picks the right one.

**Destructive — requires fresh `clean` reset first.** Renames `main` → `master` so the example project is on master.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
# Recreate as master
git branch -m main master
git checkout -q master
# Add a fresh dex/* branch
git branch dex/2026-05-04-on-master
```

After the test, restore the original layout:

```sh
git branch -m master main
```

---

## F5 — user-branch-and-dex

Both a Dex-owned and user-owned branch — to verify user branches are not deletable/promotable.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git branch feature/foo main
git branch dex/2026-05-04-coexist main
```

---

## F6 — mid-run-state

A `dex/*` branch + a state.json that reports the orchestrator is running on it. Verifies the mid-run-active guard.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git checkout -q -b dex/2026-05-04-active main
mkdir -p .dex
cat > .dex/state.json <<'EOF'
{
  "version": 1,
  "runId": "test-mid-run",
  "status": "running",
  "baseBranch": "main",
  "mode": "loop"
}
EOF
```

Cleanup after the test:

```sh
rm -f .dex/state.json
git checkout -q main
```

---

## F7 — clean-promote

A `dex/*` branch ahead of main with several step-commits, no diverging changes on main. Verifies the clean-merge promote path including diff-summary computation.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"
git checkout -q -b dex/2026-05-04-clean main

# Several committed file changes + step-commits.
mkdir -p src/feature
echo "export function add(a, b) { return a + b; }" > src/feature/math.ts
git add src/feature/math.ts
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/clean]" \
                 -m "[checkpoint:specify:1]"

echo "export function sub(a, b) { return a - b; }" >> src/feature/math.ts
echo "## Plan" > src/feature/PLAN.md
git add -A
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/clean]" \
                 -m "[checkpoint:plan:1]"

mkdir -p docs
echo "# Notes" > docs/feature-notes.md
git add docs/
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/clean]" \
                 -m "[checkpoint:tasks:1]"

git checkout -q main
```

Verify:

```sh
git diff main..dex/2026-05-04-clean --shortstat
# → "3 files changed, ..."
git merge-base --is-ancestor main dex/2026-05-04-clean   # exit 0 (yes)
```

---

## F8 — single-file-content-conflict

The classic content conflict: one file, both branches modify the same line differently. The AI resolver should resolve this in one iteration.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# Seed the file on main with a checkpoint commit.
cat > conflict-test.txt <<'EOF'
This is a test file for the AI resolver.
Line two stays the same on both sides.
Line three is the same shared line.
Line four also unchanged.
End of file.
EOF
git add conflict-test.txt
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/conflict]" \
                 -m "[checkpoint:specify:1]"

BASE=$(git rev-parse HEAD)
git checkout -q -b dex/2026-05-04-cflict-a "$BASE"
sed -i 's|^Line three is the same shared line\.$|Line three is changed by the FEATURE branch with care for clarity.|' conflict-test.txt
git add conflict-test.txt
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/conflict]" \
                 -m "[checkpoint:plan:1]"

git checkout -q main
sed -i 's|^Line three is the same shared line\.$|Line three is rewritten on main with a different approach entirely.|' conflict-test.txt
git add conflict-test.txt
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/main-side]" \
                 -m "[checkpoint:tasks:1]"
```

Verify:

```sh
git diff main..dex/2026-05-04-cflict-a -- conflict-test.txt
# → diff showing line 3 changed differently on each side
```

---

## F9 — multi-file-content-conflict

Two separate files, each with a content conflict. Verifies the resolver iterates per file.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# Seed two files on main.
echo "config A" > shared/config.txt
echo "label A" > shared/label.txt
mkdir -p shared
git add shared/
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/multi]" \
                 -m "[checkpoint:specify:1]"

BASE=$(git rev-parse HEAD)
git checkout -q -b dex/2026-05-04-multi "$BASE"
echo "config from feature" > shared/config.txt
echo "label from feature" > shared/label.txt
git add shared/
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/multi]" \
                 -m "[checkpoint:plan:1]"

git checkout -q main
echo "config from main" > shared/config.txt
echo "label from main" > shared/label.txt
git add shared/
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/main]" \
                 -m "[checkpoint:tasks:1]"
```

---

## F10 — rename-delete-conflict

A non-content conflict. Branch renames a file; main deletes it. The resolver must NOT be invoked — the merge aborts immediately.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# Seed the file on main.
echo "original content" > foo.txt
git add foo.txt
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/rd]" \
                 -m "[checkpoint:specify:1]"

BASE=$(git rev-parse HEAD)
git checkout -q -b dex/2026-05-04-rename "$BASE"
git mv foo.txt renamed.txt
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/rd]" \
                 -m "[checkpoint:plan:1]"

git checkout -q main
git rm -q foo.txt
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/main-rm]" \
                 -m "[checkpoint:tasks:1]"
```

---

## F11 — binary-file-conflict

A binary file (.png header bytes) modified on both sides. `git check-attr` flags it; resolver MUST NOT be invoked.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# Seed a "binary" file (PNG signature). Mark binary via .gitattributes.
printf '\x89PNG\r\n\x1a\nAAAA' > image.png
echo "image.png binary" > .gitattributes
git add image.png .gitattributes
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/bin]" \
                 -m "[checkpoint:specify:1]"

BASE=$(git rev-parse HEAD)
git checkout -q -b dex/2026-05-04-binary "$BASE"
printf '\x89PNG\r\n\x1a\nBBBB' > image.png
git add image.png
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/bin]" \
                 -m "[checkpoint:plan:1]"

git checkout -q main
printf '\x89PNG\r\n\x1a\nCCCC' > image.png
git add image.png
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/main-bin]" \
                 -m "[checkpoint:tasks:1]"
```

---

## F12 — both-added-conflict

Both branches independently add the same file with different content. XY status is `AA`. Non-content abort.

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# Anchor commit so both branches share an ancestor.
echo "anchor" > anchor.txt
git add anchor.txt
git commit -q -m "dex: specify completed [cycle:1] [feature:specs/aa]" \
                 -m "[checkpoint:specify:1]"

BASE=$(git rev-parse HEAD)
git checkout -q -b dex/2026-05-04-both-add "$BASE"
echo "feature version" > new.txt
git add new.txt
git commit -q -m "dex: plan completed [cycle:1] [feature:specs/aa]" \
                 -m "[checkpoint:plan:1]"

git checkout -q main
echo "main version" > new.txt
git add new.txt
git commit -q -m "dex: tasks completed [cycle:1] [feature:specs/main-aa]" \
                 -m "[checkpoint:tasks:1]"
```

---

## Cleanup helper

After any scenario, restore the example project to a clean state:

```sh
DXE=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
cd "$DXE"

# 1. Roll back any in-progress merge.
git merge --abort 2>/dev/null || true

# 2. Restore the working tree.
git reset --hard HEAD
git clean -fdx

# 3. Reset to main and prune all dex/* and selected-* branches.
git checkout -q main 2>/dev/null || git checkout -q master
for b in $(git branch --list 'dex/*' 'selected-*' 'attempt-*' --format='%(refname:short)'); do
  git branch -D "$b" 2>/dev/null
done

# 4. Reset the dex-config.json to the default test config.
mkdir -p .dex
cat > .dex/dex-config.json <<'EOF'
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

This block is referenced from each scenario's "Cleanup" section as `[run cleanup helper]`.
