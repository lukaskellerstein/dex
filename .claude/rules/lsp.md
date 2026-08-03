---
description: "Reference: the LSP tool — when it exists, how to load it, and why symbol questions belong to it rather than to grep."
---

# The `LSP` tool

Semantic navigation backed by a real language server: what a symbol *is*, not
what a string *matches*. When it is available it beats `grep` on every question
about symbols, and it is easy to miss because of how it is delivered.

> [!important]
> This file is delivered verbatim to every repo on this machine. Do not reword it
> and do not extend it — anything true only of *this* repo belongs in `CLAUDE.md`.

## IF — is it even here?

**Most repos do not have it, and that is the normal state.** The tool exists only
in a repo that opted in by enabling an `lsp-*` plugin in its
`.claude/settings.json`.

Check your tool list — nothing else:

| What you see | What it means |
|:--|:--|
| `LSP` named in the deferred-tools `<system-reminder>` | available — load it, § below |
| `LSP` absent | this repo did not opt in. **Use `grep` and move on.** |

Do not hunt for it, do not suggest enabling it mid-task, and do not treat its
absence as a fault. A repo without it is correctly configured for the default.

## THEN — load it before you can call it

`LSP` arrives **deferred**: the tool list carries the *name only*, with no
parameter schema, so calling it directly fails. One call fixes that:

```text
ToolSearch("select:LSP")
```

> [!warning]
> This is the step that gets skipped, and skipping it is silent — there is no
> error, just an agent that greps instead. If a repo enabled the plugin, someone
> paid for a language server to be running; not loading the tool wastes it.

## The nine operations — all navigation

```text
goToDefinition  findReferences  hover  documentSymbol  workspaceSymbol
goToImplementation  prepareCallHierarchy  incomingCalls  outgoingCalls
```

Prefer them over `grep` whenever the question is about a *symbol*:

| Question | Reach for | Why not grep |
|:--|:--|:--|
| Where is this defined? | `goToDefinition` | grep finds the name in comments, strings and unrelated scopes |
| Who implements this interface / base class? | `goToImplementation` | subclasses rarely repeat the base name near the method |
| What breaks if I change this signature? | `findReferences` | **the one that matters** — a missed caller is a runtime break |
| What calls this, and what does it call? | `incomingCalls` / `outgoingCalls` | a call graph is not a text pattern |
| What is this type? | `hover` | the annotation is often inferred and written nowhere |
| What is in this file / repo? | `documentSymbol` / `workspaceSymbol` | structure, not lines |

Grep remains right for non-symbol work: prose, config keys, log strings, TODOs,
and any first pass over an unfamiliar tree.

## NOT — what it cannot do

> [!danger]
> **There is no diagnostics operation.** No errors, no warnings, no lint, no type
> findings, no completion, no formatting. Asking the LSP tool "what errors do you
> see" cannot be answered — the operation does not exist.

Diagnostics belong to `nvim-tools --json --all`
([`machine-tools.md`](machine-tools.md)), which runs the same type checker as a
CLI and reports every finding in the repo. The two are complements, and the split
is clean:

| Want | Use |
|:--|:--|
| errors, lint, type findings, formatting | `nvim-tools` |
| definitions, references, implementations, call hierarchy | `LSP` |

Reporting "the LSP found no errors" is always wrong — it never looked.

## The cost, so you do not multiply it

A server starts lazily, on the first file touched whose extension the plugin
claims, and it is not free: a TypeScript server is ~0.85 GB, a Python one
~0.26–0.5 GB. That is per session, not per machine.

So: load `LSP` when you have symbol questions, not reflexively at the start of
every task. Touching one `.ts` file to "check whether it works" spawns the whole
TypeScript stack for the rest of the session.
