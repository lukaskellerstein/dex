# Contract: `.dex/queue.json` — the 016 additions

Extends [015's contract](../../015-lean-core/contracts/queue-json.md). The
queue stays version 3: both fields are optional, so every 015 queue is still
valid.

## New stage name

`STAGE_NAMES` gains `tests`, between `tasks` and `implement`. So `skip` and
`gates` accept it, and an entry can gate on it (`"gates": ["tests"]`) to review
the tests before any code is written.

## New entry fields

| Field | Type | Rule |
|---|---|---|
| `acceptance` | sensor list | `{name, command, timeoutSec?}`; names unique within the entry; `timeoutSec` default 1800 |
| `checks` | sensor list | same shape; names must not repeat a `policy.checks.fast` name |

An entry with `"skip": ["tests"]` and no `acceptance` is valid in the file. The
picker pauses it (`invalid_input`) before its first `implement` (FR-008), so a
human can add one without editing a broken queue.

## Example

```json
{
  "version": 3,
  "kind": "existing",
  "entries": [
    {
      "id": "002-improvements-1",
      "title": "Catalog improvements",
      "skip": ["brief", "specify", "clarify", "plan", "tasks", "tests"],
      "acceptance": [
        { "name": "catalog api", "command": "npm run test:acceptance -- catalog", "timeoutSec": 600 }
      ]
    },
    {
      "id": "003-promo-codes",
      "title": "Promo codes",
      "brief": "docs/my-specs/003-promo-codes/README.md",
      "checks": [{ "name": "cart unit", "command": "npm test -- src/cart" }]
    }
  ]
}
```
