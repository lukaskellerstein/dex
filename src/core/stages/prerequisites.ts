/**
 * What: Five-step pre-cycle prerequisites check (claude_cli, specify_cli, git_init, speckit_init, github_repo) plus interactive fix paths and run-record bookkeeping. Driver emits prerequisites_started → prerequisites_check (×N) → prerequisites_completed.
 * Not: Does not decide whether to skip prereqs — that's runLoop's call. Does not extract gap-analysis decisions or any clarification logic. Inter-check ordering is explicit because speckit_init depends on specify_cli's outcome and github_repo expects git_init.
 * Deps: OrchestrationContext, runs.startAgentRun/completeAgentRun, waitForUserInput (clarification IPC), node:child_process (execSync for CLI probes).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { OrchestrationContext } from "../context.js";
import type { PrerequisiteCheck, PrerequisiteCheckName } from "../types.js";
import * as runs from "../runs.js";
import { waitForUserInput } from "../userInput.js";

// ── Local helpers (unique to prereqs; private) ──────────────

function isCommandOnPath(cmd: string): boolean {
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execSync(`${whichCmd} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getScriptType(): "sh" | "ps" {
  return process.platform === "win32" ? "ps" : "sh";
}

type CheckFinalStatus = "pass" | "fail" | "fixed";

// ── Public driver ───────────────────────────────────────────

/**
 * Runs all 5 prerequisite checks in order. Mutates `ctx.state` only via
 * `runs.*` (audit trail) — no direct state mutations. Throws on abort.
 */
export async function runPrerequisites(
  ctx: OrchestrationContext,
  runId: string,
): Promise<void> {
  const { projectDir, emit, rlog } = ctx;

  rlog.run("INFO", "runPrerequisites: starting prerequisites checks");
  emit({ type: "prerequisites_started", runId });

  const agentRunId = crypto.randomUUID();
  runs.startAgentRun(projectDir, runId, {
    agentRunId,
    runId,
    specDir: null,
    taskPhaseNumber: 0,
    taskPhaseName: "loop:prerequisites",
    step: "prerequisites",
    cycleNumber: 0,
    featureSlug: null,
    startedAt: new Date().toISOString(),
    status: "running",
  });

  emit({
    type: "step_started",
    runId,
    cycleNumber: 0,
    step: "prerequisites",
    agentRunId,
  });

  const startTime = Date.now();
  const emitCheck = (check: PrerequisiteCheck) => emit({ type: "prerequisites_check", runId, check });
  const results = new Map<PrerequisiteCheckName, CheckFinalStatus>();

  // Check ordering matters: specify_cli → speckit_init (auto-init needs the CLI),
  // git_init → github_repo (initial commit before push).
  const claudeOk = await checkClaudeCli(ctx, runId, emitCheck, results);
  if (ctx.abort.signal.aborted) return;
  const specifyOk = await checkSpecifyCli(ctx, runId, emitCheck, results);
  if (ctx.abort.signal.aborted) return;
  await checkGitInit(ctx, emitCheck, results);
  if (ctx.abort.signal.aborted) return;
  await checkSpeckitInit(ctx, emitCheck, results, specifyOk);
  if (ctx.abort.signal.aborted) return;
  await checkGithubRepo(ctx, runId, emitCheck, results);
  if (ctx.abort.signal.aborted) return;

  // suppress unused-value lint — claudeOk's pass/fail is recorded via the results map
  void claudeOk;

  // ── Block until user acknowledges any fail ────────────────
  const failed = [...results.entries()].filter(([, s]) => s === "fail");
  if (failed.length > 0) {
    const failedNames = failed.map(([name]) => name).join(", ");
    rlog.run("WARN", `runPrerequisites: ${failed.length} check(s) failed: ${failedNames}`);
    await waitForUserInput(projectDir, emit, runId, [{
      question: `${failed.length} prerequisite check(s) failed: ${failedNames}. You can continue, but the loop may not work correctly.`,
      header: "Prerequisites incomplete",
      options: [{ label: "Continue anyway", description: "Proceed to clarification despite failed checks" }],
      multiSelect: false,
    }]);
  }

  const allPassed = failed.length === 0;
  const durationMs = Date.now() - startTime;
  runs.completeAgentRun(projectDir, runId, agentRunId, {
    status: "completed",
    costUsd: 0,
    durationMs,
    inputTokens: 0,
    outputTokens: 0,
  });

  emit({
    type: "step_completed",
    runId,
    cycleNumber: 0,
    step: "prerequisites",
    agentRunId,
    costUsd: 0,
    durationMs,
  });
  emit({ type: "prerequisites_completed", runId });
  rlog.run("INFO", "runPrerequisites: completed", { durationMs, allPassed });
}

// ── Individual checks ───────────────────────────────────────

async function checkClaudeCli(
  ctx: OrchestrationContext,
  runId: string,
  emitCheck: (c: PrerequisiteCheck) => void,
  results: Map<PrerequisiteCheckName, CheckFinalStatus>,
): Promise<boolean> {
  emitCheck({ name: "claude_cli", status: "running" });
  let ok = isCommandOnPath("claude");
  if (ok) {
    ctx.rlog.run("INFO", "runPrerequisites: claude CLI found");
    emitCheck({ name: "claude_cli", status: "pass" });
    results.set("claude_cli", "pass");
    return true;
  }
  ctx.rlog.run("WARN", "runPrerequisites: claude CLI not found");
  emitCheck({ name: "claude_cli", status: "fail", message: "Claude Code CLI not found on PATH" });

  while (true) {
    if (ctx.abort.signal.aborted) return false;
    const answers = await waitForUserInput(ctx.projectDir, ctx.emit, runId, [{
      question: "Claude Code CLI is not installed or not on your PATH. Please install it and try again.",
      header: "Missing: Claude CLI",
      options: [
        { label: "I've installed it — check again", description: "Re-run the check after you've installed Claude Code" },
        { label: "Skip this check", description: "Proceed without verifying (not recommended)" },
      ],
      multiSelect: false,
    }]);
    const answer = Object.values(answers)[0];
    if (answer === "Skip this check") {
      emitCheck({ name: "claude_cli", status: "fixed", message: "Skipped by user" });
      results.set("claude_cli", "fixed");
      return false;
    }
    ok = isCommandOnPath("claude");
    if (ok) {
      emitCheck({ name: "claude_cli", status: "pass" });
      results.set("claude_cli", "pass");
      return true;
    }
    emitCheck({ name: "claude_cli", status: "fail", message: "Still not found — please check your PATH" });
  }
}

async function checkSpecifyCli(
  ctx: OrchestrationContext,
  runId: string,
  emitCheck: (c: PrerequisiteCheck) => void,
  results: Map<PrerequisiteCheckName, CheckFinalStatus>,
): Promise<boolean> {
  emitCheck({ name: "specify_cli", status: "running" });
  let ok = isCommandOnPath("specify");
  if (ok) {
    ctx.rlog.run("INFO", "runPrerequisites: specify CLI found");
    emitCheck({ name: "specify_cli", status: "pass" });
    results.set("specify_cli", "pass");
    return true;
  }
  ctx.rlog.run("WARN", "runPrerequisites: specify CLI not found");
  emitCheck({ name: "specify_cli", status: "fail", message: "Spec-Kit CLI not found on PATH" });

  while (true) {
    if (ctx.abort.signal.aborted) return false;
    const answers = await waitForUserInput(ctx.projectDir, ctx.emit, runId, [{
      question: "Spec-Kit CLI (specify) is not installed. Install it with:\n\nuv tool install specify-cli --from git+https://github.com/github/spec-kit.git\n\nThen try again.",
      header: "Missing: Spec-Kit CLI",
      options: [
        { label: "I've installed it — check again", description: "Re-run the check after you've installed spec-kit" },
        { label: "Skip this check", description: "Proceed without spec-kit (the loop will likely fail)" },
      ],
      multiSelect: false,
    }]);
    const answer = Object.values(answers)[0];
    if (answer === "Skip this check") {
      emitCheck({ name: "specify_cli", status: "fixed", message: "Skipped by user" });
      results.set("specify_cli", "fixed");
      return false;
    }
    ok = isCommandOnPath("specify");
    if (ok) {
      emitCheck({ name: "specify_cli", status: "pass" });
      results.set("specify_cli", "pass");
      return true;
    }
    emitCheck({ name: "specify_cli", status: "fail", message: "Still not found — please check your PATH" });
  }
}

async function checkGitInit(
  ctx: OrchestrationContext,
  emitCheck: (c: PrerequisiteCheck) => void,
  results: Map<PrerequisiteCheckName, CheckFinalStatus>,
): Promise<void> {
  emitCheck({ name: "git_init", status: "running" });
  const gitDir = path.join(ctx.projectDir, ".git");
  if (fs.existsSync(gitDir)) {
    ctx.rlog.run("INFO", "runPrerequisites: git repo already exists");
    emitCheck({ name: "git_init", status: "pass" });
    results.set("git_init", "pass");
    return;
  }
  ctx.rlog.run("INFO", "runPrerequisites: initializing git repo");
  try {
    execSync("git init", { cwd: ctx.projectDir, stdio: "pipe", timeout: 15_000 });
    if (fs.existsSync(gitDir)) {
      ctx.rlog.run("INFO", "runPrerequisites: git init succeeded");
      emitCheck({ name: "git_init", status: "pass" });
      results.set("git_init", "pass");
    } else {
      ctx.rlog.run("WARN", "runPrerequisites: git init ran but .git/ not found");
      emitCheck({ name: "git_init", status: "fail", message: "git init ran but .git/ directory was not created" });
      results.set("git_init", "fail");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.rlog.run("ERROR", "runPrerequisites: git init failed", { error: msg });
    emitCheck({ name: "git_init", status: "fail", message: `git init failed: ${msg}` });
    results.set("git_init", "fail");
  }
}

async function checkSpeckitInit(
  ctx: OrchestrationContext,
  emitCheck: (c: PrerequisiteCheck) => void,
  results: Map<PrerequisiteCheckName, CheckFinalStatus>,
  specifyOk: boolean,
): Promise<void> {
  emitCheck({ name: "speckit_init", status: "running" });
  const integrationJson = path.join(ctx.projectDir, ".specify", "integration.json");
  if (fs.existsSync(integrationJson)) {
    ctx.rlog.run("INFO", "runPrerequisites: spec-kit already initialized");
    emitCheck({ name: "speckit_init", status: "pass" });
    results.set("speckit_init", "pass");
    return;
  }
  if (!specifyOk) {
    ctx.rlog.run("WARN", "runPrerequisites: cannot init spec-kit — specify CLI not available");
    emitCheck({ name: "speckit_init", status: "fail", message: "Cannot initialize — specify CLI not available" });
    results.set("speckit_init", "fail");
    return;
  }
  ctx.rlog.run("INFO", "runPrerequisites: running specify init");
  try {
    const scriptType = getScriptType();
    execSync(`specify init . --force --ai claude --script ${scriptType}`, {
      cwd: ctx.projectDir,
      stdio: "pipe",
      timeout: 60_000,
    });
    if (fs.existsSync(integrationJson)) {
      ctx.rlog.run("INFO", "runPrerequisites: specify init succeeded");
      emitCheck({ name: "speckit_init", status: "pass" });
      results.set("speckit_init", "pass");
    } else {
      ctx.rlog.run("WARN", "runPrerequisites: specify init ran but integration.json not found");
      emitCheck({ name: "speckit_init", status: "fail", message: "specify init ran but .specify/integration.json was not created" });
      results.set("speckit_init", "fail");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.rlog.run("ERROR", "runPrerequisites: specify init failed", { error: msg });
    emitCheck({ name: "speckit_init", status: "fail", message: `specify init failed: ${msg}` });
    results.set("speckit_init", "fail");
  }
}

async function checkGithubRepo(
  ctx: OrchestrationContext,
  runId: string,
  emitCheck: (c: PrerequisiteCheck) => void,
  results: Map<PrerequisiteCheckName, CheckFinalStatus>,
): Promise<void> {
  emitCheck({ name: "github_repo", status: "running" });
  let hasRemote = false;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: ctx.projectDir,
      stdio: "pipe",
      timeout: 5_000,
    }).toString().trim();
    hasRemote = remote.length > 0;
  } catch {
    // No remote configured.
  }
  if (hasRemote) {
    ctx.rlog.run("INFO", "runPrerequisites: GitHub remote already configured");
    emitCheck({ name: "github_repo", status: "pass" });
    results.set("github_repo", "pass");
    return;
  }
  if (!isCommandOnPath("gh")) {
    ctx.rlog.run("INFO", "runPrerequisites: gh CLI not found, skipping GitHub repo setup");
    emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI (gh) not installed — skipped" });
    results.set("github_repo", "fixed");
    return;
  }
  let ghAuthed = false;
  try {
    execSync("gh auth status", { cwd: ctx.projectDir, stdio: "pipe", timeout: 10_000 });
    ghAuthed = true;
  } catch {
    // Not authenticated.
  }
  if (!ghAuthed) {
    ctx.rlog.run("INFO", "runPrerequisites: gh not authenticated, skipping GitHub repo setup");
    emitCheck({ name: "github_repo", status: "fixed", message: "GitHub CLI not authenticated — run 'gh auth login' to enable" });
    results.set("github_repo", "fixed");
    return;
  }

  if (ctx.abort.signal.aborted) return;
  const answers = await waitForUserInput(ctx.projectDir, ctx.emit, runId, [{
    question: "Would you like to create a GitHub repository for this project?",
    header: "GitHub Repository (optional)",
    options: [
      { label: "Yes — create a new repo", description: "Create a GitHub repository and push this project" },
      { label: "No — skip", description: "Continue without a GitHub remote" },
    ],
    multiSelect: false,
  }]);
  const answer = Object.values(answers)[0];
  if (answer === "No — skip") {
    emitCheck({ name: "github_repo", status: "fixed", message: "Skipped by user" });
    results.set("github_repo", "fixed");
    return;
  }

  if (ctx.abort.signal.aborted) return;
  const repoAnswers = await waitForUserInput(ctx.projectDir, ctx.emit, runId, [{
    question: "Enter the name for your new GitHub repository:",
    header: "Repository Name",
    options: [{ label: path.basename(ctx.projectDir), description: "Use project folder name" }],
    multiSelect: false,
  }]);
  const repoName = Object.values(repoAnswers)[0];

  ctx.rlog.run("INFO", `runPrerequisites: creating GitHub repo '${repoName}'`);
  try {
    execSync("git add -A -- ':!.dex/' && git commit -m \"Initial project setup (prerequisites)\"", {
      cwd: ctx.projectDir,
      stdio: "pipe",
      timeout: 10_000,
    });
    execSync(`gh repo create "${repoName}" --private --source . --push`, {
      cwd: ctx.projectDir,
      stdio: "pipe",
      timeout: 30_000,
    });
    ctx.rlog.run("INFO", "runPrerequisites: GitHub repo created successfully");
    emitCheck({ name: "github_repo", status: "pass" });
    results.set("github_repo", "pass");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.rlog.run("ERROR", "runPrerequisites: gh repo create failed", { error: msg });
    emitCheck({ name: "github_repo", status: "fail", message: `Failed to create repo: ${msg}` });
    results.set("github_repo", "fail");
  }
}
