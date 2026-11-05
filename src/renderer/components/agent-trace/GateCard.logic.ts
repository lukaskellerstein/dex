/**
 * What: Turns Dex's `sensor_run` and `gate_decided` events (016 contracts/ipc-events.md) into `gate` steps for the live trace. `GateTracker` collects each entry's sensor runs until its next gate decision, then hands back one step carrying the decision and those runs. A `baseline` gate runs before the stage it guards starts, so it waits (`carried`) until the next stage opens; every other gate belongs to the stage that just ran.
 * Not: Renders nothing (GateCard.tsx does) and holds no React state.
 * Deps: core GateDecision, SensorRun, AgentStep and OrchestratorEvent types.
 */
import type { GateDecision } from "../../../core/gates.js";
import type { SensorRun } from "../../../core/sensors.js";
import type { AgentStep, OrchestratorEvent } from "../../../core/types.js";

export interface GateStepMeta {
  entryId: string;
  decision: GateDecision;
  runs: SensorRun[];
  evidenceFile: string;
}

export function gateMeta(step: AgentStep): GateStepMeta | null {
  const m = step.metadata as Partial<GateStepMeta> | null;
  return step.type === "gate" && m?.decision && Array.isArray(m.runs) ? (m as GateStepMeta) : null;
}

export class GateTracker {
  private readonly runs = new Map<string, SensorRun[]>();
  private seq = 0;
  /** Baseline gates that wait for the stage they guard to open. */
  carried: AgentStep[] = [];

  /**
   * Feeds one event. Returns the gate step to show now under the current
   * stage, or null (a sensor run, a carried baseline, or another event).
   */
  push(event: OrchestratorEvent): AgentStep | null {
    if (event.type === "sensor_run") {
      this.runs.set(event.entryId, [...(this.runs.get(event.entryId) ?? []), event.run]);
      return null;
    }
    if (event.type !== "gate_decided") return null;
    const runs = this.runs.get(event.entryId) ?? [];
    this.runs.delete(event.entryId);
    const meta: GateStepMeta = {
      entryId: event.entryId,
      decision: event.decision,
      runs,
      evidenceFile: event.evidenceFile,
    };
    const step: AgentStep = {
      id: `gate-${event.entryId}-${++this.seq}`,
      sequenceIndex: -1,
      type: "gate",
      content: event.decision.reason,
      metadata: meta as unknown as Record<string, unknown>,
      durationMs: runs.reduce((sum, r) => sum + r.durationMs, 0),
      tokenCount: null,
      createdAt: new Date().toISOString(),
    };
    if (event.decision.gate === "baseline") {
      this.carried.push(step);
      return null;
    }
    return step;
  }

  /** The carried baseline gates, for the stage that opens now; the list empties. */
  takeCarried(): AgentStep[] {
    const out = this.carried;
    this.carried = [];
    return out;
  }
}
