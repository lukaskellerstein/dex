import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseSensorSpecs, runSensor, runSensors, type SensorSpec } from "../sensors.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

const spec = (command: string, timeoutSec = 30, name = "check"): SensorSpec => ({
  name,
  command,
  timeoutSec,
});

function inTmp(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkTmpProject({});
    try {
      await fn(dir);
    } finally {
      rmTmp(dir);
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test(
  "runSensor: exit 0 is pass, exit 3 is fail with its exit code",
  inTmp(async (dir) => {
    const ok = await runSensor(spec("echo hello"), { cwd: dir });
    assert.equal(ok.result, "pass");
    assert.equal(ok.exitCode, 0);
    assert.deepEqual(ok.tail, ["hello"]);
    const bad = await runSensor(spec("echo boom >&2; exit 3"), { cwd: dir });
    assert.equal(bad.result, "fail");
    assert.equal(bad.exitCode, 3);
    assert.deepEqual(bad.tail, ["boom"], "stderr is in the tail");
    assert.equal(bad.signal, null);
  }),
);

test(
  "runSensor: exit 127 and a missing program are an error",
  inTmp(async (dir) => {
    assert.equal((await runSensor(spec("exit 127"), { cwd: dir })).result, "error");
    const missing = await runSensor(spec("no-such-program-dex-016"), { cwd: dir });
    assert.equal(missing.result, "error");
    assert.equal(missing.exitCode, 127);
    const noDir = await runSensor(spec("true"), { cwd: path.join(dir, "missing") });
    assert.equal(noDir.result, "error", "a cwd that does not exist cannot start");
    assert.equal(noDir.exitCode, null);
  }),
);

test(
  "runSensor: a timeout kills the whole process group, a background child included",
  inTmp(async (dir) => {
    const pidFile = path.join(dir, "child.pid");
    const started = Date.now();
    const r = await runSensor(spec(`sleep 30 & echo $! > ${pidFile}; wait`, 1), { cwd: dir });
    assert.equal(r.result, "timeout");
    assert.equal(r.exitCode, null);
    assert.equal(r.signal, "SIGTERM");
    assert.ok(Date.now() - started < 8000, "it does not wait for the sleep");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(alive(pid), false, "the background sleep is gone");
  }),
);

test(
  "runSensor: Stop (an aborted signal) stops a run",
  inTmp(async (dir) => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const r = await runSensor(spec("sleep 30"), { cwd: dir, signal: ac.signal });
    assert.equal(r.result, "error");
    assert.ok(r.durationMs < 5000);
    const before = await runSensor(spec("true"), { cwd: dir, signal: ac.signal });
    assert.equal(before.result, "error", "an already aborted signal starts nothing");
  }),
);

test(
  "runSensor: 500 lines keep only the last 200 in the tail",
  inTmp(async (dir) => {
    const r = await runSensor(
      spec("i=1; while [ $i -le 500 ]; do echo line $i; i=$((i+1)); done"),
      {
        cwd: dir,
      },
    );
    assert.equal(r.tail.length, 200);
    assert.equal(r.tail[0], "line 301");
    assert.equal(r.tail.at(-1), "line 500");
  }),
);

test(
  "runSensor: the policy env reaches the command",
  inTmp(async (dir) => {
    const r = await runSensor(spec('echo "$DEX_016_PROBE"'), {
      cwd: dir,
      env: { DEX_016_PROBE: "set" },
    });
    assert.deepEqual(r.tail, ["set"]);
  }),
);

/** Fails the first time it runs in `dir`, passes after. */
const failsOnce = (name = "check") =>
  spec(`if [ -f ran-${name} ]; then exit 0; fi; touch ran-${name}; echo first; exit 1`, 30, name);

test(
  "runSensors: a fail then a pass on its re-run is flaky; with no re-runs it is a fail",
  inTmp(async (dir) => {
    const [flaky] = await runSensors([failsOnce("a")], { cwd: dir, rerunOnFail: 1 });
    assert.equal(flaky.result, "flaky");
    assert.equal(flaky.reruns, 1);
    assert.equal(flaky.exitCode, 0);
    const [fail] = await runSensors([failsOnce("b")], { cwd: dir, rerunOnFail: 0 });
    assert.equal(fail.result, "fail");
    assert.equal(fail.reruns, 0);
    const [stillRed] = await runSensors([spec("exit 1")], { cwd: dir, rerunOnFail: 2 });
    assert.equal(stillRed.result, "fail");
    assert.equal(stillRed.reruns, 2);
  }),
);

test(
  "runSensors: every sensor runs in order even after one fails; onRun sees each",
  inTmp(async (dir) => {
    const seen: string[] = [];
    const runs = await runSensors(
      [spec("exit 1", 30, "first"), spec("exit 0", 30, "second"), spec("exit 2", 30, "third")],
      { cwd: dir, rerunOnFail: 0, onRun: (r) => seen.push(r.name) },
    );
    assert.deepEqual(
      runs.map((r) => [r.name, r.result]),
      [
        ["first", "fail"],
        ["second", "pass"],
        ["third", "fail"],
      ],
    );
    assert.deepEqual(seen, ["first", "second", "third"]);
  }),
);

test("parseSensorSpecs: defaults the timeout; rejects bad shapes and repeated names", () => {
  const fail = (detail: string): never => {
    throw new Error(detail);
  };
  assert.deepEqual(parseSensorSpecs([{ name: "unit", command: "npm test" }], "x", 600, fail), [
    { name: "unit", command: "npm test", timeoutSec: 600 },
  ]);
  for (const [raw, msg] of [
    [{}, /must be a list/],
    [[{ name: "", command: "x" }], /"x\[0\]\.name" must be a non-empty string/],
    [[{ name: "a", command: "x", timeoutSec: 0 }], /timeoutSec" must be an integer of at least 1/],
    [[{ name: "a", command: "x", extra: 1 }], /unknown field "x\[0\]\.extra"/],
    [
      [
        { name: "a", command: "x" },
        { name: "a", command: "y" },
      ],
      /repeats the name "a"/,
    ],
  ] as const) {
    assert.throws(() => parseSensorSpecs(raw, "x", 600, fail), msg);
  }
});
