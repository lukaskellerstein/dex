#!/usr/bin/env bash
# Usage: promote-checkpoint.sh <project-dir> <checkpoint-name> [<sha>]
#
# Promotes a sha to checkpoint/<name>. Defaults sha to HEAD. The script
# runs `git tag -f <tag> <sha>` directly — no orchestrator/electron
# involvement — so it's safe to use from CI or a terminal while the app
# is open, as long as you know what you're doing.
set -euo pipefail

PROJECT="${1:?project dir required}"
NAME="${2:?checkpoint name required}"
SHA="${3:-HEAD}"

case "$NAME" in
  checkpoint/*) TAG="$NAME" ;;
  *) TAG="checkpoint/$NAME" ;;
esac

cd "$PROJECT"

# Resolve sha
RESOLVED=$(git rev-parse --verify "$SHA")
if [ -z "$RESOLVED" ]; then
  echo "unable to resolve sha: $SHA" >&2
  exit 1
fi

git tag -f "$TAG" "$RESOLVED"
echo "promoted $TAG → ${RESOLVED:0:7}"
