---
description: "Reference: nvim-tools and lukas-ps — the two mac-setup CLIs always on PATH. Whether you may run them, when to, and why."
---

# Machine tools — `nvim-tools` and `lukas-ps`

Two CLIs built by this machine's `mac-setup` repo are always on `PATH`
(`~/.local/bin`). They are installed **machine-wide, not per project**: they work
in every repo on this machine, and nothing in this repo declares, installs or
configures them.

> [!important]
> This file is delivered verbatim to every repo on this machine, and it is the
> only place in this repo that documents these two tools. Do not reword it and do
> not extend it — anything true only of *this* repo belongs in `CLAUDE.md`.

## Both commands document themselves — `--help`

`nvim-tools --help` and `lukas-ps --help` print the **full current surface**:
every flag, every view, the TUI keys, and the reasoning behind the numbers they
report. They ship inside the binaries, so they cannot go stale — **this file
can**.

So: the tables below are only the handful of invocations the workflow needs. The
moment you want anything else — a different view, one tool instead of all of
them, a different sort, a fix scoped to a single file — **run `--help` and read
it.** Do not guess a flag, and do not reach for a different tool because you
could not remember one.

## IF — may I run them?

**Yes — every invocation in the two tables below is read-only and pre-approved.**
Run it yourself when the situation calls for it; do not ask.

> [!warning]
> **That approval covers the tables, not the whole binary.** Both tools also
> carry commands that rewrite files or kill processes, and `--help` lists them
> right beside the harmless ones. Finding a flag in `--help` is not permission to
> run it. They are in § The mutations at the bottom — none is pre-approved.

They are *this machine's* layer, never the repo's. A collaborator without
`mac-setup` does not have these binaries, so they **complement the project's own
test suite and never replace it**. Never add them to CI, to `package.json`
scripts, or to a `Makefile` — no repo carries a `lint` script, because the editor
and these CLIs are the runner.

## WHEN — the moments that matter

| Moment | Run | What it buys you |
|:--|:--|:--|
| **Understand**, before touching anything | `nvim-tools --json --all` | the repo's *pre-existing* findings. Without this baseline you cannot tell a problem you introduced from one that was already there — so you either take the blame for old findings or ship new ones hidden in the noise. |
| **Test**, while iterating | `nvim-tools --json` | the fast tools in a second or two. The type checker stays `pending` — see § The type checker is slow. |
| **Test**, before you report | `nvim-tools --json --all` | proof the change added no findings, against the same tool set the baseline used. Seconds on most repos; up to a minute or two where the type checker has a large import graph to read. |
| any claim about memory, CPU, or a process that will not die | `lukas-ps --json [name]` | a measurement instead of a guess. |

## `nvim-tools` — every finding in the repo, in one envelope

Errors, lint, formatting and types, from the same gated tools the editor runs —
so the CLI and the editor can never disagree about what is wrong.

| Command | Answers |
|:--|:--|
| `nvim-tools --json --all` | everything in one blocking run: errors, lint, formatting, types. **This is the workflow command.** |
| `nvim-tools --json` | the fast tools now, the slow ones reported as `pending` — seconds, not minutes, with the type checker **not run** |
| `nvim-tools --json --slow` | only the slow half, when you already have the fast one |
| `nvim-tools --status --path <file>` | one file, gate walk only, no tool runs |
| `nvim-tools --diff-all` | what `--fix-all` would change, writing nothing |

Everything else — one tool at a time (`-t`), a different root (`-C`), fixing a
single file, the unsafe fixes — is in `nvim-tools --help`, including the list of
tools it can run.

### The type checker is slow, and that changes how you call this

Everything else answers in milliseconds. The Python type checker usually does
too — a 45-file repo type-checks in under two seconds — but where the code
imports a large stack it has to read the types of everything you import, not
just what you wrote, and that is minutes rather than seconds. Worse under load;
it is CPU-bound.

**Use `--stream` and you never wait for it.** Every tool already runs
concurrently; `--stream` stops the *answer* waiting on the slowest one. It
emits NDJSON — one complete envelope per line as each tool finishes, in-flight
tools marked `state: "running"`, **last line is the answer**. On a repo whose
type scan takes ~53 s the lint and format findings are yours at 3.4 s.

`nvim-tools --help` has the exact invocations for the three cases (a runner
that can read a file mid-command, one that can raise a timeout, one that can do
neither) and the `--detach` rule that backgrounding needs. Read it there rather
than trusting this paragraph — it ships in the binary and cannot go stale.

What is a judgment call, and therefore lives here:

> [!warning]
> **A tool that has not answered is not a tool reporting "clean".** `pending`,
> `running` and `skipped` all mean the finding list is *silent* about that
> tool — and silence reads exactly like an all-clear. Only `ok` licenses a
> claim; `gated-off` means the repo opted out, `not-installed` that the binary
> is missing, `error` that it failed and the message is right there.
>
> So: never conclude "no type errors" from an envelope whose type checker was
> not `ok`. If you are reporting while a scan is still going, say which tool
> you did not wait for — "types still running, lint and format clean" — rather
> than letting a partial answer stand as a whole one.

**Nothing is cached between invocations.** Every call is a fresh process that
re-runs the tools it is asked for, so calling `--all` twice pays the minutes
twice. There is no daemon and no incremental mode, and for types there could not
easily be one: the checker is whole-program, so editing one file can create an
error in another and "re-check only what I touched" is not a sound shortcut.

The way round it is not a cache, it is **not asking twice**. Type findings can
only move if the type checker's inputs moved — a `.py` file, `pyrightconfig.json`
/ `[tool.basedpyright]`, or the installed dependencies. You know which of those
you touched, so:

| You are | Run | Because |
|:--|:--|:--|
| taking the **baseline**, before touching code | `--json --all` | the baseline has to include types, or every type error you meet later looks like yours. Pay the minutes once, here |
| **iterating** on a change | `--json` | seconds instead of minutes; types stay `pending` and you have not claimed otherwise |
| **proving**, having touched Python or its config/deps | `--json` then `--json --slow` | types can have moved, so they must be re-run. `--slow` runs *only* the slow half — the two calls together cost what one `--all` costs, and the fast half answers immediately instead of after the wait |
| **proving**, having touched nothing Python | `--json` alone | the inputs to the type checker did not change, so the baseline's type findings still stand. Say that in the report — "types unchanged since baseline, no Python touched" — rather than implying you re-ran them |

Merging two envelopes is a union with one rule: an entry in `tools[]` from the
`--slow` run **replaces** the `pending` one of the same name, and its findings
are added to `files[]` by path. Nothing else in the fast envelope is affected —
`--slow` marks every fast tool `skipped` and reports none of their findings.
(With `--stream` there is nothing to merge: every line is already whole.)

And if you do block on `--all`, let it finish: killing it and falling back to
`--json` is how "no type errors" gets reported about a repo nobody
type-checked, and because nothing is cached the killed run costs the same
minutes again next time.

> [!warning]
> **Read the envelope, not `$?`.** Exit **0 means the tools ran** — findings are
> data, not failure. Exit 1 is a broken tool or a refusal; 2 is usage. So never
> write `nvim-tools --json --all && echo clean`: a repo full of errors exits 0,
> and treating that as a pass is how a change ships with the findings it added.

Every id you can act on comes out of `--json` and nowhere else — a **file id**
for `--fix`/`--diff`, a **finding id** for `--open`. They are relative to the
root, so pass back the same `-C` you got them from.

> [!note]
> **`gated-off` is not a breakage.** This machine runs "no config, no tool": an
> opinionated linter or formatter acts only where the repo carries that tool's
> config file. `gated-off` means this repo carries none for it — the contract
> working exactly as designed, not a fault to debug. If a tool *should* be on
> here, the fix is to add its config file.

Do not substitute `biome check --write`, `ruff format`, or a bare tool binary.
`nvim-tools` runs all of them in one pass, honours the gate, and carries safety
rails they do not.

## `lukas-ps` — what a process tree actually costs

RAM and CPU for anything running on this machine: the dev server, a test run, an
editor.

| Command | Answers |
|:--|:--|
| `lukas-ps --json` | every process tree, biggest first |
| `lukas-ps --json <name>` | only the tree whose name matches (exact wins, else substring) |
| `lukas-ps --json -p <pid>` | the tree that owns that PID |

Machine-wide, not repo-scoped — it sees processes this repo never started. The
figure is the kernel's physical footprint summed over the tree, with shared pages
counted once; `lukas-ps --help` explains where that differs from `ps` and lists
the views, their sorts, and which of them accept `-p`.

`--json` **always** emits an envelope — an empty `groups` list means nothing
matched, so check the list rather than looking for an error. Its `groups[].id`
values are opaque strings and are the only ids the tool accepts; a PID is never
one, and `-p PID` is how you go the other way.

## The mutations — none of them pre-approved

Everything above is inspection. These four are not. `--help` lists them beside
the read-only flags, so **preview or ask first**, unless `CLAUDE.md`
§ Pre-approved mutations names one explicitly for this repo.

| Command | Does | First |
|:--|:--|:--|
| `nvim-tools --fix-all` | safe fixes from every tool, across the whole repo | preview with `--diff-all` |
| `nvim-tools --fix ID` | safe fixes for one file | preview with `--diff ID` |
| `lukas-ps --kill ID` | kills that row's entire process tree. **It asks nothing — the confirming is the caller's job, which means yours** | ask the user |
| `lukas-ps --activate ID` | switches the tmux client and jumps the user's pane somewhere else | it moves the screen out from under them; ask |

`--unsafe` widens either `--fix` and is never implied. `--force` overrides the
guards below, and `lukas-ps --kill --force` is the "I already asked politely"
kill — reaching for either to make a refusal go away is backwards, because the
refusal is the feature.

Three guards on the fixers, worth knowing because each explains a refusal you
might otherwise try to work around:

- **`*.enc.*` is never touched**, structurally — reformatting a SOPS-encrypted
  file invalidates its MAC and it silently stops decrypting.
- **A single `--fix ID` refuses outright** on a file with uncommitted changes;
  `--fix-all` and repeated `--fix` instead skip those files and report the count.
- **A non-git tree refuses** — no commit means no undo. `--force` is the override,
  and it is the one place that matters.
