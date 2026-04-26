# IPC Contract — `profiles:*`

**Direction**: Renderer → Main (`ipcMain.handle`)
**File**: `src/main/ipc/profiles.ts` (NEW)
**Preload binding**: `window.dexAPI.profiles.{list, saveDexJson}`

The new profile IPC surface is intentionally tiny — list + save. Folder creation, deletion, and runner-native overlay editing are filesystem-only in v1.

---

## `profiles:list`

```ts
list: (projectDir: string) => Promise<ProfileEntry[]>;
```

Returns one entry per top-level directory under `<projectDir>/.dex/agents/`. The returned array is sorted alphabetically by folder name. If `<projectDir>/.dex/agents/` does not exist, returns `[]` (no error).

`ProfileEntry` is defined in [`data-model.md`](../data-model.md#6-profileentry-new--ipc-payload-shape):

```ts
type ProfileEntry =
  | { kind: "ok"; profile: AgentProfile; overlaySummary: OverlaySummary }
  | { kind: "warn"; folder: string; agentDir: string; reason: string };
```

**Per-folder algorithm**:

1. Skip entries whose name starts with `.` (e.g. `.DS_Store`).
2. Read `<agentDir>/dex.json`. If absent → `{kind: "warn", reason: "missing dex.json"}`.
3. Parse JSON. If invalid → `{kind: "warn", reason: \`invalid JSON: ${err.message}\`}`.
4. Validate fields (see data-model.md §4):
   - `agentRunner` ∈ {`claude-sdk`, `codex`, `copilot`} → otherwise warn.
   - `model` is a non-empty string → otherwise warn.
   - `systemPromptAppend`, `allowedTools` if present must be string / `string[]` respectively → otherwise warn.
5. Compute `overlaySummary` by stat-ing `<agentDir>/.claude/`:
   - `hasClaude`: directory exists.
   - `skills`: count of regular files under `.claude/skills/` (recursive, but flat is the common case).
   - `subagents`: count of regular files under `.claude/agents/`.
   - `mcpServers`: number of top-level keys in `.claude/.mcp.json`'s `mcpServers` object (0 if file absent or malformed — file-malformed is a soft fail; the entry is still `kind: "ok"` with `mcpServers: 0`).
   - `hasClaudeMd`: `.claude/CLAUDE.md` exists.
6. Return `{kind: "ok", profile, overlaySummary}`.

**Errors**: never throw to the renderer — return a per-folder warn entry instead. A truly catastrophic failure (e.g., `.dex/agents/` exists but is unreadable due to permissions) yields a single warn entry with `folder: "."` and `reason: <perm error>`.

---

## `profiles:saveDexJson`

```ts
saveDexJson: (
  projectDir: string,
  name: string,
  dexJson: {
    agentRunner: "claude-sdk" | "codex" | "copilot";
    model: string;
    systemPromptAppend?: string;
    allowedTools?: string[];
  },
) => Promise<{ ok: true } | { ok: false; error: string }>;
```

**Behavior**:

1. Resolve `<projectDir>/.dex/agents/<name>/dex.json`. If `<projectDir>/.dex/agents/<name>/` does not exist → `{ok: false, error: "agent folder not found"}`.
2. Validate `dexJson` against the schema (same rules as `list` step 4). Invalid → `{ok: false, error: <reason>}`.
3. Write the file with `JSON.stringify(dexJson, null, 2) + "\n"`. Atomic write: write to `<file>.tmp` then `fs.renameSync` over the original.
4. Return `{ok: true}`.

The handler MUST NOT touch any file outside `<projectDir>/.dex/agents/<name>/dex.json`. In particular, the runner-native `.claude/` subdirectory is not modified by this call.

**Concurrency**: The handler uses the existing per-project `withLock(projectDir, …)` so two simultaneous saves cannot corrupt the file.

---

## Renderer call pattern

```tsx
const profiles = await window.dexAPI.profiles.list(projectDir);

const okProfiles = profiles.filter((e): e is Extract<ProfileEntry, {kind: "ok"}> => e.kind === "ok");
const warnEntries = profiles.filter((e): e is Extract<ProfileEntry, {kind: "warn"}> => e.kind === "warn");

// Save edits back
const res = await window.dexAPI.profiles.saveDexJson(projectDir, "conservative", {
  agentRunner: "claude-sdk",
  model: "claude-opus-4-7",
  systemPromptAppend: "Prefer minimal diffs.",
  allowedTools: ["Read", "Edit", "Write", "Grep", "Bash"],
});
```

---

## Out of scope for these contracts

- **No `profiles:create`** in v1. Folder creation is filesystem-only.
- **No `profiles:delete`** in v1. Same rationale.
- **No `profiles:writeClaude*`** in v1. Runner-native overlay edits are filesystem-only.
- **No user-level `~/.dex/agents/` library**. All paths are project-scoped.

These are listed in the spec's *Out of Scope / Follow-ups* and tracked separately.
