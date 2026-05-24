/**
 * Agent-backend factory. The active runner is chosen by name from
 * `dex-config.json`'s `agent` field (overridable per-run via
 * `RunConfig.agent`). Supported names today: `"claude"`, `"mock"`.
 * Planned: `"codex"`, `"copilot"`.
 *
 * Adding a new runner:
 *   1. Implement `AgentRunner` in a new file under this directory.
 *   2. Add a `case "<name>":` to `createAgentRunner` below.
 *   3. (Optional) re-export it at the bottom of this file.
 *
 * The earlier dynamic-registry indirection was deleted — a switch is
 * easier to navigate at this scale and adding a case is one line.
 */
import { ClaudeAgentRunner } from "./ClaudeAgentRunner.js";
import { MockAgentRunner } from "./MockAgentRunner.js";
import type { AgentRunner } from "./AgentRunner.js";
import type { RunConfig } from "../types.js";

/** Names this build of Dex knows how to instantiate. Update when adding a runner. */
export const KNOWN_AGENTS = ["claude", "mock"] as const;

export class UnknownAgentError extends Error {
  readonly agent: string;
  constructor(agent: string) {
    super(
      `UnknownAgentError: '${agent}' is not a registered agent. Known agents: ${KNOWN_AGENTS.join(", ")}.`,
    );
    this.name = "UnknownAgentError";
    this.agent = agent;
  }
}

export function createAgentRunner(
  agent: string,
  config: RunConfig,
  projectDir: string,
): AgentRunner {
  switch (agent) {
    case "claude":
      return new ClaudeAgentRunner(config, projectDir);
    case "mock":
      return new MockAgentRunner(config, projectDir);
    default:
      throw new UnknownAgentError(agent);
  }
}

export type { AgentRunner, StepContext, StepResult, TaskPhaseContext, TaskPhaseResult } from "./AgentRunner.js";
export { ClaudeAgentRunner } from "./ClaudeAgentRunner.js";
export { MockAgentRunner } from "./MockAgentRunner.js";
