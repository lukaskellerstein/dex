import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listProfiles,
  saveDexJson,
} from "../agent-profile.ts";

function mkTmpProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dex-profile-"));
}

function rmTmp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function seedProfile(
  projectDir: string,
  name: string,
  dexJson: object,
  claudeFiles?: Record<string, string>,
): string {
  const dir = path.join(projectDir, ".dex", "agents", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "dex.json"), JSON.stringify(dexJson, null, 2));
  if (claudeFiles) {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    for (const [rel, content] of Object.entries(claudeFiles)) {
      const target = path.join(dir, ".claude", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return dir;
}

// ── listProfiles ────────────────────────────────────────

test("listProfiles: missing .dex/agents directory → []", () => {
  const dir = mkTmpProject();
  try {
    assert.deepEqual(listProfiles(dir), []);
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: valid claude-sdk profile parses + reports overlay summary", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(
      dir,
      "conservative",
      {
        agentRunner: "claude-sdk",
        model: "claude-opus-4-7",
        systemPromptAppend: "Minimize change.",
        allowedTools: ["Read", "Edit"],
      },
      {
        "CLAUDE.md": "# Conservative profile\n",
        "skills/skill-a.md": "skill",
        "skills/skill-b.md": "skill",
        "agents/code-reviewer.md": "subagent",
      },
    );
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.kind, "ok");
    if (e.kind === "ok") {
      assert.equal(e.profile.name, "conservative");
      assert.equal(e.profile.agentRunner, "claude-sdk");
      if (e.profile.agentRunner === "claude-sdk") {
        assert.equal(e.profile.model, "claude-opus-4-7");
        assert.equal(e.profile.systemPromptAppend, "Minimize change.");
        assert.deepEqual(e.profile.allowedTools, ["Read", "Edit"]);
      }
      assert.equal(e.overlaySummary.hasClaude, true);
      assert.equal(e.overlaySummary.hasClaudeMd, true);
      assert.equal(e.overlaySummary.skills, 2);
      assert.equal(e.overlaySummary.subagents, 1);
      assert.equal(e.overlaySummary.mcpServers, 0);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: profile without .claude subdir is valid (kind: ok)", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "standard", {
      agentRunner: "claude-sdk",
      model: "claude-sonnet-4-6",
    });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "ok");
    if (entries[0].kind === "ok") {
      assert.equal(entries[0].overlaySummary.hasClaude, false);
      assert.equal(entries[0].overlaySummary.skills, 0);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: missing dex.json → kind: warn with reason", () => {
  const dir = mkTmpProject();
  try {
    fs.mkdirSync(path.join(dir, ".dex", "agents", "broken"), { recursive: true });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "warn");
    if (entries[0].kind === "warn") {
      assert.equal(entries[0].folder, "broken");
      assert.match(entries[0].reason, /missing dex\.json/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: malformed JSON → kind: warn with parser error", () => {
  const dir = mkTmpProject();
  try {
    const folder = path.join(dir, ".dex", "agents", "bad-json");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "dex.json"), "{ this is not JSON");
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "warn");
    if (entries[0].kind === "warn") {
      assert.match(entries[0].reason, /invalid JSON/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: unknown agentRunner → kind: warn", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "alien", { agentRunner: "alien-runner", model: "x" });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "warn");
    if (entries[0].kind === "warn") {
      assert.match(entries[0].reason, /unknown agentRunner/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: missing model → kind: warn", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "no-model", { agentRunner: "claude-sdk" });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "warn");
    if (entries[0].kind === "warn") {
      assert.match(entries[0].reason, /model/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: hidden folders (.DS_Store, .git) are silently skipped", () => {
  const dir = mkTmpProject();
  try {
    fs.mkdirSync(path.join(dir, ".dex", "agents"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".dex", "agents", ".DS_Store"), "junk");
    seedProfile(dir, "conservative", {
      agentRunner: "claude-sdk",
      model: "claude-opus-4-7",
    });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "ok");
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: codex/copilot agentRunner parses cleanly (kind: ok) but is flagged stub-only", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "codex-experiment", {
      agentRunner: "codex",
      model: "gpt-5",
    });
    const entries = listProfiles(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "ok");
    if (entries[0].kind === "ok") {
      assert.equal(entries[0].profile.agentRunner, "codex");
    }
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: results sorted alphabetically by folder name", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "z-alpha", { agentRunner: "claude-sdk", model: "x" });
    seedProfile(dir, "a-beta", { agentRunner: "claude-sdk", model: "x" });
    seedProfile(dir, "m-gamma", { agentRunner: "claude-sdk", model: "x" });
    const entries = listProfiles(dir);
    const names = entries.map((e) => (e.kind === "ok" ? e.profile.name : e.folder));
    assert.deepEqual(names, ["a-beta", "m-gamma", "z-alpha"]);
  } finally {
    rmTmp(dir);
  }
});

test("listProfiles: counts MCP servers from .claude/.mcp.json top-level mcpServers keys", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(
      dir,
      "with-mcp",
      { agentRunner: "claude-sdk", model: "x" },
      {
        ".mcp.json": JSON.stringify({
          mcpServers: { foo: {}, bar: {}, baz: {} },
        }),
      },
    );
    const entries = listProfiles(dir);
    assert.equal(entries[0].kind, "ok");
    if (entries[0].kind === "ok") {
      assert.equal(entries[0].overlaySummary.mcpServers, 3);
    }
  } finally {
    rmTmp(dir);
  }
});

// ── saveDexJson ────────────────────────────────────────

test("saveDexJson: writes the file atomically", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "conservative", {
      agentRunner: "claude-sdk",
      model: "claude-opus-4-7",
    });
    const r = saveDexJson(dir, "conservative", {
      agentRunner: "claude-sdk",
      model: "claude-sonnet-4-6",
      systemPromptAppend: "Updated.",
      allowedTools: ["Read", "Edit"],
    });
    assert.equal(r.ok, true);
    const written = JSON.parse(
      fs.readFileSync(
        path.join(dir, ".dex", "agents", "conservative", "dex.json"),
        "utf-8",
      ),
    );
    assert.equal(written.model, "claude-sonnet-4-6");
    assert.equal(written.systemPromptAppend, "Updated.");
  } finally {
    rmTmp(dir);
  }
});

test("saveDexJson: rejects when agent folder doesn't exist", () => {
  const dir = mkTmpProject();
  try {
    const r = saveDexJson(dir, "nonexistent", {
      agentRunner: "claude-sdk",
      model: "claude-opus-4-7",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /not found/);
    }
  } finally {
    rmTmp(dir);
  }
});

test("saveDexJson: validates the payload before writing", () => {
  const dir = mkTmpProject();
  try {
    seedProfile(dir, "conservative", {
      agentRunner: "claude-sdk",
      model: "claude-opus-4-7",
    });
    const r = saveDexJson(dir, "conservative", {
      // @ts-expect-error — testing runtime validation
      agentRunner: "alien",
      model: "x",
    });
    assert.equal(r.ok, false);
  } finally {
    rmTmp(dir);
  }
});
