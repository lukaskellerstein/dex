---
description: "Step 1: Understand — read code, ask questions, identify gaps before any implementation"
---

# Step 1: Understand

- Read relevant code and identify impacted areas
- Baseline the repo's existing problems with `nvim-tools --json --all`, so
  findings you introduce stay distinguishable from ones that were already there.
  For performance or RAM questions, `lukas-ps --json [name]` measures the real
  process tree. Both: [`machine-tools.md`](machine-tools.md).
- Ask clarifying questions if requirements are ambiguous
- Identify gaps in the current design and opportunities for improvement
- Understand the requirement completely before proceeding
- **For bug reports**: reproduce the issue first (via Playwright or logs) to confirm the problem before attempting a fix
