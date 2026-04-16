# Data Model: Filesystem-First State Management

**Feature**: 002-filesystem-state-management
**Date**: 2026-04-16

## Entities

### DexState (Primary State Record)

The single source of truth for orchestrator position, accumulators, and artifact integrity. Persisted to `.dex/state.json` in the project directory, committed to git after each stage.

| Field | Type | Description |
|-------|------|-------------|
| version | `1` (literal) | Schema version for forward compatibility |
| runId | string | Current run identifier |
| status | enum | `"running"` \| `"paused"` \| `"completed"` \| `"failed"` |
| branchName | string | Git branch this state belongs to (for stale detection) |
| baseBranch | string | Branch this feature branched from |
| mode | enum | `"loop"` \| `"build"` \| `"plan"` |
| phase | enum | `"prerequisites"` \| `"clarification"` \| `"loop"` |
| currentCycleNumber | number | Current loop cycle |
| lastCompletedStage | LoopStageType \| null | Last stage that fully completed |
| currentSpecDir | string \| null | Spec directory being worked on |
| currentPhaseNumber | number \| null | Implementation phase number within current feature |
| clarificationCompleted | boolean | Whether multi-domain clarification is done |
| fullPlanPath | string \| null | Path to GOAL_clarified.md |
| cumulativeCostUsd | number | Running cost total across all cycles |
| cyclesCompleted | number | Number of fully completed cycles |
| featuresCompleted | string[] | Spec dirs of completed features |
| featuresSkipped | string[] | Spec dirs of skipped features |
| failureCounts | Record<string, FailureEntry> | Per-spec-dir failure tracking (replaces in-memory Map + DB) |
| config | ConfigSnapshot | Frozen config for resume validation |
| artifacts | ArtifactManifest | Content-hash manifest of all tracked files |
| checkpoint | CheckpointRef | Last git checkpoint SHA + timestamp |
| pendingQuestion | PendingQuestion \| null | Persisted user input request (survives crash) |
| startedAt | string (ISO 8601) | Run start time |
| pausedAt | string \| null (ISO 8601) | When run was paused |

### FailureEntry

| Field | Type | Description |
|-------|------|-------------|
| implFailures | number | Count of implementation failures for this spec dir |
| replanFailures | number | Count of replan failures for this spec dir |

### ConfigSnapshot

Frozen subset of RunConfig for resume validation — ensures the user hasn't changed critical settings between pause and resume.

| Field | Type | Description |
|-------|------|-------------|
| model | string | Claude model used |
| maxLoopCycles | number \| undefined | Cycle limit |
| maxBudgetUsd | number \| undefined | Budget limit |
| maxTurns | number | Max turns per agent call |
| maxIterations | number | Max iterations per phase |
| autoClarification | boolean \| undefined | Whether to auto-clarify |

### ArtifactManifest

| Field | Type | Description |
|-------|------|-------------|
| goalFile | ArtifactEntry \| null | Original GOAL.md |
| clarifiedGoal | ArtifactEntry \| null | GOAL_clarified.md |
| productDomain | ArtifactEntry \| null | Product domain analysis |
| technicalDomain | ArtifactEntry \| null | Technical domain analysis |
| constitution | ArtifactEntry \| null | Constitution file |
| features | Record<string, FeatureArtifacts> | Per-feature artifacts keyed by spec dir |

### ArtifactEntry

| Field | Type | Description |
|-------|------|-------------|
| path | string | Relative to project root |
| sha256 | string | Content hash at checkpoint time |
| completedAt | string (ISO 8601) | When this artifact was last written |

### FeatureArtifacts

| Field | Type | Description |
|-------|------|-------------|
| specDir | string | Spec directory path |
| status | enum | `"specifying"` \| `"planning"` \| `"implementing"` \| `"verifying"` \| `"completed"` \| `"skipped"` |
| spec | ArtifactEntry \| null | spec.md |
| plan | ArtifactEntry \| null | plan.md |
| tasks | TasksArtifact \| null | tasks.md with checkbox state |
| lastImplementedPhase | number | Highest completed implementation phase |

### TasksArtifact (extends ArtifactEntry)

| Field | Type | Description |
|-------|------|-------------|
| path | string | Relative to project root |
| sha256 | string | Content hash |
| completedAt | string (ISO 8601) | Completion time |
| taskChecksums | Record<string, boolean> | Task ID → was-checked at checkpoint time |

### CheckpointRef

| Field | Type | Description |
|-------|------|-------------|
| sha | string | HEAD SHA after last committed checkpoint |
| timestamp | string (ISO 8601) | When checkpoint was committed |

### PendingQuestion

| Field | Type | Description |
|-------|------|-------------|
| id | string | Request ID (matches `user_input_request` event) |
| question | string | The question text |
| context | string | Which stage/phase prompted the question |
| askedAt | string (ISO 8601) | When the question was emitted |

### ReconciliationResult

| Field | Type | Description |
|-------|------|-------------|
| canResume | boolean | Whether resume is possible |
| resumeFrom | ResumePoint | Where to pick up |
| warnings | string[] | Shown to user, don't block resume |
| blockers | string[] | Require user decision before proceeding |
| statePatches | DeepPartial<DexState> | Patches to apply to state before resuming |
| driftSummary | DriftSummary | For UI display and telemetry |

### ResumePoint

| Field | Type | Description |
|-------|------|-------------|
| phase | string | Phase to resume from |
| cycleNumber | number | Cycle to resume from |
| stage | LoopStageType | Stage to resume from |
| specDir | string \| undefined | Spec dir to resume on |

### DriftSummary

| Field | Type | Description |
|-------|------|-------------|
| missingArtifacts | string[] | Files in manifest but missing on disk |
| modifiedArtifacts | string[] | Files whose hash changed |
| taskRegressions | Record<string, string[]> | Per-spec-dir task IDs that were unchecked |
| taskProgressions | Record<string, string[]> | Per-spec-dir task IDs newly checked |
| extraCommits | number | Commits after last checkpoint |
| pendingQuestionReask | boolean | Whether a pending question was found |

### LockFile

| Field | Type | Description |
|-------|------|-------------|
| pid | number | Process ID holding the lock |
| timestamp | string (ISO 8601) | When the lock was acquired |

## State Transitions

### Run Status

```
fresh start → running → paused (user stop / crash)
                      → completed (all cycles done)
                      → failed (unrecoverable error)

paused → running (resume)
completed → (deleted on next start if stale branch)
```

### Feature Status

```
specifying → planning → implementing → verifying → completed
         ↘          ↘             ↘            ↘
          skipped    skipped       skipped      skipped
```

On artifact drift (resume reconciliation):
- Missing spec → reset to `specifying`
- Missing plan → reset to `planning`
- Unchecked tasks → reset `lastImplementedPhase` to earliest unchecked

## Deep Merge Contract

`updateState()` uses these rules:

| Patch value | Behavior |
|-------------|----------|
| Key absent or `undefined` | Ignored — existing value preserved |
| `null` | Replaces (clears the field) |
| Primitive (string, number, boolean) | Replaces |
| Object | Recursively merged with existing object |
| Array | Replaces entirely (no element-wise merge) |

## Reconciliation Decision Matrix

| Drift detected | Action taken |
|----------------|-------------|
| No drift | Resume from `lastCompletedStage + 1` |
| `GOAL_clarified.md` deleted | Reset to clarification phase |
| `GOAL_clarified.md` modified | Ask user: re-run gap analysis? |
| `spec.md` deleted for feature X | Reset feature X to `specifying` |
| `plan.md` deleted for feature X | Reset feature X to `planning` |
| Tasks unchecked in `tasks.md` | Resume implement from earliest unchecked phase |
| Tasks newly checked | Accept progression, update state |
| Extra commits after checkpoint | Warn, update checkpoint SHA, proceed |
| `constitution.md` deleted | Re-run constitution before next cycle |
| Pending question unanswered | Re-ask before resuming |
