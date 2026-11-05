#!/usr/bin/env node
/**
 * What: The `dex` command line (contracts/cli.md). `dex run <projectDir> [--once | --dry-run | --status] [--agent …]` drives the same `run()` the app does; `dex queue init <projectDir>` writes a first queue, policy and `.dex/.gitignore` for an existing project; `dex digest <projectDir> <entryId>` prints the entry's digest (016: exit 1 when there is none yet, 2 for an unknown entry). Exit codes: 0 done (or a finished `--once`, `--dry-run`, `--status`), 1 failed, 2 a usage error or a queue or policy Dex refuses, 3 the run paused and needs a human.
 * Not: No Electron import — it runs under plain Node from `dist/core/cli.js`. The run, the views and the parsing live in `cli/`.
 * Deps: cli/{args, describe, run, terminal}, digest.digestPath, queue.{loadQueue, QueueInvalidError}, policy.{loadPolicy, PolicyInvalidError, PolicyRefusedError}, queue-init.{initQueue, QueueExistsError}.
 */

import fs from "node:fs";
import path from "node:path";
import { assertEntrySensors } from "./acceptance.js";
import { type CliCommand, parseArgs, USAGE, UsageError } from "./cli/args.js";
import { dryRunLines, statusLines } from "./cli/describe.js";
import { runCommand } from "./cli/run.js";
import { processTerminal, type Terminal } from "./cli/terminal.js";
import { digestPath } from "./digest.js";
import { loadPolicy, PolicyInvalidError, PolicyRefusedError } from "./policy.js";
import { loadQueue, QueueInvalidError, queuePath } from "./queue.js";
import { initQueue, QueueExistsError } from "./queue-init.js";

/** Input the human must fix: exit 2, not 1. */
function isRefusal(err: unknown): boolean {
  return [
    UsageError,
    QueueInvalidError,
    PolicyInvalidError,
    PolicyRefusedError,
    QueueExistsError,
  ].some((cls) => err instanceof cls);
}

function queueInit(projectDir: string, term: Terminal): number {
  for (const file of initQueue(projectDir)) term.out(`wrote ${path.join(projectDir, file)}`);
  term.out("Review these files, then commit them. Dex never commits for an existing project.");
  return 0;
}

/** Loads the queue and the policy the run uses, so a broken one refuses before anything starts. */
function checkRules(projectDir: string): void {
  if (!fs.existsSync(projectDir)) throw new UsageError(`no such project directory: ${projectDir}`);
  const queue = loadQueue(projectDir, { persistMigration: false });
  const policy = loadPolicy(projectDir, queue?.kind ?? "new");
  if (queue) assertEntrySensors(queue, policy, queuePath(projectDir));
}

/** `dex digest` (016 contracts/cli.md): prints the entry's digest; starts and writes nothing. */
function printDigest(projectDir: string, entryId: string, term: Terminal): number {
  if (!fs.existsSync(projectDir)) throw new UsageError(`no such project directory: ${projectDir}`);
  const queue = loadQueue(projectDir, { persistMigration: false });
  if (!queue?.entries.some((e) => e.id === entryId)) {
    term.err(`unknown entry ${entryId}`);
    return 2;
  }
  const file = digestPath(projectDir, entryId);
  if (!file) {
    term.err(`no digest for ${entryId} yet`);
    return 1;
  }
  term.out(fs.readFileSync(file, "utf-8").trimEnd());
  return 0;
}

async function dispatch(cmd: CliCommand, term: Terminal): Promise<number> {
  const projectDir = path.resolve(cmd.projectDir);
  if (cmd.kind === "queue-init") return queueInit(projectDir, term);
  if (cmd.kind === "digest") return printDigest(projectDir, cmd.entryId, term);
  checkRules(projectDir);
  if (cmd.mode === "dry-run" || cmd.mode === "status") {
    for (const line of cmd.mode === "dry-run" ? dryRunLines(projectDir) : statusLines(projectDir))
      term.out(line);
    return 0;
  }
  return runCommand(projectDir, { once: cmd.mode === "once", agent: cmd.agent }, term);
}

/** Runs one command line; resolves with the exit code. */
export async function main(argv: string[], term: Terminal = processTerminal()): Promise<number> {
  try {
    return await dispatch(parseArgs(argv), term);
  } catch (err) {
    term.err(`dex: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof UsageError) term.err(USAGE);
    return isRefusal(err) ? 2 : 1;
  }
}

// The dist build is CommonJS; under the test runner this file loads as ESM, where `require` is absent.
if (typeof require !== "undefined" && require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
