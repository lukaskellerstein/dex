#!/usr/bin/env python3
"""Worktree guard — one file, two hook events.

PreToolUse on Edit | Write | NotebookEdit
    Deny an edit whose target is in the repository's main checkout or in
    another worktree of the same repository. The session's own worktree is the
    only checkout it may write. A target outside every checkout — the session
    scratchpad, ~/.claude memory — is not this hook's business and passes.

SessionStart on startup | clear | compact
    Print one line naming the worktree, its branch and the main checkout, so
    the boundary is back in the agent's context after every compaction.
    `resume` is left out on purpose: at that moment cwd is still the launch
    directory, and Claude Code moves the session into its worktree afterwards.

CLAUDE_NO_WORKTREE — the deliberate exception
    `claude --no-worktree` (the shell function in mac-setup modules/zsh) sets
    this variable, and a hook inherits the launching shell's environment. It
    means: this session works in the main checkout on purpose. The main
    checkout then becomes writable, and only the other half of the rule
    stands — an edit into `.worktrees/<name>` is still denied, because that
    copy belongs to another session and to another branch. Outside the main
    checkout the variable changes nothing; a worktree session keeps its own
    boundary whether or not the flag was passed.

Why a hook when Claude Code already isolates a `-w` session
    Its native checks stop Edit/Write into the main checkout's tree and git
    commands that reach it, and the sandbox stops every Bash write outside the
    worktree. Two things pass both (measured 2026-09-08, Claude Code 2.1.263):
    an Edit/Write into a worktree that lives outside the main checkout's tree,
    and every edit in a session that was not started with -w at all — there
    the native checks do not exist. This closes both, and makes the main
    checkout read-only for agents.

The boundary comes from the hook input's `cwd`, never from CLAUDE_PROJECT_DIR:
on a resume that variable is the launch directory while cwd is the worktree.
Contract: mac-setup projects/claude-code.md § Worktrees.
"""

import json
import os
import subprocess
import sys


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def under(path, root):
    return path == root or path.startswith(root + os.sep)


def checkouts(cwd):
    """Every checkout of this repository, main first, as real paths."""
    listing = git(cwd, "worktree", "list", "--porcelain") or ""
    return [os.path.realpath(line[len("worktree ") :]) for line in listing.splitlines() if line.startswith("worktree ")]


def deny(reason):
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }
        )
    )
    sys.exit(0)


def main():
    try:
        d = json.load(sys.stdin)
    except Exception:
        return
    cwd = d.get("cwd") or os.getcwd()
    top = git(cwd, "rev-parse", "--show-toplevel")
    if not top:
        return  # not a git repository: nothing to guard
    here = os.path.realpath(top)
    common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
    main_root = os.path.realpath(os.path.dirname(common)) if common else here
    in_main = here == main_root
    branch = git(cwd, "branch", "--show-current") or "(detached HEAD)"
    no_worktree = bool(os.environ.get("CLAUDE_NO_WORKTREE"))

    event = d.get("hook_event_name")
    if event == "SessionStart":
        if in_main and no_worktree:
            print(
                f"Worktree guard: this is a no-worktree session in the MAIN checkout "
                f"{here}, on {branch}. The user started it with `claude --no-worktree`, "
                "so you may edit here. Do not edit any copy under .worktrees/ — those "
                "belong to other sessions and other branches, and the hook denies them."
            )
        elif in_main:
            print(
                f"Worktree guard: this is the MAIN checkout {here}, on {branch}. "
                "It is read-only for agents — Edit/Write here are denied by hook. "
                "Code changes happen in a worktree the user starts with `claude -w <name>`."
            )
        else:
            print(
                f"Worktree guard: you work in the worktree {here}, on branch {branch}. "
                f"Main checkout: {main_root}. Edits outside {here} are denied "
                "(hook + sandbox). Never cd out of it."
            )
        return
    if event != "PreToolUse":
        return

    tool_input = d.get("tool_input") or {}
    target = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not target:
        return
    if not os.path.isabs(target):
        target = os.path.join(cwd, target)
    target = os.path.realpath(target)

    if not in_main and under(target, here):
        return  # the session's own worktree

    if in_main:
        if no_worktree:
            # The main checkout is writable on purpose. A worktree nested under
            # it is not: that copy is another session's, on another branch.
            for tree in checkouts(cwd):
                if tree != main_root and under(target, tree):
                    deny(
                        f"{target} is in the worktree {tree}, which belongs to another "
                        "branch and possibly another session. This is a no-worktree "
                        f"session; edit the copy in the main checkout {main_root} instead."
                    )
            return
        if under(target, main_root):
            deny(
                f"{target} is in the main checkout {main_root}, which is read-only "
                "for agents. Ask the user to start a session with `claude -w <name>` "
                "and make the change there, or `claude --no-worktree` to work in main."
            )
        return

    for tree in checkouts(cwd):
        if tree != here and under(target, tree):
            what = "the main checkout" if tree == main_root else "another worktree"
            deny(f"{target} is in {what} ({tree}). This session's worktree is {here}; edit the copy there.")
    # outside every checkout: allowed


if __name__ == "__main__":
    main()
