---
description: "Step 1: Understand — read code, ask questions, identify gaps before any implementation"
---

# Step 1: Understand

- Read relevant code and identify impacted areas
- Baseline the repo's existing problems with `nvim-tools --json --all`, so
  findings you introduce stay distinguishable from ones that were already there.
  For performance or RAM questions, `lukas-ps --json [name]` measures the real
  process tree. Both: [`machine-tools.md`](machine-tools.md).
- **If `LSP` is in your tool list, load it and use it** for every question about
  a symbol — where defined, who implements, who calls. It is deferred, so
  `ToolSearch("select:LSP")` comes first or it cannot be called at all. Absent
  from the list means this repo did not opt in: use `grep`.
  [`lsp.md`](lsp.md).
- Ask clarifying questions if requirements are ambiguous
- Identify gaps in the current design and opportunities for improvement
- Understand the requirement completely before proceeding
- **For bug reports**: reproduce the issue first (via Playwright or logs) to confirm the problem before attempting a fix
