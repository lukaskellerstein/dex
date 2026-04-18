/**
 * Agent-backend barrel. Importing this module registers the built-in runners.
 *
 * To add a new runner:
 *   1. Implement `AgentRunner` in a new file under this directory.
 *   2. Call `registerAgent("<name>", (cfg, dir) => new YourRunner(cfg, dir))`
 *      below.
 *   3. Set `{ "agent": "<name>" }` in a project's `.dex/dex-config.json`
 *      (or pass `RunConfig.agent = "<name>"` as a per-run override).
 */
import { registerAgent } from "./registry.js";
import { ClaudeAgentRunner } from "./ClaudeAgentRunner.js";
import { MockAgentRunner } from "./MockAgentRunner.js";

registerAgent("claude", (cfg, dir) => new ClaudeAgentRunner(cfg, dir));
registerAgent("mock",   (cfg, dir) => new MockAgentRunner(cfg, dir));

export type { AgentRunner, AgentRunnerFactory, StageContext, StageResult, PhaseContext, PhaseResult } from "./AgentRunner.js";
export { registerAgent, createAgentRunner, getRegisteredAgents, UnknownAgentError } from "./registry.js";
export { ClaudeAgentRunner } from "./ClaudeAgentRunner.js";
export { MockAgentRunner } from "./MockAgentRunner.js";
