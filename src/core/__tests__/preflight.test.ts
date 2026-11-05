import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DEFAULT_POLICY, type Policy } from "../policy.ts";
import { checkRepos, runPreflight } from "../preflight.ts";
import { mkTmpRepo, rmTmp } from "./helpers/git.ts";

let dir: string;
const logged: string[] = [];
const log = (_level: string, msg: string) => logged.push(msg);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-preflight-"));
  logged.length = 0;
});

afterEach(() => {
  rmTmp(dir);
});

const policy = (p: Partial<Policy>): Policy => ({ ...DEFAULT_POLICY, ...p });

test("runPreflight: every command passes in the project folder, and each is logged", async () => {
  fs.writeFileSync(path.join(dir, "marker"), "");
  const result = await runPreflight(policy({ preflight: ["test -f marker", "echo ok | grep -q ok"] }), dir, log);
  assert.equal(result, null);
  assert.deepEqual(logged, ["preflight: ok — test -f marker", "preflight: ok — echo ok | grep -q ok"]);
});

test("runPreflight: the first failing command is named with its exit code; later ones do not run", async () => {
  const result = await runPreflight(policy({ preflight: ["exit 3", "touch ran"] }), dir, log);
  assert.equal(result, "preflight command `exit 3` failed (exit code 3)");
  assert.equal(fs.existsSync(path.join(dir, "ran")), false);
});

test("checkRepos: clean checkouts pass; files and an empty glob are ignored", () => {
  const repo = mkTmpRepo("dex-pf-repo-");
  try {
    fs.mkdirSync(path.join(dir, "workload"));
    fs.renameSync(repo, path.join(dir, "workload", "svc"));
    fs.writeFileSync(path.join(dir, "workload", "README.md"), "# not a checkout, a file\n");
    assert.equal(checkRepos(policy({ repos: ["workload/*", "tenants/*"] }), dir), null);
  } finally {
    rmTmp(repo);
  }
});

test("checkRepos: a dirty checkout and a plain folder are named", () => {
  const repo = mkTmpRepo("dex-pf-repo-");
  fs.mkdirSync(path.join(dir, "workload"));
  fs.renameSync(repo, path.join(dir, "workload", "svc"));
  fs.writeFileSync(path.join(dir, "workload", "svc", "wip.txt"), "x");
  assert.equal(
    checkRepos(policy({ repos: ["workload/*"] }), dir),
    'workload/svc (repos: "workload/*") has uncommitted changes: wip.txt',
  );
  fs.rmSync(path.join(dir, "workload", "svc", "wip.txt"));
  fs.mkdirSync(path.join(dir, "workload", "plain"));
  assert.equal(checkRepos(policy({ repos: ["workload/*"] }), dir), 'workload/plain (repos: "workload/*") is not a git checkout');
});
