import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { rmTmp } from "../../__tests__/helpers/git.ts";
import { mkTmpProject } from "../../__tests__/helpers/project.ts";
import type { OrchestratorEvent } from "../../events.ts";
import { questionModeFor, resolveRequest } from "../../humanInput.ts";
import { DEFAULT_POLICY, type Policy, parsePolicy } from "../../policy.ts";
import type { StageScope } from "../../scope.ts";
import { createInitialState, loadState, saveState } from "../../state.ts";
import type { RunConfig } from "../../types.ts";
import { buildQueryOptions, PLAYWRIGHT_MCP } from "../claudeSession.ts";
import { makeCanUseTool, type PermissionDeps, preToolUseDecision } from "../permissions.ts";

const config: RunConfig = {
  projectDir: "/tmp/project",
  specDir: "specs/001-x",
  mode: "loop",
  model: "claude-opus-4-6",
  maxIterations: 1,
  maxTurns: 40,
  taskPhases: "all",
};

const allow: CanUseTool = async () => ({ behavior: "allow" });

function options(policy: Policy, env?: Record<string, string>, projectDir = config.projectDir) {
  return buildQueryOptions(
    { config: { ...config, projectDir }, abortController: null, policy, env },
    {},
    allow,
  );
}

function policyIn(projectDir: string, raw: unknown): Policy {
  return parsePolicy(raw, "existing", { file: `${projectDir}/.dex/policy.json`, projectDir });
}

// ── buildQueryOptions ──

test("buildQueryOptions: the abort controller and the project folder always reach the SDK", () => {
  const abortController = new AbortController();
  const o = buildQueryOptions({ config, abortController, policy: DEFAULT_POLICY }, {}, allow);
  assert.equal(o.abortController, abortController);
  assert.equal(o.cwd, config.projectDir);
  assert.equal(o.canUseTool, allow);
});

test("buildQueryOptions: the preset system prompt carries the policy's append file", () => {
  const dir = mkTmpProject({ ".dex/loop-rules.md": "Never touch prod.\n" });
  try {
    const o = options(policyIn(dir, { systemPromptAppend: ".dex/loop-rules.md" }), undefined, dir);
    assert.deepEqual(o.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "Never touch prod.\n",
    });
    assert.deepEqual(options(DEFAULT_POLICY).systemPrompt, {
      type: "preset",
      preset: "claude_code",
    });
  } finally {
    rmTmp(dir);
  }
});

test("buildQueryOptions: keeps PATH, merges the policy env, the stage env wins", () => {
  const policy = policyIn("/tmp/project", { env: { CLAUDE_NO_WORKTREE: "1", SHARED: "policy" } });
  const o = options(policy, { SPECIFY_FEATURE_DIRECTORY: "specs/001-x", SHARED: "stage" });
  assert.equal(o.env?.PATH, process.env.PATH);
  assert.equal(o.env?.CLAUDE_NO_WORKTREE, "1");
  assert.equal(o.env?.SPECIFY_FEATURE_DIRECTORY, "specs/001-x");
  assert.equal(o.env?.SHARED, "stage");
});

test("buildQueryOptions: maxTurns is the smaller of the config and the policy limit", () => {
  assert.equal(options(DEFAULT_POLICY).maxTurns, 40);
  assert.equal(
    options(policyIn("/tmp/project", { limits: { maxTurnsPerStage: 25 } })).maxTurns,
    25,
  );
  assert.equal(
    options(policyIn("/tmp/project", { limits: { maxTurnsPerStage: 99 } })).maxTurns,
    40,
  );
});

test("buildQueryOptions: the policy's sources, mode and stage budget; never skips permission checks", () => {
  const policy = policyIn("/tmp/project", {
    settingSources: ["project", "local"],
    permissionMode: "acceptEdits",
    limits: { maxBudgetUsdPerStage: 15 },
  });
  const o = options(policy);
  assert.deepEqual(o.settingSources, ["project", "local"]);
  assert.equal(o.permissionMode, "acceptEdits");
  assert.equal(o.maxBudgetUsd, 15);
  for (const p of [policy, DEFAULT_POLICY]) {
    const opts = options(p);
    assert.equal(opts.allowDangerouslySkipPermissions, undefined);
    assert.notEqual(opts.permissionMode, `bypass${"Permissions"}`);
  }
  assert.equal(options(DEFAULT_POLICY).maxBudgetUsd, undefined);
});

test("buildQueryOptions: only verify with verify.browser gets the headless, isolated Playwright MCP", () => {
  const on = policyIn("/tmp/project", { verify: { browser: true } });
  const withStep = (policy: Policy, step: "verify" | "implement" | undefined) =>
    buildQueryOptions({ config, abortController: null, policy, step }, {}, allow);
  assert.deepEqual(withStep(on, "verify").mcpServers, {
    browser: {
      type: "stdio",
      command: "npx",
      args: ["-y", PLAYWRIGHT_MCP, "--headless", "--isolated"],
    },
  });
  assert.match(PLAYWRIGHT_MCP, /^@playwright\/mcp@\d+\.\d+\.\d+$/, "an exact version");
  assert.equal(withStep(on, "implement").mcpServers, undefined);
  assert.equal(withStep(on, undefined).mcpServers, undefined);
  assert.equal(withStep(DEFAULT_POLICY, "verify").mcpServers, undefined);
});

// ── The PreToolUse decision and canUseTool ──

const RULES = {
  deny: [{ tool: "Bash", pattern: "\\bgit\\s+push\\s+--force\\b", reason: "no force pushes" }],
  ask: [{ tool: "Bash", pattern: "\\bnpm\\s+run\\s+deploy\\b", reason: "deploys need a human" }],
};

function deps(projectDir: string, events: OrchestratorEvent[], aborted = false): PermissionDeps {
  return {
    policy: policyIn(projectDir, RULES),
    policyEnv: { projectDir, tmpDir: os.tmpdir(), isTrackedAtHead: () => false },
    io: { projectDir, runId: "run-1", emit: (e) => events.push(e) },
    agentRunId: "agent-1",
    entryId: "004-product-recommendations",
    questions: { mode: "wait", step: "implement" },
    isAborted: () => aborted,
    settingsAsk: [{ source: "projectSettings", content: "git push:*" }],
  };
}

test("preToolUseDecision: deny (+ policy_denied), ask, or no opinion — never allow", () => {
  const events: OrchestratorEvent[] = [];
  const d = deps("/tmp/project", events);
  const decide = (command: string) =>
    preToolUseDecision(d, "Bash", { command }) as { hookSpecificOutput?: Record<string, unknown> };

  const denied = decide("git push --force origin x");
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(denied.hookSpecificOutput?.permissionDecisionReason, "no force pushes");
  assert.deepEqual(events, [
    {
      type: "policy_denied",
      runId: "run-1",
      agentRunId: "agent-1",
      toolName: "Bash",
      subject: "git push --force origin x",
      reason: "no force pushes",
      rule: "deny",
    },
  ]);
  assert.equal(decide("npm run deploy -- --prod").hookSpecificOutput?.permissionDecision, "ask");
  const compound = decide("git add -A && git push origin HEAD").hookSpecificOutput;
  assert.equal(compound?.permissionDecision, "ask");
  assert.equal(compound?.permissionDecisionReason, "projectSettings ask rule Bash(git push:*)");
  assert.deepEqual(decide("npm test"), {});
  for (const command of ["git push --force x", "npm run deploy", "ls", "rm -rf build"]) {
    assert.notEqual(decide(command).hookSpecificOutput?.permissionDecision, "allow");
  }
  const stopped = preToolUseDecision(deps("/tmp/project", [], true), "Bash", { command: "ls" }) as {
    hookSpecificOutput?: Record<string, unknown>;
  };
  assert.equal(stopped.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(stopped.hookSpecificOutput?.permissionDecisionReason, "Run stopped by user");
});

test("preToolUseDecision and canUseTool: the stage scope denies with rule scope and a policy_denied", async () => {
  const events: OrchestratorEvent[] = [];
  const scope: StageScope = {
    entryId: "004-product-recommendations",
    stage: "implement",
    writeOnly: null,
    protect: ["tests/acceptance/recs.spec.ts"],
  };
  const d = { ...deps("/tmp/project", events), scope };
  const input = { file_path: "tests/acceptance/recs.spec.ts", old_string: "a", new_string: "b" };
  const hook = preToolUseDecision(d, "Edit", input) as { hookSpecificOutput?: Record<string, unknown> };
  assert.equal(hook.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(String(hook.hookSpecificOutput?.permissionDecisionReason), /frozen acceptance test of 004/);
  assert.equal(events[0]?.type === "policy_denied" && events[0].rule, "scope");
  const r = await makeCanUseTool(d)("Edit", input, SDK_OPTIONS);
  assert.equal(r?.behavior, "deny");
  assert.deepEqual(preToolUseDecision({ ...d, scope: undefined }, "Edit", input), {}, "no scope, no deny");
});

const SDK_OPTIONS = { signal: new AbortController().signal, toolUseID: "tu-1", requestId: "rq-1" };
type CanUseToolOptions = Parameters<CanUseTool>[2];

function withState(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkTmpProject({});
    try {
      await saveState(
        dir,
        createInitialState({ ...config, projectDir: dir }, "run-1", {
          kind: "existing",
          runBranch: null,
        }),
      );
      await fn(dir);
    } finally {
      rmTmp(dir);
    }
  };
}

test(
  "canUseTool: a settings ask rule holds the call as a tool approval until a human answers",
  withState(async (dir) => {
    const events: OrchestratorEvent[] = [];
    const canUseTool = makeCanUseTool(deps(dir, events));
    const asked = canUseTool("Bash", { command: "git push origin feature-x" }, {
      ...SDK_OPTIONS,
      matchedAskRule: { source: "projectSettings", toolName: "Bash", ruleContent: "git push:*" },
    } as CanUseToolOptions);

    const request = events.find((e) => e.type === "tool_approval_request");
    assert.ok(request?.type === "tool_approval_request");
    assert.equal(request.source, "settings");
    assert.equal(request.subject, "git push origin feature-x");
    assert.match(request.reason ?? "", /Bash\(git push:\*\)/);
    const pending = (await loadState(dir))?.pendingRequests ?? [];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "tool_approval");

    assert.equal(
      resolveRequest(request.requestId, {
        kind: "tool_approval",
        decision: "deny",
        message: "not today",
      }),
      true,
    );
    assert.deepEqual(await asked, { behavior: "deny", message: "not today" });
    assert.deepEqual((await loadState(dir))?.pendingRequests, []);
  }),
);

test(
  "canUseTool: a settings ask rule the SDK reports only as decisionReasonType 'rule' is held too",
  withState(async (dir) => {
    // The shape SDK 0.3.318 sent for `git push origin HEAD` under a project rule
    // Bash(git push:*): no matchedAskRule, no decisionReason, no suggestions.
    const events: OrchestratorEvent[] = [];
    const asked = makeCanUseTool(deps(dir, events))("Bash", { command: "git push origin HEAD" }, {
      ...SDK_OPTIONS,
      decisionReasonType: "rule",
      displayName: "Bash",
    } as CanUseToolOptions);
    const request = events.find((e) => e.type === "tool_approval_request");
    assert.ok(request?.type === "tool_approval_request");
    assert.equal(request.source, "settings");
    assert.equal(request.subject, "git push origin HEAD");
    assert.equal(request.reason, "a settings ask rule");
    resolveRequest(request.requestId, { kind: "tool_approval", decision: "deny" });
    assert.deepEqual(await asked, { behavior: "deny", message: "Denied by the human" });
  }),
);

test(
  "canUseTool: a settings ask rule on one part of a compound command is held (subcommandResults)",
  withState(async (dir) => {
    const events: OrchestratorEvent[] = [];
    const command = "git add -A && git push origin HEAD";
    const asked = makeCanUseTool(deps(dir, events))("Bash", { command }, {
      ...SDK_OPTIONS,
      decisionReasonType: "subcommandResults",
    } as CanUseToolOptions);
    const request = events.find((e) => e.type === "tool_approval_request");
    assert.ok(request?.type === "tool_approval_request");
    assert.equal(request.source, "settings");
    assert.equal(request.reason, "projectSettings ask rule Bash(git push:*)");
    resolveRequest(request.requestId, { kind: "tool_approval", decision: "approve" });
    assert.deepEqual(await asked, { behavior: "allow", updatedInput: { command } });
  }),
);

test(
  "canUseTool: a policy ask rule asks with source policy; approve runs the call",
  withState(async (dir) => {
    const events: OrchestratorEvent[] = [];
    const asked = makeCanUseTool(deps(dir, events))(
      "Bash",
      { command: "npm run deploy -- --prod" },
      SDK_OPTIONS as CanUseToolOptions,
    );
    const request = events.find((e) => e.type === "tool_approval_request");
    assert.ok(request?.type === "tool_approval_request");
    assert.equal(request.source, "policy");
    assert.equal(request.reason, "deploys need a human");
    resolveRequest(request.requestId, { kind: "tool_approval", decision: "approve" });
    assert.deepEqual(await asked, {
      behavior: "allow",
      updatedInput: { command: "npm run deploy -- --prod" },
    });
  }),
);

test(
  "canUseTool: nothing matched anywhere → allow, with no request",
  withState(async (dir) => {
    const events: OrchestratorEvent[] = [];
    const result = await makeCanUseTool(deps(dir, events))(
      "Edit",
      { file_path: "src/a.ts" },
      SDK_OPTIONS as CanUseToolOptions,
    );
    assert.deepEqual(result, { behavior: "allow", updatedInput: { file_path: "src/a.ts" } });
    assert.deepEqual(events, []);
  }),
);

test("questionModeFor: autoClarification covers only the new-project clarification steps; the rest follow the policy", () => {
  const policy = { ...DEFAULT_POLICY };
  assert.equal(questionModeFor("clarification_product", true, policy), "recommended-then-review");
  assert.equal(questionModeFor("clarification_synthesis", false, policy), "wait");
  assert.equal(questionModeFor("clarify", true, { ...policy, questions: "wait" }), "wait");
  assert.equal(questionModeFor("implement", false, policy), "recommended-then-review");
});
