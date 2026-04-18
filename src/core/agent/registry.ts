import type { AgentRunner, AgentRunnerFactory } from "./AgentRunner.js";
import type { RunConfig } from "../types.js";

export class UnknownAgentError extends Error {
  constructor(name: string, registered: readonly string[]) {
    super(
      registered.length === 0
        ? `Unknown agent: '${name}'. No agents registered.`
        : `Unknown agent: '${name}'. Registered: ${registered.join(", ")}`
    );
    this.name = "UnknownAgentError";
  }
}

const AGENT_REGISTRY: Map<string, AgentRunnerFactory> = new Map();

export function registerAgent(name: string, factory: AgentRunnerFactory): void {
  if (!name || typeof name !== "string") {
    throw new Error("registerAgent: name must be a non-empty string");
  }
  const existing = AGENT_REGISTRY.get(name);
  if (existing && existing !== factory) {
    throw new Error(`registerAgent: '${name}' already registered with a different factory`);
  }
  AGENT_REGISTRY.set(name, factory);
}

export function createAgentRunner(
  name: string,
  runConfig: RunConfig,
  projectDir: string,
): AgentRunner {
  const factory = AGENT_REGISTRY.get(name);
  if (!factory) {
    throw new UnknownAgentError(name, getRegisteredAgents());
  }
  return factory(runConfig, projectDir);
}

export function getRegisteredAgents(): readonly string[] {
  return [...AGENT_REGISTRY.keys()];
}

/** Test-only — remove all registrations. Not exported from the barrel. */
export function __clearRegistryForTests(): void {
  AGENT_REGISTRY.clear();
}
