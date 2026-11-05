import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AcceptanceRecord } from "../acceptance.ts";
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
import { resolveEntries, type StageName } from "../queue.ts";
import { stageScope } from "../scope.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

const PROJECT = "/work/shop";
const FILE = "/work/shop/.dex/policy.json";

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
      pattern: "\\bdocker\\s+(rm|rmi|push|system\\s+prune|compose\\s+down(?!\\s+--dry-run))\\b",
      reason: "containers are the owner's",
    },
    {
      tool: "Bash",
      pattern: "\\bnpm\\s+(publish|unpublish|deprecate)\\b",
      reason: "publishing is the owner's",
    },
    {
      tool: "Bash",
      pattern: "\\bsops\\s+(-d|--decrypt|decrypt|edit|exec-env)\\b",
      reason: "secrets are never decrypted by an agent",
    },
    {
      tool: "*",
      pattern: "prod-db|payments\\.shop\\.example",
      reason: "the production systems are off limits",
    },
  ],
  ask: [{ tool: "Bash", pattern: "\\bgit\\s+push\\b", reason: "pushes need a human" }],
  writeRoots: ["."],
  frozen: ["docs/legal/terms.md", "docs/legal/policy*.md"],
  limits: { maxBudgetUsdPerStage: 2, maxBudgetUsdPerRun: 20 },
};

const TRACKED = new Set([
  path.join(PROJECT, "docs/legal/terms.md"),
  path.join(PROJECT, "docs/legal/policy-a.md"),
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
const bash = (command: string) =>
  decideToolUse(policy, { toolName: "Bash", input: { command } }, ENV);
const write = (file_path: string) =>
  decideToolUse(policy, { toolName: "Write", input: { file_path, content: "x" } }, ENV);

// ── parsePolicy ──

test("parsePolicy: the project's env merges over the default env, and can turn it off", () => {
  assert.deepEqual(parse({ env: { NODE_ENV: "test" } }).env, {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    NODE_ENV: "test",
  });
  assert.deepEqual(parse({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } }).env, {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
  });
});

test("parsePolicy: an empty object is the defaults", () => {
  const p = parse({});
  assert.deepEqual(p, DEFAULT_POLICY);
  assert.deepEqual(p.settingSources, ["user", "project", "local"]);
  assert.equal(p.permissionMode, "default");
  assert.deepEqual(p.writeRoots, ["."]);
  assert.deepEqual(p.env, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  assert.equal(p.questions, "recommended-then-review");
  assert.equal(p.openPullRequest, false);
  assert.deepEqual(p.limits, { maxImplementRunsWithoutProgress: 2, maxVerifyRounds: 3 });
});

test("parsePolicy: the contract example parses, limits merge over the defaults", () => {
  assert.equal(policy.deny.length, 7);
  assert.equal(policy.limits.maxBudgetUsdPerStage, 2);
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
  [
    "a rule without a reason",
    { ask: [{ tool: "Bash", pattern: "x" }] },
    /"ask\[0\]\.reason" must be a non-empty string/,
  ],
  ["an unknown field", { allowEverything: true }, /unknown field "allowEverything"/],
  [
    "an unknown rule field",
    { deny: [{ tool: "Bash", pattern: "x", reason: "r", note: 1 }] },
    /unknown field "deny\[0\]\.note"/,
  ],
  ["an unknown limit", { limits: { maxCoffee: 1 } }, /unknown field "limits\.maxCoffee"/],
  [
    "a negative limit",
    { limits: { maxVerifyRounds: 0 } },
    /"limits\.maxVerifyRounds" must be a positive integer/,
  ],
  [
    "a missing systemPromptAppend file",
    { systemPromptAppend: ".dex/missing.md" },
    /"systemPromptAppend" file .*missing\.md does not exist/,
  ],
] as const) {
  test(`parsePolicy: ${name} is a PolicyInvalidError naming the file`, () => {
    assert.throws(
      () => parse(raw),
      (err: unknown) =>
        err instanceof PolicyInvalidError &&
        err.message.startsWith(`${FILE}: `) &&
        message.test(err.message),
    );
  });
}

test("parsePolicy: the 016 defaults — no checks, one re-run, the test globs and test support of the contract", () => {
  const p = parse({});
  assert.deepEqual(p.checks, { fast: [], standing: [], rerunOnFail: 1 });
  assert.deepEqual(p.verify, { browser: false });
  assert.deepEqual(p.testGlobs, [
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/e2e/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/test_*.py",
    "**/*_test.py",
    "**/*_test.go",
  ]);
  assert.deepEqual(p.testSupport, [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "playwright.config.*",
    "vitest.config.*",
    "jest.config.*",
    "pytest.ini",
    "pyproject.toml",
    "uv.lock",
    "**/conftest.py",
    "go.mod",
    "go.sum",
  ]);
});

test("parsePolicy: the 016 contract example parses; a check's timeout defaults to 600", () => {
  const p = parse({
    checks: {
      fast: [
        { name: "unit", command: "npm test -- --changed", timeoutSec: 300 },
        { name: "types", command: "npm run typecheck" },
      ],
      standing: [{ name: "full suite", command: "npm test", timeoutSec: 1200 }],
      rerunOnFail: 2,
    },
    testGlobs: ["tests/**", "**/*.test.ts"],
    testSupport: ["package.json"],
    verify: { browser: true },
  });
  assert.deepEqual(p.checks.fast[1], {
    name: "types",
    command: "npm run typecheck",
    timeoutSec: 600,
  });
  assert.equal(p.checks.standing[0].timeoutSec, 1200);
  assert.equal(p.checks.rerunOnFail, 2);
  assert.deepEqual(p.testGlobs, ["tests/**", "**/*.test.ts"]);
  assert.equal(p.verify.browser, true);
});

for (const [name, raw, message] of [
  ["an unknown checks key", { checks: { slow: [] } }, /unknown field "checks\.slow"/],
  ["an unknown verify key", { verify: { headless: true } }, /unknown field "verify\.headless"/],
  [
    "a duplicate check name",
    {
      checks: {
        fast: [
          { name: "unit", command: "a" },
          { name: "unit", command: "b" },
        ],
      },
    },
    /"checks\.fast\[1\]\.name" repeats the name "unit"/,
  ],
  [
    "a timeout below 1",
    { checks: { fast: [{ name: "unit", command: "a", timeoutSec: 0 }] } },
    /"checks\.fast\[0\]\.timeoutSec" must be an integer of at least 1/,
  ],
  [
    "rerunOnFail above 5",
    { checks: { rerunOnFail: 6 } },
    /"checks\.rerunOnFail" must be an integer from 0 to 5/,
  ],
  ["an empty testGlobs", { testGlobs: [] }, /"testGlobs" must not be empty/],
  [
    "a non-boolean verify.browser",
    { verify: { browser: "yes" } },
    /"verify\.browser" must be a boolean/,
  ],
] as const) {
  test(`parsePolicy: ${name} is a PolicyInvalidError`, () => {
    assert.throws(
      () => parse(raw),
      (err: unknown) => err instanceof PolicyInvalidError && message.test(err.message),
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
  assert.equal(
    subjectOf({ toolName: "Edit", input: { file_path: "src/a.ts" } }, PROJECT),
    "/work/shop/src/a.ts",
  );
  assert.equal(
    subjectOf({ toolName: "NotebookEdit", input: { notebook_path: "n.ipynb" } }, PROJECT),
    "/work/shop/n.ipynb",
  );
  assert.equal(
    subjectOf({ toolName: "WebFetch", input: { url: "https://x.dev" } }, PROJECT),
    "https://x.dev",
  );
  assert.equal(
    subjectOf({ toolName: "Glob", input: { pattern: "*.ts" } }, PROJECT),
    '{"pattern":"*.ts"}',
  );
});

// ── decideToolUse: every deny rule, one blocked and one allowed command ──

const DENY_ROWS: Array<[blocked: string, allowed: string, reason: RegExp]> = [
  ["cd repo && git push -f origin x", "git push origin feature-x", /no force/],
  ["git push origin main", "git push origin maintenance-fix", /never push to main/],
  ["git reset --hard HEAD~1", "git reset --soft HEAD~1", /history-rewriting/],
  ['bash -c "docker rm web"', "docker compose down --dry-run", /containers are the owner's/],
  ["npm unpublish shop-ui", "npm pack", /publishing is the owner's/],
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
  const read = (file_path: string) =>
    decideToolUse(policy, { toolName: "Read", input: { file_path } }, ENV);
  assert.deepEqual(read("/etc/secrets/prod-db.yaml"), {
    kind: "deny",
    rule: "deny",
    reason: "the production systems are off limits",
  });
  assert.deepEqual(read("/etc/secrets/staging-db.yaml"), { kind: "none" });
});

test("decideToolUse: an ask rule asks, after the deny rules had their turn", () => {
  assert.deepEqual(bash("git push origin feature-x"), {
    kind: "ask",
    reason: "pushes need a human",
  });
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
  const frozen = write("docs/legal/terms.md");
  assert.ok(frozen.kind === "deny" && frozen.rule === "frozen" && /terms\.md/.test(frozen.reason));
  assert.equal(write("docs/legal/policy-a.md").kind, "deny");
  assert.deepEqual(write("docs/legal/policy-new.md"), { kind: "none" });
  assert.deepEqual(write("docs/legal/sub/policy-a.md"), { kind: "none" });
});

test("decideToolUse: no rule has an opinion", () => {
  assert.deepEqual(bash("npm test"), { kind: "none" });
  assert.deepEqual(
    decideToolUse(DEFAULT_POLICY, { toolName: "Bash", input: { command: "rm -rf /" } }, ENV),
    {
      kind: "none",
    },
  );
});

// ── 016: stage scopes (contracts/policy-json.md § Table cases, research R9) ──

const [PROMO] = resolveEntries(
  { version: 3, kind: "existing", entries: [{ id: "003-promo-codes", title: "Promo codes" }] },
  "main",
  null,
);
const FROZEN_TEST = "tests/acceptance/003-promo-codes/apply.spec.ts";
const ACC_RECORD: AcceptanceRecord = {
  version: 1,
  command: "npx playwright test tests/acceptance/003-promo-codes",
  failExitCodes: [1],
  timeoutSec: 900,
  files: [FROZEN_TEST],
  covers: [{ test: "apply.spec.ts › applies", criterion: "SC-001" }],
};

function scoped(stage: StageName, toolName: string, input: Record<string, unknown>) {
  const scope = stageScope(policy, PROMO, stage, ACC_RECORD) ?? undefined;
  return decideToolUse(policy, { toolName, input }, ENV, scope);
}

const edit = (file_path: string) => ({ file_path, old_string: "a", new_string: "b" });
const ruleOf = (d: ReturnType<typeof decideToolUse>) => (d.kind === "deny" ? d.rule : d.kind);

for (const [stage, toolName, input, expected] of [
  ["tests", "Write", { file_path: "tests/acceptance/x.spec.ts", content: "x" }, "none"],
  ["tests", "Write", { file_path: "src/cart/promo.ts", content: "x" }, "scope"],
  ["tests", "Edit", edit("package.json"), "none"],
  ["tests", "Write", { file_path: "specs/003-promo-codes/acceptance.json", content: "{}" }, "none"],
  ["implement", "Edit", edit(FROZEN_TEST), "scope"],
  ["implement", "Bash", { command: `rm ${FROZEN_TEST}` }, "scope"],
  ["implement", "Bash", { command: `git mv ${FROZEN_TEST} tests/old.spec.ts` }, "scope"],
  ["implement", "Bash", { command: `echo '' > ./${FROZEN_TEST}` }, "scope"],
  ["implement", "Bash", { command: `npm test && unlink "${FROZEN_TEST}"` }, "scope"],
  ["implement", "Bash", { command: `npx playwright test ${FROZEN_TEST}` }, "none"],
  [
    "implement",
    "Write",
    { file_path: "specs/003-promo-codes/acceptance.json", content: "{}" },
    "scope",
  ],
  ["implement", "Write", { file_path: "src/cart/promo.ts", content: "x" }, "none"],
  ["verify", "Edit", edit("specs/003-promo-codes/tasks.md"), "none"],
  ["verify", "Edit", edit("src/cart/promo.ts"), "scope"],
  ["verify", "Edit", edit(FROZEN_TEST), "scope"],
  ["plan", "Write", { file_path: "src/cart/promo.ts", content: "x" }, "none"],
  ["tests", "Write", { file_path: path.join(os.tmpdir(), "scratch.txt"), content: "x" }, "none"],
] as const) {
  test(`stage scope: ${stage} · ${toolName} ${JSON.stringify(input).slice(0, 70)} → ${expected}`, () => {
    assert.equal(ruleOf(scoped(stage, toolName, input)), expected);
  });
}

test("stage scope: a policy deny is checked first; the scope reasons name the file and the stage", () => {
  const prod = scoped("implement", "Bash", { command: `rm ${FROZEN_TEST} # prod-db` });
  assert.equal(ruleOf(prod), "deny");
  const frozen = scoped("implement", "Edit", edit(FROZEN_TEST));
  assert.equal(
    frozen.kind === "deny" && frozen.reason,
    `${FROZEN_TEST} is a frozen acceptance test of 003-promo-codes; ask for a test amendment instead`,
  );
  const outside = scoped("verify", "Edit", edit("src/cart/promo.ts"));
  assert.equal(
    outside.kind === "deny" && outside.reason,
    "the verify stage may write only specs/003-promo-codes/tasks.md",
  );
});

test("stageScope: one per stage of R9, amend mode included; none for the other stages", () => {
  const tests = stageScope(policy, PROMO, "tests", null);
  assert.deepEqual(tests?.writeOnly, [
    ...policy.testGlobs,
    ...policy.testSupport,
    "specs/003-promo-codes/**",
  ]);
  assert.deepEqual(tests?.protect, []);
  const amend = stageScope(policy, PROMO, "tests", ACC_RECORD, FROZEN_TEST);
  assert.deepEqual(amend?.writeOnly, [FROZEN_TEST, "specs/003-promo-codes/**"]);
  const impl = stageScope(policy, PROMO, "implement", ACC_RECORD);
  assert.equal(impl?.writeOnly, null);
  assert.deepEqual(impl?.protect, [FROZEN_TEST, "specs/003-promo-codes/acceptance.json"]);
  assert.deepEqual(stageScope(policy, PROMO, "verify", ACC_RECORD)?.writeOnly, [
    "specs/003-promo-codes/tasks.md",
  ]);
  assert.deepEqual(
    stageScope(policy, PROMO, "implement", null)?.protect,
    [],
    "no record yet, nothing frozen",
  );
  for (const stage of ["brief", "specify", "clarify", "plan", "tasks"] as const) {
    assert.equal(stageScope(policy, PROMO, stage, ACC_RECORD), null, stage);
  }
});
