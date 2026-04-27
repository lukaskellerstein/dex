# IPC Error Vocabulary — 011-refactoring

**Created**: 2026-04-27
**Source**: `grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error' src/main/ipc/ src/core/`
**Consumer**: Wave C-services (Phase 4) — each `*Service.ts` translates the underlying throw into a typed-error class with a discriminated `code` field.

This document is the **input** for the typed-error work in C3. Each service's `code` union is derived from the throws below grouped by semantic domain. The codes named here are proposals — the service-layer authors lock the final names when they create the classes.

---

## Pre-Refactor Inventory

### Existing typed-error classes (preserve as-is)

| Class | File | Used for |
|---|---|---|
| `AbortError` | `src/core/orchestrator.ts:110` | Abort-signal propagation (internal; surfaces as cancellation) |
| `DexConfigParseError` | `src/core/dexConfig.ts:9` | `<projectDir>/.dex/dex-config.json` JSON parse failure |
| `DexConfigInvalidError` | `src/core/dexConfig.ts:18` | `dex-config.json` shape validation failure |
| `MockConfigParseError` | `src/core/agent/MockConfig.ts:47` | `<projectDir>/.dex/mock-config.json` parse failure |
| `MockConfigInvalidError` | `src/core/agent/MockConfig.ts:56` | mock-config shape validation failure |
| `MockDisabledError` | `src/core/agent/MockConfig.ts:65` | mock runner invoked but `enabled: false` |
| `MockConfigMissingEntryError` | `src/core/agent/MockConfig.ts:72` | mock-config has no entry for the requested phase/step |
| `MockFixtureMissingError` | `src/core/agent/MockConfig.ts:91` | referenced fixture file not on disk |
| `MockConfigInvalidPathError` | `src/core/agent/MockConfig.ts:100` | mock-config path template uses an unknown token |
| `UnknownAgentError` | `src/core/agent/registry.ts:4` | `dex-config.json` names an unregistered agent |

### Untyped throws — `throw new Error("...")` (need translation in C3)

#### `src/core/manifest.ts`

- `:73` `Cannot update feature status: manifest not found`
- `:75` `Cannot update feature status: featureId ${id} not found`
- `:86` `Cannot update specDir: manifest not found`
- `:88` `Cannot update specDir: featureId ${id} not found`

#### `src/core/state.ts`

- `:356` `State lock held by PID ${pid} (acquired at ${ts}). Another Dex instance may be running on this project.`

#### `src/core/runs.ts`

- `:91` `writeRun: invalid runId ${id}`
- `:170` `updateRun: run ${id} not found in ${projectDir}`

#### `src/core/orchestrator.ts`

- `:319` `runPhase called before currentRunner was resolved — run() must set it`
- `:357` `runStage called before currentRunner was resolved — run() must set it`
- `:1241` `Loop mode requires GOAL.md at ${path}`
- `:1433` `Product clarification completed but GOAL_product_domain.md not found`
- `:1450` `Technical clarification completed but GOAL_technical_domain.md not found`
- `:1481` `Synthesis completed but GOAL_clarified.md not found`
- `:1533` `Manifest extraction failed after 2 attempts — structured output was null. Check GOAL_clarified.md format.`
- `:1538` `Manifest extraction failed after 2 attempts — extracted zero features. Check GOAL_clarified.md format.`
- `:1544` `Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check GOAL_clarified.md format.`
- `:1633` `Feature manifest not found — manifest extraction should have run before the loop`
- `:1675` `Gap analysis for ${specDir} returned null structured output — cannot determine RESUME vs REPLAN`
- `:1836` `Specify completed but no new spec directory was created`
- Plus ~10 `throw new AbortError()` sprinkled across the abort-checked sites (these are not errors in the typed-vocabulary sense — they're cancellation signals)

#### `src/core/agent-overlay.ts`

- `:44` `worktree path does not exist: ${worktreePath}`

#### `src/core/agent/MockAgentRunner.ts`

- `:86` `(unconditional throw — message omitted for brevity)` — falls through into `MockConfigMissingEntryError` per surrounding context
- `:222`, `:281`, `:340` — typed throws (already covered above)

#### `src/core/agent/registry.ts`

- `:19` `registerAgent: name must be a non-empty string`
- `:23` `registerAgent: '${name}' already registered with a different factory`
- `:35` `throw new UnknownAgentError(name, getRegisteredAgents())`

#### `src/core/agent/ClaudeAgentRunner.ts`

- `:283` `Structured output validation failed for ${step} — agent could not produce valid JSON matching the schema`

#### `src/main/ipc/`

No `throw new Error` patterns. The IPC layer propagates errors from `src/core/`; `ipcMain.handle` rejects the renderer's promise with the underlying error.

---

## Service → Code Mapping (proposed for C3)

Each service translates the underlying throws above into a typed `code`. Discriminated union; exhaustiveness-checkable in `switch (err.code)`.

### `checkpointService` → `class CheckpointError`

Underlying throws come from `git.ts` (`safeExec` failures) and `checkpoints.ts` (after Phase 2's split, from the 7 sub-files).

```ts
type CheckpointErrorCode =
  | "GIT_DIRTY"           // working tree has uncommitted changes — refuse jumpTo
  | "WORKTREE_LOCKED"     // git worktree lock present
  | "INVALID_TAG"         // tag name doesn't match checkpoint/<...> pattern
  | "TAG_NOT_FOUND"       // requested checkpoint tag doesn't exist
  | "VARIANT_GROUP_MISSING" // variant-group json missing for in-flight variant
  | "BUSY"                // operation already in flight (lock contention)
  | "GIT_FAILURE";        // generic safeExec/gitExec non-zero exit not covered above
```

### `orchestratorService` → `class OrchestratorError`

Underlying throws come from `orchestrator.ts`, `manifest.ts`, `runs.ts`. After Wave A, throws migrate to `stages/*.ts` and `phase-lifecycle.ts` but keep the same semantic domains.

```ts
type OrchestratorErrorCode =
  | "ABORTED"                       // AbortError surfaced
  | "MISSING_GOAL_FILE"              // GOAL.md, GOAL_product_domain.md, GOAL_technical_domain.md, GOAL_clarified.md missing
  | "MANIFEST_NOT_FOUND"             // feature manifest not on disk when expected
  | "MANIFEST_EXTRACTION_FAILED"     // structured-output null or empty after retries
  | "MANIFEST_UPDATE_FAILED"         // featureId not found in existing manifest
  | "GAP_ANALYSIS_FAILED"            // null structured output from gap-analysis
  | "SPEC_NOT_CREATED"               // specify phase reported success but no new spec dir
  | "STRUCTURED_OUTPUT_INVALID"      // ClaudeAgentRunner:283
  | "RUNNER_NOT_INITIALIZED"         // currentRunner-not-set guards (orchestrator:319, 357)
  | "INVALID_RUN_ID";                // runs.ts:91
```

### `projectService` → `class ProjectError`

Underlying throws come from `state.ts` (lock conflicts), `dexConfig.ts`, `manifest.ts` (load failures), and any IPC reach into project file IO.

```ts
type ProjectErrorCode =
  | "STATE_LOCK_HELD"                // state.ts:356 — another Dex instance running
  | "DEX_CONFIG_PARSE_ERROR"         // dexConfig.ts:9 (preserve as-is for ergonomics)
  | "DEX_CONFIG_INVALID"             // dexConfig.ts:18
  | "MANIFEST_NOT_FOUND"             // manifest load failures (separate from orchestrator's MANIFEST_NOT_FOUND — same name, different domain; service prefix disambiguates)
  | "MOCK_CONFIG_PARSE_ERROR"
  | "MOCK_CONFIG_INVALID"
  | "MOCK_DISABLED"
  | "MOCK_CONFIG_MISSING_ENTRY"
  | "MOCK_FIXTURE_MISSING"
  | "MOCK_CONFIG_INVALID_PATH"
  | "UNKNOWN_AGENT"                  // registry.ts:35
  | "FILE_IO_ERROR";                 // generic fs read/write failure
```

### `historyService` → `class HistoryError`

Underlying throws come from `runs.ts`.

```ts
type HistoryErrorCode =
  | "RUN_NOT_FOUND"                  // runs.ts:170
  | "INVALID_RUN_ID"                 // runs.ts:91
  | "RUN_FILE_CORRUPT";              // future — if RunRecord JSON is malformed
```

### `profilesService` → `class ProfilesError`

Underlying throws come from `agent-overlay.ts`, profile-related parts of `dexConfig.ts`.

```ts
type ProfilesErrorCode =
  | "WORKTREE_MISSING"               // agent-overlay.ts:44
  | "PROFILE_INVALID"                // future — when an agent profile fails validation
  | "OVERLAY_FAILED";                // future — copy/symlink failure inside applyOverlay
```

### `windowService` → `class WindowError`

No current backend throws surface here. Reserved for future use.

```ts
type WindowErrorCode = never;        // expand as needed
```

---

## Implementation note for C3

Each service catches the underlying typed/untyped throw and re-throws with the matching `code`. Pattern:

```ts
export const checkpointService = {
  async jumpTo(projectDir: string, target: string): Promise<JumpResult> {
    try {
      return await window.dexAPI.checkpoints.jumpTo(projectDir, target);
    } catch (err: unknown) {
      throw mapToCheckpointError(err);
    }
  },
};

function mapToCheckpointError(err: unknown): CheckpointError {
  const message = err instanceof Error ? err.message : String(err);
  if (/working tree has uncommitted/i.test(message)) {
    return new CheckpointError("GIT_DIRTY", message);
  }
  if (/tag .* not found/i.test(message)) {
    return new CheckpointError("TAG_NOT_FOUND", message);
  }
  // ... exhaustive over the message strings catalogued above
  return new CheckpointError("GIT_FAILURE", message);
}
```

The string-matching is brittle but acceptable in C3 because:
1. The set of underlying throws is finite and enumerated above.
2. Future work can replace string matching by promoting more `throw new Error(...)` sites to typed errors at their source.
3. Discriminated `code` in the service layer is the contract callers depend on; the matching is an implementation detail.

When C3 lands, every entry in the "Untyped throws" inventory above must be reachable through one of the service codes — otherwise consumers can't react to it. A grep + cross-reference at the C3 wave-gate verifies completeness.
