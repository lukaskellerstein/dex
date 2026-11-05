# Contract: `specs/<id>/verify.md`

Written by the `verify` agent, committed as the project's rules say, and read
by the picker. Dex parses only the header block. Everything below it is for
humans.

## Format

```markdown
# Verification: 021-agent-entry

**Verdict**: failed
**Tasks-SHA256**: 9f2c4b0e8d1a3c5e7f9b2d4a6c8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4
**Checked**: 2026-11-12T09:41:07Z

## Commands

| Command | Exit code |
|---|---|
| `npm test` | 0 |
| `npm run typecheck` | 2 |

## Criteria

- [x] SC-001 — …
- [ ] SC-004 — typecheck fails in `src/agent/entry.ts:41`

## Fix phase

Appended to `tasks.md` as `## Phase 7: Verify fixes V2`.
```

## Parsing rules (`readVerifyRecord`)

| Line | Regex | Notes |
|---|---|---|
| verdict | `^\*\*Verdict\*\*: (passed\|failed)\s*$` | first match wins |
| hash | `^\*\*Tasks-SHA256\*\*: ([0-9a-f]{64})\s*$` | |
| checked | `^\*\*Checked\*\*: (\S+)\s*$` | informational |

- Missing file, or a missing verdict or hash line → treated as **missing** (the
  picker runs `verify`).
- Hash ≠ `sha256(bytes of tasks.md now)` → treated as **missing**.
- Verdict `passed` and hash matches → the entry is **done**.
- Verdict `failed` and hash matches → impossible after a correct verify run
  (the fix phase changed `tasks.md`); the picker treats it as missing, and the
  no-progress guard (research R9) stops a loop.

## Who computes the hash

Dex. The verify prompt carries the exact value:
`Tasks-SHA256: <hex>` — "copy this line verbatim". The agent never hashes.
Dex computes it from `tasks.md` right before the stage starts.

## The fix phase

On failure the agent appends to `tasks.md`:

```markdown
## Phase <max phase number + 1>: Verify fixes V<k>

**Purpose**: Fix what verification round <k> found.

- [ ] T<max task id + 1> <concrete fix, with file and criterion>
- [ ] T<max task id + 2> …
```

- The header keeps a **numeric** phase number, because the task parser
  (`parser.ts` `PHASE_HEADER`) and `/speckit-implement --phase N` both need one.
  `V<k>` names the round (research R8).
- Task ids continue the file's sequence, so they match `TASK_LINE`.
- `k` = the number of existing `Verify fixes V*` phases + 1. That count is the
  verify-round counter for `maxVerifyRounds`.
- A fix phase is always in scope, even when the entry has a `tasks` filter.
