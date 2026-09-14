#!/bin/bash
# WorktreeCreate hook — `claude -w <name>` works in <repo>/.worktrees/<name>.
#
# Claude Code's own logic puts a worktree under .claude/worktrees/<name> on a
# branch called worktree-<name>, and `-w` takes a name only — there is no
# location setting (checked 2026-09-08, Claude Code 2.1.263). A WorktreeCreate
# hook replaces that logic entirely, which is the documented way to choose the
# directory. This one gives the convention every repo on this machine follows:
#
#   - the worktree lives at <repo>/.worktrees/<name>
#   - the branch is called <name>          (`lukas/44-resolve` is a valid name)
#   - a worktree that already exists there is adopted, never recreated — that
#     is how two sessions share one, and how a hand-made worktree is used
#   - a new worktree branches from origin/<default branch>, after a fetch
#   - an existing branch called <name> is checked out instead of created
#
# Isolation is unchanged: the native checks, the sandbox and worktree-guard.py
# all key on the session's cwd, wherever that is. Measured in a probe repo.
# Contract: mac-setup projects/claude-code.md § Worktrees.
#
# stdin:  JSON — session_id, cwd, hook_event_name, name (the -w argument, or
#         agent-<hex> for a subagent with isolation: worktree)
# stdout: the worktree directory, one line; Claude Code starts the session there
# stderr: shown to the user
# exit:   non-zero aborts the session start
#
# bash 3.2 (a fresh Mac). Runs outside the sandbox, from the launch directory.

set -eu

input=$(cat)
name=$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
[ -n "$name" ] || { echo "worktree-create: empty worktree name" >&2; exit 1; }

# The main checkout — even when launched from inside a linked worktree, the
# common git dir is always <main>/.git.
root=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
dir="$root/.worktrees/$name"

if [ -d "$dir" ]; then
  echo "worktree-create: adopting $dir" >&2
  printf '%s\n' "$dir"
  exit 0
fi

# Base: the remote default branch, fetched first so "fresh" means fresh.
# No remote, or origin/HEAD unknown: fall back to the main checkout's HEAD.
base=$(git -C "$root" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)
if [ -z "$base" ] && git -C "$root" rev-parse -q --verify refs/remotes/origin/main >/dev/null 2>&1; then
  base=origin/main
fi
if [ -n "$base" ]; then
  git -C "$root" fetch -q origin "${base#origin/}" 2>/dev/null \
    || echo "worktree-create: fetch failed, branching from the cached $base" >&2
else
  base=HEAD
fi

if git -C "$root" show-ref -q --verify "refs/heads/$name"; then
  git -C "$root" worktree add "$dir" "$name" >&2
  echo "worktree-create: created $dir on the existing branch $name" >&2
else
  git -C "$root" worktree add -b "$name" "$dir" "$base" >&2
  echo "worktree-create: created $dir on new branch $name from $base" >&2
fi

# .worktreeinclude — gitignored files a fresh worktree needs (Claude Code skips
# its own copy step when a hook creates the worktree). One path per line,
# relative to the repo root, shell globs allowed, `#` comments. Only files that
# exist in the main checkout are copied, and nothing already present is touched.
if [ -f "$root/.worktreeinclude" ]; then
  while IFS= read -r pat || [ -n "$pat" ]; do
    case "$pat" in ''|'#'*) continue ;; esac
    (
      cd "$root"
      for f in $pat; do
        [ -f "$f" ] && [ ! -e "$dir/$f" ] || continue
        mkdir -p "$dir/$(dirname "$f")" && cp -p "$f" "$dir/$f" \
          && echo "worktree-create: copied $f" >&2
      done
    )
  done < "$root/.worktreeinclude"
fi

printf '%s\n' "$dir"
