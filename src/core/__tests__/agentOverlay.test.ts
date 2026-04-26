import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { applyOverlay } from "../agent-overlay.ts";
import type { ClaudeProfile } from "../agent-profile.ts";

function mkTmp(): { projectDir: string; worktreePath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "dex-overlay-"));
  // Project root has its own .claude/ — we want to verify it stays untouched.
  fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".claude", "CLAUDE.md"), "# project root\n");
  fs.writeFileSync(path.join(projectDir, ".claude", "settings.json"), '{"projectKey":"keep"}\n');

  // Simulated worktree dir (independent of git for this unit-level test).
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "dex-wt-"));
  return { projectDir, worktreePath };
}

function rmTmp(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function hashDir(dir: string): string {
  if (!fs.existsSync(dir)) return "<absent>";
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: false }) as string[];
  const hasher = crypto.createHash("sha256");
  for (const rel of entries.sort()) {
    const full = path.join(dir, rel);
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      hasher.update(rel + "\0" + fs.readFileSync(full).toString("utf-8"));
    }
  }
  return hasher.digest("hex");
}

function mkProfile(
  projectDir: string,
  name: string,
  claudeFiles?: Record<string, string>,
): ClaudeProfile {
  const agentDir = path.join(projectDir, ".dex", "agents", name);
  fs.mkdirSync(agentDir, { recursive: true });
  if (claudeFiles) {
    fs.mkdirSync(path.join(agentDir, ".claude"), { recursive: true });
    for (const [rel, content] of Object.entries(claudeFiles)) {
      const target = path.join(agentDir, ".claude", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  return {
    name,
    agentDir,
    agentRunner: "claude-sdk",
    model: "claude-opus-4-7",
  };
}

// ── applyOverlay ────────────────────────────────────────

test("applyOverlay: copies top-level .claude/ entries into the worktree", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    const profile = mkProfile(projectDir, "conservative", {
      "CLAUDE.md": "# Conservative\n",
      "skills/skill-a.md": "skill content",
      "agents/code-reviewer.md": "subagent body",
    });
    applyOverlay(worktreePath, profile);

    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "CLAUDE.md")));
    assert.equal(
      fs.readFileSync(path.join(worktreePath, ".claude", "CLAUDE.md"), "utf-8"),
      "# Conservative\n",
    );
    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "skills", "skill-a.md")));
    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "agents", "code-reviewer.md")));
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: replaces existing files in the worktree's .claude/", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    // Worktree starts with its own .claude/CLAUDE.md (simulating the
    // committed project default copied into the worktree by `git worktree add`).
    fs.mkdirSync(path.join(worktreePath, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, ".claude", "CLAUDE.md"), "# committed default\n");

    const profile = mkProfile(projectDir, "innovative", {
      "CLAUDE.md": "# Innovative\n",
    });
    applyOverlay(worktreePath, profile);

    assert.equal(
      fs.readFileSync(path.join(worktreePath, ".claude", "CLAUDE.md"), "utf-8"),
      "# Innovative\n",
      "overlay must replace, not merge",
    );
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: profile with no .claude/ → no-op", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    fs.mkdirSync(path.join(worktreePath, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, ".claude", "CLAUDE.md"), "# committed\n");
    const before = hashDir(path.join(worktreePath, ".claude"));

    // Profile without .claude/.
    const profile = mkProfile(projectDir, "standard");
    applyOverlay(worktreePath, profile);

    const after = hashDir(path.join(worktreePath, ".claude"));
    assert.equal(after, before, "no-op overlay must not modify the worktree");
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: profile === null → no-op", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    fs.mkdirSync(path.join(worktreePath, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, ".claude", "CLAUDE.md"), "# committed\n");
    const before = hashDir(path.join(worktreePath, ".claude"));

    applyOverlay(worktreePath, null);

    const after = hashDir(path.join(worktreePath, ".claude"));
    assert.equal(after, before);
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: project root's .claude/ is byte-for-byte unchanged (SC-007)", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    const before = hashDir(path.join(projectDir, ".claude"));

    const profile = mkProfile(projectDir, "conservative", {
      "CLAUDE.md": "# Overlay\n",
      "skills/extra.md": "skill",
    });
    applyOverlay(worktreePath, profile);

    const after = hashDir(path.join(projectDir, ".claude"));
    assert.equal(after, before, "project root .claude/ must be untouched");
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: nested directories (skills/, agents/) are copied recursively", () => {
  const { projectDir, worktreePath } = mkTmp();
  try {
    const profile = mkProfile(projectDir, "rich", {
      "skills/a/b/c/deep.md": "deep skill",
      "agents/r1.md": "r1",
      "agents/r2.md": "r2",
    });
    applyOverlay(worktreePath, profile);
    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "skills", "a", "b", "c", "deep.md")));
    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "agents", "r1.md")));
    assert.ok(fs.existsSync(path.join(worktreePath, ".claude", "agents", "r2.md")));
  } finally {
    rmTmp(projectDir, worktreePath);
  }
});

test("applyOverlay: missing worktree directory throws (caller is responsible for creating worktree first)", () => {
  const { projectDir } = mkTmp();
  try {
    const profile = mkProfile(projectDir, "x", { "CLAUDE.md": "#\n" });
    assert.throws(() => applyOverlay("/tmp/this-path-does-not-exist-xyz", profile));
  } finally {
    rmTmp(projectDir);
  }
});
