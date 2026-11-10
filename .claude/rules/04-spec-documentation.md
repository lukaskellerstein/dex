---
description: "Step 3: Spec Documentation — change the spex records first on feature branches, then follow spex next"
---

# Step 3: Spec Documentation

**Skip on `main` branch and for trivial changes.**

On feature branches, a change to what the feature does goes into its spex
folder (`specs/NNN-slug/`) **before** the code:

1. `/spex:clarify specs/NNN-slug` — the changed record goes back to `draft`.
2. `/spex:approve specs/NNN-slug` — gate 1 again.
3. Then run whatever the NEXT block (`spex next`) names: new tasks, their
   tests red first, then the code.

- The spec folder is the **single source of truth** for what was built in the
  feature branch
- Every change must be reflected in the spec — bug fixes, new functionality,
  adjustments
- When the user reports a bug or requests a change: first change the record,
  then build it. spex 2.0 removed `/spex:sync`, which edited approved records
  from the code after the fact.
- A record already on `main` is never edited: a new record with `supersedes`
  replaces it.
- `specs/001`–`016` are spec-kit history. Nothing syncs or converts them.
