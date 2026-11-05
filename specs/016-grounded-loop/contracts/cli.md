# Contract: `dex` CLI — the 016 additions

Extends [015's contract](../../015-lean-core/contracts/cli.md). Exit codes are
unchanged: 0 done, 1 failed, 2 usage or a refused queue or policy, 3 paused.

## `dex digest <projectDir> <entryId>`

Prints `.dex/digests/<entryId>.md`. Starts nothing and writes nothing.

| Case | Output | Exit |
|---|---|---|
| the digest exists | its Markdown on stdout | 0 |
| no digest for that entry yet | `no digest for <entryId> yet` on stderr | 1 |
| unknown entry id | `unknown entry <entryId>` on stderr | 2 |

## `dex run` — what changes

- When the run pauses on a gate, or an entry is done, the last line before the
  exit is `digest: <absolute path>`.
- A `red_first_green`, `plan_changed`, `tests_changed`, `stalled` or
  `flaky_check` pause exits 3, like every pause.

## `dex run --dry-run` — what changes

Each open entry's block gains a `sensors  :` section, right before its prompt.
Nothing runs:

```text
━━ 003-promo-codes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
decision : tests — specs/003-promo-codes/acceptance.json is missing
…
sensors  :
  fast        unit         npm test -- --changed             300s
  fast        types        npm run typecheck                 120s
  fast        cart unit    npm test -- src/cart              600s   (entry)
  standing    full suite   npm test                         1200s
  acceptance (written by the tests stage)
prompt   :
  …
```

- Once `acceptance.json` is valid, its command is the `acceptance` row, marked
  `(acceptance.json)`. The queue's `acceptance` rows follow it.
- For an entry with `skip: ["tests"]`, the acceptance rows are the queue's. With
  neither, the line reads `acceptance none — the entry will pause before
  implement`.
- An entry whose next step is a pause (no stage) shows only its decision.
