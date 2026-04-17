# Contract: History IPC Handlers

**Status**: Authoritative for the `window.dexAPI` history methods and their main-process IPC channels after this feature lands.

## Summary of changes

- All eight existing `history:*` handlers are preserved (FR-008).
- Five handlers gain a new leading `projectDir: string` parameter (FR-014) — three already have it; five do not.
- The return-type shapes change from snake_case SQL rows to camelCase records; field sets are preserved (FR-003).

---

## Channel contracts

| IPC channel                         | Old signature                                                                      | New signature                                                                                     |
|---                                  |---                                                                                 |---                                                                                                 |
| `history:list-runs`                 | `(limit?: number) => RunRow[]`                                                     | `(projectDir: string, limit?: number) => RunRecord[]`                                              |
| `history:get-run`                   | `(runId: string) => { run: RunRow; phases: PhaseTraceRow[] } \| null`              | `(projectDir: string, runId: string) => RunRecord \| null`                                         |
| `history:get-latest-project-run`    | `(projectDir: string) => { run: RunRow; phases: PhaseTraceRow[]; loopCycles: LoopCycleRow[] } \| null` | `(projectDir: string) => RunRecord \| null` *(loopCycles derivable via `cycleSummary`)* |
| `history:get-phase-steps`           | `(phaseTraceId: string) => TraceStepRow[]`                                         | `(projectDir: string, runId: string, phaseTraceId: string) => StepRecord[]`                       |
| `history:get-phase-subagents`       | `(phaseTraceId: string) => SubagentRow[]`                                          | `(projectDir: string, runId: string, phaseTraceId: string) => SubagentRecord[]`                    |
| `history:get-latest-phase-trace`    | `(projectDir: string, specDir: string, phaseNumber: number) => PhaseTraceRow \| null` | `(projectDir: string, specDir: string, phaseNumber: number) => PhaseRecord \| null`               |
| `history:get-spec-phase-stats`      | `(projectDir: string, specDir: string) => PhaseTraceRow[]`                         | `(projectDir: string, specDir: string) => PhaseRecord[]`                                           |
| `history:get-spec-aggregate-stats`  | `(projectDir: string, specDir: string) => SpecStats`                               | `(projectDir: string, specDir: string) => SpecStats`                                               |

### Old → new type renames

| Old type         | New type          | Source module       |
|---               |---                |---                  |
| `RunRow`          | `RunRecord`        | `src/core/runs.ts`  |
| `PhaseTraceRow`   | `PhaseRecord`      | `src/core/runs.ts`  |
| `SubagentRow`     | `SubagentRecord`   | `src/core/runs.ts`  |
| `TraceStepRow`    | `StepRecord`       | `src/core/runs.ts`  |
| `LoopCycleRow`    | *(removed — derived)* | *(N/A; use `cycleSummary(run)`)* |
| `SpecStats`       | `SpecStats`        | `src/core/runs.ts` (moved from `database.ts`) |

---

## Handler implementations

All handlers register in `src/main/ipc/history.ts`. Main-process contract:

```ts
import { ipcMain } from "electron";
import * as runs from "../../core/runs.js";

export function registerHistoryHandlers(): void {
  ipcMain.handle("history:list-runs", (_e, projectDir: string, limit?: number) =>
    runs.listRuns(projectDir, limit));

  ipcMain.handle("history:get-run", (_e, projectDir: string, runId: string) =>
    runs.readRun(projectDir, runId));

  ipcMain.handle("history:get-latest-project-run", (_e, projectDir: string) => {
    const list = runs.listRuns(projectDir, 1);
    return list[0] ?? null;
  });

  ipcMain.handle("history:get-phase-steps",
    (_e, projectDir: string, runId: string, phaseTraceId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      const phase = run.phases.find(p => p.phaseTraceId === phaseTraceId);
      if (!phase) return [];
      const slug = phase.phaseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return runs.readSteps(projectDir, runId, slug, phase.phaseNumber);
    });

  ipcMain.handle("history:get-phase-subagents",
    (_e, projectDir: string, runId: string, phaseTraceId: string) => {
      const run = runs.readRun(projectDir, runId);
      if (!run) return [];
      return run.phases.find(p => p.phaseTraceId === phaseTraceId)?.subagents ?? [];
    });

  ipcMain.handle("history:get-latest-phase-trace",
    (_e, projectDir: string, specDir: string, phaseNumber: number) => {
      const list = runs.listRuns(projectDir);
      for (const run of list) {
        const phase = run.phases
          .filter(p => (p.specDir === specDir || p.specDir === null) && p.phaseNumber === phaseNumber)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (phase) return phase;
      }
      return null;
    });

  ipcMain.handle("history:get-spec-phase-stats",
    (_e, projectDir: string, specDir: string) => {
      const list = runs.listRuns(projectDir);
      return runs.latestPhasesForSpec(list, specDir); // helper lives in runs.ts
    });

  ipcMain.handle("history:get-spec-aggregate-stats",
    (_e, projectDir: string, specDir: string) => {
      const list = runs.listRuns(projectDir);
      return runs.getSpecAggregateStats(list, specDir);
    });
}
```

(This snippet is illustrative — the final code may vary in minor ways, but the channel names, argument order, and return shapes are contractual.)

---

## Preload bridge updates — `src/main/preload.ts`

The `window.dexAPI` shape that the renderer sees:

```ts
contextBridge.exposeInMainWorld("dexAPI", {
  // ...
  listRuns: (projectDir: string, limit?: number) =>
    ipcRenderer.invoke("history:list-runs", projectDir, limit),
  getRun: (projectDir: string, runId: string) =>
    ipcRenderer.invoke("history:get-run", projectDir, runId),
  getLatestProjectRun: (projectDir: string) =>
    ipcRenderer.invoke("history:get-latest-project-run", projectDir),
  getPhaseSteps: (projectDir: string, runId: string, phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-steps", projectDir, runId, phaseTraceId),
  getPhaseSubagents: (projectDir: string, runId: string, phaseTraceId: string) =>
    ipcRenderer.invoke("history:get-phase-subagents", projectDir, runId, phaseTraceId),
  getLatestPhaseTrace: (projectDir: string, specDir: string, phaseNumber: number) =>
    ipcRenderer.invoke("history:get-latest-phase-trace", projectDir, specDir, phaseNumber),
  getSpecPhaseStats: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-phase-stats", projectDir, specDir),
  getSpecAggregateStats: (projectDir: string, specDir: string) =>
    ipcRenderer.invoke("history:get-spec-aggregate-stats", projectDir, specDir),
  // ...
});
```

---

## Renderer call-site migration

The renderer has the `projectDir` and `runId` in scope at every call site already:

- `useOrchestrator.ts:154` — `await window.dexAPI.getRun(state.runId);` → `await window.dexAPI.getRun(state.projectDir, state.runId);`
- `useOrchestrator.ts:249, 782, 824, 879` — `getPhaseSteps(phaseTraceId)` → `getPhaseSteps(state.projectDir, state.runId, phaseTraceId)`. `state` is the scope object; in one of the sites (`:879`) `state` is named differently but the same values are available.
- `useOrchestrator.ts:627` — `getLatestProjectRun(projectDir)` unchanged.
- `useProject.ts:34, :117` — `getSpecAggregateStats` / `getSpecPhaseStats` already have `projectDir`.

No new renderer state is introduced; every migrated call site uses a `projectDir` value already present in the caller's scope.

---

## Type imports — `src/renderer/electron.d.ts`

Replace:

```ts
import type { RunRow, PhaseTraceRow, TraceStepRow, SubagentRow, LoopCycleRow, SpecStats } from "../core/database.js";
```

with:

```ts
import type { RunRecord, PhaseRecord, StepRecord, SubagentRecord, SpecStats } from "../core/runs.js";
```

And the `DexAPI` interface signatures update to match the table above.

---

## Backward compatibility

**None.** The IPC channel names are preserved but payload shapes change. There is no version negotiation; the renderer is updated in the same PR as main process.

This is allowed because Dex ships as a single Electron bundle — main and renderer deploy together.
