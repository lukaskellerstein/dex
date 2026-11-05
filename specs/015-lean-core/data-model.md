# Data Model: 015 Lean Core

Every entity here is a file. There is no database. "Tracked" means the file
lives in the project's git; "runtime" means it is ignored and local to one
machine.

| File | Tracked | Written by | Read by |
|---|---|---|---|
| `.dex/queue.json` | yes | human, `dex queue init`, manifest extraction, v2 migration | picker, queue panel, CLI |
| `.dex/policy.json` | yes | human | runner, preflight, post-stage |
| `.dex/.gitignore` | yes | setup (new project) or `dex queue init` | git |
| `specs/<id>/verify.md` | yes | the `verify` agent | picker |
| `specs/<id>/tasks.md` | yes | spec-kit `tasks`, `implement` agents, `verify` agent (fix phase) | picker, parser, task board |
| `.dex/state.json` | no (runtime) | Dex | Dex, renderer, CLI |
| `.dex/questions.md` | no (runtime) | Dex | the human, CLI |
| `.dex/runs/<runId>.json` | no (runtime) | Dex (`runs.ts`, unchanged) | renderer |

## Queue — `.dex/queue.json` (v3)

```ts
interface QueueV3 {
  version: 3;
  /** "new": Dex created the project (goal → clarification → manifest), one run branch.
   *  "existing": hand-written or `dex queue init`; Dex never branches, commits or pushes. */
  kind: "new" | "existing";
  entries: QueueEntry[];
}

interface QueueEntry {
  id: string;                  // ^[a-z0-9][a-z0-9._-]*$, unique; default spec folder + branch name
  title: string;
  description?: string;        // goes into `specify` when there is no brief
  status?: "done" | "skipped"; // HUMAN-OWNED override; absent = derived by the picker
  brief?: string;              // path relative to projectDir
  generate?: { sources: string[]; instructions?: string };
  specDir?: string;            // default `specs/<id>`
  branch?: string;             // default `<id>` (existing) / the run branch (new)
  baseBranch?: string;         // default: previous entry's resolved branch, else current branch
  tasks?: string[];            // scope filter: "T110", "T122-T134"
  skip?: StageName[];
  gates?: StageName[];         // default ["brief"] when `generate` is set, else []
}

type StageName = "brief" | "specify" | "clarify" | "plan" | "tasks" | "implement" | "verify";
```

**Validation** (`QueueInvalidError`, names the entry and the field; Dex refuses to start):

- `version === 3`; `kind` is one of the two values; `entries` is a non-empty array.
- `id` unique and matches the pattern; `title` non-empty.
- `generate.sources` non-empty when `generate` is present.
- every `skip` / `gates` value is a `StageName`.
- every `tasks` item matches `^T\d+$` or `^T\d+-T\d+$` with start ≤ end.
- unknown top-level or entry fields are rejected (a typo must not be silently ignored).

**Resolved entry.** `resolveEntries(queue, currentBranch)` fills the defaults in
order, so `baseBranch` can refer to the previous entry's resolved `branch`. The
resolved form is what the picker, prompts and UI use.

**Derived status** (not stored): `skipped` (human) → `done` (human) →
`done` (verify.md passes for the current `tasks.md` hash) → `active` (the first
entry that is neither) → `pending` (every later entry).

### Migration: `.dex/feature-manifest.json` v2 → queue v3

Runs in `loadQueue` only when `queue.json` is missing and the manifest exists.
It writes `queue.json` once and leaves the manifest file in place.

| v2 field | v3 field |
|---|---|
| — | `kind: "new"` (v2 manifests only come from the new-project flow) |
| `specDir` (if set) | `id` = basename of `specDir`, `specDir` = `specDir` |
| `id`, `title` (when `specDir` is null) | `id` = `NNN-<slug(title)>`, with `NNN` = `id` zero-padded to 3 |
| `title` | `title` |
| `description` | `description` |
| `status: "completed"` | `status: "done"` (v2 runs wrote no `verify.md`, so the status is preserved) |
| `status: "skipped"` | `status: "skipped"` |
| `status: "pending" \| "active"` | (absent — derived) |
| `sourceHash`, `sourcePath` | dropped; drift detection moves to manifest extraction, which now writes v3 directly |

## Policy — `.dex/policy.json`

```ts
interface Policy {
  settingSources: ("user" | "project" | "local")[];       // default ["user","project","local"]
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions"; // default "default"
  env: Record<string, string>;                             // default {}
  deny: PolicyRule[];                                      // default []
  ask: PolicyRule[];                                       // default []
  writeRoots: string[];                                    // default ["."]; os.tmpdir() always added
  frozen: string[];                                        // git pathspec globs, default []
  preflight: string[];                                     // shell commands, default []
  repos: string[];                                         // globs of extra checkouts, default []
  systemPromptAppend?: string;                             // path to a Markdown file
  questions: "recommended-then-review" | "wait";           // default "recommended-then-review"
  openPullRequest: boolean;                                // default false
  limits: {
    maxBudgetUsdPerStage?: number;
    maxBudgetUsdPerRun?: number;
    maxTurnsPerStage?: number;
    maxImplementRunsWithoutProgress: number;               // default 2
    maxVerifyRounds: number;                               // default 3
  };
}

interface PolicyRule {
  tool: string;      // exact tool name, or "*" for any tool
  pattern: string;   // JavaScript RegExp source, compiled once at load ("u" flag)
  reason: string;    // shown to the agent and in the trace
}
```

**Validation** (`PolicyInvalidError`; Dex refuses to start): every field type;
every `pattern` compiles; `systemPromptAppend` file exists; unknown fields
rejected. `permissionMode: "bypassPermissions"` with `queue.kind === "existing"`
throws `PolicyRefusedError` (FR-014). A missing file means all defaults.

**Rule subject.** A rule's `pattern` is tested against one string per tool call:

| Tool | Subject |
|---|---|
| `Bash` | `input.command` — the whole string, so `a && b` and `bash -c "…"` are covered |
| `Edit`, `Write`, `Read`, `NotebookEdit` | `input.file_path` (or `notebook_path`), resolved to an absolute path |
| `WebFetch` | `input.url` |
| any other | `JSON.stringify(input)` |

**Decision order** (`decideToolUse`, pure): `deny` rules → write roots and frozen
files (write tools only) → `ask` rules → no opinion. The first match wins.

## Run state — `.dex/state.json` (v2, runtime)

Holds only what files cannot say (FR-004). A file with any other `version` is
treated as absent: position is derived from files, so nothing is lost but the
cost total and the run id.

```ts
interface DexStateV2 {
  version: 2;
  runId: string;
  status: "running" | "paused" | "completed" | "failed";
  pauseReason?: PauseReason;
  pauseDetail?: string;              // human-readable: which limit, which file, which command
  kind: "new" | "existing";
  runBranch: string | null;          // new projects only: the single dex/<date>-<id> branch
  current: { entryId: string; stage: StageName; taskPhase: number | null } | null;
  cumulativeCostUsd: number;
  counters: Record<string, { implementRunsWithoutProgress: number }>; // keyed by entry id
  pendingRequests: PendingRequest[];
  reviewList: ReviewItem[];          // questions auto-answered in recommended-then-review
  answerBook: AnswerBookItem[];      // answers given while no agent was waiting (headless resume)
  config: ConfigSnapshot;            // model, limits, autoClarification, descriptionFile
  startedAt: string;
  pausedAt: string | null;
}

type PauseReason =
  | "user_abort" | "gate" | "question" | "tool_approval" | "dirty_tree"
  | "frozen_changed" | "preflight_failed" | "limit_reached" | "no_progress"
  | "invalid_input";                 // unknown task ids, missing brief, bad queue/policy
```

**State transitions:** `running → paused` (any `PauseReason`), `running →
completed` (queue complete), `running → failed` (unhandled error), `paused →
running` (Resume: the picker runs again). There is no reconcile transition.

Verify rounds are **not** a counter: they are the number of
`## Phase N: Verify fixes V<k>` sections in `tasks.md`, so they survive a reset
to any commit.

## Pending request (questions, tool approvals, gates, limits)

```ts
type PendingRequest = {
  id: string;                        // uuid
  entryId: string | null;
  askedAt: string;
} & (
  | { kind: "question"; questions: UserInputQuestion[] }          // AskUserQuestion, unchanged shape
  | { kind: "tool_approval"; toolName: string; subject: string; input: unknown; source: "policy" | "settings"; reason?: string }
  | { kind: "pause"; reason: PauseReason; detail: string; options: string[] } // gate, limit, dirty tree, …
);

interface ReviewItem { question: string; answer: string; entryId: string | null; stage: StageName; at: string }
interface AnswerBookItem { key: string; answer: string | "approve" | "deny"; at: string }
```

`key` is `q:<normalized question text>` for a question and
`t:<toolName>:<subject>` for a tool approval. When a re-run agent asks a request
whose key is in the book, Dex answers from the book and removes the item.

## Verification record — `specs/<id>/verify.md`

Written by the `verify` agent; Dex parses only the three header lines. Exact
format in [`contracts/verify-md.md`](contracts/verify-md.md).

```text
**Verdict**: passed | failed
**Tasks-SHA256**: <64 hex>      ← copied verbatim from the prompt; Dex computes it
**Checked**: <ISO-8601>
```

Valid for picking only when the hash equals `sha256(tasks.md)` now.

## Picker decision

```ts
type PickerDecision =
  | { kind: "stage"; entry: ResolvedEntry; stage: StageName; taskPhase?: number; reason: string }
  | { kind: "pause"; entry: ResolvedEntry; reason: PauseReason; detail: string }
  | { kind: "complete" };            // every entry is done or skipped
```

`reason` is the matched row of the D-015-1 table, in words (for the trace,
`--dry-run` and the queue panel).
