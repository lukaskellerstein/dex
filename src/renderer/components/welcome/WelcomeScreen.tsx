import { useCallback, useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { projectService } from "../../services/projectService.js";

export type WelcomeNextView = "overview" | "loop-dashboard" | "loop-start";

interface WelcomeScreenProps {
  openProjectPath: (target: string) => Promise<{ path: string } | { error: string }>;
  createProject: (parent: string, name: string) => Promise<{ path: string } | { error: string }>;
  loadRunHistory: (dir: string) => Promise<boolean>;
  onComplete: (next: WelcomeNextView) => void;
}

export function WelcomeScreen({
  openProjectPath,
  createProject,
  loadRunHistory,
  onComplete,
}: WelcomeScreenProps) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [targetExists, setTargetExists] = useState(false);

  // Populate inputs from ~/.dex/app-config.json on mount.
  // The random postfix in the name template is freshly expanded each load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const defaults = await projectService.getWelcomeDefaults();
      if (cancelled) return;
      setPath((current) => current || defaults.defaultLocation);
      setName((current) => current || defaults.defaultName);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced existence check for the combined target path.
  useEffect(() => {
    const trimmedPath = path.trim();
    const trimmedName = name.trim();
    if (!trimmedPath || !trimmedName) {
      setTargetExists(false);
      return;
    }
    const target = `${trimmedPath.replace(/\/$/, "")}/${trimmedName}`;
    const id = setTimeout(async () => {
      const exists = await projectService.pathExists(target);
      setTargetExists(exists);
    }, 150);
    return () => clearTimeout(id);
  }, [path, name]);

  const handlePickFolder = useCallback(async () => {
    const folder = await projectService.pickFolder();
    if (folder) {
      setPath(folder);
      setError(null);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmedPath = path.trim();
    const trimmedName = name.trim();
    if (!trimmedPath || !trimmedName) return;
    const target = `${trimmedPath.replace(/\/$/, "")}/${trimmedName}`;

    if (targetExists) {
      const result = await openProjectPath(target);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const hasHistory = await loadRunHistory(result.path);
      onComplete(hasHistory ? "loop-dashboard" : "overview");
      return;
    }

    const result = await createProject(trimmedPath, trimmedName);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onComplete("loop-start");
  }, [path, name, targetExists, openProjectPath, createProject, loadRunHistory, onComplete]);

  const canSubmit = path.trim() !== "" && name.trim() !== "";
  const combinedPath = `${path.trim().replace(/\/$/, "")}/${name.trim()}`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        paddingTop: 120,
        gap: 16,
        color: "var(--foreground-dim)",
      }}
    >
      <span style={{ fontSize: "0.88rem" }}>
        Create a new project or open an existing one
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 440 }}>
        <div>
          <label
            style={{
              fontSize: "0.78rem",
              color: "var(--foreground-dim)",
              display: "block",
              marginBottom: 6,
            }}
          >
            Location
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              data-testid="welcome-path"
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError(null);
              }}
              placeholder="~/Projects/Temp"
              style={{
                flex: 1,
                padding: "8px 10px",
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--surface-elevated)",
                color: "var(--foreground)",
                fontSize: "0.84rem",
                fontFamily: "var(--font-mono)",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            <button
              data-testid="welcome-pick-folder"
              onClick={handlePickFolder}
              title="Pick folder"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                padding: 0,
                borderRadius: "var(--radius)",
                border: "1px solid var(--border)",
                background: "var(--surface-elevated)",
                color: "var(--foreground-muted)",
                cursor: "pointer",
              }}
            >
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
        <div>
          <label
            style={{
              fontSize: "0.78rem",
              color: "var(--foreground-dim)",
              display: "block",
              marginBottom: 6,
            }}
          >
            Project name
          </label>
          <input
            data-testid="welcome-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) handleSubmit();
            }}
            placeholder="my-awesome-project"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--radius)",
              border: `1px solid ${error ? "var(--status-error)" : "var(--border)"}`,
              background: "var(--surface-elevated)",
              color: "var(--foreground)",
              fontSize: "0.84rem",
              fontFamily: "var(--font-mono)",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        </div>
        {canSubmit && (
          <div
            style={{
              fontSize: "0.72rem",
              color: "var(--foreground-dim)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {combinedPath}
          </div>
        )}
        {error && (
          <div style={{ fontSize: "0.76rem", color: "var(--status-error)" }}>
            {error}
          </div>
        )}
        <button
          data-testid="welcome-submit"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            marginTop: 4,
            padding: "8px 16px",
            background: canSubmit ? "var(--primary)" : "var(--surface-elevated)",
            color: canSubmit ? "#fff" : "var(--foreground-disabled)",
            borderRadius: "var(--radius)",
            fontWeight: 500,
            fontSize: "0.84rem",
            cursor: canSubmit ? "pointer" : "not-allowed",
            border: "none",
          }}
        >
          {targetExists ? "Open Existing" : "New"}
        </button>
      </div>
    </div>
  );
}
