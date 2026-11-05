# Contract: `.dex/queue.json` v3

Tracked in the project's git. The human owns it. Dex writes it only in three
explicit setup moments: manifest extraction (new project), the one-time v2
migration, and `dex queue init`. **Dex never writes it during a run** — entry
status is derived from files (research R2).

Types and validation rules: [`../data-model.md`](../data-model.md) § Queue.

## Example — existing project (`onion-demo-01`, abridged)

```json
{
  "version": 3,
  "kind": "existing",
  "entries": [
    {
      "id": "020-onion-thin-layer",
      "title": "Onion thin layer — US7 labels + Trino access rules",
      "skip": ["brief", "specify", "clarify", "plan", "tasks"],
      "tasks": ["T110", "T122-T134"]
    },
    {
      "id": "021-agent-entry",
      "title": "Agent entry",
      "brief": "docs/my-specs/021-agent-entry/README.md",
      "baseBranch": "020-onion-thin-layer"
    },
    {
      "id": "022-installable-pilot",
      "title": "Month 2 — installable pilot",
      "brief": "docs/my-specs/022-installable-pilot/README.md",
      "generate": {
        "sources": [
          "../executive-management/product/first-paying-customer/index.html",
          "../executive-management/product/first-paying-customer/demo-coverage.html",
          "docs/my-specs/021-agent-entry/README.md",
          "demo/gap-report.md",
          "specs/020-onion-thin-layer/tasks.md"
        ],
        "instructions": "Month 2 features from §3 of the plan. Include US8 (T135–T144) from 020."
      },
      "gates": ["brief"]
    }
  ]
}
```

`022`'s `baseBranch` is absent, so it defaults to `021-agent-entry`.

## Example — new project (written by manifest extraction)

```json
{
  "version": 3,
  "kind": "new",
  "entries": [
    { "id": "001-catalog-and-search", "title": "Catalog and search", "description": "…" },
    { "id": "002-cart-and-checkout", "title": "Cart and checkout", "description": "…" }
  ]
}
```

In a `new` queue, every entry's `branch` resolves to the run branch, so there
is no per-entry branch switching.

## Human-owned `status`

| Value | Effect |
|---|---|
| absent | the picker derives it |
| `"skipped"` | the picker passes over the entry |
| `"done"` | the picker treats the entry as done without reading `verify.md` (used by the v2 migration, and for features finished before Dex) |

## `dex queue init <projectDir>`

1. Refuses if `.dex/queue.json` exists (prints its path; exit 2).
2. Lists `specs/*/` and `docs/my-specs/*/` (directories only), merges them by
   folder name, and sorts by name.
3. Writes one entry per folder:
   - `id` = folder name, `title` = the first `# ` heading of `spec.md` or the brief, else the id;
   - `brief` = `docs/my-specs/<id>/README.md` when it exists;
   - `skip` = the stages whose artefacts already exist (`specify` if `spec.md`,
     `clarify` if it has `## Clarifications`, `plan`, `tasks`);
   - `status: "done"` when `tasks.md` exists with every task checked.
4. Writes `kind: "existing"`, `.dex/policy.json` with every default spelled
   out (if absent), and `.dex/.gitignore` (if absent).
5. Prints the files it wrote and the reminder to review and commit them. It does
   not start a run and does not run git.
