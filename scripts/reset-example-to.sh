#!/usr/bin/env bash
# Usage: reset-example-to.sh <clean|after-clarification|after-tasks>
#
# Restores the dex-ecommerce example project to a known state. This is the
# ONLY authorized destructive path against dex-ecommerce (trust boundary
# documented in .claude/rules/06-testing.md §4c.1).
#
# - clean:                 blank slate on main, only GOAL.md tracked
# - after-clarification:   post-manifest_extraction fixture (skip prereq/clarify/constitution)
# - after-tasks:           post-tasks fixture (skip specify/plan/tasks; resume into implement)
set -euo pipefail

TARGET=/home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce
CHECKPOINT="${1:-clean}"

cd "$TARGET"

case "$CHECKPOINT" in
  clean)
    git reset --hard HEAD
    git clean -fdx
    git checkout main
    ;;
  after-clarification|after-tasks)
    BRANCH="fixture/$CHECKPOINT"
    git rev-parse --verify "$BRANCH" >/dev/null
    git reset --hard HEAD
    git clean -fdx
    git checkout -B "$BRANCH" "$BRANCH"
    jq -e --arg b "$BRANCH" '.branchName == $b' .dex/state.json >/dev/null \
      || { echo "fixture drift: state.json branchName != $BRANCH" >&2; exit 1; }
    ;;
  *)
    echo "unknown checkpoint: $CHECKPOINT" >&2
    exit 2
    ;;
esac

git status --short
