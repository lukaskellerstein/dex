#!/usr/bin/env bash
# Usage: reset-example-to.sh <initial|pristine|clean|list|checkpoint-name>
#
# Rewritten for 008: tag-aware replay. Fixture branches deleted; use
# the checkpoint tree to reset to any named save point.
#
#   reset-example-to.sh initial                  (strongest possible — wipes origin too)
#     → reset main to its root commit, delete every other local branch,
#       delete every non-main branch on origin, force-push origin/main.
#       Use only when you genuinely want a blank slate including GitHub
#       state — the loop will push fresh dex/* branches into a clean remote.
#   reset-example-to.sh pristine                 (strongest local-only reset)
#     → git fetch origin → git reset --hard origin/main → -fdx clean → delete
#       all dex/* / selected-* / attempt-* local branches → checkout main.
#       Discards every local commit ahead of origin/main and every test
#       branch left over from previous runs, then re-syncs local main to
#       the current GitHub state. Does NOT rewrite origin.
#   reset-example-to.sh clean
#     → git reset --hard HEAD → -fdx clean → checkout main. Does NOT sync
#       main to origin and does NOT prune dex/* branches. Useful when you
#       want to keep local main's commits but reset the working tree.
#   reset-example-to.sh list
#     → print all checkpoint/* tags
#   reset-example-to.sh <name>
#     → resolve to checkpoint/<name> (or use the exact name if it already
#       starts with checkpoint/), create a fresh attempt-* branch from it
#       with the working tree restored to exactly that checkpoint's state.
#
# Repo target (hardcoded):
#   filesystem: /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
#   github:     https://github.com/lukaskellerstein/dex-ecommerce
set -euo pipefail

TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
ARG="${1:-clean}"

cd "$TARGET"

case "$ARG" in
  list)
    git tag --list 'checkpoint/*' | sort
    exit 0
    ;;
  initial)
    # Strongest possible reset — wipes both local AND origin/main back to the
    # repo's root commit. Deletes every other branch, local and remote.
    # Force-pushes origin/main. Use when you want a true blank slate end-to-end.
    git merge --abort 2>/dev/null || true

    INITIAL_COMMIT=$(git rev-list --max-parents=0 main | tail -n 1)
    echo "initial: rolling main back to $INITIAL_COMMIT"

    git checkout -f main
    git reset --hard "$INITIAL_COMMIT"
    git clean -fdx

    LOCAL_BRANCHES=$(git for-each-ref --format='%(refname:short)' refs/heads \
      | grep -v '^main$' || true)
    if [ -n "$LOCAL_BRANCHES" ]; then
      echo "deleting local branches:"
      echo "$LOCAL_BRANCHES"
      echo "$LOCAL_BRANCHES" | xargs git branch -D
    fi

    REMOTE_BRANCHES=$(git for-each-ref --format='%(refname:short)' refs/remotes/origin \
      | sed 's|^origin/||' \
      | grep -Ev '^(HEAD|main)$' || true)
    if [ -n "$REMOTE_BRANCHES" ]; then
      echo "deleting remote branches:"
      echo "$REMOTE_BRANCHES"
      echo "$REMOTE_BRANCHES" | xargs git push origin --delete
    fi

    git remote prune origin
    git push --force-with-lease origin main

    echo "initial: main reset to $INITIAL_COMMIT; all other branches removed (local + remote)"
    ;;
  pristine)
    # Strongest reset — re-syncs main to origin/main and prunes all test
    # branches. This is the canonical starting state for 014 test scenarios.
    git fetch -q origin
    # Abort any in-progress merge first (left over from a failed promote).
    git merge --abort 2>/dev/null || true
    # If HEAD is detached or on a non-main branch, force back onto main first.
    git checkout -q main 2>/dev/null || git checkout -q -B main origin/main
    git reset --hard origin/main
    git clean -fdx
    # Prune every test-fixture branch left over from prior runs.
    for b in $(git branch --format='%(refname:short)' | grep -E '^(dex/|selected-|attempt-|feature/)' || true); do
      git branch -D "$b" 2>/dev/null || true
    done
    echo "pristine: main reset to $(git rev-parse --short origin/main); local test branches pruned"
    ;;
  clean)
    git reset --hard HEAD
    # -fdx wipes gitignored files too; clean-slate desired here (only for clean target).
    git clean -fdx
    git checkout main
    ;;
  *)
    case "$ARG" in
      checkpoint/*) TAG="$ARG" ;;
      *)            TAG="checkpoint/$ARG" ;;
    esac
    if ! git rev-parse --verify "refs/tags/$TAG" >/dev/null 2>&1; then
      echo "unknown checkpoint: $TAG" >&2
      echo "use 'list' to see available checkpoints" >&2
      exit 2
    fi

    # Dirty-tree check — safety net. Do NOT force onto dirty state.
    if [ -n "$(git status --porcelain)" ]; then
      echo "uncommitted changes present; aborting. Use 'clean' first." >&2
      exit 3
    fi

    # Create a fresh attempt branch from the tag.
    STAMP=$(date -u +%Y%m%dT%H%M%S)
    BRANCH="attempt-${STAMP}"
    git checkout -B "$BRANCH" "$TAG"
    # -fd preserves gitignored files (.env, build output, editor state). Never -fdx here.
    git clean -fd -e .dex/state.lock
    echo "reset to $TAG; new branch: $BRANCH"
    ;;
esac

git status --short
