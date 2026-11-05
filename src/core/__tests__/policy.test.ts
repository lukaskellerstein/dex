import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_POLICY,
  decideToolUse,
  loadPolicy,
  type Policy,
  type PolicyEnv,
  PolicyInvalidError,
  PolicyRefusedError,
  parsePolicy,
  skipsPermissionChecks,
  subjectOf,
} from "../policy.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

const PROJECT = "/work/onion";
const FILE = "/work/onion/.dex/policy.json";

/** The rules of contracts/policy-json.md § Example, as the owner writes them. */
const EXAMPLE = {
  settingSources: ["user", "project", "local"],
  permissionMode: "default",
  env: { CLAUDE_NO_WORKTREE: "1" },
  deny: [
    {
      tool: "Bash",
      pattern:
        "\\bgit\\s+push\\b[^\\n]*(\\s--force\\b|\\s-f\\b|--force-with-lease|--delete\\b|--mirror\\b|--tags\\b)",
      reason: "no force, delete, mirror or tag-all pushes",
    },
    {
      tool: "Bash",
      pattern: "\\bgit\\s+push\\b[^\\n]*\\s(origin\\s+)?(main|master)\\b",
      reason: "never push to main/master",
    },
    {
      tool: "Bash",
      pattern: "\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]*f|merge|rebase|worktree)\\b",
      reason: "history-rewriting git commands are the owner's",
    },
    {
      tool: "Bash",
      pattern:
        "\\bkubectl\\s+(delete|apply|create(?!\\s+job\\s+--from=)|replace|patch|edit|scale|drain|cordon|taint)\\b",
      reason: "helm is the only deploy path",
    },
    {
      tool: "Bash",
      pattern: "\\bhelm\\s+(uninstall|delete|rollback)\\b",
      reason: "destructive helm commands are the owner's",
    },
    {
      tool: "Bash",
      pattern: "\\bsops\\s+(-d|--decrypt|decrypt|edit|exec-env)\\b",
      reason: "secrets are never decrypted by an agent",
    },
    { tool: "*", pattern: "mgmt-01|rancher\\.cellarwood\\.org", reason: "the management cluster is off limits" },
  ],
  ask: [{ tool: "Bash", pattern: "\\bgit\\s+push\\b", reason: "pushes need a human" }],
  writeRoots: ["."],
  frozen: ["workload/report/thresholds.md", "workload/report/claim*.md"],
  limits: { maxBudgetUsdPerStage: 15, maxBudgetUsdPerRun: 120 },
};

const TRACKED = new Set([
  path.join(PROJECT, "workload/report/thresholds.md"),
  path.join(PROJECT, "workload/report/claim-a.md"),
]);
const ENV: PolicyEnv = {
  projectDir: PROJECT,
  tmpDir: os.tmpdir(),
  isTrackedAtHead: (abs) => TRACKED.has(abs),
};

function parse(raw: unknown, kind: "new" | "existing" = "existing"): Policy {
  return parsePolicy(raw, kind, { file: FILE, projectDir: PROJECT });
}

const policy = parse(EXAMPLE);
const bash = (command: string) => decideToolUse(policy, { toolName: "Bash", input: { command } }, ENV);
const write = (file_path: string) =>
  decideToolUse(policy, { toolName: "Write", input: { file_path, content: "x" } }, ENV);

// ── parsePolicy ──

test("parsePolicy: an empty object is the defaults", () => {
  const p = parse({});
  assert.deepEqual(p, DEFAULT_POLICY);
  assert.deepEqual(p.settingSources, ["user", "project", "local"]);
  assert.equal(p.permissionMode, "default");
  assert.deepEqual(p.writeRoots, ["."]);
  assert.equal(p.questions, "recommended-then-review");
  assert.equal(p.openPullRequest, false);
  assert.deepEqual(p.limits, { maxImplementRunsWithoutProgress: 2, maxVerifyRounds: 3 });
});

test("parsePolicy: the contract example parses, limits merge over the defaults", () => {
  assert.equal(policy.deny.length, 7);
  assert.equal(policy.limits.maxBudgetUsdPerStage, 15);
  assert.equal(policy.limits.maxVerifyRounds, 3);
  assert.equal(policy.env.CLAUDE_NO_WORKTREE, "1");
});

for (const [name, raw, message] of [
  ["a bad type", { openPullRequest: "yes" }, /"openPullRequest" must be a boolean/],
  ["a bad enum value", { questions: "sometimes" }, /"questions" must be one of/],
  ["a bad setting source", { settingSources: ["team"] }, /"settingSources\[0\]" must be one of/],
  [
    "a bad regex",
    { deny: [{ tool: "Bash", pattern: "git (push", reason: "r" }] },
    /"deny\[0\]\.pattern" is not a valid regular expression/,
  ],
  ["a rule without a reason", { ask: [{ tool: "Bash", pattern: "x" }] }, /"ask\[0\]\.reason" must be a non-empty string/],
  ["an unknown field", { allowEverything: true }, /unknown field "allowEverything"/],
  ["an unknown rule field", { deny: [{ tool: "Bash", pattern: "x", reason: "r", note: 1 }] }, /unknown field "deny\[0\]\.note"/],
  ["an unknown limit", { limits: { maxCoffee: 1 } }, /unknown field "limits\.maxCoffee"/],
  ["a negative limit", { limits: { maxVerifyRounds: 0 } }, /"limits\.maxVerifyRounds" must be a positive integer/],
  ["a missing systemPromptAppend file", { systemPromptAppend: ".dex/missing.md" }, /"systemPromptAppend" file .*missing\.md does not exist/],
] as const) {
  test(`parsePolicy: ${name} is a PolicyInvalidError naming the file`, () => {
    assert.throws(
      () => parse(raw),
      (err: unknown) =>
        err instanceof PolicyInvalidError && err.message.startsWith(`${FILE}: `) && message.test(err.message),
    );
  });
}

test("parsePolicy: an explicit null systemPromptAppend is the default (dex queue init writes it)", () => {
  assert.equal(parse({ systemPromptAppend: null }).systemPromptAppend, null);
});

test("parsePolicy: bypass is refused for an existing project and accepted for a new one", () => {
  const raw = { permissionMode: "bypassPermissions" };
  assert.throws(
    () => parse(raw, "existing"),
    (err: unknown) =>
      err instanceof PolicyRefusedError &&
      /permissionMode "bypassPermissions" is refused for an existing project/.test(err.message),
  );
  const accepted = parse(raw, "new");
  assert.equal(skipsPermissionChecks(accepted), true);
  assert.equal(skipsPermissionChecks(DEFAULT_POLICY), false);
});

test("loadPolicy: no file means the defaults; bad JSON is a PolicyInvalidError", () => {
  const dir = mkTmpProject({});
  const bad = mkTmpProject({ ".dex/policy.json": "{ nope" });
  const withAppend = mkTmpProject({
    ".dex/policy.json": JSON.stringify({ systemPromptAppend: ".dex/loop-rules.md" }),
    ".dex/loop-rules.md": "# Rules\n",
  });
  try {
    assert.deepEqual(loadPolicy(dir, "existing"), DEFAULT_POLICY);
    assert.throws(() => loadPolicy(bad, "existing"), /policy\.json: not valid JSON/);
    assert.equal(loadPolicy(withAppend, "existing").systemPromptAppend, ".dex/loop-rules.md");
  } finally {
    for (const d of [dir, bad, withAppend]) rmTmp(d);
  }
});

// ── subjectOf ──

test("subjectOf: the command, a resolved path, the URL, or the JSON input", () => {
  assert.equal(subjectOf({ toolName: "Bash", input: { command: "ls -la" } }, PROJECT), "ls -la");
  assert.equal(subjectOf({ toolName: "Edit", input: { file_path: "src/a.ts" } }, PROJECT), "/work/onion/src/a.ts");
  assert.equal(
    subjectOf({ toolName: "NotebookEdit", input: { notebook_path: "n.ipynb" } }, PROJECT),
    "/work/onion/n.ipynb",
  );
  assert.equal(subjectOf({ toolName: "WebFetch", input: { url: "https://x.dev" } }, PROJECT), "https://x.dev");
  assert.equal(subjectOf({ toolName: "Glob", input: { pattern: "*.ts" } }, PROJECT), '{"pattern":"*.ts"}');
});

// ── decideToolUse: every deny rule, one blocked and one allowed command ──

const DENY_ROWS: Array<[blocked: string, allowed: string, reason: RegExp]> = [
  ["cd repo && git push -f origin x", "git push origin feature-x", /no force/],
  ["git push origin main", "git push origin maintenance-fix", /never push to main/],
  ["git reset --hard HEAD~1", "git reset --soft HEAD~1", /history-rewriting/],
  ['bash -c "kubectl delete ns x"', "kubectl create job --from=cronjob/backup backup-now", /helm is the only/],
  ["helm uninstall onion", "helm upgrade --install onion ./chart", /destructive helm/],
  ["sops -d secrets.enc.yaml", "sops -e -i secrets.enc.yaml", /never decrypted/],
];

for (const [blocked, allowed, reason] of DENY_ROWS) {
  test(`decideToolUse: deny "${blocked}", let "${allowed}" through`, () => {
    const d = bash(blocked);
    assert.equal(d.kind, "deny");
    assert.ok(d.kind === "deny" && d.rule === "deny" && reason.test(d.reason));
    assert.notEqual(bash(allowed).kind, "deny");
  });
}

test('decideToolUse: a "*" rule matches any tool, here Read', () => {
  const read = (file_path: string) => decideToolUse(policy, { toolName: "Read", input: { file_path } }, ENV);
  assert.deepEqual(read("/etc/kube/mgmt-01.yaml"), {
    kind: "deny",
    rule: "deny",
    reason: "the management cluster is off limits",
  });
  assert.deepEqual(read("/etc/kube/onion-demo-01.yaml"), { kind: "none" });
});

test("decideToolUse: an ask rule asks, after the deny rules had their turn", () => {
  assert.deepEqual(bash("git push origin feature-x"), { kind: "ask", reason: "pushes need a human" });
  assert.equal(bash("git push --force origin feature-x").kind, "deny");
});

test("decideToolUse: write roots — inside, outside, the temp folder, a ../ escape", () => {
  assert.deepEqual(write("src/new.ts"), { kind: "none" });
  assert.deepEqual(write(path.join(os.tmpdir(), "scratch.txt")), { kind: "none" });
  for (const outside of ["/etc/hosts", "../other-repo/x.ts", "src/../../escape.ts"]) {
    const d = write(outside);
    assert.ok(d.kind === "deny" && d.rule === "writeRoots", `${outside} must be denied`);
  }
});

test("decideToolUse: a frozen file is denied when tracked, allowed when not", () => {
  const frozen = write("workload/report/thresholds.md");
  assert.ok(frozen.kind === "deny" && frozen.rule === "frozen" && /thresholds\.md/.test(frozen.reason));
  assert.equal(write("workload/report/claim-a.md").kind, "deny");
  assert.deepEqual(write("workload/report/claim-new.md"), { kind: "none" });
  assert.deepEqual(write("workload/report/sub/claim-a.md"), { kind: "none" });
});

test("decideToolUse: no rule has an opinion", () => {
  assert.deepEqual(bash("npm test"), { kind: "none" });
  assert.deepEqual(decideToolUse(DEFAULT_POLICY, { toolName: "Bash", input: { command: "rm -rf /" } }, ENV), {
    kind: "none",
  });
});
