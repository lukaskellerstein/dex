interface Props {
  recordMode: boolean;
}

export function RecBadge({ recordMode }: Props) {
  if (!recordMode) return null;
  return (
    <div
      title="Record mode: every completed step is promoted to canonical automatically"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 6px",
        background: "rgba(239, 68, 68, 0.15)",
        border: "1px solid rgb(239, 68, 68)",
        color: "rgb(239, 68, 68)",
        borderRadius: "var(--radius)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        fontFamily: "var(--font-mono)",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "rgb(239, 68, 68)",
          animation: "rec-pulse 1.6s infinite ease-in-out",
        }}
      />
      REC
      <style>{`@keyframes rec-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
