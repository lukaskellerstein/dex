# Contract: evidence — `.dex/evidence/<id>/`

Written by Dex only, never by an agent. Not tracked: the folder keeps 015's
self-ignoring `.gitignore` (`*`). Losing the folder is safe: every gate runs
again (spec, Edge Cases).

```text
.dex/evidence/
├── .gitignore                 # "*", as in 015
└── <entry id>/
    ├── baseline-<n>.json      # a stage record (below)
    ├── tests-<n>.json
    ├── red-first-<n>.json
    ├── implement-<n>.json
    ├── verify-<n>.json
    ├── done.json              # the done record; replaces 015's verify.json
    ├── amendments.json
    ├── progress.md            # the attempt log
    └── archive/
        └── progress-<ISO>.md
```

`<n>` counts per stage from 1. Every JSON file is written to `<file>.tmp` and
renamed.

## Stage record

```json
{
  "version": 1,
  "entryId": "003-promo-codes",
  "stage": "implement",
  "n": 3,
  "mode": "phase",
  "taskPhase": 2,
  "key": "5d1c0a9e3b7f2c4d6e8a0b1c3d5e7f9a1b2c3d4e",
  "tasksHash": "9f2c…",
  "startSha": "a1b2…",
  "endSha": "c3d4…",
  "treeStamp": "77e0…",
  "runs": [
    {
      "name": "unit", "command": "npm test -- src/cart", "exitCode": 1, "signal": null,
      "durationMs": 8123, "result": "fail", "reruns": 1,
      "tail": ["FAIL src/cart/promo.test.ts > rejects an expired code", "  expected 400, got 200"]
    },
    {
      "name": "types", "command": "npm run typecheck", "exitCode": 0, "signal": null,
      "durationMs": 4410, "result": "pass", "reruns": 0, "tail": []
    }
  ],
  "planDiff": { "newlyTicked": ["T014"], "violations": [] },
  "testChanges": { "frozenChanged": [], "testsDeletedOrRenamed": [], "skipMarkers": [] },
  "fingerprint": "0be1…",
  "gate": {
    "gate": "progress", "outcome": "fail", "pauseReason": null,
    "reason": "T014 is ticked, but the fast check \"unit\" is red", "next": "restore"
  },
  "acceptanceHash": null,
  "summary": "T014 done; the expiry check uses the clock helper.",
  "at": "2026-11-12T09:41:07.000Z"
}
```

| `stage` | Written | Holds |
|---|---|---|
| `baseline` | before `implement` and `verify`, unless the last stamp matches (R6) | fast (and standing) runs, the baseline gate |
| `tests` | after the `tests` stage | the agent's summary, `mode` |
| `red-first` | right after `tests` (create mode) | the acceptance run, `acceptanceHash`, the red-first gate |
| `implement` | after every implement run | runs, `planDiff`, `testChanges`, `fingerprint`, the progress gate |
| `verify` | after every verify | the acceptance runs, the verifier's output, the done gate |

## Done record — `done.json`

```json
{
  "version": 2,
  "entryId": "003-promo-codes",
  "key": "5d1c…",
  "tasksHash": "9f2c…",
  "checked": "2026-11-12T10:02:44.000Z",
  "acceptance": [ { "name": "acceptance", "result": "pass", "exitCode": 0, "…": "…" } ],
  "mode": "review",
  "findings": [
    { "severity": "minor", "summary": "The error text says 'coupon', the spec says 'promo code'", "criterion": "SC-003", "where": "src/cart/promo.ts:41" }
  ],
  "hypotheses": [],
  "summary": "Acceptance is green; one minor wording finding.",
  "gate": "passed"
}
```

- `key` and `tasksHash` are 015's (`evidenceKey`, `tasksHash`), taken before the
  stage.
- `gate` is Dex's: `passed` only when every acceptance run is green and no
  finding is `blocking`.
- A `verify.json` from 015 is ignored; the picker sees no done record and runs
  `verify` once more.

## `amendments.json`

```json
{
  "items": [
    {
      "file": "tests/acceptance/003-promo-codes/expired-code.spec.ts",
      "reason": "The test expects HTTP 410; the plan's contract says 422 for an expired code.",
      "status": "approved",
      "askedAt": "2026-11-12T09:50:00.000Z",
      "decidedAt": "2026-11-12T09:58:12.000Z"
    }
  ]
}
```

## `progress.md`

```markdown
## 2026-11-12T09:41:07Z · implement · phase 2

**Agent**: Added the promo-code lookup; the expiry check is not wired yet.
**Notes**: `src/cart/promo.ts` needs the clock from `src/lib/time.ts` to test expiry.
**Gate**: progress fail — 1 fast check is red: unit
**Failing**: unit — `FAIL src/cart/promo.test.ts > rejects an expired code`
```

`**Notes**`, `**Gate**` and `**Failing**` appear only when they have content;
several notes or failing runs are joined with ` · `. A failing run shows its
first output line that names an error or a failure, else its last line, cut at
200 characters.

## The digest — `.dex/digests/<id>.md`

Not in the evidence folder, but built from it. `.dex/digests/` carries its own
`.gitignore` (`*`).

```markdown
# 003-promo-codes — paused at implement: stalled

**Why**: 003-promo-codes: three implement runs ended with the same failure and no new diff

**Diff** (since a1b2c3d): src/cart/promo.ts +84 −3 · src/lib/time.ts +12 −0 · 2 files

**Diff** services/api (since 9f8e7d6): no changes

**Tasks done**: T010–T014 (5 of 9 in scope)

**Checks**: unit ✗ (red 3 runs in a row) · types ✓ · lint ✓ (flaky ×1)

**Acceptance**: not run yet

**Verifier**: —

**Skip markers**: none

**Answered by default**: 1 — "Store codes case-insensitively?" → "Yes (Recommended)"

**Cost**: $1.84 this entry, this run
```

- The sections are separated by a blank line, so the page also reads right
  when it is rendered as Markdown.
- `**Why**` is the pause detail; a done entry has none and its status is `done`.
- One `**Diff**` line per repo. The project's runs from the `startSha` of the
  entry's first stage record; an extra checkout of the policy's `repos` runs
  from its HEAD at the first record's time (`git rev-list -1 --before=<at> HEAD`).
  This is an approximation: Dex does not record that repo's HEAD at the start.
  Up to 5 files, biggest first.
- `**Checks**` starts with `no fast checks ran (none declared; the progress gate
  rests on the plan diff alone)` when the policy and the entry declare none
  (FR-020).
- `**Acceptance**` shows the newest acceptance runs (verify, else red-first).
- `**Verifier**` lists each finding on its own line under the summary.
