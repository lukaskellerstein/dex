import { ipcMain, dialog } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTasksFile } from "../../core/parser.js";

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function registerProjectHandlers(): void {
  ipcMain.handle("project:open", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select Project Directory",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "project:list-specs",
    (_event, projectDir: string) => {
      // Look for specs in common locations
      const candidates = [
        path.join(projectDir, "specs"),
        path.join(projectDir, ".specify", "specs"),
      ];

      for (const specsRoot of candidates) {
        if (fs.existsSync(specsRoot)) {
          const entries = fs.readdirSync(specsRoot, { withFileTypes: true });
          return entries
            .filter((e) => e.isDirectory())
            .filter((e) => {
              const tasksPath = path.join(specsRoot, e.name, "tasks.md");
              return fs.existsSync(tasksPath);
            })
            .map((e) => {
              // Return relative path from project root
              return path.relative(projectDir, path.join(specsRoot, e.name));
            })
            .sort();
        }
      }

      return [];
    }
  );

  ipcMain.handle(
    "project:parse-spec",
    (_event, projectDir: string, specDir: string) => {
      return parseTasksFile(projectDir, specDir);
    }
  );

  ipcMain.handle(
    "project:read-file",
    (_event, filePath: string): string | null => {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        return null;
      }
    }
  );

  ipcMain.handle(
    "project:write-file",
    (_event, filePath: string, content: string): boolean => {
      try {
        fs.writeFileSync(filePath, content, "utf-8");
        return true;
      } catch {
        return false;
      }
    }
  );

  ipcMain.handle(
    "project:open-path",
    (_event, projectPath: string): { path: string } | { error: string } => {
      const resolved = expandTilde(projectPath);
      if (!fs.existsSync(resolved)) {
        return { error: `Directory does not exist: ${resolved}` };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { error: `Path is not a directory: ${resolved}` };
      }
      return { path: resolved };
    }
  );

  ipcMain.handle(
    "project:path-exists",
    (_event, targetPath: string): boolean => {
      try {
        const resolved = expandTilde(targetPath);
        return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
      } catch {
        return false;
      }
    }
  );

  ipcMain.handle("project:pick-folder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Select location for new project",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("project:pick-goal-file", async (_event, defaultDir: string) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      title: "Select goal file",
      defaultPath: defaultDir,
      filters: [
        { name: "Markdown", extensions: ["md", "markdown"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "project:create-project",
    (_event, parentDir: string, projectName: string): { path: string } | { error: string } => {
      const projectPath = path.join(expandTilde(parentDir), projectName);
      if (fs.existsSync(projectPath)) {
        return { error: `Directory already exists: ${projectPath}` };
      }
      try {
        fs.mkdirSync(projectPath, { recursive: true });
        return { path: projectPath };
      } catch (err) {
        return { error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  );
}
