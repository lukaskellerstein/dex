interface ToolFormattedResultProps {
  toolName: string;
  content: string | null;
}

function parseResult(content: string | null): Record<string, unknown> | null {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function ReadResult({ content }: { content: string | null }) {
  const parsed = parseResult(content);
  const file = parsed?.file as Record<string, unknown> | undefined;
  const text = String(file?.content ?? content ?? "");
  if (!text) return null;

  return (
    <pre
      style={{
        fontSize: "0.8rem",
        fontFamily: "var(--font-mono)",
        color: "var(--foreground-dim)",
        background: "var(--surface)",
        padding: "8px 12px",
        borderRadius: "var(--radius)",
        margin: 0,
        maxHeight: 300,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </pre>
  );
}

function BashResult({ content }: { content: string | null }) {
  const parsed = parseResult(content);
  const stdout = parsed ? String(parsed.stdout ?? "") : "";
  const stderr = parsed ? String(parsed.stderr ?? "") : "";
  const output = stdout || stderr || content || "";
  if (!output) return null;

  return (
    <pre
      style={{
        fontSize: "0.8rem",
        fontFamily: "var(--font-mono)",
        color: stderr && !stdout ? "var(--status-error)" : "var(--foreground-dim)",
        background: "var(--surface)",
        padding: "8px 12px",
        borderRadius: "var(--radius)",
        margin: 0,
        maxHeight: 300,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {stdout || stderr || output}
    </pre>
  );
}

function FileListResult({ content }: { content: string | null }) {
  const parsed = parseResult(content);
  const filenames = (parsed?.filenames ?? []) as string[];
  if (filenames.length === 0) return null;

  return (
    <div
      style={{
        fontSize: "0.8rem",
        fontFamily: "var(--font-mono)",
        background: "rgba(0, 0, 0, 0.2)",
        padding: "6px 10px",
        borderRadius: "var(--radius)",
        marginTop: 4,
        maxHeight: 300,
        overflow: "auto",
      }}
    >
      {filenames.map((f, i) => (
        <div
          key={i}
          style={{
            color: "var(--foreground-dim)",
            padding: "1px 0",
          }}
        >
          {f.split("/").slice(-3).join("/")}
        </div>
      ))}
      {filenames.length > 0 && (
        <div
          style={{
            color: "var(--foreground-disabled)",
            fontSize: "0.75rem",
            marginTop: 4,
          }}
        >
          {filenames.length} file{filenames.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

/** Tools whose input already shows the full content — suppress result entirely */
const SUPPRESS_RESULT = new Set(["Write", "Edit", "TodoWrite"]);

/** Tools with a formatted result renderer */
const FORMATTED_TOOLS: Record<string, React.ComponentType<{ content: string | null }>> = {
  Read: ReadResult,
  Bash: BashResult,
  Grep: FileListResult,
  Glob: FileListResult,
};

export function hasFormattedResult(toolName: string): boolean {
  return SUPPRESS_RESULT.has(toolName) || toolName in FORMATTED_TOOLS;
}

export function ToolFormattedResult({ toolName, content }: ToolFormattedResultProps) {
  if (SUPPRESS_RESULT.has(toolName)) return null;

  const Renderer = FORMATTED_TOOLS[toolName];
  if (!Renderer) return null;

  return <Renderer content={content} />;
}
