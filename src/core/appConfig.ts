import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Global, app-wide configuration. Lives at `~/.dex/app-config.json`.
 *
 * Distinct from the project-local `<projectDir>/.dex/dex-config.json` (see
 * `dexConfig.ts`), which carries per-project choices (e.g. agent runner).
 * This file holds preferences that must be resolvable BEFORE any project is
 * opened — currently the welcome-screen defaults.
 */
export interface AppConfig {
  welcome: {
    /** Default parent directory shown in the welcome "Location" input. May contain a leading `~`. */
    defaultLocation: string;
    /**
     * Default project name shown in the welcome "Project name" input.
     * May embed `{random:N}` placeholders that are expanded to a fresh
     * base36 string of length N at read time.
     */
    defaultName: string;
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  welcome: {
    defaultLocation: "~/Projects/Temp",
    defaultName: "project-{random:8}",
  },
};

export function appConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".dex", "app-config.json");
}

/**
 * Load `~/.dex/app-config.json`.
 *
 * - If the file is missing, write the defaults to disk so the user can
 *   discover and edit it, then return the defaults.
 * - If the file is malformed or violates the schema, log a warning and
 *   return the built-in defaults. We never throw — the welcome screen
 *   must always render with *some* values.
 *
 * `homeDir` is overridable for tests; production callers omit it.
 */
export function loadAppConfig(homeDir: string = os.homedir()): AppConfig {
  const file = appConfigPath(homeDir);

  if (!fs.existsSync(file)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(DEFAULT_APP_CONFIG, null, 2) + "\n");
    } catch (err) {
      console.warn(`[dex] could not seed ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return cloneDefaults();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[dex] ${file} is not valid JSON, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    return cloneDefaults();
  }

  const validated = validate(parsed);
  if (!validated) {
    console.warn(`[dex] ${file} did not match schema, using defaults`);
    return cloneDefaults();
  }
  return validated;
}

function cloneDefaults(): AppConfig {
  return {
    welcome: { ...DEFAULT_APP_CONFIG.welcome },
  };
}

function validate(raw: unknown): AppConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const welcome = obj.welcome;
  if (!welcome || typeof welcome !== "object" || Array.isArray(welcome)) return null;
  const w = welcome as Record<string, unknown>;
  if (typeof w.defaultLocation !== "string" || w.defaultLocation.length === 0) return null;
  if (typeof w.defaultName !== "string" || w.defaultName.length === 0) return null;
  return {
    welcome: {
      defaultLocation: w.defaultLocation,
      defaultName: w.defaultName,
    },
  };
}

/**
 * Replace `{random:N}` placeholders with a fresh base36 string of length N.
 * Multiple placeholders in the same template each get an independent value.
 * Unrecognized placeholders are left untouched.
 */
export function expandNameTemplate(template: string): string {
  return template.replace(/\{random:(\d+)\}/g, (_match, lenStr: string) => {
    const len = Math.max(1, Math.min(64, Number(lenStr)));
    return randomBase36(len);
  });
}

function randomBase36(len: number): string {
  let out = "";
  while (out.length < len) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, len);
}

/**
 * Convenience helper used by the IPC layer: returns welcome-screen defaults
 * with all template placeholders already expanded. Callers get a fresh
 * random value each invocation.
 */
export function getWelcomeDefaults(homeDir?: string): { defaultLocation: string; defaultName: string } {
  const cfg = loadAppConfig(homeDir);
  return {
    defaultLocation: cfg.welcome.defaultLocation,
    defaultName: expandNameTemplate(cfg.welcome.defaultName),
  };
}
