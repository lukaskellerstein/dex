/**
 * What: Typed wrapper over window.dexAPI project + appConfig surface — openProject, listSpecs, parseSpec, readFile/writeFile, pickFolder, pickGoalFile, createProject, openProjectPath, pathExists, getWelcomeDefaults.
 * Not: Does not own project state — that lives in useProject. Does not handle history/runs reads — that's historyService.
 * Deps: window.dexAPI project methods, TaskPhase from core/types.
 */
import type { TaskPhase } from "../../core/types.js";

export type ProjectErrorCode =
  | "STATE_LOCK_HELD"
  | "DEX_CONFIG_PARSE_ERROR"
  | "DEX_CONFIG_INVALID"
  | "MANIFEST_NOT_FOUND"
  | "MOCK_CONFIG_PARSE_ERROR"
  | "MOCK_CONFIG_INVALID"
  | "MOCK_CONFIG_MISSING_ENTRY"
  | "MOCK_CONFIG_INVALID_PATH"
  | "UNKNOWN_AGENT"
  | "FILE_IO_ERROR"
  | "PROJECT_FAILURE";

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;

  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
  }
}

function mapToProjectError(err: unknown): ProjectError {
  if (err instanceof ProjectError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (/state lock held|another dex instance/i.test(message)) {
    return new ProjectError("STATE_LOCK_HELD", message);
  }
  if (/dex-config.*parse|DexConfigParseError/i.test(message)) {
    return new ProjectError("DEX_CONFIG_PARSE_ERROR", message);
  }
  if (/dex-config.*invalid|DexConfigInvalidError/i.test(message)) {
    return new ProjectError("DEX_CONFIG_INVALID", message);
  }
  if (/manifest not found/i.test(message)) {
    return new ProjectError("MANIFEST_NOT_FOUND", message);
  }
  if (/MockConfigParseError/i.test(message)) {
    return new ProjectError("MOCK_CONFIG_PARSE_ERROR", message);
  }
  if (/MockConfigInvalidError|MockConfigInvalidPathError/i.test(message)) {
    return /Path/i.test(message)
      ? new ProjectError("MOCK_CONFIG_INVALID_PATH", message)
      : new ProjectError("MOCK_CONFIG_INVALID", message);
  }
  if (/MockConfigMissingEntryError/i.test(message)) {
    return new ProjectError("MOCK_CONFIG_MISSING_ENTRY", message);
  }
  if (/UnknownAgentError/i.test(message)) {
    return new ProjectError("UNKNOWN_AGENT", message);
  }
  if (/ENOENT|EACCES|EISDIR|file.*not.*exist/i.test(message)) {
    return new ProjectError("FILE_IO_ERROR", message);
  }
  return new ProjectError("PROJECT_FAILURE", message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    throw mapToProjectError(err);
  }
}

export const projectService = {
  openProject(): Promise<string | null> {
    return call(() => window.dexAPI.openProject());
  },

  listSpecs(dir: string): Promise<string[]> {
    return call(() => window.dexAPI.listSpecs(dir));
  },

  parseSpec(dir: string, spec: string): Promise<TaskPhase[]> {
    return call(() => window.dexAPI.parseSpec(dir, spec));
  },

  readFile(filePath: string): Promise<string | null> {
    return call(() => window.dexAPI.readFile(filePath));
  },

  writeFile(filePath: string, content: string): Promise<boolean> {
    return call(() => window.dexAPI.writeFile(filePath, content));
  },

  pickFolder(): Promise<string | null> {
    return call(() => window.dexAPI.pickFolder());
  },

  pickGoalFile(defaultDir: string): Promise<string | null> {
    return call(() => window.dexAPI.pickGoalFile(defaultDir));
  },

  createProject(
    parentDir: string,
    name: string,
  ): Promise<{ path: string } | { error: string }> {
    return call(() => window.dexAPI.createProject(parentDir, name));
  },

  openProjectPath(
    projectPath: string,
  ): Promise<{ path: string } | { error: string }> {
    return call(() => window.dexAPI.openProjectPath(projectPath));
  },

  pathExists(targetPath: string): Promise<boolean> {
    return call(() => window.dexAPI.pathExists(targetPath));
  },

  getWelcomeDefaults(): Promise<{ defaultLocation: string; defaultName: string }> {
    return call(() => window.dexAPI.getWelcomeDefaults());
  },
};
