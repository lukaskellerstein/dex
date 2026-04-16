# IPC Contract: State Management

**Feature**: 002-filesystem-state-management

## New IPC Channels

### `orchestrator:getProjectState`

**Direction**: Renderer → Main → Renderer (request-response)
**Pattern**: `ipcMain.handle` / `ipcRenderer.invoke`

**Request**: `{ projectDir: string }`
**Response**: `DexState | null`

Returns the current state file contents for a project directory, or null if no state file exists / file is corrupt.

**Usage**: Called on renderer mount to detect paused runs, replacing the DB-based `getActiveRunState()` approach.

### Updated: `orchestrator:getRunState`

**Change**: When not currently running, falls back to reading the state file instead of returning null. This allows the renderer to display "paused" state for a project that was stopped in a previous session.

## New Events (Main → Renderer)

### `state_reconciling`

Emitted via `webContents.send("orchestrator:event", event)` when reconciliation begins on resume.

```typescript
{ type: "state_reconciling"; runId: string }
```

### `state_reconciled`

Emitted when reconciliation completes, carrying the drift summary for UI display.

```typescript
{
  type: "state_reconciled";
  runId: string;
  driftSummary: {
    missingArtifacts: string[];
    modifiedArtifacts: string[];
    taskRegressions: Record<string, string[]>;
    taskProgressions: Record<string, string[]>;
    extraCommits: number;
    pendingQuestionReask: boolean;
  }
}
```

## Updated Preload API (`window.dexAPI`)

### New method: `getProjectState`

```typescript
getProjectState(dir: string): Promise<DexState | null>
```

Exposed via `contextBridge.exposeInMainWorld`.

## Updated RunConfig (via `startRun`)

### Before
```typescript
{ resumeRunId?: string }
```

### After
```typescript
{ resume?: boolean }
```

The `resume` flag tells the orchestrator to load state from the state file. The run ID and all resume context come from the state file, not from the caller.
