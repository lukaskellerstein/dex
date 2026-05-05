# Phase 1 — Data Model: Branch Management

**Feature**: 014-branch-management
**Date**: 2026-05-03

This document is the canonical reference for every type the feature introduces or modifies. Code lives in `src/core/checkpoints/branchOps.ts`, `src/core/conflict-resolver.ts`, `src/core/agent/AgentRunner.ts`, and `src/core/dexConfig.ts` (extension).

## 1. AgentRunner extension — `runOneShot`

```ts
// src/core/agent/AgentRunner.ts (modified)

export interface OneShotContext {
  /** Same RunConfig that drives the orchestrator — used for model lookup, allowed-tools resolution, system-prompt assembly. */
  config: RunConfig;
  /** Free-form user prompt sent as the only user turn (or first turn — the agent may continue across maxTurns). */
  prompt: string;
  /** Appended to (not replacing) the project's resolved system prompt. Used by the resolver to install the role-specific instructions. */
  systemPromptOverride?: string;
  /** Tool allowlist passed to the SDK. Defaults to the runner's normal step-mode allowlist when undefined. */
  allowedTools?: string[];
  /** Working dir for the SDK invocation. The conflict resolver always sets this to `projectDir`. */
  cwd?: string;
  abortController: AbortController | null;
  emit: EmitFn;
  rlog: RunLogger;
  /** SDK maxTurns ceiling. Defaults to 1 (one assistant turn) when undefined. */
  maxTurns?: number;
}

export interface OneShotResult {
  /** USD; 0 for non-SDK runners (MockAgentRunner). */
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  /** The agent's last assistant message (text only). Used by callers that want a free-form reply. */
  finalText: string;
  /** True iff the SDK ended its stream cleanly — no abort, no error, no max-turns cutoff. */
  finishedNormally: boolean;
}

export interface AgentRunner {
  runStep(ctx: StepContext): Promise<StepResult>;
  runTaskPhase(ctx: TaskPhaseContext): Promise<TaskPhaseResult>;
  runOneShot(ctx: OneShotContext): Promise<OneShotResult>;   // NEW
}
```

**MockAgentRunner extension**: `MockConfig` gains an optional `oneShotResponses` array. Each entry is matched against the prompt by exact-match on a regex; the first match wins. Each response specifies `finalText`, `cost`, `inputTokens`, `outputTokens`, optional `editFile` (path + new contents the mock should write — used by resolver tests to simulate a successful edit), and optional `finishedNormally` (default `true`). Unmatched prompts return a default success record so a test author doesn't have to script every prompt the resolver might send.

## 2. Branch operations — `branchOps.ts`

```ts
// src/core/checkpoints/branchOps.ts (new)

export interface DeleteBranchOpts {
  /** When true, the lost-work check is skipped — caller has confirmed loss. */
  confirmedLoss?: boolean;
}

export type DeleteBranchResult =
  | { ok: true; deleted: string; switchedTo: string | null }
  | { ok: false; error: "not_dex_owned"; branch: string }
  | { ok: false; error: "is_protected"; branch: string }                    // main / master
  | { ok: false; error: "no_primary_to_switch_to" }                         // HEAD on target, neither main nor master exists
  | { ok: false; error: "would_lose_work"; lostSteps: LostStep[] }          // Caller should re-call with confirmedLoss: true.
  | { ok: false; error: "branch_in_active_run"; branch: string }
  | { ok: false; error: "git_error"; message: string };

export interface LostStep {
  /** Plain-English label, e.g. "Cycle 2 — Plan". */
  label: string;
  /** First 7 chars of the commit SHA. */
  shortSha: string;
}

export interface MergeToMainOpts {
  /** save | discard | undefined (no dirty tree). Same shape as JumpToOpts.force. */
  force?: "save" | "discard";
  /** Caller may pass a per-promotion override of conflictResolver.* — defaults pulled from dex-config.json. */
  resolverOverride?: Partial<ConflictResolverConfig>;
}

export type MergeToMainResult =
  | { ok: true; mode: "clean"; mergeSha: string; deletedSource: string }
  | { ok: true; mode: "resolved"; mergeSha: string; deletedSource: string; resolverCostUsd: number; resolvedFiles: string[] }
  | { ok: false; error: "dirty_working_tree"; files: string[] }             // returned only when opts.force is undefined
  | { ok: false; error: "not_dex_owned"; branch: string }
  | { ok: false; error: "branch_in_active_run"; branch: string }
  | { ok: false; error: "main_in_active_run" }
  | { ok: false; error: "no_primary_branch" }
  | { ok: false; error: "non_content_conflict"; kinds: NonContentConflictKind[] }
  | { ok: false; error: "resolver_failed"; reason: ResolverFailReason; partialMergeSha: string | null }
  | { ok: false; error: "git_error"; message: string };

export type NonContentConflictKind = "rename_delete" | "binary" | "submodule" | "both_added" | "both_deleted";
```

**Discriminated-union pattern** mirrors `JumpToResult` so the IPC layer can pattern-match on `error` strings without invariant strings of its own. Each error variant carries exactly the data the renderer needs for the user-visible copy lookup in `branchOps/copy.ts`.

## 3. Conflict resolver — `conflict-resolver.ts`

```ts
// src/core/conflict-resolver.ts (new)

export interface ConflictResolverConfig {
  /** Override the orchestrator model. null → fall back to dex-config.json top-level `model`. */
  model: string | null;
  maxIterations: number;            // default 5
  maxTurnsPerIteration: number;     // default 5
  costCapUsd: number;               // default 0.50
  /** Shell command to run after resolution. null skips verification. */
  verifyCommand: string | null;     // default "npx tsc --noEmit"
}

export interface ResolverContext {
  projectDir: string;
  sourceBranch: string;
  /** Files git status reports as unmerged. Caller has already classified them as content-conflicts. */
  conflictedPaths: string[];
  runner: AgentRunner;
  config: ConflictResolverConfig;
  /** RunConfig the resolver embeds into each OneShotContext. */
  runConfig: RunConfig;
  emit: EmitFn;
  abortController: AbortController | null;
  rlog: RunLogger;
}

export type ResolverFailReason =
  | "max_iterations"
  | "cost_cap"
  | "verify_failed"
  | "agent_gave_up"
  | "user_cancelled";

export type ResolverResult =
  | { ok: true; costUsd: number; resolvedFiles: string[]; durationMs: number }
  | { ok: false; reason: ResolverFailReason; costUsd: number; resolvedFiles: string[]; failedFiles: string[]; durationMs: number };

export async function resolveConflicts(ctx: ResolverContext): Promise<ResolverResult>;
```

### Per-file iteration state machine

Each file in `conflictedPaths` cycles through:

```
PENDING ─runOneShot(prompt)──▶ EDITED ─verify-content──▶ DONE
                                  │
                                  └─markers-still-present──▶ FAILED
```

- `PENDING` — file not yet touched in this resolver invocation.
- `EDITED` — `runOneShot` returned `finishedNormally: true`.
- `DONE` — re-read of the file shows zero `<<<<<<<`, `=======`, `>>>>>>>` markers.
- `FAILED` — markers remain after the iteration; counts against `maxIterations`.

The harness emits one `conflict-resolver:file-start` event on entry to a file and one `conflict-resolver:file-done` event on transition to `DONE` or `FAILED` (with `ok: true | false`). Between files, `conflict-resolver:iteration` carries the running iteration counter and `costSoFar`. On terminal exit, `conflict-resolver:done` with the final `ok` and `costTotal`.

### Cost accounting

Single `costUsd` field accumulated across all `runOneShot` results. Before each iteration the harness checks `costSoFar + estimatedNext > config.costCapUsd`. The estimate is `prevIterationCost` (or `0.05` for the first iteration). On overshoot, the harness halts before invoking the next iteration and returns `reason: "cost_cap"`.

## 4. DexConfig extension

```ts
// src/core/dexConfig.ts (modified)

export interface DexConfig {
  agent: string;                                    // existing
  model?: string;                                   // existing (top-level model)
  conflictResolver?: Partial<ConflictResolverConfig>; // NEW
}

export const DEFAULT_CONFLICT_RESOLVER_CONFIG: ConflictResolverConfig = {
  model: null,
  maxIterations: 5,
  maxTurnsPerIteration: 5,
  costCapUsd: 0.50,
  verifyCommand: "npx tsc --noEmit",
};
```

The loader merges any user-supplied `conflictResolver` field over `DEFAULT_CONFLICT_RESOLVER_CONFIG` field-by-field. Missing file or missing `conflictResolver` key → defaults are used unmodified. Schema validation:

- `model`: string or null
- `maxIterations`: integer ≥ 1
- `maxTurnsPerIteration`: integer ≥ 1
- `costCapUsd`: number ≥ 0
- `verifyCommand`: string or null (empty string normalised to null)

Out-of-range values throw `DexConfigInvalidError` (consistent with the existing schema-violation behaviour for the top-level `agent` field).

## 5. Event-stream additions

The following event types appear on the existing `orchestrator:event` channel during `mergeToMain` execution. The renderer subscribes for the duration of the promotion and unsubscribes on terminal `done`/`abort`.

```ts
type ConflictResolverEvent =
  | { type: "conflict-resolver:file-start"; file: string; index: number; total: number }
  | { type: "conflict-resolver:file-done"; file: string; ok: boolean; iterationsUsed: number }
  | { type: "conflict-resolver:iteration"; n: number; costSoFar: number; currentFile: string }
  | { type: "conflict-resolver:done"; ok: boolean; costTotal: number; reason?: ResolverFailReason };
```

`index`/`total` on `file-start` enable the progress modal's "Resolving disagreement #3 of 7" copy without the modal having to count files itself.

## 6. Entity → spec-FR mapping

| Entity | Spec FR coverage |
|---|---|
| `DeleteBranchOpts.confirmedLoss` | FR-004 (lost-work modal flow) |
| `DeleteBranchResult.error` variants | FR-002, FR-003, FR-005, FR-031 |
| `LostStep` | FR-004, US1-AS3 acceptance |
| `MergeToMainResult.mode === "clean"` | FR-014, US2-AS2 |
| `MergeToMainResult.mode === "resolved"` | US3-AS2 success path |
| `MergeToMainResult.error === "non_content_conflict"` | FR-020, US3-AS4 |
| `MergeToMainResult.error === "resolver_failed"` | FR-022, US4-AS1/2 |
| `MergeToMainResult.error === "branch_in_active_run"` | FR-012, US2-AS4 |
| `MergeToMainResult.error === "dirty_working_tree"` | FR-013, US2-AS5 |
| `ResolverFailReason === "cost_cap"` | FR-019, SC-008, US3-AS5 |
| `ResolverFailReason === "user_cancelled"` | FR-021, US3-AS3 |
| `ResolverFailReason === "verify_failed"` | FR-018, US4-AS2 |
| `ConflictResolverEvent` | FR-017, US3-AS1, copy module |
| `ConflictResolverConfig` | FR-026, FR-027 |

Every functional requirement maps to at least one type-level enforcement. Every type-level enforcement maps to at least one acceptance scenario.
