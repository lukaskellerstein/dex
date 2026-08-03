# Data Model: Structured Outputs for Agent Boundaries

## New Entities

### FeatureManifest

Ordered list of features extracted from the clarified project plan. Created once after clarification, updated at lifecycle transitions.

**Persistence**: `.dex/feature-manifest.json`

| Field | Type | Description |
|-------|------|-------------|
| `version` | `1` (literal) | Schema version for future migration |
| `sourceHash` | `string` | SHA-256 of GOAL_clarified.md at extraction time |
| `features` | `FeatureManifestEntry[]` | Ordered feature list |

### FeatureManifestEntry

Single feature within the manifest. Tracks selection state and links to artifact tracking.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Sequential feature number from priority table (1, 2, 3...) |
| `title` | `string` | Feature name from priority table |
| `description` | `string` | Rich description: user stories, acceptance criteria, data model entities, scope constraints |
| `status` | `ManifestFeatureStatus` | Coarse lifecycle: `"pending"` → `"active"` → `"completed"` \| `"skipped"` |
| `specDir` | `string \| null` | Spec directory path, set after specify completes (e.g., `"specs/001-product-catalog"`) |

**Status transitions**:

```
pending ──(selected)──→ active ──(verify passes)──→ completed
                            │
                            └──(3 replan failures)──→ skipped
```

### VerifyOutput (structured output, not persisted)

Structured result from the verification stage. Consumed by the orchestrator to decide fix-reverify vs proceed.

| Field | Type | Description |
|-------|------|-------------|
| `passed` | `boolean` | `true` only if ALL checks succeed |
| `buildSucceeded` | `boolean` | Build/compilation status |
| `testsSucceeded` | `boolean` | Test suite status (true if no tests exist) |
| `failures` | `VerifyFailure[]` | List of specific failures |
| `summary` | `string` | One-paragraph summary |

### VerifyFailure

| Field | Type | Description |
|-------|------|-------------|
| `criterion` | `string` | The acceptance criterion or check that failed |
| `description` | `string` | What went wrong and what was expected |
| `severity` | `"blocking" \| "minor"` | `blocking` = must fix; `minor` = cosmetic |

### LearningInsight (structured output, appended to file)

Categorized insight from the learnings stage. Appended to `learnings.md` with deduplication.

| Field | Type | Description |
|-------|------|-------------|
| `category` | `string` | One of: `build`, `testing`, `api`, `architecture`, `tooling`, `workaround` |
| `insight` | `string` | One-line actionable insight |
| `context` | `string` | Brief context for when this applies |

### SynthesisConfirmation (structured output, not persisted)

Confirmation from the clarification synthesis stage.

| Field | Type | Description |
|-------|------|-------------|
| `filesProduced` | `string[]` | Relative paths of files created/updated |
| `goalClarifiedPath` | `string` | Relative path to the clarified goal file |

## Modified Entities

### GapAnalysisDecision (types.ts)

Add `featureId` to `NEXT_FEATURE` variant:

| Field | Type | Description |
|-------|------|-------------|
| `featureId` | `number` | Manifest entry ID for manifest-specDir linking after specify |

### RunConfig (types.ts)

Add optional fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxVerifyRetries` | `number` | `1` | Fix-reverify attempts per cycle |
| `maxLearningsPerCategory` | `number` | `20` | Cap per category in learnings.md |

### LoopStageType (types.ts)

Add new stage types:

| Value | Description |
|-------|-------------|
| `"manifest_extraction"` | One-time feature extraction from GOAL_clarified.md |
| `"implement_fix"` | Targeted fix after verification failure |

### OrchestratorEvent (types.ts)

Add new event types:

| Event | Fields | Description |
|-------|--------|-------------|
| `manifest_created` | `runId`, `featureCount` | Emitted after manifest extraction |
| `manifest_drift_detected` | `runId` | Emitted when GOAL_clarified.md changed since manifest creation |
| `verify_failed` | `runId`, `cycleNumber`, `blockingCount`, `summary` | Emitted when verification finds blocking failures |

## Entity Relationships

```
FeatureManifest
  └── features[] ──(specDir)──→ ArtifactManifest.features[specDir]
                                    └── FeatureArtifacts (existing)
                                         ├── spec: ArtifactEntry
                                         ├── plan: ArtifactEntry
                                         └── tasks: TasksArtifact

DexState (existing)
  ├── artifacts: ArtifactManifest
  └── (reads) FeatureManifest from .dex/feature-manifest.json
```

**Manifest** owns selection (which feature next).
**ArtifactManifest** owns progress (which artifacts exist, which phase is active).
**specDir** is the join key between them.
