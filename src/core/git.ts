import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

function exec(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf-8" }).trim();
}

export function getCurrentBranch(projectDir: string): string {
  return exec("git rev-parse --abbrev-ref HEAD", projectDir);
}

export function getHeadSha(projectDir: string): string {
  return exec("git rev-parse HEAD", projectDir);
}

export function countCommitsBetween(projectDir: string, fromSha: string, toSha: string): number {
  const count = exec(`git rev-list --count ${fromSha}..${toSha}`, projectDir);
  return parseInt(count, 10) || 0;
}

export function getCommittedFileContent(projectDir: string, ref: string, filePath: string): string | null {
  try {
    return exec(`git show ${ref}:${filePath}`, projectDir);
  } catch {
    return null;
  }
}

// commitCheckpoint moved to src/core/checkpoints/commit.ts as part of 011-A0.

export function createBranch(
  projectDir: string,
  mode: "plan" | "build" | "loop"
): string {
  const date = new Date().toISOString().slice(0, 10);
  const shortId = crypto.randomUUID().slice(0, 6);
  const branchName = `dex/${date}-${shortId}`;

  exec(`git checkout -b ${branchName}`, projectDir);
  return branchName;
}

export function createPullRequest(
  projectDir: string,
  branchName: string,
  baseBranch: string,
  mode: "plan" | "build" | "loop",
  phasesCompleted: number,
  totalCost: number,
  totalDurationMs: number
): string | null {
  // Push the branch to remote
  try {
    exec(`git push -u origin ${branchName}`, projectDir);
  } catch {
    return null;
  }

  // Gather commit log for the PR body
  const commitLog = exec(
    `git log ${baseBranch}..${branchName} --pretty=format:"- %s" --reverse`,
    projectDir
  );

  const diffStat = exec(
    `git diff --stat ${baseBranch}..${branchName}`,
    projectDir
  );

  const durationMin = (totalDurationMs / 60_000).toFixed(1);
  const costStr = totalCost > 0 ? `$${totalCost.toFixed(2)}` : "n/a";

  const title = `Dex ${mode}: ${phasesCompleted} phase${phasesCompleted === 1 ? "" : "s"} completed`;

  const body = `## Summary

Automated ${mode} run by Dex orchestrator.

- **Mode**: ${mode}
- **Phases completed**: ${phasesCompleted}
- **Duration**: ${durationMin} min
- **Cost**: ${costStr}

## Commits

${commitLog || "_No commits were made._"}

## Diff stats

\`\`\`
${diffStat || "No changes."}
\`\`\`
`;

  // Write body to a temp file to avoid shell escaping issues
  const bodyFile = path.join(os.tmpdir(), `dex-pr-body-${crypto.randomUUID()}.md`);
  try {
    fs.writeFileSync(bodyFile, body, "utf-8");
    const prUrl = exec(
      `gh pr create --base ${baseBranch} --head ${branchName} --title "${title}" --body-file "${bodyFile}"`,
      projectDir
    );
    return prUrl;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
  }
}

// ── Loop-specific PR (T021) ──

export function createLoopPullRequest(
  projectDir: string,
  branchName: string,
  baseBranch: string,
  terminationReason: string,
  cyclesCompleted: number,
  featuresCompleted: string[],
  featuresSkipped: string[],
  totalCost: number,
  totalDurationMs: number
): string | null {
  try {
    exec(`git push -u origin ${branchName}`, projectDir);
  } catch {
    return null;
  }

  const commitLog = exec(
    `git log ${baseBranch}..${branchName} --pretty=format:"- %s" --reverse`,
    projectDir
  );

  const diffStat = exec(
    `git diff --stat ${baseBranch}..${branchName}`,
    projectDir
  );

  const durationMin = (totalDurationMs / 60_000).toFixed(1);
  const costStr = totalCost > 0 ? `$${totalCost.toFixed(2)}` : "n/a";

  const title = `Dex loop: ${featuresCompleted.length} feature${featuresCompleted.length === 1 ? "" : "s"} completed`;

  const completedList = featuresCompleted.length > 0
    ? featuresCompleted.map((f) => `  - ${f}`).join("\n")
    : "  _none_";
  const skippedList = featuresSkipped.length > 0
    ? featuresSkipped.map((f) => `  - ${f}`).join("\n")
    : "  _none_";

  const body = `## Summary

Autonomous loop run by Dex orchestrator.

- **Termination reason**: ${terminationReason}
- **Cycles completed**: ${cyclesCompleted}
- **Duration**: ${durationMin} min
- **Cost**: ${costStr}

## Features completed

${completedList}

## Features skipped

${skippedList}

## Commits

${commitLog || "_No commits were made._"}

## Diff stats

\`\`\`
${diffStat || "No changes."}
\`\`\`
`;

  const bodyFile = path.join(os.tmpdir(), `dex-pr-body-${crypto.randomUUID()}.md`);
  try {
    fs.writeFileSync(bodyFile, body, "utf-8");
    const prUrl = exec(
      `gh pr create --base ${baseBranch} --head ${branchName} --title "${title}" --body-file "${bodyFile}"`,
      projectDir
    );
    return prUrl;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
  }
}
