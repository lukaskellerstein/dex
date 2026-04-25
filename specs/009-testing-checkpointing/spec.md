# Feature Specification: Testing Checkpointing via Mock Agent

**Feature Branch**: `009-testing-checkpointing`
**Created**: 2026-04-18
**Status**: Draft
**Input**: User description: "read /home/lukas/Projects/Github/lukaskellerstein/dex/docs/my-specs/009-testing-checkpointing" — a design brief for a deterministic, scripted agent backend that lets developers exercise the full orchestrator loop (and especially the 008 checkpoint surface: tags, timeline, Go Back, Try Again, Try N Ways, Step Mode, Record Mode, promotion) in seconds and at zero API cost, by introducing a pluggable agent-backend selection point behind which real-agent, mock, and future providers all live.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Exercise the entire checkpoint surface in seconds (Priority: P1)

A Dex developer is working on a change that touches the checkpoint timeline, Go Back, Try Again, Step Mode, or Record Mode. To validate the change today, they have to run a real orchestrator loop: 20+ minutes per cycle and real dollars per run — and they need *multiple* cycles to exercise mid-run, cross-cycle, and end-of-loop checkpoint behavior. This story lets them select a scripted "mock" agent backend for their project, start the loop, and watch a full multi-cycle run finish in well under a minute with zero external API cost — while still producing the same tags, branches, artifacts, and checkpoint commits a real run would produce.

**Why this priority**: This is the headline motivator of the feature. Everything else (pluggability, strict error behavior, config layout) exists to serve this outcome. Without it, developers continue paying 20+ minutes and real money per iteration on checkpoint-UX changes.

**Independent Test**: In the example project, select the mock backend, author a script with three cycles, and start the loop. The entire run completes end-to-end in under 60 seconds; the checkpoint timeline shows one entry per stage per cycle; clicking Go Back on a mid-cycle checkpoint creates a new attempt branch whose working tree matches that checkpoint's committed state.

**Acceptance Scenarios**:

1. **Given** a freshly reset example project with the mock backend selected and a script enumerating three cycles (one feature each, final cycle signalling loop completion), **When** the developer clicks Start Autonomous Loop, **Then** the loop advances through every stage of every cycle, produces a checkpoint tag for every stage it should, and finishes in under 60 seconds.
2. **Given** a completed mock run with checkpoints committed, **When** the developer opens the checkpoint timeline and clicks Go Back on a mid-cycle checkpoint, **Then** a new attempt branch is created and the working tree matches that checkpoint's state — identical observable behavior to a real-agent run.
3. **Given** a completed mock run, **When** the developer repeats the run with Step Mode on, **Then** the loop pauses after each stage; with Record Mode on, every candidate is auto-promoted — both modes behave identically to how they would under a real agent.

---

### User Story 2 — Swap agent backends without touching orchestrator code (Priority: P1)

Today the orchestrator is hard-wired to one specific agent provider. As the team explores alternate providers (mock for testing; potentially Codex, Gemini, or other future backends for production), they need a clean place to plug new backends in without rewriting the loop every time. This story introduces a single project-level selector and a registration point so the orchestrator is provider-agnostic: selecting a backend is a one-line config change, and adding a new backend is done by implementing it against the provider contract and registering it — not by editing the loop.

**Why this priority**: The mock backend is the first consumer, but the *mechanism* is what matters: it prevents per-provider conditionals from leaking into the orchestrator and makes every future provider-addition a bounded, low-risk change. Without it, the mock backend itself becomes a special case the loop has to know about.

**Independent Test**: Select the real backend → run one cycle → observe identical behavior to pre-refactor. Select the mock backend → run one cycle → loop uses the mock. No code was edited between runs. Attempt to register a hypothetical third backend in a throwaway branch and confirm the orchestrator needs zero modifications to route to it.

**Acceptance Scenarios**:

1. **Given** the orchestrator loop, **When** a new agent backend is added, **Then** the addition requires implementing the backend against the provider contract and registering it — no conditionals in the loop, no edits to the loop's stage-execution code.
2. **Given** a project with the selector set to the real backend, **When** the loop runs, **Then** end-to-end behavior is indistinguishable from pre-feature behavior (no observable regression on the real path).
3. **Given** a project with the selector set to the mock backend and a valid script, **When** the loop runs, **Then** the orchestrator follows the same stage sequence it follows for the real backend, only the per-stage execution differs.

---

### User Story 3 — Fail loudly on script drift, never silently fake (Priority: P2)

Scripted tests are only useful if they catch drift. When a developer edits the orchestrator (adds a stage, renames one, changes cycle semantics) and forgets to update the mock script, the run must stop immediately at the drift point with a diagnostic pinpointing what's missing — not quietly skip the stage, not emit a default, not pretend to succeed. Same when a referenced fixture file is missing.

**Why this priority**: A silently-passing mock is worse than no mock — it gives false confidence. This story prevents the mock from ever masking real orchestrator changes.

**Independent Test**: Delete one stage entry from the middle of the script and start the loop. The run reaches that stage, halts, and the error message names the exact phase, cycle, feature, and stage that is missing. Repeat with a fixture file deleted from disk — same shape of failure, naming the resolved fixture path.

**Acceptance Scenarios**:

1. **Given** a script missing an entry for a stage the loop is about to execute, **When** the loop reaches that stage, **Then** the loop halts and surfaces an error naming the missing coordinates (phase, cycle, feature, stage).
2. **Given** a script entry whose referenced fixture file does not exist on disk, **When** the loop reaches that stage, **Then** the loop halts and surfaces an error naming the resolved fixture path.
3. **Given** the selector set to mock but the mock is disabled in its own config, **When** the loop is started, **Then** the loop refuses to start with a clear error explaining the contradiction.
4. **Given** the selector set to an unknown backend name, **When** the loop is started, **Then** startup fails with an error listing the valid backend names.

---

### User Story 4 — Scripted runs produce real artifacts so downstream behavior is faithful (Priority: P2)

For checkpoint testing to be meaningful, every stage that would normally commit a real diff must commit a *real non-empty* diff under the mock. Every downstream stage that reads a file (e.g., planning reads the spec, tasks read the plan, implementation reads tasks, gap-analysis reads the feature manifest) must find a real file to read. The mock plays back the filesystem side effects a real run would have produced — not just the in-memory signals.

**Why this priority**: Without this, checkpoints become empty commits, gap-analysis has nothing to read, and the UI surfaces indistinguishable-from-bug state. The mock must produce a faithful on-disk trail.

**Independent Test**: After a mock run, the example project's feature manifest, learnings file, spec/plan/tasks files per feature, and mock source files for implementation stages are all present with real content. Checkpoint commits inspected via the history layer show non-empty diffs.

**Acceptance Scenarios**:

1. **Given** a mock run completes, **When** the project's `.dex/` and spec-kit output directories are inspected, **Then** the feature manifest, learnings file, and per-feature spec/plan/tasks files are all present with real content.
2. **Given** a mock run completes, **When** the checkpoint history is inspected, **Then** every stage that produces artifacts has a corresponding non-empty checkpoint commit.
3. **Given** a stage whose real counterpart returns structured output (e.g., gap-analysis decision, verification result), **When** the mock executes that stage, **Then** the mock returns the structured output declared in the script verbatim.

---

### User Story 5 — Every cycle, stage, and fixture is explicitly spelled out in one place (Priority: P3)

Rather than inferring loop shape from defaults or heuristics, the script fully enumerates every phase, every stage within that phase, and every cycle the run will produce. A developer authoring a new test case reads a single JSON file and can point at the line that will produce each observable outcome. Cycle count equals the length of the script's cycle list; loop termination is an explicit signal on the last cycle.

**Why this priority**: This makes mock authoring obvious to someone unfamiliar with the orchestrator internals, and it keeps the "surprise" level low — no hidden defaults, no magic.

**Independent Test**: A developer unfamiliar with the orchestrator receives a pointer to the script file and a one-paragraph explanation. They add a fourth cycle to a three-cycle script and the loop runs with four cycles; they mark a different cycle as the terminal one and the loop stops there.

**Acceptance Scenarios**:

1. **Given** a script with N cycles, **When** the loop runs, **Then** the loop executes exactly N cycles (assuming the final cycle signals termination).
2. **Given** a script whose cycle list exhausts without an explicit termination signal, **When** the loop reaches the end of the list, **Then** the loop halts with a clear message rather than looping indefinitely or silently truncating.
3. **Given** a stage is renamed or added to the orchestrator, **When** the script is not updated, **Then** the mock run fails loudly at that stage (already covered by Story 3) — confirming the script is authoritative and enumerable.

---

### Edge Cases

- **Selector points at a backend that has never been registered** — startup fails with a message listing every registered backend name.
- **Selector config file is absent** — treated as "default backend selected," no error; the loop proceeds on the real path.
- **Selector says mock, but the mock script file is absent** — startup fails with a message pointing at the expected path.
- **Selector says mock, mock script present, but the script is marked disabled** — startup fails with a clear "mock backend selected but script is disabled" message.
- **Script references a cycle feature ID that does not appear in the feature manifest fixture** — surfaces at the stage that reconciles them, with a message naming both IDs.
- **Mock run followed immediately by a real run on the same project** — no state leaks: the real run proceeds as if the mock had never executed (aside from committed files / tags, which are part of the project's history by design).
- **Developer edits the script mid-run** — out of scope; the script is read at run start, not hot-reloaded.
- **Script declares a delay of zero** — honored; the stage advances as fast as the filesystem operations allow.
- **Two developers on the same team choose different backends** — their individual selector configs do not collide because per-developer config is not committed; project-level committed state (manifest, specs, tasks, learnings) remains shared.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a developer to select the agent backend that drives the orchestrator loop via a project-level configuration file, with no code changes required to switch.
- **FR-002**: The system MUST default to the real agent backend when no selection is configured, preserving today's behavior for developers who do nothing.
- **FR-003**: The system MUST reject an unknown backend name at startup with an error that lists the valid names.
- **FR-004**: The system MUST expose a registration point so that additional agent backends can be added without modifying the orchestrator's loop code, conditionals, or stage-execution paths.
- **FR-005**: When the scripted (mock) backend is selected, the system MUST execute each orchestrator stage according to an explicit, project-local script that enumerates every phase, every cycle, and every stage the run will touch.
- **FR-006**: The scripted backend MUST produce the filesystem artifacts each downstream stage requires (clarification outputs, feature manifest, per-feature spec/plan/tasks documents, implementation source files, learnings entries) so the loop progresses end-to-end without manual intervention.
- **FR-007**: The scripted backend MUST produce non-empty working-tree changes during stages where a real run would commit, so that checkpoint commits capture real diffs.
- **FR-008**: For stages whose real counterparts return a structured output (e.g., gap-analysis decision, verification outcome, manifest extraction), the scripted backend MUST return the structured output declared in the script, verbatim.
- **FR-009**: The loop length under the scripted backend MUST be determined solely by the script's explicit cycle list; the run MUST terminate cleanly when the script's final cycle signals completion.
- **FR-010**: The scripted backend MUST halt with a diagnostic error naming the missing coordinates (phase, cycle, feature, stage) whenever a required script entry is absent, and naming the resolved fixture path whenever a required fixture file is absent.
- **FR-011**: The scripted backend MUST NOT silently substitute defaults, skip stages, or fall through to the real backend when script entries are missing.
- **FR-012**: Selecting, deselecting, or switching backends MUST be achievable by editing configuration files only — no recompilation, no restart of unrelated tooling, no UI change.
- **FR-013**: Each agent backend MUST have its own configuration file, separate from the backend-selector config, so each backend can grow its configuration surface independently without bloating the selector.
- **FR-014**: The scripted backend MUST emit the stage-lifecycle events the UI depends on (stage started, stage completed, checkpoint created) so the trace, timeline, and dashboard render correctly — even if the per-stage event detail is intentionally sparse.
- **FR-015**: The scripted backend MUST honor a per-stage configurable delay so a full run finishes quickly in test mode while still letting observers see stage-by-stage progression.
- **FR-016**: The backend-selector config and per-backend config files MUST default to being developer-local (not committed to shared history) so each developer can configure their own test harness without affecting teammates.
- **FR-017**: Switching back to the real agent backend MUST require no code changes — editing the selector config and starting a new run is sufficient, and the real run's observable behavior MUST be indistinguishable from pre-feature behavior.
- **FR-018**: The registration point MUST allow an in-process override — for example, a future UI or a per-run setting could supply a backend name that wins over the project-level selector, without changes to the registration mechanism.

### Key Entities *(include if feature involves data)*

- **Agent Backend**: The component that, for a given orchestrator stage, actually does the work — whether by invoking an external model provider or replaying a script. Identified by a short name (e.g., `claude`, `mock`, future `codex`, `gemini`).
- **Backend-Selector Config**: A small project-level file whose primary job is to name the currently active backend. Defaults apply when absent.
- **Backend-Specific Config**: A separate project-level file per backend, holding that backend's configuration (most notably: the scripted backend's full run script).
- **Run Script** (scripted backend only): An enumeration of phases, each containing its stages and, for the per-feature loop phase, an ordered list of cycles. Each stage entry declares the delay, the filesystem side effects to produce, any structured output to return, and — for cycles — the feature being worked on and the gap-analysis decision driving cycle transitions.
- **Fixture Set**: The reference artifacts the script points to (`from` references) — trimmed, canonical versions of the files real runs produce. Used to make mock stages produce real downstream-readable content.
- **Cycle**: One pass through the per-feature loop phase. Each cycle is bound to exactly one feature and advances the loop by one step. The number of cycles in a run equals the number of cycle entries in the script.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can exercise every stage of the loop across multiple cycles in under **60 seconds** with **zero external API cost**, starting from a freshly reset example project.
- **SC-002**: Adding support for a new agent backend requires **zero** changes to the orchestrator loop code; the change is confined to the new backend's own file(s) and its registration.
- **SC-003**: When the script is missing a required entry, the run halts within **one stage** of the missing coordinate and the error message identifies the missing phase, cycle, feature, and stage.
- **SC-004**: After a scripted run completes, **every checkpoint** the equivalent real run would produce is present, and **every checkpoint commit** contains a non-empty diff.
- **SC-005**: Switching between the scripted backend and the real backend takes **under 10 seconds** and requires editing exactly **one configuration file**.
- **SC-006**: All checkpoint UX flows (Go Back, Try Again, Step Mode, Record Mode, promotion) produce observable state (tags, branches, working tree) under the scripted backend that is **identical** to the equivalent state under a real run.
- **SC-007**: A real-agent smoke run completed end-to-end after this feature lands shows **no observable regression** in orchestrator behavior versus pre-feature.
- **SC-008**: A developer unfamiliar with the orchestrator internals, given only a pointer to the script file and a short explanation, can extend a three-cycle script to four cycles and observe the loop run four cycles — no code read required.
- **SC-009**: Scripted run cycle-time, measured wall-clock from Start Autonomous Loop to loop termination, is at least **20×** faster than the equivalent real run in the same example project.

## Assumptions

- The checkpoint-and-resume system built in 008-interactive-checkpoint is in place and stable; this feature builds on top of it without modifying it.
- Developers using the scripted backend are comfortable editing JSON files directly; a settings UI for backend selection or script editing is explicitly out of scope for this feature.
- Reducing the scripted backend's per-stage trace fidelity to a single event per stage is acceptable, because this backend targets checkpoint-system validation, not trace-view fidelity. Richer trace simulation can be added later if needed without reshaping the selector mechanism.
- Per-developer backend selection and per-backend configuration files are not shared across the team — each developer authors their own locally. Shared on-disk project state (feature manifest, specs, learnings) remains project-wide as today.
- Continuous integration and pre-release validation continue to use the real backend. The scripted backend is a developer-iteration tool, not a release gate or CI replacement.
- The scripted backend does not validate structured outputs against the real stage-output schemas. Authors own shape correctness; mismatches surface as ordinary orchestrator errors at the next stage that reads them.
- Fixture files and the orchestrator evolve independently. Drift is caught by loud failure (FR-010) rather than silent substitution, and is expected to be fixed by editing the script or fixture set.
- The example project (`dex-ecommerce`) is the primary testbed for validating this feature end-to-end, consistent with existing project testing guidance.
