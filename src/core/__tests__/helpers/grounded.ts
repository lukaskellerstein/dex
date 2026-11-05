/**
 * The harness for the grounded-loop scenarios (016 D-016-11, FR-044): `run()`
 * on the existing-project fixture with fake sensors that are real commands, so
 * the real sensor runner, gates and records decide — at zero cost. `ENDS` is
 * the one table of how every fixture in fixtures/mock/grounded/ ends; every
 * `scenario()` run is checked against it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";
import type { OrchestratorEvent } from "../../events.ts";
import { readStageRecords, type StageRecord } from "../../evidence.ts";
import type * as HumanInput from "../../humanInput.ts";
import type * as Orchestrator from "../../orchestrator.ts";
import type * as State from "../../state.ts";
import type { RunConfig } from "../../types.ts";
import { rmTmp } from "./git.ts";
import { GROUNDED_QUEUE, type GroundedOptions, mkGroundedProject, stubCliTools } from "./loop.ts";

export const ENTRY = "900-fixture-a";

export interface Outcome {
  dir: string;
  events: OrchestratorEvent[];
  termination: string | undefined;
  records: StageRecord[];
  state: Awaited<ReturnType<typeof State.loadState>>;
}

export type End =
  | { termination: "queue_complete" }
  | { termination: "paused"; pauseReason: string };

/**
 * FR-044 and contracts/mock-config.md § Scenario fixtures, as one table: every
 * fixture in fixtures/mock/grounded/ and how its run ends. A variant of a
 * fixture names its own end.
 */
export const ENDS: Record<string, End> = {
  "ticks-while-red.json": { termination: "queue_complete" },
  "rewords-task.json": { termination: "paused", pauseReason: "plan_changed" },
  "edits-frozen-test.json": { termination: "queue_complete" },
  "tests-already-pass.json": { termination: "paused", pauseReason: "red_first_green" },
  "tests-crash.json": { termination: "paused", pauseReason: "no_progress" },
  "same-fingerprint.json": { termination: "paused", pauseReason: "stalled" },
  "flaky-check.json": { termination: "queue_complete" },
  "verifier-passes-red.json": { termination: "queue_complete" },
  "blocking-finding.json": { termination: "queue_complete" },
  "skip-tests-no-acceptance.json": { termination: "paused", pauseReason: "invalid_input" },
  "happy-path.json": { termination: "queue_complete" },
  "test-amendment.json": { termination: "queue_complete" },
};

export type ScenarioOptions = GroundedOptions & {
  onEvent?: (ev: OrchestratorEvent) => void;
  end?: End;
};

function config(projectDir: string): RunConfig {
  return {
    projectDir,
    specDir: "",
    mode: "loop",
    model: "claude-opus-4-6",
    maxIterations: 50,
    maxTurns: 75,
    taskPhases: "all",
    autoClarification: false,
    resume: false,
  };
}

/**
 * Registers the file's `before`/`after`: `HOME` points at a temp folder before
 * the orchestrator is imported, so the run log tree stays out of the real home.
 */
export function groundedHarness() {
  const realHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "dex-home-"));
  let run: typeof Orchestrator.run;
  let loadState: typeof State.loadState;
  let resolveRequest: typeof HumanInput.resolveRequest;
  let restorePath: () => void;

  before(async () => {
    process.env.HOME = tmpHome;
    ({ run } = await import("../../orchestrator.ts"));
    ({ loadState } = await import("../../state.ts"));
    ({ resolveRequest } = await import("../../humanInput.ts"));
    restorePath = stubCliTools();
  });
  after(() => {
    restorePath();
    process.env.HOME = realHome;
    rmTmp(tmpHome);
  });

  /** One mock run of `fixture`; checks its end against `ENDS` and its cost, then `check`. */
  async function scenario(
    fixture: string,
    opts: ScenarioOptions,
    check: (o: Outcome) => void | Promise<void>,
  ): Promise<void> {
    const dir = mkGroundedProject(fixture, opts);
    try {
      const events: OrchestratorEvent[] = [];
      await run(config(dir), (ev) => {
        events.push(ev);
        opts.onEvent?.(ev);
      });
      const end = [...events].reverse().find((e) => e.type === "loop_terminated");
      assert.deepEqual(
        events.filter((e) => e.type === "error"),
        [],
      );
      const termination = end?.type === "loop_terminated" ? end.termination.reason : undefined;
      const state = await loadState(dir);
      const expected = opts.end ?? ENDS[fixture];
      assert.ok(expected, `${fixture} has a row in the scenario table`);
      assert.deepEqual(
        expected.termination === "paused"
          ? { termination, pauseReason: state?.pauseReason }
          : { termination },
        expected,
        `${fixture} ends as the table says`,
      );
      await check({ dir, events, termination, records: readStageRecords(dir, ENTRY), state });
      assert.equal((await loadState(dir))?.cumulativeCostUsd, 0, "every scenario costs nothing");
    } finally {
      rmTmp(dir);
    }
  }

  return {
    scenario,
    /** One `run()` of the loop on `dir`, outside the scenario table. */
    runLoop: (dir: string, emit: (ev: OrchestratorEvent) => void) => run(config(dir), emit),
    resolveRequest: (...args: Parameters<typeof HumanInput.resolveRequest>) =>
      resolveRequest(...args),
  };
}

/** Fixture A's queue entry, changed by `over`. */
export function queueWith(over: Record<string, unknown>): Record<string, unknown> {
  const [entry] = GROUNDED_QUEUE.entries;
  return { ...GROUNDED_QUEUE, entries: [{ ...entry, ...over }] };
}

/** Fixture A with the tests stage on, and no queue acceptance. */
export const WITH_TESTS = queueWith({
  skip: ["brief", "specify", "clarify", "plan", "tasks"],
  acceptance: undefined,
});

export const gates = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "gate_decided" ? [`${e.decision.gate}:${e.decision.outcome}`] : [],
  );

export const prompts = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "agent_step" && e.agentStep.type === "user_message"
      ? [e.agentStep.content ?? ""]
      : [],
  );

export const stagesRun = (events: OrchestratorEvent[]) =>
  events.flatMap((e) =>
    e.type === "stage_decision" && e.decision === "stage" ? [e.stage ?? ""] : [],
  );

export const label = (r: StageRecord) =>
  `${r.stage}-${r.n}:${r.mode ?? "-"}:${r.gate?.outcome ?? "-"}`;
