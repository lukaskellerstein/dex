import { FileEdit } from "lucide-react";

interface EditInputProps {
  input: Record<string, unknown>;
}

export function EditInput({ input }: EditInputProps) {
  const filePath = String(input.file_path ?? input.path ?? "");
  const oldStr = String(input.old_string ?? input.old ?? "");
  const newStr = String(input.new_string ?? input.new ?? "");
  const displayPath = filePath.split("/").slice(-3).join("/");

  return (
    <div style={{ fontSize: "11px", fontFamily: "var(--font-mono)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <FileEdit size={11} color="var(--foreground-dim)" />
        <span style={{ color: "var(--foreground-muted)" }} title={filePath}>
          {displayPath}
        </span>
      </div>
      <div
        style={{
          background: "var(--background)",
        }}
      >
        {oldStr && (
          <div
            style={{
              background: "rgba(239, 68, 68, 0.08)",
              padding: "4px 8px",
              borderLeft: "3px solid rgba(239, 68, 68, 0.4)",
            }}
          >
            {oldStr
              .split("\n")
              .slice(0, 8)
              .map((line, i) => (
                <div key={i} style={{ color: "rgba(239, 68, 68, 0.8)" }}>
                  - {line}
                </div>
              ))}
            {oldStr.split("\n").length > 8 && (
              <div style={{ color: "var(--foreground-disabled)" }}>...</div>
            )}
          </div>
        )}
        {newStr && (
          <div
            style={{
              background: "rgba(34, 197, 94, 0.08)",
              padding: "4px 8px",
              borderLeft: "3px solid rgba(34, 197, 94, 0.4)",
            }}
          >
            {newStr
              .split("\n")
              .slice(0, 8)
              .map((line, i) => (
                <div key={i} style={{ color: "rgba(34, 197, 94, 0.8)" }}>
                  + {line}
                </div>
              ))}
            {newStr.split("\n").length > 8 && (
              <div style={{ color: "var(--foreground-disabled)" }}>...</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
