# 003: Structured Outputs — Bulletproof Feature Handoff

## Problem

The Dex autonomous loop has three categories of failure at agent boundaries:

1. **Wrong prompt format for `/speckit-specify`**: `buildSpecifyPrompt` outputs structured fields (`Feature name: X`, `Feature description: Y`, `Project directory: Z`) but `/speckit-specify` expects plain text as `$ARGUMENTS`. This caused the specify agent to create the spec at `.specify/features/project-foundation/` instead of `specs/001-project-foundation/`. The specify agent completed successfully, but `discoverNewSpecDir()` couldn't find the output, throwing `"Specify completed but no new spec directory was created"`, which terminated Cycle 1 after only gap_analysis + specify.

2. **Non-deterministic feature selection**: The gap analysis agent re-reads the entire GOAL_clarified.md every cycle and independently decides what's next via free-text output (`NEXT_FEATURE: name | one-liner`) that must be regex-parsed. Feature naming, ordering, and descriptions drift across cycles. The one-liner description is too lossy — a 712-line plan gets compressed to a sentence.

3. **No machine-readable feedback from verify/learnings stages**: The verify stage (`buildVerifyPrompt`) asks the agent to "report what passed and what failed," but the orchestrator ignores `verifyResult.result` entirely (line 2338-2339). The loop always proceeds to learnings regardless of outcome — it cannot self-correct within a cycle because it has no structured signal of pass/fail.

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

### Silent verify stage

`buildVerifyPrompt` (line 245-270) produces a plain-text report. The orchestrator stores the cost but never inspects the content — `verifyResult.result` is not parsed or acted upon. The loop unconditionally proceeds to learnings and then the next cycle, even when blocking failures exist. This means verification failures can only be corrected in the *next cycle's* gap analysis, wasting an entire cycle.

## Prerequisites

- **SDK upgrade required**: `package.json` pins `"@anthropic-ai/claude-agent-sdk": "^0.1.0"`. The `outputFormat` parameter and `structured_output` on result messages require **v0.1.45+**. Before any implementation, upgrade the SDK and verify the types exist in the installed version's `.d.ts` files. This blocks the entire spec.

## Solution

Use the Claude Agent SDK's **structured outputs** (`outputFormat`) to eliminate free-text parsing at every agent boundary where the orchestrator needs to make a decision, and create a **deterministic feature manifest** that owns feature selection and lifecycle tracking.

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

## Design Decision: Manifest vs ArtifactManifest

`state.ts` already tracks features via `ArtifactManifest.features: Record<string, FeatureArtifacts>` with status (`specifying | planning | implementing | verifying | completed | skipped`), `specDir`, artifact checksums, and `lastImplementedPhase`.

The new `FeatureManifest` serves a different purpose:

| Concern | `FeatureManifest` (new) | `ArtifactManifest` (existing) |
|---------|------------------------|-------------------------------|
| **Role** | Feature *selection and ordering* — what to build next | Feature *artifact tracking* — what files exist and their integrity |
| **Lifecycle** | Created once from GOAL_clarified.md, read-only after initial extraction (status updates only) | Updated continuously as artifacts are produced |
| **Key data** | Feature id, title, rich description, priority order | specDir, artifact SHA-256 checksums, lastImplementedPhase |
| **Status granularity** | Coarse: `pending → active → completed/skipped` | Fine: `specifying → planning → implementing → verifying → completed/skipped` |

**Rule**: The manifest owns *selection* (which feature next). `ArtifactManifest` owns *progress* (which artifacts exist and their state). The manifest status is coarse on purpose — it only needs three meaningful states:

- `pending` — not yet started (only exists in manifest, not in ArtifactManifest)
- `active` — currently being worked on (detailed status lives in ArtifactManifest)
- `completed` / `skipped` — terminal

To avoid dual-tracking, the manifest status enum is simplified to `"pending" | "active" | "completed" | "skipped"`. When the orchestrator needs fine-grained status (which phase? which artifacts?), it consults `ArtifactManifest`. When it needs "what's next?", it consults the manifest.

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
  structuredOutput: unknown | null;  // null when no outputFormat provided or when schema validation falls through
  cost: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}>
```

Changes inside `runStage`:
- Pass `outputFormat` into `query()` options alongside existing `model`, `cwd`, `maxTurns`, etc.
- Capture `message.structured_output` from the result message (alongside existing `message.result`)
- Return `structuredOutput` in the result object (defaults to `null` when no schema provided)
- All existing callers continue to work (they ignore `structuredOutput`)

#### Error handling for structured output validation failures

The SDK can return `error_max_structured_output_retries` when schema validation fails repeatedly. `runStage` must handle this:

```typescript
if (message.type === "result") {
  // ... existing cost/token extraction ...
  if (typeof message.result === "string") resultText = message.result;
  
  // Structured output handling
  if (outputFormat) {
    if (message.subtype === "error_max_structured_output_retries") {
      rlog.run("ERROR", `runStage(${stageType}): structured output validation failed after max retries`);
      throw new Error(`Structured output validation failed for ${stageType} — agent could not produce valid JSON matching the schema`);
    }
    structuredOutput = message.structured_output ?? null;
    if (structuredOutput === null) {
      rlog.run("WARN", `runStage(${stageType}): outputFormat requested but structured_output is null — falling back to raw text`);
    }
  }
}
```

#### Null structured output fallback policy

When `outputFormat` is provided but `structured_output` comes back `null` (no SDK error, but no parsed JSON either), the behavior depends on the stage's criticality:

| Stage | Null fallback | Rationale |
|-------|---------------|-----------|
| `manifest_extraction` | **Throw** — treated as extraction failure, enters retry loop | Cannot proceed without a manifest |
| `gap_analysis` (RESUME/REPLAN) | **Throw** — treated as stage failure | Decision is binary; no safe default |
| `verify` | **Treat as not-passed** — set `verification = { passed: false, buildSucceeded: false, testsSucceeded: false, failures: [{ criterion: "structured_output", description: "Verify agent did not return structured output", severity: "blocking" }], summary: "Verification could not be evaluated" }` | Conservative: unknown verification state should not mark a feature complete |
| `learnings` | **No-op** — skip append, log warning | Learnings are non-critical; losing one cycle's insights is acceptable |

`runStage` itself always returns `structuredOutput: null` on fallback — the **caller** implements the policy above. This keeps `runStage` generic.

### Step 2: Feature Manifest module

**New file**: `src/core/manifest.ts`

#### Types

```typescript
export type ManifestFeatureStatus = "pending" | "active" | "completed" | "skipped";

export interface FeatureManifestEntry {
  id: number;                    // sequential: 1, 2, 3... (from priority table)
  title: string;                 // "Product Catalog" (from priority table)
  description: string;           // rich description including user stories + acceptance criteria
  status: ManifestFeatureStatus;
  specDir: string | null;        // set after specify completes (e.g., "specs/001-product-catalog")
}

export interface FeatureManifest {
  version: 1;
  sourceHash: string;            // SHA-256 of GOAL_clarified.md — see "Source hash drift detection" below
  features: FeatureManifestEntry[];
}
```

`specDir` is set to `null` at extraction time and populated after the specify stage completes. This provides the key link between the manifest and `ArtifactManifest.features[specDir]` — without it, mapping a manifest title ("Product Catalog") to an ArtifactManifest key (`"specs/001-product-catalog"`) would require fragile fuzzy matching.

#### Functions

- `loadManifest(projectDir: string): FeatureManifest | null` — Read `.dex/feature-manifest.json`, return null if missing
- `saveManifest(projectDir: string, manifest: FeatureManifest): void` — Atomic write (tmp file + rename)
- `getNextFeature(manifest: FeatureManifest): FeatureManifestEntry | null` — First entry with `status === "pending"`
- `getActiveFeature(manifest: FeatureManifest): FeatureManifestEntry | null` — First entry with `status === "active"`
- `updateFeatureStatus(projectDir: string, featureId: number, status: ManifestFeatureStatus): void` — Load, update, save
- `updateFeatureSpecDir(projectDir: string, featureId: number, specDir: string): void` — Set `specDir` on a manifest entry after specify completes
- `checkSourceDrift(projectDir: string, manifest: FeatureManifest, goalPath: string): boolean` — Returns true if GOAL_clarified.md hash differs from `manifest.sourceHash`

**Manifest file location**: `.dex/feature-manifest.json` (alongside existing `.dex/state.json`)

#### Source hash drift detection

`sourceHash` stores a SHA-256 of GOAL_clarified.md at manifest creation time. On each loop start, `checkSourceDrift()` compares the current file hash against the stored hash. If they differ:

1. Log a warning: `"GOAL_clarified.md has changed since manifest was created"`
2. Emit an event: `{ type: "manifest_drift_detected", runId }`
3. **Do not auto-regenerate** — the user may have made intentional edits that don't affect feature ordering. The orchestrator continues with the existing manifest.
4. To force re-extraction, the user deletes `.dex/feature-manifest.json` and restarts the loop.

This is intentionally conservative. Auto-regeneration risks discarding in-progress feature state.

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
    })),
  };
  saveManifest(config.projectDir, manifest);
} else if (checkSourceDrift(config.projectDir, manifest, fullPlanPath)) {
  rlog.run("WARN", "GOAL_clarified.md has changed since manifest was created");
  emit({ type: "manifest_drift_detected", runId });
}
```

#### Error recovery for manifest extraction failure

If manifest extraction fails (SDK error, schema validation failure, agent cannot parse the GOAL), the orchestrator has no manifest and cannot proceed to the loop. Recovery strategy:

1. **Retry once** — transient SDK errors or schema validation failures may succeed on a second attempt
2. **If retry fails, abort the run** with a clear error: `"Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check GOAL_clarified.md format."`
3. **Do not fall back to the old gap analysis** — the regex-based path is being removed, and mixing both approaches creates untestable state

```typescript
if (!manifest) {
  let extracted: { features: Array<{ id: number; title: string; description: string }> } | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const prompt = buildManifestExtractionPrompt(fullPlanPath);
      const result = await runStage(
        config, prompt, emit, rlog, runId, 0,
        "manifest_extraction", undefined, MANIFEST_SCHEMA
      );
      extracted = result.structuredOutput as typeof extracted;
      // Null structured output (per fallback policy) is treated as extraction failure
      if (!extracted) {
        rlog.run("WARN", `Manifest extraction attempt ${attempt}: structured_output was null`);
        if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — structured output was null. Check GOAL_clarified.md format.");
        continue;
      }
      if (!extracted.features?.length) {
        rlog.run("WARN", `Manifest extraction attempt ${attempt}: empty features array`);
        if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — extracted zero features. Check GOAL_clarified.md format.");
        continue;
      }
      break;
    } catch (err) {
      rlog.run("ERROR", `Manifest extraction attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt === 2) throw new Error("Manifest extraction failed after 2 attempts — cannot proceed without a feature manifest. Check GOAL_clarified.md format.");
    }
  }
  // ... build and save manifest from extracted ...
```

### Step 4: Replace LLM gap analysis with manifest-based selection

**File**: `src/core/orchestrator.ts`

The gap analysis block (~lines 2070-2103) changes from an LLM call to deterministic manifest traversal:

```typescript
const manifest = loadManifest(config.projectDir)!;
const active = getActiveFeature(manifest);
const nextPending = getNextFeature(manifest);

let decision: GapAnalysisDecision;

if (active) {
  // Feature was started but not completed — specDir is stored on the manifest entry
  if (active.specDir) {
    // Use structured output to evaluate RESUME vs REPLAN
    const evaluationPrompt = buildFeatureEvaluationPrompt(config, active.specDir);
    const result = await runStage(
      config, evaluationPrompt, emit, rlog, runId, cycleNumber,
      "gap_analysis", active.specDir,
      GAP_ANALYSIS_SCHEMA
    );
    const evaluation = result.structuredOutput as { decision: string; reason: string } | null;
    // Null fallback policy: throw — decision is binary, no safe default
    if (!evaluation) {
      throw new Error(`Gap analysis for ${active.specDir} returned null structured output — cannot determine RESUME vs REPLAN`);
    }
    if (evaluation.decision === "REPLAN_FEATURE") {
      decision = { type: "REPLAN_FEATURE", specDir: active.specDir };
    } else {
      decision = { type: "RESUME_FEATURE", specDir: active.specDir };
    }
  } else {
    // Active but no specDir yet — re-run specify
    decision = {
      type: "NEXT_FEATURE",
      name: active.title,
      description: active.description,
      featureId: active.id,
    };
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

#### Feature Evaluation Prompt (for RESUME/REPLAN)

**File**: `src/core/prompts.ts`

This replaces the old `buildGapAnalysisPrompt` for the RESUME/REPLAN path. The old prompt was designed for the regex-parsed output format (`NEXT_FEATURE: name | description`) and must be rewritten to target the `GAP_ANALYSIS_SCHEMA`.

```typescript
export function buildFeatureEvaluationPrompt(
  config: RunConfig,
  specDir: string
): string {
  return `You are evaluating whether a partially-completed feature should be resumed or replanned.

## Instructions

1. Read the spec at: ${specDir}/spec.md
2. Read the plan at: ${specDir}/plan.md
3. Read the tasks at: ${specDir}/tasks.md
4. Check the current state of the implementation — which tasks are done, which remain
5. Assess whether the existing plan is still viable or needs replanning

## Decision criteria

Choose RESUME_FEATURE if:
- The plan is sound and remaining tasks are clearly defined
- Progress has been made and continuing makes sense
- No fundamental design issues have been discovered

Choose REPLAN_FEATURE if:
- The plan has structural problems that make remaining tasks unworkable
- Key assumptions in the plan turned out to be wrong
- The implementation has diverged significantly from the plan

## Project Directory

${config.projectDir}`;
}
```

**Cleanup**: Remove the old `buildGapAnalysisPrompt` function from `prompts.ts` — it is no longer called. The NEXT_FEATURE path is deterministic (no prompt needed), and the RESUME/REPLAN path now uses `buildFeatureEvaluationPrompt`.

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
- **Call-site update required**: `orchestrator.ts:~2178` currently passes `config` as the first argument — update to `buildSpecifyPrompt(decision.name, decision.description)`

**After specify completes**: Once `discoverNewSpecDir()` returns the new spec directory, update the manifest entry with the resolved `specDir`:

```typescript
const newSpecDir = discoverNewSpecDir(config.projectDir, existingSpecs);
if (newSpecDir && decision.type === "NEXT_FEATURE") {
  updateFeatureSpecDir(config.projectDir, decision.featureId, newSpecDir);
}
```

Add `updateFeatureSpecDir(projectDir: string, featureId: number, specDir: string): void` to `manifest.ts` — loads manifest, sets `features[id].specDir`, saves.

**Note on `discoverNewSpecDir` fragility**: The specify stage still relies on `discoverNewSpecDir()` — a filesystem diff comparing spec dirs before/after the call. This is a known limitation: `/speckit-specify` is an external skill whose output format we don't control, so we can't add `outputFormat` to it. The prompt fix (correct `$ARGUMENTS` format) eliminates the primary failure mode. The filesystem diff approach is acceptable because: (a) spec creation is atomic (single directory), (b) the before/after window is tightly scoped, and (c) no concurrent spec creation exists in the current architecture.

### Step 6: Structured verify output

**Files**: `src/core/prompts.ts`, `src/core/orchestrator.ts`

This is the highest-impact structured output addition beyond the manifest work. Currently `verifyResult.result` is unused — the orchestrator cannot distinguish pass from fail.

#### Verify Schema

```typescript
const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    passed: {
      type: "boolean",
      description: "true if ALL acceptance criteria pass and build/tests succeed"
    },
    buildSucceeded: {
      type: "boolean",
      description: "true if the project compiles without errors"
    },
    testsSucceeded: {
      type: "boolean",
      description: "true if all tests pass (or no tests exist)"
    },
    failures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: {
            type: "string",
            description: "The acceptance criterion or check that failed"
          },
          description: {
            type: "string",
            description: "What went wrong and what was expected"
          },
          severity: {
            type: "string",
            enum: ["blocking", "minor"],
            description: "blocking = must fix before feature is complete; minor = cosmetic or non-critical"
          }
        },
        required: ["criterion", "description", "severity"],
        additionalProperties: false,
      }
    },
    summary: {
      type: "string",
      description: "One-paragraph summary of verification results"
    }
  },
  required: ["passed", "buildSucceeded", "testsSucceeded", "failures", "summary"],
  additionalProperties: false,
}
```

#### Updated verify prompt

```typescript
export function buildVerifyPrompt(
  config: RunConfig,
  specDir: string,
  fullPlanPath: string
): string {
  return `You are a verification agent. Your job is to verify that the implementation in the project matches the specification.

## Instructions

1. Read the spec at: ${specDir}/spec.md
2. Read the plan at: ${specDir}/plan.md
3. Read the full project plan at: ${fullPlanPath} for testing strategy
4. Run the build command to verify the project compiles
5. Run tests if they exist
6. Check that all acceptance criteria from the spec are met
7. If browser-based verification is needed, use the available MCP tools

## Project Directory

${config.projectDir}

## Output

Your structured output must accurately reflect what you observed. Set passed=true ONLY if the build succeeds, tests pass, AND all acceptance criteria are met. For each failure, classify severity:
- "blocking": the feature is incomplete or broken — must fix before marking complete
- "minor": cosmetic issues, missing polish, non-critical deviations`;
}
```

#### Orchestrator integration — verify-then-retry loop

```typescript
// Verify (T033)
const verifyPrompt = buildVerifyPrompt(config, implSpecPath, fullPlanPath);
const verifyResult = await runStage(
  config, verifyPrompt, emit, rlog, runId, cycleNumber,
  "verify", implSpecDir, VERIFY_SCHEMA
);
cycleCost += verifyResult.cost;

type VerifyOutput = {
  passed: boolean;
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  failures: Array<{ criterion: string; description: string; severity: string }>;
  summary: string;
};

// Null fallback policy: treat as not-passed (conservative — unknown state should not mark feature complete)
const verification: VerifyOutput = (verifyResult.structuredOutput as VerifyOutput | null) ?? {
  passed: false,
  buildSucceeded: false,
  testsSucceeded: false,
  failures: [{ criterion: "structured_output", description: "Verify agent did not return structured output", severity: "blocking" }],
  summary: "Verification could not be evaluated — structured output was null",
};

if (!verification.passed) {
  const blockingFailures = verification.failures.filter(f => f.severity === "blocking");
  if (blockingFailures.length > 0) {
    const maxRetries = config.maxVerifyRetries ?? 1;
    let currentVerification = verification;

    for (let retryNum = 1; retryNum <= maxRetries; retryNum++) {
      const currentBlocking = currentVerification.failures.filter(f => f.severity === "blocking");
      rlog.run("WARN", `runLoop: verify found ${currentBlocking.length} blocking failure(s) — fix attempt ${retryNum}/${maxRetries}`);
      emit({
        type: "verify_failed",
        runId,
        cycleNumber,
        blockingCount: currentBlocking.length,
        summary: currentVerification.summary,
      });

      // Build a targeted fix prompt from the structured failures
      const fixPrompt = buildVerifyFixPrompt(config, implSpecPath, currentBlocking);
      const fixResult = await runStage(
        config, fixPrompt, emit, rlog, runId, cycleNumber,
        "implement_fix", implSpecDir
      );
      cycleCost += fixResult.cost;

      // Re-verify after fix attempt
      const reVerifyResult = await runStage(
        config, verifyPrompt, emit, rlog, runId, cycleNumber,
        "verify", implSpecDir, VERIFY_SCHEMA
      );
      cycleCost += reVerifyResult.cost;

      currentVerification = (reVerifyResult.structuredOutput as VerifyOutput | null) ?? {
        passed: false,
        buildSucceeded: false,
        testsSucceeded: false,
        failures: [{ criterion: "structured_output", description: "Re-verify agent did not return structured output", severity: "blocking" }],
        summary: "Re-verification could not be evaluated — structured output was null",
      };

      if (currentVerification.passed) {
        rlog.run("INFO", `runLoop: re-verify passed on attempt ${retryNum}`);
        break;
      }
      if (retryNum === maxRetries) {
        rlog.run("WARN", `runLoop: re-verify still failing after ${maxRetries} fix attempt(s) — proceeding to learnings, will retry next cycle`);
      }
    }
  }
}
```

The fix prompt function:

```typescript
export function buildVerifyFixPrompt(
  config: RunConfig,
  specDir: string,
  failures: Array<{ criterion: string; description: string; severity: string }>
): string {
  const failureList = failures.map((f, i) =>
    `${i + 1}. **${f.criterion}**: ${f.description}`
  ).join("\n");

  return `You are a fix agent. The verification stage found blocking failures in the implementation at ${specDir}.

## Failures to fix

${failureList}

## Instructions

1. Read the relevant code and spec
2. Fix each blocking failure
3. Run the build to verify your fixes compile
4. Do not introduce new features — only fix the listed failures

## Project Directory

${config.projectDir}`;
}
```

### Step 7: Structured learnings output

**Files**: `src/core/prompts.ts`, `src/core/orchestrator.ts`

Lower priority than verify, but provides machine-appendable insights that can be deduplicated.

#### Learnings Schema

```typescript
const LEARNINGS_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["build", "testing", "api", "architecture", "tooling", "workaround"],
            description: "Classification of the insight"
          },
          insight: {
            type: "string",
            description: "One-line actionable insight"
          },
          context: {
            type: "string",
            description: "Brief context for when this applies"
          }
        },
        required: ["category", "insight", "context"],
        additionalProperties: false,
      }
    }
  },
  required: ["insights"],
  additionalProperties: false,
}
```

#### Orchestrator integration

```typescript
const learningsResult = await runStage(
  config, learningsPrompt, emit, rlog, runId, cycleNumber,
  "learnings", implSpecDir, LEARNINGS_SCHEMA
);
cycleCost += learningsResult.cost;

const learnings = learningsResult.structuredOutput as {
  insights: Array<{ category: string; insight: string; context: string }>;
} | null;

if (learnings?.insights.length) {
  // Append to learnings.md with deduplication
  appendLearnings(config.projectDir, learnings.insights);
}
```

The `appendLearnings` function reads the existing file, deduplicates, and appends new entries. Deduplication uses **normalized matching** on the `insight` field: case-insensitive, trimmed, with whitespace collapsed and leading articles/common verbs stripped (e.g., "Use --legacy-peer-deps" and "use  --legacy-peer-deps" match). This is more aggressive than exact match but still deterministic and zero-dependency — it catches the most common rephrasing patterns (capitalization, extra spaces, "Run X" vs "run X") without requiring embeddings.

To prevent unbounded growth over many cycles, `appendLearnings` enforces a **per-category cap of 20 entries** (configurable via `config.maxLearningsPerCategory`, default 20). When a category exceeds the cap, the oldest entries in that category are dropped. This bounds the file to ~120 entries max (6 categories × 20) while preserving the most recent insights.

This replaces the current approach where the agent reads and rewrites the entire file — eliminating read-modify-write race conditions.

### Step 8: Update manifest and `FeatureArtifacts.status` at lifecycle points

**Files**: `src/core/orchestrator.ts`, `src/core/state.ts`

#### Manifest updates

| Event | Location | Manifest Update |
|-------|----------|-----------------|
| Manifest created | After extraction | Emit `manifest_created` event (see new event below) |
| Feature selected (NEXT_FEATURE) | Before specify | `status: "active"` |
| Specify completes | After `discoverNewSpecDir` | `specDir: newSpecDir` |
| Feature skipped (3 replan failures) | ~line 2149 | `status: "skipped"` |
| Verify passes (all criteria met) | After verify | `status: "completed"` |
| Cycle error in catch block | ~line 2369 | Leave as `"active"` (retry next cycle) |

#### Crash consistency between manifest and state.json

Both `.dex/feature-manifest.json` and `.dex/state.json` are updated at lifecycle transitions. A crash between writing one and the other creates divergence (e.g., manifest says `"active"` but `FeatureArtifacts.status` is still `"specifying"` from a prior stage). To mitigate:

1. **Always update both stores in the same `commitCheckpoint()` call**. Extend `commitCheckpoint` to accept an optional manifest write alongside the state write, so they happen atomically (both tmp+rename in sequence, no interleaving).
2. **Add manifest reconciliation to crash recovery** (`state.ts` reconciliation logic): on startup, if manifest says `"active"` but no matching `FeatureArtifacts` entry exists, create one with `status: "specifying"`. If manifest says `"completed"` but `FeatureArtifacts.status` is not `"completed"`, update it. This is the same pattern already used for `FeatureArtifacts` crash recovery.
3. **Manifest is source of truth for coarse status**. If they disagree, manifest wins for selection decisions (what's next), `FeatureArtifacts` wins for phase decisions (which stage within a feature).

#### `FeatureArtifacts.status` updates (bug fix)

`FeatureArtifacts.status` in `state.ts:91-98` is currently **never updated during normal execution** — only during crash-recovery reconciliation (`state.ts:563,569`). The orchestrator tracks completion via the `featuresCompleted[]` array (`orchestrator.ts:2359`) but never writes status back to `FeatureArtifacts`. This must be fixed alongside the manifest work:

| Event | Location | `FeatureArtifacts.status` Update |
|-------|----------|----------------------------------|
| Specify starts | Before specify stage | `"specifying"` |
| Plan starts | Before plan stage | `"planning"` |
| Implement starts | Before implement stage | `"implementing"` |
| Verify starts | Before verify stage | `"verifying"` |
| Verify passes | After verify (all criteria met) | `"completed"` |
| Feature skipped | After 3 replan failures | `"skipped"` |

This aligns both tracking systems: the manifest owns coarse selection status (`pending/active/completed/skipped`), `FeatureArtifacts` owns fine-grained phase status (`specifying/planning/implementing/verifying/completed/skipped`).

### Step 9: Update types and clean up parser

**File**: `src/core/types.ts`

Extend `GapAnalysisDecision` with `featureId`:

```typescript
export type GapAnalysisDecision =
  | { type: "NEXT_FEATURE"; name: string; description: string; featureId: number }
  | { type: "RESUME_FEATURE"; specDir: string }
  | { type: "REPLAN_FEATURE"; specDir: string }
  | { type: "GAPS_COMPLETE" };
```

Add new stage types:
```typescript
export type LoopStageType = 
  | "manifest_extraction"   // NEW — one-time feature extraction
  | "implement_fix"         // NEW — targeted fix after verify failure
  | "gap_analysis" | "specify" | "plan" | "tasks" 
  | "implement" | "verify" | "learnings"
  | "clarification_synthesis" | ...;  // synthesis now uses outputFormat
```

Add new event types:
```typescript
// In OrchestratorEvent union:
| { type: "manifest_created"; runId: string; featureCount: number }
| { type: "manifest_drift_detected"; runId: string }
| { type: "verify_failed"; runId: string; cycleNumber: number; blockingCount: number; summary: string }
```

Add config fields:
```typescript
// In RunConfig:
maxVerifyRetries?: number;       // default: 1 — fix-reverify attempts per cycle before deferring
maxLearningsPerCategory?: number; // default: 20 — cap per category in learnings.md
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
| Verify | Plain text report, result ignored by orchestrator | `outputFormat` with pass/fail + typed failures → enables verify-fix-reverify loop |
| Learnings | Agent reads-modify-writes learnings.md directly | `outputFormat` with typed insights → machine-appendable, deduplicated with per-category cap |
| Clarification synthesis | Produces files via tools, orchestrator probes filesystem | `outputFormat` with `filesProduced` + `goalClarifiedPath` → explicit confirmation, filesystem probe as fallback |

### Stages evaluated but not converted to structured output

| Stage | Why not | Future opportunity? |
|-------|---------|---------------------|
| Clarification (product/technical) | Interactive — uses `AskUserQuestion` tool, no final-response parsing needed | No |
| Clarification synthesis | Produces files (GOAL_clarified.md, CLAUDE.md) via tools — the files *are* the output | **In scope** (Step 10) — structured confirmation of which files were produced eliminates filesystem probing |
| Specify | External skill (`/speckit-specify`) — cannot control output format | Yes — a post-specify structured output call can return `{ "specDir": "..." }`, eliminating `discoverNewSpecDir` filesystem diff |
| Plan | External skill (`/speckit-plan`) — produces plan.md via tools | No |
| Tasks | External skill (`/speckit-tasks`) — produces tasks.md via tools | No |
| Implement | Phase work via `runPhase` — results are implicit (code changes, task checkmarks) | Yes — structured output returning `{ tasksCompleted, tasksSkipped, buildPasses }` would let verify be more targeted |

### Step 10: Structured clarification synthesis confirmation

**Files**: `src/core/prompts.ts`, `src/core/orchestrator.ts`

Low-cost addition: after synthesis completes, the agent confirms which files were produced via structured output instead of the orchestrator probing the filesystem.

#### Synthesis Confirmation Schema

```typescript
const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    filesProduced: {
      type: "array",
      items: { type: "string" },
      description: "Relative paths of files created or updated during synthesis (e.g., 'GOAL_clarified.md', '.claude/CLAUDE.md')"
    },
    goalClarifiedPath: {
      type: "string",
      description: "Relative path to the clarified goal file"
    }
  },
  required: ["filesProduced", "goalClarifiedPath"],
  additionalProperties: false,
}
```

The synthesis prompt already instructs the agent to produce these files. Adding `outputFormat` with this schema makes the output explicit — the orchestrator reads `goalClarifiedPath` directly instead of searching for it. Null fallback: probe the filesystem as today (graceful degradation).

### Future opportunities (out of scope for this spec)

These are structured output applications identified during review that could further improve reliability but are not critical for the initial implementation:

1. **Post-specify spec directory confirmation**: Instead of relying on `discoverNewSpecDir()` filesystem diff, run a cheap follow-up structured output stage asking the agent "What spec directory did you just create?" returning `{ "specDir": "specs/001-product-catalog" }`. Eliminates the fragile before/after directory comparison entirely.

2. **Implementation phase completion signal**: `runPhase` currently produces free-text results with no structured signal of what was accomplished. A structured output returning `{ "tasksCompleted": [...], "tasksSkipped": [...], "buildPasses": true }` would let the verify stage target only what was actually implemented, reducing false negatives.

3. **Schema versioning**: Structured output schemas (`MANIFEST_SCHEMA`, `VERIFY_SCHEMA`, etc.) have no version field. If schemas change between Dex versions, in-progress runs with cached agent state could produce output matching the old schema. Future work: add a `schemaVersion` field to each schema, or include it in the stage type (e.g., `"verify_v2"`).

## Files Modified

| File | Change |
|------|--------|
| `package.json` | Upgrade `@anthropic-ai/claude-agent-sdk` to `^0.1.45` (prerequisite) |
| `src/core/manifest.ts` | **NEW** — FeatureManifest types (with `specDir` field), load/save/update/query/drift-check/updateSpecDir functions |
| `src/core/types.ts` | Add `ManifestFeatureStatus`, `FeatureManifestEntry`, `FeatureManifest`; add `featureId` to `GapAnalysisDecision`; add `manifest_extraction` and `implement_fix` stage types; add `manifest_drift_detected` and `verify_failed` events |
| `src/core/prompts.ts` | Fix `buildSpecifyPrompt` (remove `config` param, update call-site); add `buildManifestExtractionPrompt`; add `buildFeatureEvaluationPrompt` (replaces `buildGapAnalysisPrompt`); add `buildVerifyFixPrompt`; update `buildVerifyPrompt` output instructions; update `buildLearningsPrompt` output instructions; update synthesis prompt for `SYNTHESIS_SCHEMA` |
| `src/core/orchestrator.ts` | Add `outputFormat` to `runStage` with error handling and null fallback policy; manifest creation after clarification with retry logic and drift check; deterministic gap analysis using `active.specDir` with `buildFeatureEvaluationPrompt`; structured verify with configurable fix-reverify loop (`maxVerifyRetries`); structured learnings with normalized dedup and per-category cap; structured synthesis confirmation; manifest+state dual-write via `commitCheckpoint`; `FeatureArtifacts.status` updates during normal execution (bug fix) |
| `src/core/state.ts` | Ensure `FeatureArtifacts.status` is updated at each stage transition (specifying/planning/implementing/verifying/completed/skipped) — currently only set during crash-recovery reconciliation; add manifest reconciliation to crash recovery |
| `src/core/parser.ts` | Remove `parseGapAnalysisResult`, `GAP_DECISION_RE`, and `buildGapAnalysisPrompt` — no longer needed |

## Verification

1. **TypeScript compilation**: `npx tsc --noEmit`
2. **Manual test — manifest extraction**: Run the loop on dex-ecommerce, verify:
   - `.dex/feature-manifest.json` created after clarification with all 18 MVP features
   - Each feature has a rich description (user stories + acceptance criteria)
   - Feature statuses are all `"pending"`
   - `sourceHash` matches SHA-256 of GOAL_clarified.md
3. **Manual test — deterministic gap analysis**: Verify:
   - Cycle 1 gap analysis is instant (manifest walk), picks Feature 1
   - Specify prompt is `/speckit-specify Product Catalog: Categories (2-level)...`
   - Spec created at `specs/001-<name>/spec.md` (correct path)
   - Manifest updated to `"active"` for Feature 1
   - ArtifactManifest updated with `specDir` and fine-grained status
   - Cycle 2 picks Feature 2 deterministically
4. **Manual test — structured verify**: Verify:
   - Verify stage returns structured output with `passed`, `failures`, etc.
   - When `passed: false` with blocking failures, orchestrator re-enters implementation with a fix prompt
   - Re-verify runs after fix attempt
   - Only one fix-reverify loop per cycle (no infinite loops)
5. **Manual test — structured learnings**: Verify:
   - Learnings stage returns typed insights
   - Insights appended to `learnings.md` without duplicating existing entries
6. **Error handling**: Verify:
   - If structured output validation fails (`error_max_structured_output_retries`), the stage throws with a clear error message
   - Null fallback policy per stage: manifest_extraction throws, gap_analysis throws, verify treats as not-passed, learnings no-ops
   - Gap analysis (RESUME/REPLAN) uses `buildFeatureEvaluationPrompt` and returns structured `{decision, reason}`
7. **Synthesis confirmation**: Verify:
   - After synthesis, structured output contains `filesProduced` and `goalClarifiedPath`
   - If null, falls back to filesystem probing (existing behavior)
8. **Crash consistency**: Verify:
   - Manifest and state.json updates happen in the same `commitCheckpoint()` call
   - After simulated crash between stages, reconciliation restores consistent state
9. **Drift detection**: Verify:
   - Modify GOAL_clarified.md between runs
   - Loop start emits `manifest_drift_detected` event and logs a warning
   - Loop continues with existing manifest (does not auto-regenerate)
10. **Check logs**: `~/.dex/logs/` for errors, verify `structured_output` is captured
