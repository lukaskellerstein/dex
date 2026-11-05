# Data Model: 015 Lean Core

Every entity here is a file. There is no database. "Tracked" means the file
lives in the project's git; "runtime" means it is ignored and local to one
machine.

| File | Tracked | Written by | Read by |
|---|---|---|---|
| `.dex/queue.json` | yes | human, `dex queue init`, manifest extraction, v2 migration | picker, queue panel, CLI |
| `.dex/policy.json` | yes | human | runner, preflight, post-stage |
| `.dex/.gitignore` | yes | setup (new project) or `dex queue init`, only when absent | git |
| `.dex/evidence/<id>/verify.json` | no (the folder ignores itself) | Dex, from the `verify` agent's structured verdict | picker |
| `specs/<id>/tasks.md` | yes | spec-kit `tasks`, `implement` agents, `verify` agent (fix phase) | picker, parser, task board |
| `.dex/state.json` | no (runtime) | Dex | Dex, renderer, CLI |
| `.dex/questions.md` | no (runtime) | Dex (`renderQuestionsFile`; removed when nothing waits and the review list is empty) | the human, CLI |
| `.dex/mock-config.json` | project's choice | human | the mock agent (`entries` map, see [R15](research.md)) |

The runtime files are listed once, in `RUNTIME_IGNORE_ENTRIES` (`state.json`, `state.json.tmp`, `state.lock`, `runs/`, `questions.md`, `ui.json`). That list writes `.dex/.gitignore` and also defines which paths never make a tree "dirty".
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
- `generate.sources` non-empty when `generate` is present, and `generate` needs `brief` (the path it writes).
- optional strings (`description`, `brief`, `specDir`, `branch`, `baseBranch`) are non-empty when present; `status` is `done` or `skipped`.
- every `skip` / `gates` value is a `StageName`.
- every `tasks` item matches `^T\d+$` or `^T\d+-T\d+$` with start ≤ end.
- unknown top-level or entry fields are rejected (a typo must not be silently ignored).

**Resolved entry.** `resolveEntries(queue, currentBranch, runBranch)` fills the defaults in
order, so `baseBranch` can refer to the previous entry's resolved `branch`. In a
`new` queue every entry's `branch` is the run branch (the current branch before it
exists). `tasks` is expanded to individual ids (`parseTaskScope`). The resolved
form is what the picker, prompts and UI use.

**Task scope.** A task is in scope when the entry has no `tasks` filter, lists the
id, or sits in a fix phase (a phase whose name starts `Verify fixes V<n>`,
`isFixPhase`). The one rule is `isInScope` / `hasOpenScopedTask` in `queue.ts`; the
picker, the implement counter, the implement prompt and build mode all use it. The
parser reads `[x]` and `[X]` alike (spec-kit writes `[X]`).

**Derived status** (not stored): `skipped` (human) → `done` (human) →
`done` (a passing verify record matches the entry's key and `tasks.md` now) → `active` (the first
entry that is neither) → `pending` (every later entry).

### Migration: `.dex/feature-manifest.json` v2 → queue v3

Runs in `loadQueue` only when `queue.json` is missing and the manifest exists.
It writes `queue.json` once and leaves the manifest file in place. With
`loadQueue(projectDir, { persistMigration: false })` it migrates in memory and
writes nothing (`--dry-run`, `--status`, the app's snapshot).

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
  systemPromptAppend: string | null;                       // project-relative path to a Markdown file; null = none (default)
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
| `Edit`, `Write`, `MultiEdit`, `Read`, `NotebookEdit` | `input.file_path` (or `notebook_path`), resolved to an absolute path |
| `WebFetch` | `input.url` |
| any other | `JSON.stringify(input)` |

**Decision order** (`decideToolUse`, pure): `deny` rules → write roots and frozen
files (write tools only: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`) → `ask` rules
→ no opinion. The first match wins. A frozen file denies a write only when it is
tracked at HEAD (`git cat-file -e HEAD:./<rel>`); a file that is only staged is not
frozen yet. `frozen` globs are project-relative and tested with `path.matchesGlob`
(`*` stays inside one folder). `limits` values must be positive; the budget fields
are numbers, the others integers.

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
  current: { entryId: string; stage: StageName; taskPhase: number | null } | null; // the stage that ran last; informational, the picker decides what is next
  cumulativeCostUsd: number;
  counters: Record<string, { implementRunsWithoutProgress: number }>; // keyed by entry id
  pendingRequests: PendingRequest[];
  reviewList: ReviewItem[];          // questions auto-answered in recommended-then-review
  answerBook: AnswerBookItem[];      // answers given while no agent was waiting (headless resume)
  config: ConfigSnapshot;            // model, maxTurns, maxIterations, autoClarification, descriptionFile (limits live in the policy, not here)
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
On Resume every pending request is dropped (`clearStaleRequests`): a pause is
answered by Resume itself, and a parked question or approval is asked again by the
stage that re-runs. `budget_exceeded` ends the loop with `paused` / `limit_reached`;
Stop ends it `paused` / `user_abort`; a run that pauses because no human can answer
(`dex run` without a TTY) is `paused` with `question` or `tool_approval`, not a Stop.
A paused or failed loop writes `paused` / `failed` to `runs/<runId>.json`.

Only one counter is stored: `counters[entryId].implementRunsWithoutProgress`. It
resets to 0 when an `implement` run increases the number of checked in-scope tasks
(fix phases count), and a stopped `implement` leaves it alone.

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

interface ReviewItem { question: string; answer: string; entryId: string | null; stage: StepType; at: string } // StepType: a new project's clarification steps are not queue stages
interface AnswerBookItem { key: string; answer: string; at: string } // a label or typed text; for an approval "approve", "deny" or the denial message
```

`key` is `q:<normalized question text>` for a question and
`t:<toolName>:<subject>` for a tool approval. When a re-run agent asks a request
whose key is in the book, Dex answers from the book and removes the item.

**Who answers a question** (`askQuestions`, one place): the answer book, then (in
`recommended-then-review`) the recommended options, then a human. An option is
recommended when its label ends in `(Recommended)`, case-insensitive. The mode per
session is `questionModeFor(step, autoClarification, policy)`: the new-project
clarification steps follow `autoClarification`, every other stage follows
`policy.questions`. A pause request is recorded with `recordPause`; the run has
already ended, so nothing waits on it and the IPC answer path does not carry it.
`.dex/questions.md` is regenerated from `pendingRequests` and `reviewList`.

## Verification record — `.dex/evidence/<id>/verify.json`

Written by Dex after each `verify` stage from the agent's structured verdict;
not tracked. Exact format in [`contracts/evidence.md`](contracts/evidence.md).

```ts
interface VerifyRecord {
  version: 1;
  entryId: string;
  key: string;          // existing: the entry branch's HEAD; new: "spec:" + sha256 of the spec folder
  tasksHash: string;    // sha256(tasks.md) when the stage started
  checked: string;      // ISO-8601
  verdict: "passed" | "failed";
  summary: string;
  commands: Array<{ command: string; exitCode: number }>;
  criteria: Array<{ criterion: string; met: boolean; note: string }>;
}
```

Valid for picking only when `key` and `tasksHash` equal the entry's key and
`sha256(tasks.md)` now. The key is taken before the stage, so it names what the
agent checked (research R19).

## Picker decision

```ts
type PickerDecision =
  | { kind: "stage"; entry: ResolvedEntry; stage: StageName; taskPhase?: number; reason: string }
  | { kind: "pause"; entry: ResolvedEntry; reason: "invalid_input"; detail: string } // missing brief without `generate`, unknown task ids, no branch
  | { kind: "complete" };            // every entry is done or skipped
```

`reason` is the matched row of the D-015-1 table, in words (for the trace,
`--dry-run` and the queue panel). The picker only ever pauses with
`invalid_input`; every other pause reason comes from a guard around the stage
(`stages/post-stage.ts`, `branching.ts`, `preflight.ts`). A verify record that
matches and says `failed` also yields `verify`.

`describeEntries` / `describeQueue` give the queue panel's view: `skipped` and
`done` from the human override or the verify record, the first other entry `active`, every
later one `pending`. Each entry is judged on its own tree, so a later entry shows
its own first stage.

## Run snapshot (`project:get-run-snapshot`, `dex run --status`)

```ts
interface RunSnapshot {
  state: DexStateV2 | null;   // read fresh
  queue: QueueView | null;    // null: no queue yet (new project before manifest), or an invalid one
  errors: string[];           // queue / policy validation errors, verbatim
}
```

Per-entry cost is the sum of the run record's agent runs by `featureSlug`, which
`run-stage.ts` sets to the entry id (the entry's 1-based queue position is the
`cycleNumber`, so the log tree and `runs.ts` keep their paths). The run record
keeps `maxBudgetUsd`, read from `limits.maxBudgetUsdPerRun`.
