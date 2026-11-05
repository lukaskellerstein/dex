/**
 * What: Parses the `dex` command line (contracts/cli.md) into one command: `run <projectDir>` with at most one of `--once`, `--dry-run`, `--status` and an optional `--agent`, `queue init <projectDir>`, or `digest <projectDir> <entryId>`. Anything else throws `UsageError`.
 * Not: Runs nothing and reads no file.
 * Deps: agent.KNOWN_AGENTS.
 */

import { KNOWN_AGENTS } from "../agent/index.js";

export type RunMode = "run" | "once" | "dry-run" | "status";

export type CliCommand =
  | { kind: "queue-init"; projectDir: string }
  | { kind: "digest"; projectDir: string; entryId: string }
  | { kind: "run"; projectDir: string; mode: RunMode; agent: string | null };

export const USAGE = [
  "Usage:",
  `  dex run <projectDir> [--once | --dry-run | --status] [--agent ${KNOWN_AGENTS.join("|")}]`,
  "  dex queue init <projectDir>",
  "  dex digest <projectDir> <entryId>",
].join("\n");

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const MODE_FLAGS = new Map<string, RunMode>([
  ["--once", "once"],
  ["--dry-run", "dry-run"],
  ["--status", "status"],
]);

function agentName(value: string | undefined): string {
  if (value && (KNOWN_AGENTS as readonly string[]).includes(value)) return value;
  throw new UsageError(`--agent needs one of: ${KNOWN_AGENTS.join(", ")}`);
}

function parseRun(args: string[]): CliCommand {
  let mode: RunMode = "run";
  let agent: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flagMode = MODE_FLAGS.get(arg);
    if (flagMode) {
      if (mode !== "run") throw new UsageError(`${arg} cannot be combined with --${mode}`);
      mode = flagMode;
    } else if (arg === "--agent") {
      agent = agentName(args[++i]);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new UsageError("dex run takes exactly one <projectDir>");
  return { kind: "run", projectDir: positional[0], mode, agent };
}

/** The command `argv` (without `node` and the script) asks for. */
export function parseArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  if (command === "run") return parseRun(rest);
  if (command === "queue" && rest[0] === "init" && rest.length === 2) {
    return { kind: "queue-init", projectDir: rest[1] };
  }
  if (command === "digest") {
    if (rest.length !== 2 || rest.some((a) => a.startsWith("-"))) {
      throw new UsageError("dex digest takes <projectDir> and <entryId>");
    }
    return { kind: "digest", projectDir: rest[0], entryId: rest[1] };
  }
  throw new UsageError(command ? `unknown command: ${argv.join(" ")}` : "no command given");
}
