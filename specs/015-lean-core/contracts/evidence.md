# Contract: verify records — `.dex/evidence/<id>/verify.json`

Written by Dex after each `verify` stage, from the agent's structured verdict,
and read by the picker. The file is not tracked: `.dex/evidence/` carries its
own `.gitignore` (`*`), and `.dex/.gitignore` lists `evidence/` for new
projects. The verify agent writes no verdict file (research R19).

## The agent's structured output (`VERIFY_SCHEMA`)

The verify stage runs with the SDK's `outputFormat: { type: "json_schema" }`.

```json
{
  "verdict": "failed",
  "summary": "Typecheck fails in the ranking module; the other criteria are met.",
  "commands": [
    { "command": "npm test", "exitCode": 0 },
    { "command": "npm run typecheck", "exitCode": 2 }
  ],
  "criteria": [
    { "criterion": "SC-001", "met": true, "note": "" },
    { "criterion": "SC-004", "met": false, "note": "typecheck fails in src/recommendations/rank.ts:41" }
  ]
}
```

- `verdict` is `passed` only when every criterion is met and every command succeeds.
- An output without a `passed` or `failed` verdict (`parseVerdict` → null), or a
  stage stopped before it ended, writes no record. The picker then runs `verify` again.

## The record

```json
{
  "version": 1,
  "entryId": "004-product-recommendations",
  "key": "5d1c0a9e3b7f2c4d6e8a0b1c3d5e7f9a1b2c3d4e",
  "tasksHash": "9f2c4b0e8d1a3c5e7f9b2d4a6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4",
  "checked": "2026-11-12T09:41:07.000Z",
  "verdict": "failed",
  "summary": "…",
  "commands": [ … ],
  "criteria": [ … ]
}
```

One file per entry. A new verify stage replaces it.

## The key (`evidenceKey`)

Dex computes the key right **before** the stage, so the record names what the
agent checked.

| Queue `kind` | Key | Why |
|---|---|---|
| `existing` | `git rev-parse refs/heads/<entry branch>` | Each entry has its own branch. Any later commit on it sends the entry back to `verify` |
| `new` | `spec:` + sha256 over every file under the spec folder (path, then content; uncommitted changes included) | All entries share one run branch. A HEAD key would undo every earlier entry at the next entry's first commit |

`tasksHash` is `sha256(tasks.md)` as the picker reads it (the entry's own
tree, research R3).

## How the picker reads it

| Record | Next stage |
|---|---|
| missing or unreadable | `verify` ("no verify record in .dex/evidence/<id>/") |
| `key` ≠ the entry's key now | `verify` ("branch … has commits since the last verify", or "… changed since the last verify") |
| `tasksHash` ≠ `sha256(tasks.md)` now | `verify` |
| `verdict: failed` for the entry as it is | `verify` again |
| `verdict: passed` for the entry as it is | the entry is **done** |

After a failure the agent appends a fix phase, so `tasks.md` has unchecked
in-scope tasks and the picker picks `implement` before it reaches this table.
When the picker asks for `verify` again right after a verify stage, the
no-progress guard (research R9) pauses the run with `no_progress` and the
picker's reason. That covers three cases: a failure with no fix phase
appended, a stage that returned no verdict, and an agent that committed during
a passing stage (the record names the HEAD it checked, not the new one).

## The prompt

`buildVerifyPrompt` gives the agent the round `k`, the next phase number and the
next task id (`verifyFacts` in `stages/cycle-stages.ts`), so the agent does not
have to count. It tells the agent to change no file and make no commit on a
pass. The mock agent reads the same three facts from the prompt and returns the
scripted verdict as its structured output, so it tests the contract the real
agent follows (research R15).

## The fix phase

On failure the agent appends to `tasks.md`, and commits as the project's rules say:

```markdown
## Phase <max phase number + 1>: Verify fixes V<k>

**Purpose**: Fix what verification round <k> found.

- [ ] T<max task id + 1> <concrete fix, with file and criterion>
- [ ] T<max task id + 2> …
```

- The header keeps a **numeric** phase number, because the task parser
  (`parser.ts` `PHASE_HEADER`) and `/speckit-implement --phase N` both need one.
  `V<k>` names the round (research R8).
- Task ids continue the file's sequence (`T<max+1>`, padded like the file's ids), so they match `TASK_LINE`; the parser reads both `[x]` and `[X]`.
- A phase is a fix phase when its name starts with `Verify fixes V<k>` (`isFixPhase`).
- `k` = the number of existing `Verify fixes V*` phases + 1. That count is the
  verify-round counter for `maxVerifyRounds`.
- A fix phase is always in scope, even when the entry has a `tasks` filter.
