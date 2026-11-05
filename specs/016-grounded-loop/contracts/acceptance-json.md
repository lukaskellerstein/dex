# Contract: the acceptance record — `<specDir>/acceptance.json`

Written by the `tests` stage's agent, inside its write scope, and committed with
the tests as the project's rules say. Tracked, so it survives a reset and is
reviewed in git. Dex reads it; Dex never writes it (research R3).

## Example

```json
{
  "version": 1,
  "command": "npx playwright test tests/acceptance/003-promo-codes",
  "failExitCodes": [1],
  "timeoutSec": 900,
  "files": [
    "tests/acceptance/003-promo-codes/apply-code.spec.ts",
    "tests/acceptance/003-promo-codes/expired-code.spec.ts"
  ],
  "covers": [
    { "test": "apply-code.spec.ts › a valid code lowers the cart total", "criterion": "SC-001" },
    { "test": "expired-code.spec.ts › an expired code shows an error", "criterion": "SC-003" }
  ]
}
```

## Fields

| Field | Required | Rule |
|---|---|---|
| `version` | yes | `1` |
| `command` | yes | non-empty; runs **only** this entry's acceptance tests |
| `failExitCodes` | no | non-empty integer list without `0`; default `[1]` |
| `timeoutSec` | no | integer ≥ 1; default `1800` |
| `files` | yes | at least one; project-relative; each exists and matches `testGlobs` |
| `covers` | yes | at least one `{test, criterion}`; `criterion` names a success criterion of the spec or an item of the brief's acceptance section |

Unknown fields are rejected.

## Validation outcomes

`parseAcceptance(raw, policy, projectDir)` returns the record or throws
`AcceptanceInvalidError` with the field. After the `tests` stage:

| Case | Outcome |
|---|---|
| the file is missing | treated as a red-first crash (R20) |
| the file does not validate | treated as a red-first crash, with the validation message as the evidence |
| a listed file is missing, or outside `testGlobs` | the same |

When the picker reads the file for a later stage and it does not validate, the
run pauses `invalid_input` with the message: a human, not an agent, broke it.

## Uses

- **Acceptance sensor**: `{name: "acceptance", command, timeoutSec}`, run first
  at red-first and with the queue's `acceptance` at verify.
- **Frozen test set**: `files` and `acceptance.json` itself (research R9). So
  implement and verify can change neither the tests nor the command that runs
  them; a change goes through a test amendment.
- **Red-first key**: sha256 of the file's bytes.
