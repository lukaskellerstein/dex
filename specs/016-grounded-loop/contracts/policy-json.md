# Contract: `.dex/policy.json` — the 016 additions

Extends [015's contract](../../015-lean-core/contracts/policy-json.md). Every
015 field and rule stays as it is. Unknown fields stay rejected.

## Example

```json
{
  "checks": {
    "fast": [
      { "name": "unit", "command": "npm test -- --changed", "timeoutSec": 300 },
      { "name": "types", "command": "npm run typecheck", "timeoutSec": 120 }
    ],
    "standing": [
      { "name": "full suite", "command": "npm test", "timeoutSec": 1200 }
    ],
    "rerunOnFail": 1
  },
  "testGlobs": ["tests/**", "**/*.test.ts"],
  "testSupport": ["package.json", "package-lock.json", "playwright.config.*"],
  "verify": { "browser": true }
}
```

## Fields

| Field | Type | Default | Rule |
|---|---|---|---|
| `checks` | object | `{fast: [], standing: [], rerunOnFail: 1}` | only these three keys |
| `checks.fast` | sensor list | `[]` | each `{name, command, timeoutSec?}`; names unique; `timeoutSec` default 600 |
| `checks.standing` | sensor list | `[]` | same shape |
| `checks.rerunOnFail` | integer | `1` | 0 … 5 |
| `testGlobs` | string list | below | non-empty when present; `path.matchesGlob` syntax, like `frozen` |
| `testSupport` | string list | below | same syntax |
| `verify` | object | `{browser: false}` | only `browser` |
| `verify.browser` | boolean | `false` | the verifier in review mode works the feature in a browser (Playwright MCP) |

Default `testGlobs`:

```json
["**/test/**", "**/tests/**", "**/__tests__/**", "**/e2e/**",
 "**/*.test.*", "**/*.spec.*", "**/test_*.py", "**/*_test.py", "**/*_test.go"]
```

Default `testSupport`:

```json
["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
 "playwright.config.*", "vitest.config.*", "jest.config.*",
 "pytest.ini", "pyproject.toml", "uv.lock", "**/conftest.py", "go.mod", "go.sum"]
```

`dex queue init` writes every default spelled out, as 015 does.

## `decideToolUse(policy, call, env, scope?)`

015's order stays: deny rules → write roots and frozen files → ask rules → no
opinion. The optional `scope` (data-model § Stage scope) adds two checks right
after the deny rules:

1. A write tool whose target matches a `scope.protect` path, or a Bash command
   that names a `protect` path after `rm`, `mv`, `git rm`, `git mv`, `unlink`
   or `>` → `{kind: "deny", rule: "scope", reason: "<path> is a frozen acceptance test of <id>; ask for a test amendment instead"}`.
2. A write tool whose target matches none of `scope.writeOnly` (when set) →
   `{kind: "deny", rule: "scope", reason: "the <stage> stage may write only <globs>"}`.

`PolicyDecision.rule` gains `"scope"`. The `policy_denied` event carries it.

## Table cases (SC-001)

| Stage | Call | Expected |
|---|---|---|
| `tests` | Write `tests/acceptance/x.spec.ts` | none |
| `tests` | Write `src/cart/promo.ts` | deny (scope) |
| `tests` | Edit `package.json` | none (`testSupport`) |
| `implement` | Edit a frozen test, untracked | deny (scope) |
| `implement` | Bash `rm tests/acceptance/x.spec.ts` (frozen) | deny (scope) |
| `implement` | Write `src/cart/promo.ts` | none |
| `verify` | Edit `specs/003-promo-codes/tasks.md` | none |
| `verify` | Edit `src/cart/promo.ts` | deny (scope) |
| any | a policy `deny` match | deny (deny), checked first |
