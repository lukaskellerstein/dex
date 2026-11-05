/**
 * What: Runs the project's sensors — its checks and acceptance commands — in Dex's own process (D-016-1, research R1, R2, R12). `runSensor` spawns `/bin/sh -c <command>` in its own process group, keeps the last 200 output lines, kills the whole group on a timeout or Stop (SIGTERM, then SIGKILL after 5 s) and once the command exits (no sensor process outlives its run), and classifies the run: `pass` (exit 0), `fail` (any other exit), `timeout`, `error` (cannot start, exit 126 or 127, or stopped). `runSensors` runs a list in its declared order, every one even after a failure (FR-017), and re-runs a `fail` up to `rerunOnFail` times: a later pass is `flaky`. `parseSensorSpecs` validates a declared list for the policy and the queue.
 * Not: Decides no gate (gates.ts does) and writes no evidence (stages/gate-runs.ts does). Never runs a command through an agent.
 * Deps: node:child_process.spawn.
 */

import { spawn } from "node:child_process";

export interface SensorSpec {
  name: string;
  command: string;
  timeoutSec: number;
}

export type SensorResult = "pass" | "fail" | "timeout" | "error" | "flaky";

/** One run of one sensor (data-model.md § Sensor run). */
export interface SensorRun {
  name: string;
  command: string;
  /** Null when killed or never started. */
  exitCode: number | null;
  /** Set when the process ended on a signal. */
  signal: string | null;
  /** Wall clock of the first attempt. */
  durationMs: number;
  result: SensorResult;
  reruns: number;
  /** The last 200 output lines (stdout and stderr) of the last attempt. */
  tail: string[];
}

export interface SensorOptions {
  cwd: string;
  /** Merged over `process.env`. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export const TAIL_LINES = 200;
const KILL_GRACE_MS = 5000;

/** "Green" for every gate: a pass, or a fail that passed on a re-run. */
export function isGreen(run: SensorRun): boolean {
  return run.result === "pass" || run.result === "flaky";
}

/** The last `max` lines of a stream, without holding the rest. */
class Tail {
  private readonly lines: string[] = [];
  private readonly max: number;
  private partial = "";

  constructor(max: number) {
    this.max = max;
  }

  push(chunk: string): void {
    const parts = (this.partial + chunk).split("\n");
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.add(line);
  }

  done(): string[] {
    if (this.partial !== "") this.add(this.partial);
    this.partial = "";
    return this.lines;
  }

  private add(line: string): void {
    this.lines.push(line.replace(/\r$/, ""));
    if (this.lines.length > this.max) this.lines.shift();
  }
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, sig);
  } catch {
    // The group is already gone.
  }
}

function classify(exitCode: number | null, killedBy: "timeout" | "stop" | null): SensorResult {
  if (killedBy === "timeout") return "timeout";
  if (killedBy === "stop") return "error";
  if (exitCode === 0) return "pass";
  if (exitCode === 126 || exitCode === 127) return "error";
  return "fail";
}

/** One attempt of one sensor. Never throws: a command that cannot start is an `error` run. */
export function runSensor(spec: SensorSpec, opts: SensorOptions): Promise<SensorRun> {
  const start = Date.now();
  const tail = new Tail(TAIL_LINES);
  const base = { name: spec.name, command: spec.command, reruns: 0 };
  if (opts.signal?.aborted) {
    return Promise.resolve({
      ...base,
      exitCode: null,
      signal: null,
      durationMs: 0,
      result: "error",
      tail: ["stopped before it started"],
    });
  }
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", spec.command], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killedBy: "timeout" | "stop" | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    const stop = (why: "timeout" | "stop") => {
      if (killedBy) return;
      killedBy = why;
      killGroup(child.pid, "SIGTERM");
      graceTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timeout"), spec.timeoutSec * 1000);
    const onAbort = () => stop("stop");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const onData = (b: Buffer) => tail.push(b.toString("utf-8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (extra) tail.push(`${extra}\n`);
      resolve({
        ...base,
        exitCode,
        signal,
        durationMs: Date.now() - start,
        result: extra ? "error" : classify(exitCode, killedBy),
        tail: tail.done(),
      });
    };
    // A background child of the command must not outlive the run; `close` waits for its pipes.
    child.on("exit", () => {
      clearTimeout(timer);
      killGroup(child.pid, "SIGTERM");
      graceTimer ??= setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
    });
    child.on("close", (code, sig) => finish(code, sig));
    child.on("error", (err) => finish(null, null, `cannot start: ${err.message}`));
  });
}

export interface RunSensorsOptions extends SensorOptions {
  rerunOnFail: number;
  /** Called once per sensor, with its final run. */
  onRun?: (run: SensorRun) => void;
}

/** Every sensor of `specs`, in order; a `fail` is re-run up to `rerunOnFail` times (R12). Stops early only on Stop. */
export async function runSensors(
  specs: SensorSpec[],
  opts: RunSensorsOptions,
): Promise<SensorRun[]> {
  const out: SensorRun[] = [];
  for (const spec of specs) {
    if (opts.signal?.aborted) break;
    const first = await runSensor(spec, opts);
    let last = first;
    let reruns = 0;
    while (last.result === "fail" && reruns < opts.rerunOnFail && !opts.signal?.aborted) {
      reruns++;
      last = await runSensor(spec, opts);
    }
    const run: SensorRun = {
      ...last,
      durationMs: first.durationMs,
      reruns,
      result: reruns > 0 && last.result === "pass" ? "flaky" : last.result,
    };
    out.push(run);
    opts.onRun?.(run);
  }
  return out;
}

// ── Declared lists (policy.checks, queue entry acceptance and checks) ──

const SPEC_FIELDS = ["name", "command", "timeoutSec"];

/**
 * Validates a declared sensor list: `{name, command, timeoutSec?}` objects with
 * unique names; `timeoutSec` defaults to `defaultTimeoutSec`. `fail` throws the
 * caller's own error type.
 */
export function parseSensorSpecs(
  raw: unknown,
  field: string,
  defaultTimeoutSec: number,
  fail: (detail: string) => never,
): SensorSpec[] {
  if (!Array.isArray(raw)) fail(`"${field}" must be a list of {name, command, timeoutSec}`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((item, i) => {
    const where = `${field}[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail(`"${where}" must be an object`);
    const s = item as Record<string, unknown>;
    const extra = Object.keys(s).find((k) => !SPEC_FIELDS.includes(k));
    if (extra) fail(`unknown field "${where}.${extra}"`);
    for (const key of ["name", "command"]) {
      if (typeof s[key] !== "string" || (s[key] as string).trim() === "")
        fail(`"${where}.${key}" must be a non-empty string`);
    }
    const name = s.name as string;
    if (seen.has(name)) fail(`"${where}.name" repeats the name "${name}"`);
    seen.add(name);
    const timeout = s.timeoutSec ?? defaultTimeoutSec;
    if (!Number.isInteger(timeout) || (timeout as number) < 1)
      fail(`"${where}.timeoutSec" must be an integer of at least 1`);
    return { name, command: s.command as string, timeoutSec: timeout as number };
  });
}
