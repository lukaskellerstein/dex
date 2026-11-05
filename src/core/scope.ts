/**
 * What: Per-stage write scopes (research R9, contracts/policy-json.md § decideToolUse). `stageScope` builds one per stage: the tests stage may write only test files, test-support files and its spec folder (amend mode: the amended file and the spec folder); implement and verify may not touch the entry's frozen test set or its acceptance record, and verify may write only its tasks.md. `scopeDecision` is the pure check `decideToolUse` runs right after the deny rules: a write to a protected path, or a Bash `rm`/`mv`/`git rm`/`git mv`/`unlink`/`>` that names one, or a write outside `writeOnly`, is denied with rule `scope`.
 * Not: Not a sandbox: the Bash check is a guardrail against mistakes (015's stance), and the post-stage diff is the backstop. Reads no file.
 * Deps: node:path; acceptance.frozenTestSet; types from policy and queue.
 */

import path from "node:path";
import { type AcceptanceRecord, frozenTestSet } from "./acceptance.js";
import type { Policy, PolicyDecision, PolicyEnv, ToolCall } from "./policy.js";
import type { ResolvedEntry, StageName } from "./queue.js";

/** What one stage may write (data-model.md § Stage scope). */
export interface StageScope {
  entryId: string;
  stage: StageName;
  /** Project-relative globs; a write tool outside them is denied. Null: the policy's write roots decide. */
  writeOnly: string[] | null;
  /** Project-relative paths; any edit, move or delete is denied. */
  protect: string[];
}

/** The scope of `stage` for `entry` (R9), or null for a stage with none. */
export function stageScope(
  policy: Policy,
  entry: ResolvedEntry,
  stage: StageName,
  record: AcceptanceRecord | null,
  amendFile: string | null = null,
): StageScope | null {
  const specGlob = `${entry.specDir}/**`;
  const frozen = frozenTestSet(entry, record);
  const base = { entryId: entry.id, stage };
  switch (stage) {
    case "tests":
      return {
        ...base,
        writeOnly: amendFile
          ? [amendFile, specGlob]
          : [...policy.testGlobs, ...policy.testSupport, specGlob],
        protect: [],
      };
    case "implement":
      return { ...base, writeOnly: null, protect: frozen };
    case "verify":
      return { ...base, writeOnly: [`${entry.specDir}/tasks.md`], protect: frozen };
    default:
      return null;
  }
}

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const DESTRUCTIVE = /^(rm|mv|unlink)$/;
const unquote = (t: string) => t.replace(/^["']|["']$/g, "");

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The protected paths a Bash command names after a destructive verb or a `>` redirect. */
function bashTargets(command: string, env: PolicyEnv): string[] {
  const out: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    for (const m of segment.matchAll(/>{1,2}\s*([^\s;&|]+)/g)) out.push(unquote(m[1]));
    const tokens = segment
      .replace(/>{1,2}\s*[^\s;&|]+/g, " ")
      .trim()
      .split(/\s+/)
      .map(unquote);
    const verb = tokens[0] === "git" ? tokens[1] : tokens[0];
    const args = tokens.slice(tokens[0] === "git" ? 2 : 1);
    const destructive =
      tokens[0] === "git" ? verb === "rm" || verb === "mv" : DESTRUCTIVE.test(verb ?? "");
    if (destructive) out.push(...args.filter((a) => !a.startsWith("-")));
  }
  return out.map((t) => path.resolve(env.projectDir, t));
}

function protectedHit(scope: StageScope, targets: string[], env: PolicyEnv): string | null {
  const shielded = new Set(scope.protect.map((p) => path.resolve(env.projectDir, p)));
  const hit = targets.find((t) => shielded.has(t));
  return hit ? path.relative(env.projectDir, hit) : null;
}

function writeTarget(call: ToolCall, projectDir: string): string | null {
  const p = call.input.file_path ?? call.input.notebook_path;
  return typeof p === "string" ? path.resolve(projectDir, p) : null;
}

/** The scope's verdict on one call: a `scope` deny, or null (the rest of `decideToolUse` decides). */
export function scopeDecision(
  scope: StageScope | undefined,
  call: ToolCall,
  env: PolicyEnv,
): PolicyDecision | null {
  if (!scope) return null;
  const isWrite = WRITE_TOOLS.has(call.toolName);
  const target = isWrite ? writeTarget(call, env.projectDir) : null;
  const named =
    call.toolName === "Bash" && typeof call.input.command === "string"
      ? bashTargets(call.input.command, env)
      : target
        ? [target]
        : [];
  const hit = protectedHit(scope, named, env);
  if (hit) {
    return {
      kind: "deny",
      rule: "scope",
      reason: `${hit} is a frozen acceptance test of ${scope.entryId}; ask for a test amendment instead`,
    };
  }
  if (!target || !scope.writeOnly || isInside(env.tmpDir, target)) return null;
  const rel = path.relative(env.projectDir, target);
  if (!rel.startsWith("..") && scope.writeOnly.some((g) => path.matchesGlob(rel, g))) return null;
  return {
    kind: "deny",
    rule: "scope",
    reason: `the ${scope.stage} stage may write only ${scope.writeOnly.join(", ")}`,
  };
}
