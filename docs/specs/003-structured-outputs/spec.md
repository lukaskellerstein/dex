# 003: Structured Outputs — Bulletproof Feature Handoff

## Problem

The Dex autonomous loop has two compounding failures in the gap analysis → specify handoff:

1. **Wrong prompt format for `/speckit-specify`**: `buildSpecifyPrompt` outputs structured fields (`Feature name: X`, `Feature description: Y`, `Project directory: Z`) but `/speckit-specify` expects plain text as `$ARGUMENTS`. This caused the specify agent to create the spec at `.specify/features/project-foundation/` instead of `specs/001-project-foundation/`. The specify agent completed successfully, but `discoverNewSpecDir()` couldn't find the output, throwing `"Specify completed but no new spec directory was created"`, which terminated Cycle 1 after only gap_analysis + specify.

2. **Non-deterministic feature selection**: The gap analysis agent re-reads the entire GOAL_clarified.md every cycle and independently decides what's next via free-text output (`NEXT_FEATURE: name | one-liner`) that must be regex-parsed. Feature naming, ordering, and descriptions drift across cycles. The one-liner description is too lossy — a 712-line plan gets compressed to a sentence.

## Root Cause Analysis

### Specify prompt mismatch

The `/speckit-specify` skill (from spec-kit) processes `$ARGUMENTS` as the feature description — the raw text after the command name. It auto-generates a 2-4 word short name, determines the next sequential number by scanning `specs/`, and creates `specs/<NNN>-<short-name>/spec.md`.

Current prompt (`src/core/prompts.ts:217-222`):
```
/speckit-specify

Feature name: project-foundation
Feature description: Set up the foundational project structure
  
Project directory: /home/lukas/.../dex-ecommerce
```

The structured `Feature name:` / `Feature description:` / `Project directory:` fields are not part of the expected input format. The agent misinterpreted them and wrote to `.specify/features/` instead of following its standard `specs/` convention.

### Non-deterministic gap analysis

The gap analysis agent receives the full plan + list of existing spec dirs, and outputs one of:
```
NEXT_FEATURE: {name} | {description}
RESUME_FEATURE: {specDir}
REPLAN_FEATURE: {specDir}
GAPS_COMPLETE
```

This is parsed by `parseGapAnalysisResult()` using a regex (`GAP_DECISION_RE`). Problems:
- The agent picks feature names non-deterministically (e.g., "project-foundation" vs "project-setup")
- The one-line description loses all user stories, acceptance criteria, and data model context
- Feature ordering may drift between cycles
- The regex parser is fragile — any deviation in format causes a hard failure

## Solution

Use the Claude Agent SDK's **structured outputs** (`outputFormat`) to eliminate free-text parsing at every agent boundary, and create a **deterministic feature manifest** that owns feature selection and lifecycle tracking.

### Key Discovery: Agent SDK Structured Outputs

The TypeScript Agent SDK (v0.1.45+) supports structured outputs:

```typescript
// In query() options:
outputFormat: {
  type: "json_schema",
  schema: { type: "object", properties: {...}, required: [...] }
}

// In result message:
message.structured_output  // parsed JSON matching the schema
```

The agent still uses tools (Read, Write, Bash, etc.) normally — only the **final response** is schema-constrained. This means agents can do their full work AND return machine-readable results.

Type definitions from the installed SDK (`@anthropic-ai/claude-agent-sdk`):
```typescript
// entrypoints/sdk/runtimeTypes.d.ts
outputFormat?: OutputFormat;

// entrypoints/sdk/coreTypes.d.ts
export type OutputFormatType = 'json_schema';
// Result message includes:
structured_output?: unknown;
// Error subtype for validation failures:
subtype: '...' | 'error_max_structured_output_retries';
```

Runtime behavior (`sdk.mjs`):
```javascript
const jsonSchema = outputFormat?.type === "json_schema" ? outputFormat.schema : undefined;
args.push("--json-schema", jsonStringify(jsonSchema));
```

---

## Implementation Plan

### Step 1: Add `outputFormat` support to `runStage`

**File**: `src/core/orchestrator.ts`

Extend `runStage` to accept an optional `outputFormat` parameter and return `structuredOutput`:

```typescript
async function runStage(
  config: RunConfig,
  prompt: string,
  emit: EmitFn,
  rlog: RunLogger,
  runId: string,
  cycleNumber: number,
  stageType: LoopStageType,
  specDir?: string,
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> }
): Promise<{
  result: string;
  structuredOutput: unknown;
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}>
```

Changes inside `runStage`:
- Pass `outputFormat` into `query()` options alongside existing `model`, `cwd`, `maxTurns`, etc.
- Capture `message.structured_output` from the result message (alongside existing `message.result`)
- Return `structuredOutput` in the result object
- All existing callers continue to work (they ignore `structuredOutput`)

### Step 2: Feature Manifest module

**New file**: `src/core/manifest.ts`

#### Types

```typescript
export interface FeatureManifestEntry {
  id: number;                    // sequential: 1, 2, 3... (from priority table)
  title: string;                 // "Product Catalog" (from priority table)
  description: string;           // rich description including user stories + acceptance criteria
  status: "pending" | "specifying" | "in_progress" | "completed" | "skipped";
  specDir: string | null;        // set after specify creates the directory
}

export interface FeatureManifest {
  version: 1;
  sourceHash: string;            // SHA-256 of GOAL_clarified.md for drift detection
  features: FeatureManifestEntry[];
}
```

#### Functions

- `loadManifest(projectDir: string): FeatureManifest | null` — Read `.dex/feature-manifest.json`, return null if missing
- `saveManifest(projectDir: string, manifest: FeatureManifest): void` — Atomic write (tmp file + rename)
- `getNextFeature(manifest: FeatureManifest): FeatureManifestEntry | null` — First entry with `status === "pending"`
- `getInProgressFeature(manifest: FeatureManifest): FeatureManifestEntry | null` — First entry with `status === "in_progress"` or `"specifying"`
- `updateFeatureStatus(projectDir: string, featureId: number, updates: Partial<Pick<FeatureManifestEntry, "status" | "specDir">>): void` — Load, update, save

**Manifest file location**: `.dex/feature-manifest.json` (alongside existing `.dex/state.json`)

### Step 3: Manifest extraction stage (structured output)

**Files**: `src/core/prompts.ts`, `src/core/orchestrator.ts`

After clarification completes and GOAL_clarified.md exists, run a one-time manifest extraction stage using structured output.

#### JSON Schema

```typescript
const MANIFEST_SCHEMA = {
  type: "object",
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "number", description: "Feature number from the priority table (1, 2, 3...)" },
          title: { type: "string", description: "Feature name from the priority table" },
          description: { type: "string", description: "Rich description including user stories, acceptance criteria, relevant data model entities, and scope constraints" },
        },
        required: ["id", "title", "description"],
        additionalProperties: false,
      }
    }
  },
  required: ["features"],
  additionalProperties: false,
}
```

#### Prompt

```typescript
export function buildManifestExtractionPrompt(goalPath: string): string {
  return `Read the project plan at ${goalPath}. Extract every MVP feature listed in the feature priority table.

For each feature, produce:
- id: the feature number from the table (1, 2, 3...)
- title: the feature name exactly as it appears in the table (e.g., "Product Catalog")
- description: a rich, self-contained description that includes:
  - The one-line description from the priority table
  - All related user stories with their full acceptance criteria
  - Relevant data model entities and their relationships
  - Any scope constraints or out-of-scope items that apply to this feature

The description must be detailed enough that someone reading ONLY that description can write a complete feature specification. Do NOT include technology stack details — focus on WHAT the feature does, not HOW it is built.

Process features in the exact order they appear in the priority table. Do not skip features. Do not invent new features.`;
}
```

#### Orchestrator integration

After clarification completes (~line 2030 in orchestrator.ts), before the loop starts:

```typescript
let manifest = loadManifest(config.projectDir);
if (!manifest) {
  const prompt = buildManifestExtractionPrompt(fullPlanPath);
  const result = await runStage(
    config, prompt, emit, rlog, runId, 0,
    "manifest_extraction",
    undefined,
    MANIFEST_SCHEMA
  );
  const extracted = result.structuredOutput as {
    features: Array<{ id: number; title: string; description: string }>
  };
  manifest = {
    version: 1,
    sourceHash: hashFile(fullPlanPath),
    features: extracted.features.map(f => ({
      ...f,
      status: "pending" as const,
      specDir: null,
    })),
  };
  saveManifest(config.projectDir, manifest);
}
```

### Step 4: Replace LLM gap analysis with manifest-based selection

**File**: `src/core/orchestrator.ts`

The gap analysis block (~lines 2070-2103) changes from an LLM call to deterministic manifest traversal:

```typescript
const manifest = loadManifest(config.projectDir)!;
const inProgress = getInProgressFeature(manifest);
const nextPending = getNextFeature(manifest);

let decision: GapAnalysisDecision;

if (inProgress && inProgress.specDir) {
  // Feature was started but not completed — evaluate RESUME vs REPLAN
  // Use structured output for this LLM evaluation
  const result = await runStage(
    config, evaluationPrompt, emit, rlog, runId, cycleNumber,
    "gap_analysis", inProgress.specDir,
    GAP_ANALYSIS_SCHEMA
  );
  const evaluation = result.structuredOutput as { decision: string; reason: string };
  if (evaluation.decision === "REPLAN_FEATURE") {
    decision = { type: "REPLAN_FEATURE", specDir: inProgress.specDir };
  } else {
    decision = { type: "RESUME_FEATURE", specDir: inProgress.specDir };
  }
} else if (nextPending) {
  // Deterministic — no LLM call needed
  decision = {
    type: "NEXT_FEATURE",
    name: nextPending.title,
    description: nextPending.description,
    featureId: nextPending.id,
  };
} else {
  decision = { type: "GAPS_COMPLETE" };
}
```

#### Gap Analysis Schema (for RESUME/REPLAN only)

```typescript
const GAP_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    decision: {
      type: "string",
      enum: ["RESUME_FEATURE", "REPLAN_FEATURE"],
    },
    reason: { type: "string" },
  },
  required: ["decision", "reason"],
  additionalProperties: false,
}
```

Still emit `stage_started`/`stage_completed` for gap_analysis so the UI renders it, but for NEXT_FEATURE the work is deterministic (near-zero cost and duration).

### Step 5: Fix `buildSpecifyPrompt`

**File**: `src/core/prompts.ts`

```typescript
export function buildSpecifyPrompt(
  featureTitle: string,
  featureDescription: string
): string {
  return `/speckit-specify ${featureTitle}: ${featureDescription}`;
}
```

Changes:
- Description goes on the **same line** as `/speckit-specify` (this is `$ARGUMENTS` — what the skill expects)
- No `Feature name:` / `Feature description:` / `Project directory:` structured fields
- `Project directory:` removed entirely (agent already runs with correct `cwd`)
- The rich `description` from the manifest replaces the lossy one-liner
- `config` parameter removed (not needed)

### Step 6: Update manifest at lifecycle points

**File**: `src/core/orchestrator.ts`

| Event | Location | Manifest Update |
|-------|----------|-----------------|
| Specify starts | ~line 2177 | `status: "specifying"` |
| Specify completes, specDir discovered | ~line 2192 | `status: "in_progress"`, `specDir: "specs/001-..."` |
| Verify completes successfully | ~line 2339 | `status: "completed"` |
| Feature skipped (3 replan failures) | ~line 2149 | `status: "skipped"` |
| Cycle error in catch block | ~line 2369 | Leave as current status (retry next cycle) |

### Step 7: Update types and clean up parser

**File**: `src/core/types.ts`

Extend `GapAnalysisDecision` with `featureId`:

```typescript
export type GapAnalysisDecision =
  | { type: "NEXT_FEATURE"; name: string; description: string; featureId: number }
  | { type: "RESUME_FEATURE"; specDir: string }
  | { type: "REPLAN_FEATURE"; specDir: string }
  | { type: "GAPS_COMPLETE" };
```

Add new stage type for manifest extraction:
```typescript
export type LoopStageType = 
  | "manifest_extraction"  // NEW
  | "gap_analysis" | "specify" | "plan" | "tasks" 
  | "implement" | "verify" | "learnings" | ...;
```

**File**: `src/core/parser.ts`

Remove `parseGapAnalysisResult()` and the `GAP_DECISION_RE` regex — no longer needed.

---

## Summary: Where Structured Outputs Are Used

| Stage | Current (fragile) | New (structured) |
|-------|-------------------|------------------|
| Manifest extraction | N/A (doesn't exist) | `outputFormat` with features array schema |
| Gap analysis (NEXT_FEATURE) | LLM reads GOAL_clarified.md, outputs regex-parsed text | **No LLM** — deterministic manifest walk |
| Gap analysis (RESUME/REPLAN) | Same LLM + regex | `outputFormat` with decision enum schema |
| Specify | Free-text prompt with wrong field format | Plain text `$ARGUMENTS` with rich description from manifest |

## Files Modified

| File | Change |
|------|--------|
| `src/core/manifest.ts` | **NEW** — FeatureManifest types, load/save/update/query functions |
| `src/core/types.ts` | Add `FeatureManifestEntry`, `FeatureManifest`; add `featureId` to `GapAnalysisDecision`; add `manifest_extraction` stage type |
| `src/core/prompts.ts` | Fix `buildSpecifyPrompt`; add `buildManifestExtractionPrompt`; simplify `buildGapAnalysisPrompt` |
| `src/core/orchestrator.ts` | Add `outputFormat` to `runStage`; manifest creation after clarification; deterministic gap analysis; manifest updates at lifecycle points |
| `src/core/parser.ts` | Remove `parseGapAnalysisResult` and `GAP_DECISION_RE` |

## Verification

1. **TypeScript compilation**: `npx tsc --noEmit`
2. **Manual test**: Run the loop on dex-ecommerce, verify:
   - `.dex/feature-manifest.json` created after clarification with all 18 MVP features
   - Each feature has a rich description (user stories + acceptance criteria)
   - Cycle 1 gap analysis is instant (manifest walk), picks Feature 1
   - Specify prompt is `/speckit-specify Product Catalog: Categories (2-level)...`
   - Spec created at `specs/001-<name>/spec.md` (correct path)
   - Manifest updated with `specDir` and `status: "in_progress"`
   - Cycle 2 picks Feature 2 deterministically
3. **Check logs**: `~/.dex/logs/` for errors, verify `structured_output` is captured
