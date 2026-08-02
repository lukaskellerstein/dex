---
description: "Step 3: Spec Documentation — update spec-kit on feature branches after implementing changes"
---

# Step 3: Spec Documentation

**Skip on `main` branch and for trivial changes.**

On feature branches, run `/sync-spec-kit` to update the spec folder after
implementing changes.

- The spec folder is the **single source of truth** for what was built in the
  feature branch
- Every change must be reflected in the spec — bug fixes, new functionality,
  adjustments
- When the user reports a bug or requests a change: first implement it, then
  update the spec
