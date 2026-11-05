/**
 * What: The entry's one-page digest (016 FR-037, FR-038) in an overlay — fetched through `getDigest` when it opens, shown with its file path. The page is Dex's own small Markdown: a `#` title, `**Label**:` sections, `- ` items; `renderDigest` blocks map to a heading, paragraphs with bold labels, and a list.
 * Not: Writes nothing, and renders no HTML from the file: text only, no `dangerouslySetInnerHTML`.
 * Deps: projectService.getDigest, lucide-react.
 */
import { FileText, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { projectService } from "../../services/projectService.js";

type Loaded = { kind: "loading" } | { kind: "none" } | { kind: "ok"; markdown: string; path: string };

/** `**Label**: rest` → bold label, plain rest; other text stays as it is. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

/** One block of the digest: separated by a blank line. */
function Block({ text }: { text: string }) {
  if (text.startsWith("# ")) {
    return <h3 style={{ margin: "0 0 10px", fontSize: "0.95rem", color: "var(--foreground)" }}>{text.slice(2)}</h3>;
  }
  const lines = text.split("\n");
  if (lines.every((l) => l.startsWith("- "))) {
    return (
      <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
        {lines.map((l) => (
          <li key={l}>{inline(l.slice(2))}</li>
        ))}
      </ul>
    );
  }
  return <p style={{ margin: "0 0 8px" }}>{inline(text)}</p>;
}

export function DigestMarkdown({ markdown }: { markdown: string }) {
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return (
    <div data-testid="digest-body" style={{ fontSize: "0.8rem", lineHeight: 1.5, color: "var(--foreground-muted)" }}>
      {blocks.map((b, i) => (
        <Block key={i} text={b} />
      ))}
    </div>
  );
}

export function DigestView({
  projectDir,
  entryId,
  onClose,
}: {
  projectDir: string;
  entryId: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    projectService
      .getDigest(projectDir, entryId)
      .then((d) => live && setLoaded(d ? { kind: "ok", ...d } : { kind: "none" }))
      .catch(() => live && setLoaded({ kind: "none" }));
    return () => {
      live = false;
    };
  }, [projectDir, entryId]);

  return (
    <div
      data-testid="digest-view"
      role="dialog"
      aria-label={`Digest of ${entryId}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "80vh",
          overflowY: "auto",
          padding: "16px 20px",
          borderRadius: "var(--radius)",
          border: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <FileText size={15} style={{ color: "var(--primary)" }} />
          <span style={{ flex: 1, fontSize: "0.75rem", fontFamily: "var(--font-mono)", color: "var(--foreground-dim)" }}>
            {loaded.kind === "ok" ? loaded.path : entryId}
          </span>
          <button
            type="button"
            data-testid="digest-close"
            onClick={onClose}
            aria-label="Close the digest"
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--foreground-muted)" }}
          >
            <X size={16} />
          </button>
        </div>
        {loaded.kind === "loading" && <div style={{ fontSize: "0.8rem" }}>Loading…</div>}
        {loaded.kind === "none" && (
          <div data-testid="digest-none" style={{ fontSize: "0.8rem", color: "var(--foreground-muted)" }}>
            No digest for {entryId} yet.
          </div>
        )}
        {loaded.kind === "ok" && <DigestMarkdown markdown={loaded.markdown} />}
      </div>
    </div>
  );
}
