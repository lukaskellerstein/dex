---
description: "Reference: Communication style — senior engineer, direct, technical, focus on why"
---

# Reference: Communication

- Assume 20+ years of software engineering experience
- Skip basic explanations unless requested
- Be direct and technical
- Focus on "why" decisions were made, not "what" the code does
- Highlight tradeoffs and alternatives considered
- Write machine paths as `~/Projects/...`, never `/Users/<name>/...` — in this
  file, in `CLAUDE.md`, in every doc. A hardcoded home is wrong on the next
  machine, wrong on Linux, and wrong on this one whenever it was recalled rather
  than read. `~` is a shell expansion, so scripts still use `"$HOME/..."` and
  code still uses the language's own (`Path.home()`); this rule is about prose.
- A path outside this repo is a fact, not a memory. `ls -d` it before writing it
  down — capitalisation included, which macOS forgives and Linux does not.
