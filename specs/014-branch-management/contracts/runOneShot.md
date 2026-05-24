# Interface Contract: `AgentRunner.runOneShot`

**Module**: `src/core/agent/AgentRunner.ts`
**Implementations**: `ClaudeAgentRunner` (production), `MockAgentRunner` (tests)
**Used by**: `src/core/conflict-resolver.ts` (v1 sole caller; the interface is generic so future ad-hoc agent invocations reuse it).

## Method signature

```ts
runOneShot(ctx: OneShotContext): Promise<OneShotResult>
```

See [data-model.md §1](../data-model.md#1-agentrunner-extension--runoneshot) for the type definitions.

## Behaviour invariants — all implementations

1. **Free-form invocation**. No structured-output schema, no spec dir, no cycle context. The caller controls the entire prompt and receives the agent's last assistant text back.
2. **CWD is honoured**. When `ctx.cwd` is set, the SDK invocation runs with that working directory; native config discovery (e.g. `.claude/CLAUDE.md`) picks up the file tree at `ctx.cwd`. When unset, the runner uses `ctx.config.projectDir`.
3. **System prompt composition**. The runner assembles the project's normal system prompt (same logic as `runStep` and `runTaskPhase`) and **appends** `ctx.systemPromptOverride` (if any). It does not replace the project prompt — that would lose the user's installed `CLAUDE.md` rules.
4. **Tool allowlist**. `ctx.allowedTools` is passed straight through to the SDK. When undefined, the runner uses its normal step-mode allowlist (so the resolver always passes an explicit list to lock down to `["Read", "Edit"]`).
5. **maxTurns**. Defaults to 1 when undefined. The conflict resolver passes 5 (configurable per-iteration).
6. **Cost reporting**. `cost` is the SDK-reported total for this invocation in USD. For mock runners that don't call the SDK, `cost` is whatever the scripted response specifies (default 0).
7. **finishedNormally**. `true` iff the SDK ended its message stream cleanly (last message is an assistant message, no abort signal fired, no error event). `false` for: aborts (caller-initiated or otherwise), max-turns cutoff, error events, agent giving up via `tool_use` of an unrecoverable kind. The conflict resolver treats `false` as "this iteration didn't produce a usable edit" without attempting to extract `finalText`.
8. **Token reporting**. `inputTokens` / `outputTokens` are SDK totals across all turns within this invocation.
9. **Abort**. When `ctx.abortController.signal` fires, the runner propagates the abort to the SDK and rejects the Promise with the abort reason. (Convention follows the existing `runStep` and `runTaskPhase` shapes.)
10. **No persistence**. The runner emits step events via `ctx.emit` (so live UI tracing still works), but it does **not** write to `~/.dex/logs/<project>/<runId>/...` because the resolver invocation isn't part of a run. (The harness logs through `ctx.rlog` for diagnostics.)

## ClaudeAgentRunner implementation contract

`ClaudeAgentRunner.runOneShot` wraps `query()` from `@anthropic-ai/claude-agent-sdk`. The SDK call:

```ts
query({
  prompt: ctx.prompt,
  options: {
    cwd: ctx.cwd ?? ctx.config.projectDir,
    model: ctx.config.model,
    systemPromptAppend: ctx.systemPromptOverride,
    allowedTools: ctx.allowedTools,
    maxTurns: ctx.maxTurns ?? 1,
    abortSignal: ctx.abortController?.signal,
  },
})
```

The async iterator is consumed; on each yielded message:

- `assistant` messages: append text to a buffer, update `lastAssistantText`.
- `result` messages: capture cost, durationMs, inputTokens, outputTokens; mark `finishedNormally = true`.
- `error` / `abort` events: mark `finishedNormally = false`; rethrow if abort, else continue to drain.

Returned `OneShotResult.finalText` is `lastAssistantText`. When no assistant message arrived (e.g. immediate abort), `finalText` is `""`.

## MockAgentRunner implementation contract

`MockAgentRunner.runOneShot` looks up `ctx.prompt` against `MockConfig.oneShotResponses`:

```ts
interface MockOneShotResponse {
  matchPrompt: string | RegExp;        // string is exact-match; RegExp is .test()
  finalText: string;
  cost?: number;                        // default 0
  inputTokens?: number;                 // default 0
  outputTokens?: number;                // default 0
  finishedNormally?: boolean;           // default true
  /** When set, the mock writes `editFile.content` to `editFile.path` (relative to ctx.cwd) before returning. */
  editFile?: { path: string; content: string };
  /** Simulated invocation latency. Default 0. */
  delayMs?: number;
}
```

First match wins. If no entry matches, the mock returns:

```ts
{
  cost: 0, durationMs: 0, inputTokens: 0, outputTokens: 0,
  finalText: "(mock default — no oneShotResponses entry matched)",
  finishedNormally: true,
}
```

This permissive default is intentional: tests that don't care about the resolver path don't have to script every prompt the harness might send.

## Error semantics

`runOneShot` rejects (does not return `{ ok: false }`) only on:

- `AbortError` from the SDK (caller-initiated abort).
- Programmer error (missing `ctx.prompt`, invalid `ctx.config`).

Domain-level "agent gave up" is encoded in `finishedNormally: false` on the resolved result, **not** as a rejection. This keeps the harness's control flow flat (no nested try/catch per iteration).

## Logging discipline

Each invocation writes one structured log line at `INFO`:

```
[INFO] runOneShot: cost=$<n> turns=<n> tools=<allowedTools> finishedNormally=<bool>
```

Plus the per-message event emits via `ctx.emit` (consistent with `runStep`). The conflict-resolver harness layers its own progress events on top via the same `emit` callback.

## What `runOneShot` is NOT

- **Not** a replacement for `runStep`. Cycle steps need structured output, spec-dir context, agent-profile resolution — none of which `runOneShot` provides.
- **Not** a replacement for `runTaskPhase`. Build-mode tasks need TodoWrite plumbing.
- **Not** a long-lived agent session. Each invocation is one bounded `query()` call. State carries over only via filesystem changes the agent made.
- **Not** allowed to install MCP servers. The MCP surface for v1 callers is empty by construction (resolver passes `["Read", "Edit"]`).

## Test surface

- `src/core/agent/__tests__/runOneShot.test.ts` — `MockAgentRunner.runOneShot` matches scripted responses, applies `editFile` writes, honours `delayMs`, returns the documented default for unmatched prompts.
- `src/core/__tests__/conflictResolver.test.ts` — exercises `runOneShot` end-to-end through the harness against `MockAgentRunner` with realistic `oneShotResponses` arrays.
- `ClaudeAgentRunner.runOneShot` is **integration-tested only** by the resolver tests when run with `DEX_AGENT=claude` (off by default in CI). The interface contract is the only guarantee; the implementation is a thin shim over the SDK.
