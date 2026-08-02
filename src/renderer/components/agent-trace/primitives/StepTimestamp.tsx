interface StepTimestampProps {
  timestamp?: string;
  delta?: string;
}

/**
 * Right-aligned timestamp pill with optional delta-from-previous-step indicator.
 * Used in every AgentStepItem header.
 */
export function StepTimestamp({ timestamp, delta }: StepTimestampProps) {
  if (!timestamp) return null;
  return (
    <span
      style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: "0.7rem",
        fontFamily: "var(--font-mono)",
        color: "var(--foreground-dim)",
        flexShrink: 0,
      }}
    >
      <span>{timestamp}</span>
      {delta && <span style={{ color: "var(--primary)", opacity: 0.8 }}>{delta}</span>}
    </span>
  );
}
