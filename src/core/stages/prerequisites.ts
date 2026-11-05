/**
 * What: The prerequisites step before the loop, in two forms (research R12). A new project: five checks (claude_cli, specify_cli, git_init, speckit_init, github_repo) with interactive fix paths. An existing project: `checkExistingProject`, check-only — the same CLIs, a git repository, `.specify/` whose `common.sh` knows `SPECIFY_FEATURE_DIRECTORY`, and Claude Code's trust state for the folder as information; it returns the failures and fixes nothing. Both emit prerequisites_started → prerequisites_check (×N) → prerequisites_completed and keep the run record.
 * Not: Does not decide whether to skip prereqs — that's runLoop's call. Does not pause the run — the loop turns check-only failures into a pause. Never runs `git init`, `specify init` or `gh repo create` for an existing project. Inter-check ordering is explicit because speckit_init depends on specify_cli's outcome and github_repo expects git_init.
 * Deps: OrchestrationContext, runs.startAgentRun/completeAgentRun, humanInput.askQuestions, node:child_process (execSync for CLI probes).
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrchestrationContext } from "../context.js";
import { askQuestions } from "../humanInput.js";
import * as runs from "../runs.js";
import type { PrerequisiteCheck, PrerequisiteCheckName } from "../types.js";

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

/**
 * Which flag this spec-kit build uses to select the coding agent.
 *
 * spec-kit 0.14 renamed `--ai` to `--integration`. Passing the wrong one makes
 * `specify init` exit non-zero with "No such option", which fails the
 * speckit_init check — and a failed check blocks the whole run behind the
 * "Continue anyway" prompt in runPrerequisites. Probing `--help` keeps both the
 * current CLI and pre-0.14 installs working.
 *
 * Defaults to `--integration` when the probe yields nothing useful: an unknown
 * future build is likelier to resemble the current CLI than the retired one.
 */
function detectSpecifyAgentFlag(): "--integration" | "--ai" {
  try {
    const help = execSync("specify init --help", {
      stdio: "pipe",
      timeout: 15_000,
      encoding: "utf-8",
    });
    if (help.includes("--integration")) return "--integration";
    if (help.includes("--ai")) return "--ai";
  } catch {
    // Probe failed (CLI missing, or --help itself errored). Fall through.
  }
  return "--integration";
}

type CheckFinalStatus = "pass" | "fail" | "fixed";

// ── Public driver ───────────────────────────────────────────

/**
 * Runs all 5 prerequisite checks in order. Mutates `ctx.state` only via
 * `runs.*` (audit trail) — no direct state mutations. Throws on abort.
 */
export async function runPrerequisites(ctx: OrchestrationContext, runId: string): Promise<void> {
  const { projectDir, emit, rlog } = ctx;
  const step = beginPrerequisites(ctx, runId);
  const { emitCheck } = step;
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
    await askQuestions({ projectDir: projectDir, emit: emit, runId }, null, [
      {
        question: `${failed.length} prerequisite check(s) failed: ${failedNames}. You can continue, but the loop may not work correctly.`,
        header: "Prerequisites incomplete",
        options: [
          {
            label: "Continue anyway",
            description: "Proceed to clarification despite failed checks",
          },
        ],
        multiSelect: false,
      },
    ]);
  }

  endPrerequisites(ctx, runId, step, failed.length === 0);
}

interface PrerequisitesStep {
  agentRunId: string;
  startTime: number;
  emitCheck: (c: PrerequisiteCheck) => void;
}

/** prerequisites_started, the run record's agent run, and step_started. */
function beginPrerequisites(ctx: OrchestrationContext, runId: string): PrerequisitesStep {
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
  emit({ type: "step_started", runId, cycleNumber: 0, step: "prerequisites", agentRunId });
  const emitCheck = (check: PrerequisiteCheck) => emit({ type: "prerequisites_check", runId, check });
  return { agentRunId, startTime: Date.now(), emitCheck };
}

/** The run record's agent run, step_completed and prerequisites_completed. */
function endPrerequisites(ctx: OrchestrationContext, runId: string, step: PrerequisitesStep, allPassed: boolean): void {
  const { projectDir, emit, rlog } = ctx;
  const durationMs = Date.now() - step.startTime;
  runs.completeAgentRun(projectDir, runId, step.agentRunId, {
    status: "completed",
    costUsd: 0,
    durationMs,
    inputTokens: 0,
    outputTokens: 0,
  });
  emit({ type: "step_completed", runId, cycleNumber: 0, step: "prerequisites", agentRunId: step.agentRunId, costUsd: 0, durationMs });
  emit({ type: "prerequisites_completed", runId });
  rlog.run("INFO", "runPrerequisites: completed", { durationMs, allPassed });
}

// ── Existing project: check only ────────────────────────────

function isGitRepo(projectDir: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: projectDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Why `.specify/` cannot take SPECIFY_FEATURE_DIRECTORY (research R5), or null when it can. */
function speckitProblem(projectDir: string): string | null {
  if (!fs.existsSync(path.join(projectDir, ".specify"))) return ".specify/ is missing — run `specify init` in the project";
  const common = path.join(projectDir, ".specify", "scripts", "bash", "common.sh");
  if (!fs.existsSync(common)) return ".specify/scripts/bash/common.sh is missing";
  if (!fs.readFileSync(common, "utf-8").includes("SPECIFY_FEATURE_DIRECTORY")) {
    return ".specify/scripts/bash/common.sh does not know SPECIFY_FEATURE_DIRECTORY — upgrade spec-kit";
  }
  return null;
}

/**
 * Whether Claude Code's folder trust dialog was accepted for this project.
 * Reads one field of `~/.claude.json`; nothing else in that file is used or logged.
 */
function trustState(projectDir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf-8"));
    const accepted = raw?.projects?.[projectDir]?.hasTrustDialogAccepted;
    if (accepted === true) return "the folder trust dialog is accepted";
    return "the folder trust dialog was not accepted yet (open the folder once in Claude Code)";
  } catch {
    return "folder trust unknown (no readable ~/.claude.json)";
  }
}

/**
 * Check-only prerequisites for an existing project (research R12). Returns one
 * line per failed check; empty when all pass. Fixes nothing and asks nothing.
 */
export async function checkExistingProject(ctx: OrchestrationContext, runId: string): Promise<string[]> {
  const { projectDir } = ctx;
  const step = beginPrerequisites(ctx, runId);
  const failures: string[] = [];
  const check = (name: PrerequisiteCheckName, problem: string | null, okMessage?: string) => {
    if (problem) failures.push(problem);
    step.emitCheck(problem ? { name, status: "fail", message: problem } : { name, status: "pass", message: okMessage });
  };
  check("claude_cli", isCommandOnPath("claude") ? null : "Claude Code CLI (`claude`) is not on PATH", trustState(projectDir));
  check("specify_cli", isCommandOnPath("specify") ? null : "spec-kit CLI (`specify`) is not on PATH");
  check("git_init", isGitRepo(projectDir) ? null : `${projectDir} is not a git repository`);
  check("speckit_init", speckitProblem(projectDir));
  if (failures.length > 0) ctx.rlog.run("WARN", `checkExistingProject: ${failures.length} check(s) failed`, { failures });
  endPrerequisites(ctx, runId, step, failures.length === 0);
  return failures;
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
    const answers = await askQuestions({ projectDir: ctx.projectDir, emit: ctx.emit, runId }, null, [
      {
        question:
          "Claude Code CLI is not installed or not on your PATH. Please install it and try again.",
        header: "Missing: Claude CLI",
        options: [
          {
            label: "I've installed it — check again",
            description: "Re-run the check after you've installed Claude Code",
          },
          { label: "Skip this check", description: "Proceed without verifying (not recommended)" },
        ],
        multiSelect: false,
      },
    ]);
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
    emitCheck({
      name: "claude_cli",
      status: "fail",
      message: "Still not found — please check your PATH",
    });
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
    const answers = await askQuestions({ projectDir: ctx.projectDir, emit: ctx.emit, runId }, null, [
      {
        question:
          "Spec-Kit CLI (specify) is not installed. Install it with:\n\nuv tool install specify-cli --from git+https://github.com/github/spec-kit.git\n\nThen try again.",
        header: "Missing: Spec-Kit CLI",
        options: [
          {
            label: "I've installed it — check again",
            description: "Re-run the check after you've installed spec-kit",
          },
          {
            label: "Skip this check",
            description: "Proceed without spec-kit (the loop will likely fail)",
          },
        ],
        multiSelect: false,
      },
    ]);
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
    emitCheck({
      name: "specify_cli",
      status: "fail",
      message: "Still not found — please check your PATH",
    });
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
      emitCheck({
        name: "git_init",
        status: "fail",
        message: "git init ran but .git/ directory was not created",
      });
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
    emitCheck({
      name: "speckit_init",
      status: "fail",
      message: "Cannot initialize — specify CLI not available",
    });
    results.set("speckit_init", "fail");
    return;
  }
  const agentFlag = detectSpecifyAgentFlag();
  ctx.rlog.run("INFO", "runPrerequisites: running specify init", { agentFlag });
  try {
    const scriptType = getScriptType();
    execSync(`specify init . --force ${agentFlag} claude --script ${scriptType}`, {
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
      emitCheck({
        name: "speckit_init",
        status: "fail",
        message: "specify init ran but .specify/integration.json was not created",
      });
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
    })
      .toString()
      .trim();
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
    emitCheck({
      name: "github_repo",
      status: "fixed",
      message: "GitHub CLI (gh) not installed — skipped",
    });
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
    emitCheck({
      name: "github_repo",
      status: "fixed",
      message: "GitHub CLI not authenticated — run 'gh auth login' to enable",
    });
    results.set("github_repo", "fixed");
    return;
  }

  if (ctx.abort.signal.aborted) return;
  const answers = await askQuestions({ projectDir: ctx.projectDir, emit: ctx.emit, runId }, null, [
    {
      question: "Would you like to create a GitHub repository for this project?",
      header: "GitHub Repository (optional)",
      options: [
        {
          label: "Yes — create a new repo",
          description: "Create a GitHub repository and push this project",
        },
        { label: "No — skip", description: "Continue without a GitHub remote" },
      ],
      multiSelect: false,
    },
  ]);
  const answer = Object.values(answers)[0];
  if (answer === "No — skip") {
    emitCheck({ name: "github_repo", status: "fixed", message: "Skipped by user" });
    results.set("github_repo", "fixed");
    return;
  }

  if (ctx.abort.signal.aborted) return;
  const repoAnswers = await askQuestions({ projectDir: ctx.projectDir, emit: ctx.emit, runId }, null, [
    {
      question: "Enter the name for your new GitHub repository:",
      header: "Repository Name",
      options: [{ label: path.basename(ctx.projectDir), description: "Use project folder name" }],
      multiSelect: false,
    },
  ]);
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
