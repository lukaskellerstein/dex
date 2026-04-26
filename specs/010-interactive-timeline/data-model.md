# Data Model — 010 Interactive Timeline

This document captures the entity shapes introduced or extended by this feature. Types are TypeScript-flavoured pseudocode; the canonical home for each is given alongside.

---

## 1. `TimelineCommit` *(NEW)*

**Defined in**: `src/core/checkpoints.ts`

One step-commit, ready for layout.

```ts
interface TimelineCommit {
  sha: string;          // 40-char hex
  shortSha: string;     // first 7 chars
  branch: string;       // refname:short — column key
  parentSha: string | null;  // first-parent in git, used for cross-column edges
  step: StepType;       // parsed from "[checkpoint:<step>:<cycle>]"
  cycleNumber: number;  // 0 for cycle-0 (bare) tags
  subject: string;      // full commit subject
  timestamp: string;    // ISO-8601 (%cI)
  hasCheckpointTag: boolean;  // any checkpoint/* tag points at this SHA
}
```

**Rules**:
- Only commits whose subject matches `^\[checkpoint:` are emitted as `TimelineCommit`. Mid-stage WIP commits are filtered out at the source.
- `parentSha` is the first-parent SHA from git, regardless of whether that parent is itself a step-commit. The renderer is responsible for resolving "previous step-commit reachable from this one in the same column" via the index of all returned commits.

---

## 2. `TimelineSnapshot` *(EXTENDED)*

**Defined in**: `src/core/checkpoints.ts`

Adds two fields on top of the existing 008 shape:

```ts
interface TimelineSnapshot {
  // Existing 008 fields — unchanged
  checkpoints: CheckpointInfo[];
  attempts: AttemptInfo[];
  currentAttempt: AttemptInfo | null;
  pending: PendingCandidate[];
  captureBranches: string[];
  startingPoint: StartingPoint | null;

  // NEW
  commits: TimelineCommit[];     // every step-commit reachable from any tracked branch
  selectedPath: string[];         // ordered list of step-commit SHAs from starting-point → HEAD
}
```

**Rules**:
- `commits` is sorted ascending by `timestamp` for deterministic layout.
- `selectedPath` is a strict subset of `commits.map(c => c.sha)` and stops at the run's starting-point (not earlier).
- The error fallback in `checkpoints:listTimeline` IPC handler MUST include `commits: []` and `selectedPath: []` so the renderer never crashes on an empty payload.

---

## 3. `JumpToResult` *(NEW)*

**Defined in**: `src/core/checkpoints.ts`

Discriminated-union return shape for `jumpTo()`:

```ts
type JumpToResult =
  | { ok: true; action: "noop" }
  | { ok: true; action: "checkout"; branch: string }
  | { ok: true; action: "fork"; branch: string }
  | { ok: false; error: "dirty_working_tree"; files: string[] }
  | { ok: false; error: "not_found" | "git_error"; message: string };
```

**State transitions** (from current HEAD pointing at SHA `H`, target SHA `T`):

| Precondition | Result | Side effects |
|---|---|---|
| `T === H` | `{action: "noop"}` | none |
| Working tree dirty | `{error: "dirty_working_tree"}` | none (UI handles modal) |
| `T` is unique tip of branch `B` | `{action: "checkout", branch: B}` | `git checkout B` |
| `T` is mid-branch or tip of multiple branches | `{action: "fork", branch: <new>}` | `git checkout -B <attempt-ts> T` |
| `T` does not resolve to a commit | `{error: "not_found"}` | none |
| Any other git error | `{error: "git_error", message}` | possibly partial (rolled back where possible) |

---

## 4. `AgentProfile` *(NEW)*

**Defined in**: `src/core/agent-profile.ts`

Discriminated union over runner type. The folder-name IS the profile name; `agentDir` is computed at load time.

```ts
type AgentProfile = ClaudeProfile | CodexProfile | CopilotProfile;

interface BaseProfile {
  name: string;           // folder basename (e.g., "conservative")
  agentDir: string;       // absolute path: <projectDir>/.dex/agents/<name>
}

interface ClaudeProfile extends BaseProfile {
  agentRunner: "claude-sdk";
  model: string;                  // "claude-opus-4-7" | "claude-sonnet-4-6" | "claude-haiku-4-5"
  systemPromptAppend?: string;    // appended to assembled system prompt
  allowedTools?: string[];        // SDK allowedTools restriction; subset of project tools
  // Skills, subagents, plugins, MCP servers, marketplaces are NOT enumerated here.
  // They live as files inside <agentDir>/.claude/ and are picked up natively at spawn.
}

interface CodexProfile extends BaseProfile {
  agentRunner: "codex";
  model: string;
  systemPromptAppend?: string;
}

interface CopilotProfile extends BaseProfile {
  agentRunner: "copilot";
  model: string;
  systemPromptAppend?: string;
}
```

**Validation rules**:
- `agentRunner` MUST be one of `"claude-sdk"` | `"codex"` | `"copilot"`. Unknown values → folder is reported as `{kind: "warn"}` (see `ProfileEntry` below).
- `model` MUST be a non-empty string. Empty/missing → warn.
- `systemPromptAppend` MAY be present; if present MUST be a string.
- `allowedTools` MAY be present; if present MUST be `string[]`.
- The folder-name (and therefore `name`) MUST be filesystem-safe and non-empty. Folders starting with `.` (e.g., `.DS_Store`) are silently skipped.
- v1 only `claude-sdk` profiles are operational. `codex` and `copilot` parse cleanly but are flagged as "Coming soon" by the modal (the runner registry rejects them with `"runner not implemented"` if anyone tries to spawn).

---

## 5. `dex.json` *(NEW — on-disk schema)*

**Stored at**: `<projectDir>/.dex/agents/<name>/dex.json`

```jsonc
{
  "agentRunner": "claude-sdk",                                   // required
  "model": "claude-sonnet-4-6",                                  // required
  "systemPromptAppend": "Prefer minimal diffs. Avoid new deps.", // optional
  "allowedTools": ["Read", "Edit", "Write", "Grep", "Bash"]      // optional
}
```

`name` and `agentDir` are NOT stored in `dex.json` — they're derived from the folder path at load time.

A bare `dex.json` with no `.claude/` sibling is valid: the variant inherits the project's committed `.claude/` (no overlay) and only the Dex-side knobs apply.

---

## 6. `ProfileEntry` *(NEW — IPC payload shape)*

**Returned by**: `profiles:list(projectDir)` IPC handler

```ts
type ProfileEntry =
  | { kind: "ok"; profile: AgentProfile; overlaySummary: OverlaySummary }
  | { kind: "warn"; folder: string; agentDir: string; reason: string };

interface OverlaySummary {
  hasClaude: boolean;            // does <agentDir>/.claude/ exist?
  skills: number;                // count of files under .claude/skills/
  subagents: number;             // count of files under .claude/agents/
  mcpServers: number;            // count of servers in .claude/.mcp.json (top-level keys)
  hasClaudeMd: boolean;          // <agentDir>/.claude/CLAUDE.md exists
}
```

**Rules**:
- `kind: "ok"` entries are pickable in the modal dropdown.
- `kind: "warn"` entries are rendered as disabled rows with `reason` shown in muted text. The `reason` is human-readable: e.g. `"missing dex.json"`, `"invalid JSON: Unexpected token …"`, `"unknown agentRunner: 'foo'"`.

---

## 7. `VariantSpawnRequest` *(EXTENDED)*

**Defined in**: `src/core/checkpoints.ts`

Adds an optional per-variant profile binding:

```ts
interface VariantSpawnRequest {
  fromCheckpoint: string;                     // existing
  variantLetters: string[];                   // existing, e.g., ["a","b","c"]
  step: StepType;                             // existing
  profiles?: Array<{                          // NEW
    letter: string;                           // matches variantLetters[i]
    profile: AgentProfile | null;             // null = (none) → no overlay, runner defaults
  }>;
}
```

**Rules**:
- If `profiles` is omitted, every variant runs with `null` (current behavior).
- For each `letter` present in `variantLetters` but missing from `profiles`, treat as `{profile: null}` — the array is sparse-tolerant.
- Codex/Copilot profiles cause `spawnVariants` to return `{ok: false, error: "runner not implemented"}` with no side effects.

---

## 8. `VariantGroupState` *(EXTENDED — on-disk file shape)*

**Stored at**: `<projectDir>/.dex/variant-groups/<groupId>.json`

The 008 file already records `groupId`, `branches`, `worktrees`, `parallel`, `step`. We add:

```jsonc
{
  "groupId": "...",
  "step": "plan",
  "branches": ["attempt-2026-04-25-abc-a", "attempt-2026-04-25-abc-b"],
  "worktrees": [".dex/worktrees/attempt-2026-04-25-abc-a", "..."],
  "parallel": true,
  "profiles": [                                            // NEW
    {
      "letter": "a",
      "name": "conservative",
      "agentDir": "/abs/path/<projectDir>/.dex/agents/conservative"
    },
    { "letter": "b", "name": null, "agentDir": null }
  ]
}
```

**Rules**:
- The `profiles` field is optional on read for backwards compatibility (groups created before this feature lack it). Missing → treat as all-`null`.
- `name`/`agentDir` are `null` when `(none)` was selected.
- `agentDir` is stored as an absolute path so resume continues to work even if the Dex CWD changes between sessions.

---

## 9. Step status (`StageList` row) — *(EXTENDED)*

**Defined in**: `src/renderer/components/loop/StageList.tsx`

Existing states: `done` | `running` | `paused` | `pending`. Adds:

```ts
type StageStatus = "done" | "running" | "paused" | "pause-pending" | "pending";
```

**Derivation rule** (replaces today's read of orchestrator state):

```ts
function statusFor(
  step: StepType,
  selectedPath: string[],
  expectedSha: (s: StepType) => string | null,  // mapping step → step-commit SHA on this path
  state: { currentStage: StepType | null; status: "running" | "paused" | "idle" }
): StageStatus {
  const sha = expectedSha(step);
  if (sha && selectedPath.includes(sha)) return "done";
  if (state.currentStage === step) {
    return state.status === "running" ? "running" : "paused";
  }
  // pause-pending: stage is the next unstarted row when status is paused
  if (state.status === "paused" && isNextUnstarted(step, selectedPath, state.currentStage)) {
    return "pause-pending";
  }
  return "pending";
}
```

`isNextUnstarted` is a pure function over `STAGE_ORDER_RENDERER` and the inputs above.

---

## 10. `CommitContextMenu` props *(NEW — UI shape)*

**Defined in**: `src/renderer/components/checkpoints/CommitContextMenu.tsx`

```ts
interface CommitContextMenuProps {
  commit: TimelineCommit;
  isKept: boolean;                              // node has a checkpoint/* tag
  position: { x: number; y: number };           // viewport coords
  onKeep: (sha: string) => Promise<void>;       // → checkpoints:promote
  onUnkeep: (sha: string) => Promise<void>;     // → new: clear-tag IPC; reuse existing if present
  onTryNWays: (sha: string, step: StepType) => void; // → opens TryNWaysModal anchored at sha
  onClose: () => void;
}
```

**Rules**:
- The menu shows **Keep this** when `isKept === false`, **Unmark kept** when `true`.
- "Try N ways from here" is always shown.
- Clicking outside or pressing Escape closes the menu via `onClose`.

---

## Cross-references

| Entity | Used by |
|---|---|
| `TimelineCommit` | `timelineLayout()`, `<TimelineGraph>` |
| `TimelineSnapshot.commits` / `.selectedPath` | `useTimeline` hook → `<TimelinePanel>`, `<StageList>`, `<ProcessStepper>` |
| `JumpToResult` | `checkpoints:jumpTo` IPC, `<TimelineGraph>` click handler, `<GoBackConfirm>` re-use |
| `AgentProfile` | `profiles:list`, `<TryNWaysModal>`, `<AgentProfileForm>`, `spawnVariants()`, `applyOverlay()`, `ClaudeAgentRunner` |
| `dex.json` | `loadProfile()`, `saveDexJson()` |
| `ProfileEntry` | `profiles:list` IPC, modal dropdown rendering |
| `VariantSpawnRequest.profiles` | `spawnVariants()`, `applyOverlay()` call sites |
| `VariantGroupState.profiles` | resume flow in `orchestrator.ts` |
