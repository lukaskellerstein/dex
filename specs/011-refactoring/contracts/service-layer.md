# Contract: Renderer service layer

**Modules**: `src/renderer/services/{checkpointService, orchestratorService, projectService, historyService, profilesService, windowService}.ts` (NEW, Wave C-services).
**Status**: Required by Wave C end-gate.

## Purpose

Wrap every IPC call from the renderer through one of six typed services. After Wave C, no component or hook outside `src/renderer/services/` references `window.dexAPI`. A single change to an IPC call shape touches one service file plus its callers — never 14 files.

## Surface

`window.dexAPI` is assembled in `src/main/preload.ts` from 4 flat-merged groups (`projectApi`, `orchestratorApi`, `historyApi`, `windowApi` — all spread into the top-level object) plus 2 nested namespaces (`checkpoints`, `profiles`). The service layer normalizes this — all 6 services use the typed-object shape regardless of how preload exposes the underlying call.

| Service | Wraps | Methods (representative) |
|---|---|---|
| `checkpointService` | `dexAPI.checkpoints.*` | `listTimeline`, `jumpTo`, `commit`, `promote`, `unmark`, `estimateVariantCost`, `spawnVariants` |
| `orchestratorService` | `dexAPI.{startRun, stopRun, answerQuestion, getRunState, onOrchestratorEvent}` | `startRun`, `stopRun`, `answerQuestion`, `getRunState`, `subscribeEvents` |
| `projectService` | `dexAPI.{openProject, listSpecs, parseSpec, …}` | `openProject`, `listSpecs`, `parseSpec`, `readFile`, `writeFile` |
| `historyService` | `dexAPI.{listRuns, getRun, getPhaseSteps, getPhaseSubagents}` | `listRuns`, `getRun`, `getPhaseSteps`, `getPhaseSubagents` |
| `profilesService` | `dexAPI.profiles.*` | `list`, `get`, `saveDexJson`, `delete` |
| `windowService` | `dexAPI.{minimize, maximize, close}` | `minimize`, `maximize`, `close` |

## Shape

Each service is a flat object of typed async functions plus an exported error class:

```ts
// checkpointService.ts
export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = "CheckpointError";
    this.code = code;
  }
}

export type CheckpointErrorCode =
  | "NOT_FOUND"
  | "BUSY"
  | "GIT_DIRTY"
  | "INVALID_TAG"
  | "WORKTREE_LOCKED"
  | "VARIANT_GROUP_MISSING"
  // ... full list from error-codes.md

export const checkpointService = {
  async listTimeline(projectDir: string): Promise<TimelineSnapshot> { /* ... */ },
  async jumpTo(projectDir: string, target: string): Promise<JumpResult> { /* ... */ },
  async commit(projectDir: string, params: CommitParams): Promise<void> { /* ... */ },
  // ...
};
```

The exported `code` union is enumerated in Pre-Wave from `src/main/ipc/` + `src/core/` via:

```bash
grep -rn 'throw new Error\|throw new [A-Z][a-zA-Z]*Error' src/main/ipc/ src/core/
```

…and committed to `docs/my-specs/011-refactoring/error-codes.md` before C3 starts.

## Invariants

1. **Single point of `window.dexAPI` reference per service.** Each service file references `window.dexAPI` exactly at its module-import surface (or via a thin internal helper); consumers never reach in.
2. **No `window.dexAPI` reference outside `src/renderer/services/`.** Enforced by the wave gate:
   ```bash
   grep -rn 'window\.dexAPI' src/renderer | grep -v '^src/renderer/services/'
   ```
   Returns zero matches at the end of Wave C. Non-zero is a refactor failure.
3. **All 14 current consumers migrate in Wave C.** The list (12 components + `useProject` + `useTimeline`) is enumerated up-front from a grep in Pre-Wave. Half-migration is forbidden.
4. **Typed errors are part of the exported surface.** Consumers `import { CheckpointError } from "@/services/checkpointService"` and use `switch (err.code)` for exhaustiveness checking.
5. **`subscribeEvents` returns an unsubscribe function**, matching the existing `onOrchestratorEvent` pattern. The service does not hide that.

## Migration order (informational, in C3)

C3's git history within Wave C-services follows this order — each commit migrates one consumer:

1. Land all 6 service files at once (no consumers wired yet).
2. Migrate `useProject` and `useTimeline` (2 hooks).
3. Migrate the 12 components in alphabetical order.
4. Add the wave-gate grep to `npm run check:size`'s sibling check (or run it inline at the gate).
5. Smoke + golden-trace diff.

## Test contract

Each service has a unit test under `src/renderer/services/__tests__/<service>.test.ts` (Wave D Path A — vitest). The test mocks `window.dexAPI` with a fake object and asserts:

- Each method calls the expected `dexAPI.*` path with the right arguments.
- Errors thrown by the IPC fake are translated into the typed error class with the right `code`.
- `subscribeEvents` returns a working unsubscribe function (the orchestrator-service test fakes the event bus).

The first delivered test (`checkpointService.test.ts`) is required as part of Wave D. The remaining five are nice-to-have but not gating.

## Non-goals

- This contract does **not** change the `window.dexAPI` shape. Preload-side surgery is out of scope.
- This contract does **not** introduce reactive wrappers (Promises, Observables) beyond what the underlying IPC already returns. Service methods are 1:1 with IPC calls.
- This contract does **not** add caching or retry logic. Consumers handle their own.

## References

- Spec FR-005, FR-006, FR-011, SC-003, SC-009.
- Research R-006 — typed-error vocabulary up-front.
- Research R-005 — services before hooks (C3 before Wave B).
