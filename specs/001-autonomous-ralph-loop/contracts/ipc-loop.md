# IPC Contracts: Loop Mode

**Feature**: 001-autonomous-ralph-loop | **Date**: 2026-04-15

## Request-Response Channels (`ipcMain.handle`)

### `orchestrator:start` (modified)

Existing channel, extended to accept loop-mode config.

**Request** (renderer → main):

```typescript
{
  projectDir: string;
  mode: "plan" | "build" | "loop";
  model: string;
  maxTurns: number;

  // Existing (plan/build mode)
  specDir?: string;
  phases?: number[] | "all";
  maxIterations?: number;
  runAllSpecs?: boolean;

  // New (loop mode only)
  description?: string;
  descriptionFile?: string;
  fullPlanPath?: string;
  maxLoopCycles?: number;
  maxBudgetUsd?: number;
}
```

**Response**: `void` (fires and streams events)

### `orchestrator:stop` (unchanged)

**Request**: `void`
**Response**: `void`

### `orchestrator:isRunning` (unchanged)

**Request**: `void`
**Response**: `boolean`

### `orchestrator:getRunState` (modified)

Extended with loop-specific state for HMR recovery.

**Response**:

```typescript
{
  // Existing fields
  runId: string;
  specDir: string;
  mode: string;
  phases: Phase[];
  activePhaseNumber: number | null;
  isRunning: boolean;
  totalCost: number;
  totalDuration: number;
  phasesCompleted: number;

  // New (loop mode)
  currentCycle?: number;
  currentStage?: LoopStageType;
  isClarifying?: boolean;
  loopsCompleted?: number;
  featuresCompleted?: string[];
}
```

## Event Streaming Channels (`webContents.send`)

All events flow through `orchestrator:event` (existing channel).

### New Event Types

#### `clarification_started`

```typescript
{ type: "clarification_started"; runId: string }
```

Emitted when Phase A begins.

#### `clarification_question`

```typescript
{ type: "clarification_question"; runId: string; question: string }
```

Emitted when the agent asks the user a question during clarification. The renderer displays this in the ClarificationPanel.

#### `clarification_completed`

```typescript
{ type: "clarification_completed"; runId: string; fullPlanPath: string }
```

Emitted when Phase A finishes and `full_plan.md` is written.

#### `loop_cycle_started`

```typescript
{ type: "loop_cycle_started"; runId: string; cycleNumber: number }
```

#### `loop_cycle_completed`

```typescript
{
  type: "loop_cycle_completed";
  runId: string;
  cycleNumber: number;
  decision: "NEXT_FEATURE" | "RESUME_FEATURE" | "REPLAN_FEATURE" | "GAPS_COMPLETE";
  featureName: string | null;
  specDir: string | null;
  costUsd: number;
}
```

#### `stage_started`

```typescript
{
  type: "stage_started";
  runId: string;
  cycleNumber: number;
  stage: LoopStageType;
  specDir?: string;
  phaseNumber?: number;
}
```

#### `stage_completed`

```typescript
{
  type: "stage_completed";
  runId: string;
  cycleNumber: number;
  stage: LoopStageType;
  costUsd: number;
  durationMs: number;
}
```

#### `loop_terminated`

```typescript
{
  type: "loop_terminated";
  runId: string;
  reason: "gaps_complete" | "budget_exceeded" | "max_cycles_reached" | "user_abort";
  cyclesCompleted: number;
  totalCostUsd: number;
  totalDurationMs: number;
  featuresCompleted: string[];
  featuresSkipped: string[];
}
```

## Preload API Extensions

### `window.dexAPI` (new methods)

```typescript
interface DexAPI {
  // ... existing methods ...

  // No new IPC methods needed — loop mode uses existing
  // orchestrator:start with extended config and receives
  // new event types through existing onOrchestratorEvent()
}
```

**Note**: No new IPC channels are needed. Loop mode is activated by passing `mode: "loop"` to the existing `startRun()` call. All new events flow through the existing `orchestrator:event` channel. The renderer handles new event types in `useOrchestrator.ts`.

## Backward Compatibility

- All existing `"plan"` and `"build"` mode behavior is unchanged
- New fields on `RunConfig` are optional and only relevant for `mode === "loop"`
- New event types are additive — existing event handlers ignore unknown types
- `getRunState()` returns new fields only when a loop run is active
- Database schema changes use `ALTER TABLE ADD COLUMN` (nullable columns, no migration needed)
