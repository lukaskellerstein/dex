/**
 * What: The permission chain Dex adds to every Claude session (research R6) — `preToolUseDecision` (the PreToolUse hook: the policy's deny → `deny` + `policy_denied`, its ask → `ask`, else `{}`; never `allow`, so the project's own deny and ask rules always run), and `makeCanUseTool` (AskUserQuestion → a held question; a policy `ask`, or a settings ask rule (`matchedAskRule` or `decisionReasonType: "rule"`) → a held tool approval; anything else → allow). `policyEnvFor` gives the decision its git probe.
 * Not: Does not build SDK options or run the session (claudeSession.ts). Does not parse the policy (policy.ts) or own the request queue (humanInput.ts).
 * Deps: policy.{decideToolUse, subjectOf}, humanInput.{askQuestions, requestToolApproval}, git.isTrackedAtHead, SDK types only.
 */

import os from "node:os";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { isTrackedAtHead } from "../git.js";
import {
  askQuestions,
  type HumanIO,
  isRecommended,
  type QuestionOptions,
  requestToolApproval,
} from "../humanInput.js";
import type { RunLogger } from "../log.js";
import { decideToolUse, type Policy, type PolicyEnv, subjectOf, type ToolCall } from "../policy.js";
import type { UserInputQuestion } from "../types.js";

export interface PermissionDeps {
  policy: Policy;
  policyEnv: PolicyEnv;
  io: HumanIO;
  agentRunId: string;
  entryId: string | null;
  /** How AskUserQuestion is answered in this stage (the session picks the mode). */
  questions: QuestionOptions;
  isAborted: () => boolean;
  rlog?: Pick<RunLogger, "agentRun">;
}

const STOPPED = "Run stopped by user";

/** The policy's view of the tree: the project, the temp folder, and a probe for tracked files. */
export function policyEnvFor(projectDir: string): PolicyEnv {
  return {
    projectDir,
    tmpDir: os.tmpdir(),
    isTrackedAtHead: (absPath) => isTrackedAtHead(projectDir, absPath),
  };
}

function hookDecision(permissionDecision: "deny" | "ask", reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
    },
  };
}

/** What the PreToolUse hook returns for one call. */
export function preToolUseDecision(
  d: PermissionDeps,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  if (d.isAborted()) return hookDecision("deny", STOPPED);
  const call: ToolCall = { toolName, input: toolInput };
  const decision = decideToolUse(d.policy, call, d.policyEnv);
  if (decision.kind === "deny") {
    const subject = subjectOf(call, d.policyEnv.projectDir);
    d.io.emit({
      type: "policy_denied",
      runId: d.io.runId,
      agentRunId: d.agentRunId,
      toolName,
      subject,
      reason: decision.reason,
      rule: decision.rule,
    });
    d.rlog?.agentRun("WARN", `policy: denied ${toolName} (${decision.rule}) — ${decision.reason}`, {
      subject,
    });
    return hookDecision("deny", decision.reason);
  }
  if (decision.kind === "ask") return hookDecision("ask", decision.reason);
  return {};
}

type CanUseToolOptions = Parameters<CanUseTool>[2];

/**
 * Why a settings ask rule forced this call to canUseTool, or null when none did.
 * `matchedAskRule` is set only when the ask also carries the tool's own reason.
 * A plain rule-forced ask arrives as `decisionReasonType: "rule"`, a field the
 * SDK forwards from the CLI but does not declare (measured on 0.3.318, T067).
 */
function settingsAskReason(options: CanUseToolOptions | undefined): string | null {
  const rule = options?.matchedAskRule;
  if (rule) {
    const content = rule.ruleContent ? `(${rule.ruleContent})` : "";
    return `${rule.source} ask rule ${rule.toolName}${content}`;
  }
  const reasonType = (options as { decisionReasonType?: unknown } | undefined)?.decisionReasonType;
  return reasonType === "rule" ? "a settings ask rule" : null;
}

/** canUseTool for every Dex session: questions, approvals, else allow. */
export function makeCanUseTool(d: PermissionDeps): CanUseTool {
  return async (toolName, input, options) => {
    if (toolName === "AskUserQuestion") return answerQuestions(d, input);
    const call: ToolCall = { toolName, input };
    const decision = decideToolUse(d.policy, call, d.policyEnv);
    // The hook denies first; this keeps a deny a deny if the hook did not run.
    if (decision.kind === "deny") return { behavior: "deny", message: decision.reason };
    const settingsReason = settingsAskReason(options);
    if (decision.kind !== "ask" && !settingsReason)
      return { behavior: "allow", updatedInput: input };
    const answer = await requestToolApproval(d.io, d.entryId, {
      toolName,
      subject: subjectOf(call, d.policyEnv.projectDir),
      input,
      source: decision.kind === "ask" ? "policy" : "settings",
      reason: decision.kind === "ask" ? decision.reason : (settingsReason ?? undefined),
    });
    const verdict = answer.decision === "approve" ? "approved" : "denied";
    d.rlog?.agentRun("INFO", `canUseTool: ${toolName} ${verdict} by the human`);
    return answer.decision === "approve"
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: answer.message ?? "Denied by the human" };
  };
}

function toQuestions(raw: Array<Record<string, unknown>>): UserInputQuestion[] {
  return raw.map((q) => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? ""),
    options: ((q.options ?? []) as Array<Record<string, unknown>>).map((o) => ({
      label: String(o.label ?? ""),
      description: String(o.description ?? ""),
      recommended: isRecommended(String(o.label ?? "")),
    })),
    multiSelect: Boolean(q.multiSelect),
  }));
}

/** AskUserQuestion: answered by the stage's question mode (research R7); no recommended option means wait. */
async function answerQuestions(
  d: PermissionDeps,
  input: Record<string, unknown>,
): Promise<PermissionResult> {
  const rawQuestions = (input.questions ?? []) as Array<Record<string, unknown>>;
  const answers = await askQuestions(d.io, d.entryId, toQuestions(rawQuestions), d.questions);
  d.rlog?.agentRun("INFO", `canUseTool: questions answered (${d.questions.mode})`, { answers });
  return { behavior: "allow", updatedInput: { questions: rawQuestions, answers } };
}
