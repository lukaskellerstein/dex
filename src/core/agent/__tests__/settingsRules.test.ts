import assert from "node:assert/strict";
import test from "node:test";
import { rmTmp } from "../../__tests__/helpers/git.ts";
import { mkTmpProject } from "../../__tests__/helpers/project.ts";
import { loadSettingsAskRules, matchSettingsAsk, type SettingsAskRule } from "../settingsRules.ts";

const rule = (content: string): SettingsAskRule => ({ source: "projectSettings", content });

test("matchSettingsAsk: a rule matches any part of a compound Bash command", () => {
  const push = [rule("git push:*")];
  for (const command of [
    "git push origin HEAD",
    "git push",
    "git add -A && git push origin HEAD",
    "npm test || git push",
    "git status; git push -u origin x",
    "echo hi | git push",
    "git add -A\ngit push",
  ]) {
    assert.equal(matchSettingsAsk(push, command)?.content, "git push:*", command);
  }
  for (const command of ["git pushx", "git status && git commit -m push", "echo git push"]) {
    assert.equal(matchSettingsAsk(push, command), null, command);
  }
});

test("matchSettingsAsk: wildcard, bare tool and exact rules", () => {
  assert.ok(matchSettingsAsk([rule("npm run *")], "ls && npm run deploy"));
  assert.ok(matchSettingsAsk([rule("npm run *")], "npm run"));
  assert.equal(matchSettingsAsk([rule("npm run *")], "npm runner"), null);
  assert.ok(matchSettingsAsk([rule("rm * build")], "cd x && rm -rf build"));
  assert.ok(matchSettingsAsk([rule("npm test")], "cd x && npm test"));
  assert.equal(matchSettingsAsk([rule("npm test")], "npm test --watch"), null);
  assert.ok(matchSettingsAsk([{ source: "userSettings", content: null }], "ls"));
});

test("loadSettingsAskRules: Bash ask rules from the policy's sources only", () => {
  const home = mkTmpProject({
    ".claude/settings.json": JSON.stringify({ permissions: { ask: ["Bash(git push --force:*)"] } }),
  });
  const project = mkTmpProject({
    ".claude/settings.json": JSON.stringify({
      permissions: { ask: ["Bash(git push:*)", "Read(./.env)", "Bash"], allow: ["Bash(ls:*)"] },
    }),
    ".claude/settings.local.json": "{ not json",
  });
  try {
    assert.deepEqual(loadSettingsAskRules(project, ["project", "local"], home), [
      { source: "projectSettings", content: "git push:*" },
      { source: "projectSettings", content: null },
    ]);
    assert.deepEqual(loadSettingsAskRules(project, ["user"], home), [
      { source: "userSettings", content: "git push --force:*" },
    ]);
    assert.deepEqual(loadSettingsAskRules(project, [], home), []);
  } finally {
    rmTmp(home);
    rmTmp(project);
  }
});
