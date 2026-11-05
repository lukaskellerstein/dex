# 018 — Living docs: the project's documentation is the loop's lasting memory

> **Status:** draft v1.0 · 2026-11-05 · the brief for spec-kit. Feature, branch and spec folder: `018-living-docs`.
>
> **Builds on** [`015-lean-core`](../015-lean-core/README.md) (queue, picker, policy) and [`016-grounded-loop`](../016-grounded-loop/README.md) (sensors, gates, evidence, digest).
>
> **Followed by** [`019-many-projects-any-agent`](../019-many-projects-any-agent/README.md): several projects at once, and Codex and OpenCode next to Claude. Its agents get the project's instructions from this spec's `docs` list (D-019-6).
>
> **Timing:** 018 doesn't block the first real run on a `dex-ecommerce` scratch clone at the end of 016. It should land before that queue reaches its first generated brief, because the `brief` stage reads the docs and the previous entry's digest (D-018-7).

## Why

A loop needs memory that outlives a session ("The agent forgets, the repo doesn't" — Osmani). There are three kinds, and Dex has to treat them differently.

| Memory | What it holds | Lifetime | Where it lives |
|---|---|---|---|
| **Working** | this entry's attempts: what was tried, what failed, open hypotheses | until the entry is done | `.dex/evidence/<id>/progress.md` (016, D-016-9) |
| **Lasting** | what the system *is*, why it is that way, and how to work on it | as long as the project | **the project's own docs**, in git (this spec) |
| **History** | transcripts, evidence records, digests | kept, never fed back into prompts | Claude Code's session files, `.dex/evidence/`, `.dex/digests/` |

Lasting memory is the risky one, for four reasons:

- **The old learnings code had no gate.** The learnings stage appended agent-written "insights" to `learnings.md` (capped at `maxLearningsPerCategory`, 20 per category), and `manifest.ts` still migrates that file out of `.claude/rules/learnings.md`. Unreviewed lessons went into the rules that every later agent loads as instructions.
- **Bad memories persist.** A 2026 study found an instruction written into an agent's memory in one session keeps steering later sessions, with about 50% attack success on average. A survey notes that agent memory layers rarely use the version-control rollback the code already has.
- **Two debts grow quietly:** *comprehension debt* (code nobody understands) and *intent debt* (the "why" is lost unless it's written down). A smooth loop grows both faster.
- **spec-kit records history, not the present.** Each spec says what one feature intended at the time it was written. Nothing in them says what the system is today, which is what an agent starting a run needs.

Dex already knows the answer: its own workflow has a feature-docs step that keeps the docs true to the code. Nothing checks it. So this spec makes **the project's documentation the only lasting memory**: written to the repo, reviewed as diffs, revertible with git, checked by the loop.

## What changes

### D-018-1 — The docs are the only lasting memory

There is no learnings store. Delete `appendLearnings`, `LEARNINGS_SCHEMA`, `maxLearningsPerCategory`, the `.claude/rules/learnings.md` migration, and anything 015 left of the learnings stage.

A project's lasting knowledge has two audiences, and both live in the repo:

| Audience | What | Typical files |
|---|---|---|
| Humans, and agents getting their bearings | architecture (current state), decision log (why), runbook (how to deploy) | `docs/architecture.md`, a decision log, `docs/runbook.md`, READMEs |
| Agents | how to work here: commands, conventions, gotchas | `CLAUDE.md`, `.claude/rules/`, skills |

Claude Code loads the agent docs itself, through `settingSources`, so Dex doesn't inject them. The **personal** auto memory of the human who owns the machine stays out of the loop: 015's policy sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for every loop agent by default.

### D-018-2 — The policy declares the docs

`policy.json` gains a `docs` list:

| Field | Meaning | Default |
|---|---|---|
| `path` | the doc (or a glob) | — |
| `audience` | `human` or `agent` | `human` |
| `read` | `always`: every stage prompt says "read these first"; `onDemand`: listed as available | `onDemand` |
| `covers` | code globs this doc describes | `[]` |
| `maintain` | `true`: must stay true to the code; `false`: read-only for the loop | `true` |
| `appendOnly` | entries may be added, never rewritten (a decision log) | `false` |
| `maxLines` | size limit, so it stays readable | none |

Also `docs.lint`, a list of lint commands (terminology, markdown) Dex runs as sensors. Files with `maintain: false` go into the policy's `frozen` set automatically.

The `read: always` docs should stay short. Together they are what every fresh session reads before it starts, so their size is a cost paid on every stage.

### D-018-3 — Docs are part of done

1. **Routing is deterministic.** When an entry's diff, which Dex collected, touches files under a doc's `covers`, Dex lists that doc in the verifier's prompt as "check this doc against the diff". It does this whether or not the doc changed.
2. **Truth is the verifier's call.** In review mode (016, D-016-5) the verifier reports a doc that no longer matches the code as a **blocking** finding. The rule is "the doc must be true", not "the doc must change", so a diff that leaves a doc correct needs no doc edit.
3. **The fix goes through the plan.** A blocking doc finding appends a doc task to the fix phase, like any other finding.

### D-018-4 — Drift sensors Dex runs itself

These are deterministic and run at the done gate, on every `maintain: true` doc:

| Sensor | Blocks? |
|---|---|
| Broken references: relative links, and repo paths in backticks that no longer exist | yes |
| `docs.lint` commands | yes, when declared |
| Over `maxLines` | no; listed in the digest |
| An `appendOnly` doc with existing lines removed or changed | yes |

Dex does **not** execute commands found in docs. Docs are written by agents, so running their code blocks would execute agent-written commands outside the policy's hooks, which only see agent tool calls. Runbooks are tested through the project's own acceptance commands (016) instead.

### D-018-5 — Lessons become proposed doc edits, approved by the human

A stage's structured output may include `lessons`: `{text, target, kind, evidenceId?}`.

- `target` is the doc to change. It must be a `maintain: true` doc, otherwise the lesson is rejected on arrival.
- `kind` is `convention`, `command`, `gotcha` or `decision`.
- `evidenceId` points at the 016 evidence that supports it. A lesson with evidence (for example, a command that failed and then worked) is marked **grounded** in the digest.

Dex stores lessons in `.dex/lessons.json` (gitignored), with their provenance (entry, stage, run, evidence, date) and a status: `proposed`, `approved`, `rejected` or `applied`.

- **Review.** The human reviews lessons in a batch, in the digest view or with `dex lessons`. Nothing is auto-approved: unreviewed lessons wait and are counted in every digest.
- **Applying.** Dex never writes the docs itself (D-015-2). Approved lessons are applied by a `docs` stage (D-018-6), and the agent commits them.

### D-018-6 — A `docs` stage applies lessons and writes baselines

The stage has two modes.

- **Apply.** It runs when approved lessons are pending, on the current entry's branch, before any other stage. The picker gets a new first row: "approved lessons pending → `docs`". The agent writes each lesson into its target, within `maxLines`. It may merge or move text inside a doc to stay within the limit. Removing a fact needs its own approved lesson. Its write scope is the target docs only (016, D-016-6).
- **Baseline.** A queue entry with `kind: "docs-baseline"` runs this mode once, for an existing project with missing docs. The agent surveys the code and writes the first architecture doc (and a runbook, if asked). The entry is gated on review: the human approves it at the gate before it counts as done. It never runs on its own schedule, because regenerating docs wipes human edits and drifts toward bulk.

`dex docs check` runs the D-018-4 sensors on demand, outside a run.

### D-018-7 — Handoff between entries goes through docs and the digest

When the `brief` stage writes the next entry's brief, it reads:

- the `read: always` docs;
- the decision log;
- the previous entry's digest (016, D-016-10).

That is how what one entry learned reaches the next entry's brief: through reviewed text, not through an agent's private notes.

### D-018-8 — Spec folders are history, never the architecture

The verifier and the `brief` stage treat `specs/*` as the record of intent at the time each spec was written. When a spec and the architecture doc disagree, the doc describes the present. A disagreement the code doesn't settle is a question for the human.

## Files

- **Delete:** `appendLearnings` and the learnings migration in `manifest.ts`, `LEARNINGS_SCHEMA` in `prompts.ts`, `maxLearningsPerCategory` in `config.ts`, and the learnings call in `stages/cycle-stages.ts`, if 015 left any of them.
- **Add, core:**
  - `docs-sensors.ts`: references, `appendOnly`, size;
  - `lessons.ts`: the store, statuses, provenance;
  - `stages/docs.ts`: apply and baseline modes.
- **Change:**
  - `policy.ts`: the `docs` list, and `maintain: false` → `frozen`;
  - `picker.ts`: the `docs` row and the `docs-baseline` entry kind;
  - `gates.ts`: the doc sensors in the done gate;
  - `prompts.ts`: the `read: always` list in every stage; doc routing in the verifier's prompt; `lessons` in the stage output schemas;
  - `digest.ts` and the renderer: a lessons review section with approve and reject;
  - `cli.ts`: `dex lessons`, `dex docs check`;
  - `MockConfig.ts`: the scenarios below.

## Implementation order

After every phase, `npm test` and `npm run typecheck` pass.

0. Confirm 016 as built: sensors, gates, evidence, digest.
1. Delete the learnings code; add the `docs` policy list and the frozen mapping.
2. Doc sensors (D-018-4) in the done gate; doc routing to the verifier (D-018-3).
3. Lessons: the store, the output schema, review in the digest and the CLI (D-018-5).
4. The `docs` stage in apply and baseline modes; the picker rows (D-018-6).
5. Handoff into the `brief` stage (D-018-7).
6. The mock scenarios.
7. Configure the `dex-ecommerce` scratch clone (Appendix A) and run `dex docs check` there. The first findings are a baseline, not a failure: list them in the digest and fix them as a docs entry, with the owner's approval.

## Verification (DoD)

- [ ] `npm test`, `npm run typecheck` and `npm run check:size` pass.
- [ ] `grep` finds no `learnings` code path in `src`.
- [ ] Mock scenarios end as documented:

| Scenario | Expected outcome |
|---|---|
| The verifier reports a covered doc as false | done gate fails; a doc task is added to the fix phase |
| A maintained doc links to a deleted file | done gate fails |
| An agent edits a `maintain: false` doc | the hook denies it |
| A lesson targets a frozen doc | rejected on arrival |
| A lesson is approved | the `docs` stage applies it and the agent commits; status `applied` |
| A lesson is rejected | never applied |
| An `appendOnly` decision log gets a line rewritten | done gate fails |
| The next entry's `brief` stage runs | its prompt includes the previous digest and the `read: always` docs |

- [ ] A loop agent's environment has `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, and a mock run leaves the owner's auto-memory directory unchanged.
- [ ] On the `dex-ecommerce` scratch clone, `dex docs check` runs, and its findings are listed for the owner.

## Out of scope

- Regenerating docs on every run.
- Generated diagrams.
- Publishing a docs site.
- Executing commands found in docs (D-018-4 says why).
- Vector search or embeddings over docs.
- Docs outside the project's `writeRoots`; they stay read-only.

## Open decisions

The proposed default is in bold.

1. **Lesson approval:** **always the human** | auto-approve grounded `command` lessons.
2. **A doc the verifier finds false:** **blocks done** | is listed in the digest only.
3. **Over `maxLines`:** **listed in the digest** | blocks done.
4. **When approved lessons are applied:** **before the next stage, on the current entry's branch** | in one batch at the end of each entry.

## Appendix A — a dex-ecommerce scratch clone

The clone has no architecture doc yet, so it also exercises the `docs-baseline` mode (D-018-6).

| Doc | Audience | Read | Covers | Notes |
|---|---|---|---|---|
| `README.md` | human | always | `src/**` | |
| `GOAL_technical_domain.md` | human | always | `src/**` | the stack, the folder structure and the constraints |
| `GOAL.md`, `GOAL_clarified.md`, `GOAL_product_domain.md` | human | onDemand | — | `maintain: false`: the owner's intent, changed only by the owner |
| `docs/architecture.md` | human | always | `src/{catalog,cart,accounts}/**` | written by a `docs-baseline` entry; `maxLines` 400 |
| `docs/decisions.md` | human, decision log | onDemand | — | `appendOnly`; created by the same `docs-baseline` entry |
| `CLAUDE.md`, `.claude/rules/*.md` | agent | loaded by Claude Code | — | where `command`, `convention` and `gotcha` lessons go; created by the first such lesson |
| `.claude/skills/**` | agent | loaded by Claude Code | — | `maintain: false`: installed by spec-kit |

- **Lint:** `docs.lint` is empty until the clone carries a markdown lint config.
- **Lesson targets:** `decision` lessons go to `docs/decisions.md`; the others go to the `.claude/rules/` file the lesson names.
