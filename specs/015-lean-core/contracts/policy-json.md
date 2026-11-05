# Contract: `.dex/policy.json` and the permission chain

Tracked in the project's git, owned by the project. Types, defaults and
validation: [`../data-model.md`](../data-model.md) § Policy. Why the chain
looks like this: [`../research.md`](../research.md) R6.

## Example (shape of `onion-demo-01`'s policy, abridged)

```json
{
  "settingSources": ["user", "project", "local"],
  "permissionMode": "default",
  "env": { "CLAUDE_NO_WORKTREE": "1" },
  "deny": [
    { "tool": "Bash", "pattern": "\\bgit\\s+push\\b[^\\n]*(\\s--force\\b|\\s-f\\b|--force-with-lease|--delete\\b|--mirror\\b|--tags\\b)", "reason": "no force, delete, mirror or tag-all pushes" },
    { "tool": "Bash", "pattern": "\\bgit\\s+push\\b[^\\n]*\\s(origin\\s+)?(main|master)\\b", "reason": "never push to main/master" },
    { "tool": "Bash", "pattern": "\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]*f|merge|rebase|worktree)\\b", "reason": "history-rewriting git commands are the owner's" },
    { "tool": "Bash", "pattern": "\\bkubectl\\s+(delete|apply|create(?!\\s+job\\s+--from=)|replace|patch|edit|scale|drain|cordon|taint)\\b", "reason": "helm is the only deploy path" },
    { "tool": "Bash", "pattern": "\\bhelm\\s+(uninstall|delete|rollback)\\b", "reason": "destructive helm commands are the owner's" },
    { "tool": "Bash", "pattern": "\\bsops\\s+(-d|--decrypt|decrypt|edit|exec-env)\\b", "reason": "secrets are never decrypted by an agent" },
    { "tool": "*", "pattern": "mgmt-01|rancher\\.cellarwood\\.org", "reason": "the management cluster is off limits" }
  ],
  "ask": [],
  "writeRoots": ["."],
  "frozen": ["workload/onion-poc-report/thresholds.md", "workload/onion-poc-report/claim*.md", "workload/onion-poc-report/*-thresholds.md"],
  "preflight": ["kubectl config current-context | grep -q '^onion-demo-01'", "timeout 15 kubectl get ns >/dev/null"],
  "repos": ["workload/*", "workload/sectors/*", "workload/tenants/*"],
  "systemPromptAppend": ".dex/loop-rules.md",
  "questions": "recommended-then-review",
  "openPullRequest": false,
  "limits": { "maxBudgetUsdPerStage": 15, "maxBudgetUsdPerRun": 120, "maxImplementRunsWithoutProgress": 2, "maxVerifyRounds": 3 }
}
```

The owner writes the real file in that repo. The table tests in this repo carry
the rules above as fixtures, one passing and one blocked command each.

## `decideToolUse(policy, call, env)` — pure

```ts
type ToolCall = { toolName: string; input: Record<string, unknown> };
type PolicyEnv = { projectDir: string; tmpDir: string; isTrackedAtHead: (absPath: string) => boolean };
type PolicyDecision =
  | { kind: "deny"; rule: "deny" | "writeRoots" | "frozen"; reason: string }
  | { kind: "ask"; reason: string }
  | { kind: "none" };
```

Order, first match wins:

1. `deny` rules whose `tool` is the call's tool or `"*"`, `pattern` tested on the subject.
2. Write tools (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) only:
   - the resolved target outside every `writeRoots` entry and outside `tmpDir`
     → `deny` (`writeRoots`);
   - the target matching a `frozen` glob and tracked at HEAD → `deny` (`frozen`).
3. `ask` rules, same matching as `deny`.
4. `none`.

`isTrackedAtHead` is injected, so the function stays pure and table-testable.
The runner passes a `git cat-file -e HEAD:./<rel>` probe: a frozen file counts
once it is committed, and a file that is only staged does not. `systemPromptAppend`
is `null` when absent.

## The chain at runtime

```mermaid
flowchart TD
  T[tool call] --> H{"Dex PreToolUse<br/>decideToolUse"}
  H -->|deny| D1["denied + reason<br/>policy_denied event"]
  H -->|ask| CU
  H -->|"none → {}"| SD{"project settings<br/>deny rules"}
  SD -->|match| D2[denied by project]
  SD -->|no| SA{"project settings<br/>ask rules"}
  SA -->|match| CU
  SA -->|no| M{"permission mode +<br/>allow rules"}
  M -->|allowed| RUN[runs]
  M -->|needs approval| CU{"Dex canUseTool"}
  CU -->|"AskUserQuestion"| Q[humanInput question]
  CU -->|"policy ask or settings ask rule"| A["humanInput tool_approval<br/>agent waits"]
  CU -->|"no ask anywhere"| RUN
  A -->|approve| RUN
  A -->|"deny / Stop"| D3[denied + message]
```

## Where it runs

`agent/permissions.ts` holds the chain, so it is tested without the SDK:
`preToolUseDecision` (the PreToolUse hook: a policy `deny` returns `deny` and emits
`policy_denied`; an `ask` returns `ask`; otherwise `{}`; after Stop it denies with
"Run stopped by user"; it never returns `allow`) and `makeCanUseTool`
(`AskUserQuestion` goes to `humanInput`; a policy `ask`, or a settings ask rule
that the SDK reports as `matchedAskRule` or as `decisionReasonType: "rule"`, holds
the call as a `tool_approval` with source `policy` or `settings`; anything else is
allowed; a policy `deny` stays a deny even if the hook did not run). A settings
ask rule that matches only one part of a compound command arrives as
`"subcommandResults"` and is allowed (research R6, Known gap); a policy `ask`
pattern catches it. `agent/claudeSession.ts` `buildQueryOptions(policy)` turns the policy
into SDK options: `settingSources`, `permissionMode`, `env: { ...process.env,
...policy.env, ...stageEnv }`, the `claude_code` preset system prompt with the
append file, `maxTurns = min(config.maxTurns, limits.maxTurnsPerStage)` and
`maxBudgetUsd = limits.maxBudgetUsdPerStage`. The SDK's
`allowDangerouslySkipPermissions` is set only when a new project's policy asks for
`bypassPermissions`. A stage that ends on `error_max_turns` or
`error_max_budget_usd` reports `limitHit` (`turns` / `budget`) and the run pauses
`limit_reached`.

## What the refusal looks like

`permissionMode: "bypassPermissions"` in an `existing` project → `run()` emits
`error` with:

> `<projectDir>/.dex/policy.json: permissionMode "bypassPermissions" is refused for an existing project — the project's own permission rules would be skipped.`

and the CLI exits 2. This check, in `policy.ts`, is the only place the string
`bypassPermissions` appears in `src/` (SC-006).
