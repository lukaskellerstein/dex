# Contract — Agent Registry

**File**: `src/core/agent/registry.ts`

---

## API

```typescript
export function registerAgent(name: string, factory: AgentRunnerFactory): void;
export function createAgentRunner(
  name: string,
  runConfig: RunConfig,
  projectDir: string,
): AgentRunner;
export function getRegisteredAgents(): readonly string[];
```

Built-in registrations live in `src/core/agent/index.ts` and execute at module load:

```typescript
registerAgent("claude", (cfg, dir) => new ClaudeAgentRunner(cfg, dir));
registerAgent("mock",   (cfg, dir) => new MockAgentRunner(cfg, dir));
```

---

## Behavior

### `registerAgent(name, factory)`

- `name` MUST be a non-empty string. Empty or duplicate → throw `Error("registerAgent: '<name>' already registered")` / `"name must be non-empty"`.
- Idempotent for the *same* factory reference (rare, but helps with hot-reload in tests) — double-registering the identical factory is a no-op.
- Registering a *different* factory for an existing name throws — protects against surprise overrides. Tests that want to swap runners use `unregisterAgent` (not exported publicly — test-only).

### `createAgentRunner(name, runConfig, projectDir)`

- Lookup in `AGENT_REGISTRY`:
  - hit → `factory(runConfig, projectDir)` → return `AgentRunner` instance.
  - miss → throw `UnknownAgentError("Unknown agent: '<name>'. Registered: <comma-separated list>")`.
- This function is the **only** place the orchestrator reads from the registry. No other code should branch on `name`.

### `getRegisteredAgents()`

- Returns an immutable snapshot (`readonly string[]`) of the current names. Used by error messages and by the future debug-badge payload.

---

## Testing contract

Vitest suite `src/core/agent/__tests__/registry.test.ts`:

- `registers a factory and createAgentRunner returns an instance of the right class`
- `throws UnknownAgentError listing registered names when name is unknown`
- `throws when registerAgent is called with an empty name`
- `throws when a different factory is registered under an existing name`
- `getRegisteredAgents returns all current names after built-in registration`
- `UnknownAgentError.message contains every registered name exactly once`

---

## Non-goals

- **No DI container.** If runner construction needs more than `(runConfig, projectDir)`, the factory closes over what it needs itself.
- **No plugin discovery.** Registrations are source-visible imports.
- **No per-runner capability flags.** If a runner can't run a stage, it throws at stage time with a clear message. The orchestrator doesn't pre-check.
