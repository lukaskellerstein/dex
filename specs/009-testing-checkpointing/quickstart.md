# Quickstart — Running the Mock Agent Backend

**Feature**: 009-testing-checkpointing
**Audience**: A Dex developer validating checkpoint UX (timeline, Go Back, Try Again, Step Mode, Record Mode, promotion) without paying real-agent time/cost.

---

## TL;DR

```bash
# 1. Reset the example project
./scripts/reset-example-to.sh clean

# 2. Point the example at the mock backend
cat > /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json <<'EOF'
{ "agent": "mock" }
EOF

# 3. Drop in a scripted run (see §3 below for a full template)
cp specs/009-testing-checkpointing/quickstart-assets/mock-config.example.json \
   /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/mock-config.json

# 4. Start the loop — UI click, no toggle needed
#    Welcome → Open Existing → Start Autonomous Loop
```

A three-cycle run should complete in well under 60 seconds. Every checkpoint tag a real run would create is present; every checkpoint commit has a non-empty diff.

---

## 1. When to use the mock backend

- You're editing checkpoint code (`src/core/checkpoints.ts`, `src/renderer/components/checkpoint/*`) and need to see the timeline, tags, and Go Back / Try Again / Step Mode / Record Mode actually work.
- You're reproducing a checkpoint-related bug and need deterministic behavior.
- You're writing tests that exercise the full loop and want them fast.

**When NOT to use it**:
- Validating a real-agent behavior change — use the real backend with `dex-ecommerce`.
- CI or pre-ship — real backend only.
- Anything that needs real prompt/SDK fidelity — the mock is sparse by design.

---

## 2. Pre-flight

1. **Reset the example project** (destructive, authorized):
   ```bash
   ./scripts/reset-example-to.sh clean
   ```

2. **Confirm dev-setup.sh is running** — `~/.dex/dev-logs/electron.log` exists and is being appended; `mcp__electron-chrome__list_pages` succeeds.

3. **Confirm the fixtures exist** at repo root:
   ```bash
   ls fixtures/mock-run/
   # Expected: GOAL_clarified.md, CLAUDE.md, constitution.md, feature-manifest.json,
   #           f1-spec.md, f1-plan.md, f1-tasks.md, f2-*, f3-*
   ```

---

## 3. Author the mock script

Create `<projectDir>/.dex/mock-config.json`. The shape below is a three-cycle template — two cycles add a feature each, the third is a terminator.

```json
{
  "enabled": true,
  "fixtureDir": "/home/lukas/Projects/Github/lukaskellerstein/dex/fixtures/mock-run/",

  "prerequisites": {
    "prerequisites": { "delay": 100 }
  },

  "clarification": {
    "clarification_product":   { "delay": 150 },
    "clarification_technical": { "delay": 150 },
    "clarification_synthesis": {
      "delay": 200,
      "writes": [
        { "path": "GOAL_clarified.md", "from": "GOAL_clarified.md" },
        { "path": "CLAUDE.md",          "from": "CLAUDE.md" }
      ]
    },
    "constitution": {
      "delay": 150,
      "writes": [
        { "path": ".specify/memory/constitution.md", "from": "constitution.md" }
      ]
    },
    "manifest_extraction": {
      "delay": 200,
      "writes": [
        { "path": ".dex/feature-manifest.json", "from": "feature-manifest.json" }
      ]
    }
  },

  "dex_loop": {
    "cycles": [
      { "…": "see specs/009-testing-checkpointing/quickstart-assets/mock-config.example.json for the full three-cycle template" }
    ]
  },

  "completion": {}
}
```

**Notes on the template**:
- The three feature IDs (`f-001`, `f-002`, `f-003`) MUST appear in `fixtures/mock-run/feature-manifest.json` (they're already listed there).
- Loop termination is driven by **manifest state**, not by the mock. Once every feature in the manifest is `completed`, the orchestrator emits a synthetic `GAPS_COMPLETE` on the next iteration and breaks — no entry in mock-config is consulted for that terminator iteration. The `gap_analysis.structured_output` in each cycle is load-bearing only for RESUME paths (mid-cycle abort + resume into an already-active feature).
- To run N full cycles, put N features in the manifest **and** N cycle entries in mock-config (one cycle per feature). Ordering in `cycles[]` must match the orchestrator's `getNextFeature()` traversal order (first pending feature in the manifest = cycles[0]).
- `delay: 0` is legal and useful for "burn-through" cycles.
- Substitution tokens (`{specDir}`, `{cycle}`, `{feature}`) are resolved at stage execution time.

---

## 4. Run it

1. Launch the app (via `dev-setup.sh`).
2. Welcome screen:
   - Parent: `/home/lukas/Projects/Github/lukaskellerstein`
   - Name: `dex-ecommerce`
   - Click **Open Existing** (label appears because the folder exists after reset).
3. Loop page:
   - Toggle **Automatic Clarification** on.
   - Click **Start Autonomous Loop**.
4. Watch the trace view. In under 60 seconds you should see:
   - `prerequisites` completed,
   - five clarification stages completed,
   - three full loop cycles (each: `gap_analysis → specify → plan → tasks → implement → verify → learnings`),
   - loop terminates cleanly.

---

## 5. DoD checklist — verify before reporting

| # | Check | How |
|---|---|---|
| 1 | `npx tsc --noEmit` | Run at repo root. Zero errors. |
| 2 | Unit tests pass | `npm test -- MockAgentRunner registry dexConfig MockConfig` |
| 3 | Three-cycle mock run finishes under 60 s | Wall-clock from Start button to loop termination. |
| 4 | Every stage has a checkpoint tag | `git -C /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce tag --list 'checkpoint/*'` — expect one per stage per cycle plus the clarification-phase checkpoints. |
| 5 | Every checkpoint commit has a non-empty diff | `git -C dex-ecommerce log --all --grep='^\[checkpoint:' --stat` |
| 6 | Filesystem artifacts present | `ls dex-ecommerce/.dex/feature-manifest.json dex-ecommerce/.dex/learnings.md dex-ecommerce/specs/*/spec.md dex-ecommerce/src/mock/*.ts` |
| 7 | Go Back works on a mid-cycle checkpoint | Open 008 TimelinePanel, click Go Back on cycle-2 `specify`; verify attempt branch created and working tree matches that checkpoint. |
| 8 | Step Mode pauses after each stage | Rerun with Step Mode on; loop halts after every stage, Continue advances it. |
| 9 | Record Mode auto-promotes every candidate | Rerun with Record Mode on; verify `capture/*` branches / tags per mode spec. |
| 10 | Missing-entry error surfaces loudly | Remove `cycles[1].stages.implement`, restart loop, observe `MockConfigMissingEntryError` naming phase/cycle/feature/stage. |
| 11 | Missing-fixture error surfaces loudly | Rename `fixtures/mock-run/f1-spec.md`, restart loop, observe `MockFixtureMissingError` with the resolved path. |
| 12 | Real-path regression smoke run | Flip `.dex/dex-config.json` back to `{ "agent": "claude" }`. Reset and run one real cycle. Observe no regression vs. pre-feature. |

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| App refuses to start, log shows `UnknownAgentError: Unknown agent: 'mok'. Registered: claude, mock` | Typo in `dex-config.json` | Fix the name. |
| App refuses to start, log shows `MockDisabledError` | `"enabled": false` in `mock-config.json` while selector says `mock` | Flip `enabled` to `true` or switch selector to `claude`. |
| Loop halts at a stage with `MockConfigMissingEntryError` | Script doesn't enumerate that (phase, cycle, stage) | Add the missing descriptor; the error names the exact coordinates. |
| Loop halts with `MockFixtureMissingError` | A `writes[].from` points at a nonexistent file | The error names the resolved path — create/rename the fixture. |
| Checkpoint commits are empty | Some stage declared `writes` but all targeted paths were already in the working tree with identical content | Vary the fixture or use `content` with a cycle-specific suffix. |
| Loop runs forever or halts with "cycles exhausted" | Last cycle's `gap_analysis.decision` is not `"GAPS_COMPLETE"` | Mark the last cycle as the terminator. |
| Loop skips directly from prerequisites to gap-analysis | Feature manifest fixture doesn't contain the feature IDs your cycles reference | Regenerate/edit `fixtures/mock-run/feature-manifest.json`. |

---

## 7. Going back to the real backend

```bash
echo '{ "agent": "claude" }' > /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
# or delete the file entirely — absent selector defaults to "claude"
rm /home/lukas/Projects/Github/lukaskellerstein/dex-ecommerce/.dex/dex-config.json
```

No restart of `dev-setup.sh` required — the selector is read at run start, every run. Start the loop normally.
