# Contract: On-Disk JSON File Formats

**Status**: Authoritative for the file formats this feature creates. Implementations must produce byte-compatible output.

Two file formats are defined:

1. **`<projectDir>/.dex/runs/<runId>.json`** — pretty-printed JSON (2-space indent, trailing newline).
2. **`~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl`** — JSON Lines (one JSON object per line, no enclosing array).

Both files use UTF-8 encoding and LF line endings.

---

## 1. `runId.json` — RunRecord

### Top-level structure (example)

```json
{
  "runId": "ab2c3f4d-1234-5678-9abc-def012345678",
  "mode": "loop",
  "model": "claude-opus-4-7",
  "specDir": "specs/007-sqlite-removal",
  "startedAt": "2026-04-17T12:34:56.789Z",
  "endedAt": "2026-04-17T12:58:11.012Z",
  "status": "completed",
  "totalCostUsd": 1.234567,
  "totalDurationMs": 1394223,
  "phasesCompleted": 6,
  "writerPid": 28471,
  "description": null,
  "fullPlanPath": null,
  "maxLoopCycles": 3,
  "maxBudgetUsd": 5,
  "loopsCompleted": 1,
  "phases": [
    {
      "phaseTraceId": "a1b2c3d4-...",
      "runId": "ab2c3f4d-...",
      "specDir": "specs/007-sqlite-removal",
      "phaseNumber": 1,
      "phaseName": "loop:specify",
      "stage": "specify",
      "cycleNumber": 1,
      "featureSlug": "007-sqlite-removal",
      "startedAt": "2026-04-17T12:34:56.789Z",
      "endedAt": "2026-04-17T12:36:00.000Z",
      "status": "completed",
      "costUsd": 0.123,
      "durationMs": 63211,
      "inputTokens": 12345,
      "outputTokens": 6789,
      "subagents": [
        {
          "id": "subagent-uuid",
          "type": "specify",
          "description": null,
          "status": "ok",
          "startedAt": "2026-04-17T12:35:00.000Z",
          "endedAt": "2026-04-17T12:35:55.000Z",
          "durationMs": 55000,
          "costUsd": 0
        }
      ],
      "checkpointTag": null,
      "candidateSha": null
    }
    /* ... more phases ... */
  ],
  "failureCounters": {
    "specs/007-sqlite-removal": { "impl": 0, "replan": 0 }
  }
}
```

### Field types

See `data-model.md § 1` (`RunRecord`), `§ 2` (`PhaseRecord`), `§ 3` (`SubagentRecord`).

### Serialization rules

- `JSON.stringify(run, null, 2)` — pretty-printed with 2-space indent.
- Trailing newline (`\n`) appended after the closing brace. Makes `tail`, `cat`, and version-control diffs cleaner.
- ISO-8601 timestamps with millisecond precision (`new Date().toISOString()` produces this exact format).
- Numbers are JavaScript `number`s (IEEE 754 double). USD costs are written as full-precision; consumers should display rounded.
- `null` for absent optional values, never `undefined` (which `JSON.stringify` would drop).

### Atomicity

- File is written via `fs.writeFileSync(tmp, ...)` then `fs.renameSync(tmp, target)`. The `tmp` path is `<target>.tmp` in the same directory.
- Readers should never observe a partial file: either the previous version is in place, or the new version is.
- A `.tmp` file left over from a crash is invisible to `listRuns` (suffix filter on `.json`).

---

## 2. `steps.jsonl` — StepRecord stream

### Format

- One JSON object per line.
- No enclosing array. No comma between lines. No trailing comma at end-of-file.
- Each line is `JSON.stringify(step) + "\n"`.
- File is append-only during the phase's lifetime.

### Example file

```jsonl
{"id":"step-001","phaseTraceId":"a1b2c3d4-...","sequenceIndex":0,"type":"user_message","content":"...","metadata":{"costUsd":null,"inputTokens":null,"outputTokens":null},"durationMs":null,"tokenCount":null,"createdAt":"2026-04-17T12:35:00.000Z"}
{"id":"step-002","phaseTraceId":"a1b2c3d4-...","sequenceIndex":1,"type":"skill_invoke","content":null,"metadata":{"skillName":"speckit.specify","skillArgs":"specs/007 --phase 1","costUsd":null,"inputTokens":null,"outputTokens":null},"durationMs":null,"tokenCount":null,"createdAt":"2026-04-17T12:35:01.000Z"}
{"id":"step-003","phaseTraceId":"a1b2c3d4-...","sequenceIndex":2,"type":"tool_call","content":"Read /tmp/foo","metadata":{"toolName":"Read","toolUseId":"abc","costUsd":0.001,"inputTokens":12,"outputTokens":34,"belongsToSubagent":"subagent-uuid"},"durationMs":15,"tokenCount":46,"createdAt":"2026-04-17T12:35:02.000Z"}
```

### Per-line JSON shape

See `data-model.md § 4` (`StepRecord`).

### Reader behavior

```ts
function readSteps(file: string): StepRecord[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const out: StepRecord[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as StepRecord);
    } catch {
      console.warn(`steps.jsonl: skipping malformed line in ${file}`);
    }
  }
  return out;
}
```

A half-written final line (orchestrator killed mid-append) is silently skipped. The rest of the file remains valid.

### Sort order

Steps are written in `sequenceIndex` order. The reader does NOT re-sort under normal operation. A defensive `sort((a, b) => a.sequenceIndex - b.sequenceIndex)` is acceptable but not required.

### `metadata` field shape

The `metadata` object is loosely typed (`Record<string, unknown>`). Known keys:

- `costUsd`: running total at the time the step was emitted.
- `inputTokens`, `outputTokens`: running totals.
- `belongsToSubagent`: subagent id, present only when exactly one subagent is active at step emission time.
- `toolName`, `toolUseId`, `toolInput`, `toolResult`: present on `tool_call`/`tool_result` steps.
- `skillName`, `skillArgs`: present on `skill_invoke` steps.

Future additions go here without breaking the format.

---

## 3. Cross-file invariants

### Phase identity

The same `phaseTraceId` appears in:

- `<projectDir>/.dex/runs/<runId>.json` → `phases[].phaseTraceId`
- `~/.dex/logs/<project>/<runId>/phase-<N>_<slug>/steps.jsonl` → every line's `phaseTraceId` field

This is denormalized (the file path also encodes `phaseNumber` and `slug`) but inclusion makes each line self-describing for ad-hoc analysis (`cat steps.jsonl | jq 'select(.type=="tool_call")'`).

### Phase log path derivation

Given a `RunRecord` and a `PhaseRecord` from it, the steps file is at:

```
~/.dex/logs/<basename(projectDir)>/<runId>/phase-<phaseNumber>_<slug(phaseName)>/steps.jsonl
```

where `slug(s) = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")` — the same algorithm `RunLogger.startPhase` uses today (`orchestrator.ts:133`).

### Cost reconciliation

`run.totalCostUsd` ≈ `sum(phases[].costUsd where status terminal)`. Drift is tolerated only for live `running` phases — once a phase reaches a terminal status, the sum invariant must hold to within IEEE-754 floating-point error.

---

## 4. Compatibility windows

This is the v1 of these formats. There is no version field. Future additions are append-only (new optional fields with documented defaults). Removing or renaming a field is a breaking change requiring a migration step (out of scope for this feature; spec is dev-phase).

If a future feature needs a versioned format, it adds a `schemaVersion: 2` (or similar) top-level field and the reader branches on its presence.
