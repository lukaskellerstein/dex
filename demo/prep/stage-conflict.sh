#!/usr/bin/env bash
# Move main underneath the finished run, so promoting the run branch produces a
# real merge conflict for storyboard section 05.
#
# Run this AFTER the loop finishes and BEFORE recording section 05.
#
# The scenario is the ordinary one: a teammate edited the same file on main
# while the agent's run was in flight. reset.sh seeded README.md into the merge
# base, the run rewrote it, and this rewrites it differently on main. Both sides
# replace the whole file, so git cannot auto-merge and reports `UU` — the only
# classification that reaches the AI resolver (`AA` aborts as a non-content
# conflict).
#
# Written with plumbing (hash-object / update-index / commit-tree / update-ref)
# rather than checkout+commit on purpose: the app has the project open, and
# after section 04 HEAD sits on a selected-* branch. Checking main out would
# move the app's HEAD mid-session and change what the Timeline shows. Plumbing
# writes the commit and moves refs/heads/main without touching HEAD, the index,
# or the working tree.
#
# usage: demo/prep/stage-conflict.sh [projectDir]
set -euo pipefail

PROJECT="${1:-$HOME/Projects/Github/lukaskellerstein/dex-ecommerce}"

if [[ "$(basename "$PROJECT")" != "dex-ecommerce" ]]; then
  echo "refusing to operate on '$PROJECT' — demo prep only manages dex-ecommerce" >&2
  exit 1
fi

git -C "$PROJECT" rev-parse --verify -q main >/dev/null \
  || {
    echo "no main branch in $PROJECT" >&2
    exit 1
  }

RUN_BRANCH="$(git -C "$PROJECT" for-each-ref --format='%(refname:short)' 'refs/heads/dex/*' | head -1)"
if [[ -z "$RUN_BRANCH" ]]; then
  echo "FATAL: no dex/* run branch in $PROJECT — run the loop first." >&2
  echo "There is nothing to promote, so there is nothing to conflict with." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/README.md" <<'MD'
# Eshopy

Storefront for a small online shop. See `docs/my-specs/` for the specifications.

## Modules

- `src/admin/` — back-office dashboard (in progress, not yet wired up)

## Status

Admin back office started directly on main while the catalogue work was in flight.

## Contributing

Run `npm test` before opening a pull request.
MD

BLOB="$(git -C "$PROJECT" hash-object -w "$TMP/README.md")"

export GIT_INDEX_FILE="$TMP/index"
git -C "$PROJECT" read-tree main
git -C "$PROJECT" update-index --add --cacheinfo "100644,$BLOB,README.md"
TREE="$(git -C "$PROJECT" write-tree)"
unset GIT_INDEX_FILE

COMMIT="$(git -C "$PROJECT" \
  -c user.name="Priya" -c user.email="priya@eshopy.example" \
  commit-tree "$TREE" -p main -m "Start admin back office and document it in the README")"

git -C "$PROJECT" update-ref refs/heads/main "$COMMIT"

# Post-conditions. A silently-missing conflict means section 05 records a clean
# merge while the narration talks about conflict resolution.
BASE="$(git -C "$PROJECT" merge-base main "$RUN_BRANCH")"
for ref in "$BASE" main "$RUN_BRANCH"; do
  git -C "$PROJECT" cat-file -e "$ref:README.md" 2>/dev/null \
    || {
      echo "FATAL: README.md missing on $ref — the merge would be AA, not UU." >&2
      exit 1
    }
done

base_blob="$(git -C "$PROJECT" rev-parse "$BASE:README.md")"
main_blob="$(git -C "$PROJECT" rev-parse "main:README.md")"
run_blob="$(git -C "$PROJECT" rev-parse "$RUN_BRANCH:README.md")"
[[ "$main_blob" != "$base_blob" ]] || {
  echo "FATAL: main did not change README.md" >&2
  exit 1
}
[[ "$run_blob" != "$base_blob" ]] || {
  echo "FATAL: the run did not change README.md" >&2
  exit 1
}
[[ "$main_blob" != "$run_blob" ]] || {
  echo "FATAL: both sides wrote identical content — git would auto-merge" >&2
  exit 1
}

# Prove the merge actually conflicts, without touching the working tree.
if git -C "$PROJECT" merge-tree --write-tree main "$RUN_BRANCH" >/dev/null 2>&1; then
  echo "FATAL: main and $RUN_BRANCH merge cleanly — section 05 would show no resolver." >&2
  exit 1
fi

echo "demo-prep: main moved to ${COMMIT:0:7} — README.md now conflicts with $RUN_BRANCH"
echo "  HEAD is untouched: $(git -C "$PROJECT" rev-parse --abbrev-ref HEAD)"
