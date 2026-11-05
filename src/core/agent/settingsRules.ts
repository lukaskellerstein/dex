/**
 * What: The Bash `permissions.ask` rules of the settings files a session loads, and a matcher that checks each part of a compound command against them (research R6, compound commands). The SDK reports an ask rule on one part of `a && b` the same way as no rule at all, so Dex finds it itself.
 * Not: Does not decide allow or deny, and reads no allow or deny rules — Claude Code applies those. Covers `&&`, `||`, `;`, `|` and new lines; a command hidden in `$(…)` or `bash -c` is not split.
 * Deps: node fs, os, path only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SettingsAskRule {
  source: "userSettings" | "projectSettings" | "localSettings";
  /** What is inside `Bash(…)`; null for a bare `Bash` rule, which asks for every command. */
  content: string | null;
}

const SOURCE_FILES = {
  user: {
    source: "userSettings",
    file: (_dir: string, home: string) => path.join(home, ".claude", "settings.json"),
  },
  project: {
    source: "projectSettings",
    file: (dir: string) => path.join(dir, ".claude", "settings.json"),
  },
  local: {
    source: "localSettings",
    file: (dir: string) => path.join(dir, ".claude", "settings.local.json"),
  },
} as const;

function askList(file: string): string[] {
  try {
    const ask = JSON.parse(fs.readFileSync(file, "utf-8"))?.permissions?.ask;
    return Array.isArray(ask) ? ask.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** The Bash ask rules of the given setting sources, in source order. An unreadable file has none. */
export function loadSettingsAskRules(
  projectDir: string,
  sources: readonly string[],
  home: string = os.homedir(),
): SettingsAskRule[] {
  const rules: SettingsAskRule[] = [];
  for (const name of sources) {
    const entry = SOURCE_FILES[name as keyof typeof SOURCE_FILES];
    if (!entry) continue;
    for (const raw of askList(entry.file(projectDir, home))) {
      const m = /^Bash(?:\((.*)\))?$/s.exec(raw.trim());
      if (m) rules.push({ source: entry.source, content: m[1] ?? null });
    }
  }
  return rules;
}

function ruleRegex(content: string): RegExp {
  // `git push:*` and `git push *` both match `git push` alone and `git push <anything>`.
  const prefix = /^(.*?)(?::\*| \*)$/s.exec(content);
  const toPattern = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return prefix
    ? new RegExp(`^${toPattern(prefix[1])}( .*)?$`, "s")
    : new RegExp(`^${toPattern(content)}$`, "s");
}

function commandParts(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().replace(/^[({]\s*/, ""))
    .filter(Boolean);
}

/** The first rule that matches any part of the command, or null. */
export function matchSettingsAsk(
  rules: SettingsAskRule[],
  command: string,
): SettingsAskRule | null {
  const parts = commandParts(command);
  for (const rule of rules) {
    if (rule.content === null) return rule;
    const regex = ruleRegex(rule.content);
    if (parts.some((part) => regex.test(part))) return rule;
  }
  return null;
}
