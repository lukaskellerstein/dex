import { CheckCircle, XCircle, AlertCircle } from "lucide-react";
import type { LoopTermination } from "../../../../core/types.js";

const REASON_CONFIG: Record<
  string,
  { label: string; heading: string; icon: React.ReactNode; color: string }
> = {
  gaps_complete: {
    heading: "All Features Implemented",
    label:
      "The loop completed successfully — all planned features were implemented.",
    icon: <CheckCircle size={28} style={{ color: "var(--status-success)" }} />,
    color: "var(--status-success)",
  },
  budget_exceeded: {
    heading: "Budget Limit Reached",
    label:
      "The loop stopped because the configured budget limit was exceeded.",
    icon: (
      <AlertCircle size={28} style={{ color: "var(--status-warning, #f59e0b)" }} />
    ),
    color: "var(--status-warning, #f59e0b)",
  },
  max_cycles_reached: {
    heading: "Max Cycles Reached",
    label:
      "The loop stopped after reaching the maximum number of configured cycles.",
    icon: (
      <AlertCircle size={28} style={{ color: "var(--status-warning, #f59e0b)" }} />
    ),
    color: "var(--status-warning, #f59e0b)",
  },
  user_abort: {
    heading: "Stopped by User",
    label: "The loop was stopped manually before completion.",
    icon: <XCircle size={28} style={{ color: "var(--foreground-muted)" }} />,
    color: "var(--foreground-muted)",
  },
  consecutive_failures: {
    heading: "Stopped After Repeated Failures",
    label:
      "The loop stopped after 3 consecutive cycles failed — likely a configuration or environment issue.",
    icon: <AlertCircle size={28} style={{ color: "var(--status-error)" }} />,
    color: "var(--status-error)",
  },
};

function StatCard({
  value,
  label,
  color,
}: {
  value: string | number;
  label: string;
  color?: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "16px 20px",
        flex: 1,
        minWidth: 120,
      }}
    >
      <div
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          fontFamily: "var(--font-mono)",
          color: color ?? "var(--foreground)",
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "0.72rem",
          color: "var(--foreground-dim)",
          marginTop: 4,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
    </div>
  );
}

interface CompletionPhaseProps {
  termination: LoopTermination;
}

export function CompletionPhase({ termination }: CompletionPhaseProps) {
  const reason = REASON_CONFIG[termination.reason] ?? REASON_CONFIG.user_abort;
  const totalFeatures =
    termination.featuresCompleted.length + termination.featuresSkipped.length;

  return (
    <div style={{ padding: "28px 32px", overflow: "auto", flex: 1, maxWidth: 640 }}>
      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "flex-start",
          marginBottom: 28,
        }}
      >
        <div style={{ flexShrink: 0, marginTop: 2 }}>{reason.icon}</div>
        <div>
          <h3
            style={{
              fontSize: "1.15rem",
              fontWeight: 600,
              color: "var(--foreground)",
              marginBottom: 4,
            }}
          >
            {reason.heading}
          </h3>
          <p
            style={{
              fontSize: "0.84rem",
              color: "var(--foreground-muted)",
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {reason.label}
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
        <StatCard value={termination.cyclesCompleted} label="Cycles" />
        <StatCard
          value={termination.featuresCompleted.length}
          label="Completed"
          color={
            termination.featuresCompleted.length > 0
              ? "var(--status-success)"
              : undefined
          }
        />
        <StatCard
          value={termination.featuresSkipped.length}
          label="Skipped"
          color={
            termination.featuresSkipped.length > 0
              ? "var(--status-error)"
              : undefined
          }
        />
        {termination.totalCostUsd > 0 && (
          <StatCard
            value={`$${termination.totalCostUsd.toFixed(2)}`}
            label="Total Cost"
          />
        )}
      </div>

      {totalFeatures > 0 && (
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            padding: "16px 20px",
            marginBottom: 24,
          }}
        >
          {termination.featuresCompleted.length > 0 && (
            <div
              style={{
                marginBottom: termination.featuresSkipped.length > 0 ? 16 : 0,
              }}
            >
              <div
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  color: "var(--status-success)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: 8,
                }}
              >
                Completed Features
              </div>
              {termination.featuresCompleted.map((f) => (
                <div
                  key={f}
                  style={{
                    fontSize: "0.82rem",
                    color: "var(--foreground)",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <CheckCircle
                    size={12}
                    style={{ color: "var(--status-success)", flexShrink: 0 }}
                  />
                  {f}
                </div>
              ))}
            </div>
          )}
          {termination.featuresSkipped.length > 0 && (
            <div>
              {termination.featuresCompleted.length > 0 && (
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    marginBottom: 12,
                  }}
                />
              )}
              <div
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  color: "var(--status-error)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: 8,
                }}
              >
                Skipped Features
              </div>
              {termination.featuresSkipped.map((f) => (
                <div
                  key={f}
                  style={{
                    fontSize: "0.82rem",
                    color: "var(--foreground-muted)",
                    padding: "4px 0",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <XCircle
                    size={12}
                    style={{ color: "var(--status-error)", flexShrink: 0 }}
                  />
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          background: "var(--primary-muted)",
          border: "1px solid rgba(124, 58, 237, 0.25)",
          borderRadius: "var(--radius-lg)",
          padding: "14px 18px",
          fontSize: "0.82rem",
          color: "var(--foreground-muted)",
          lineHeight: 1.5,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            color: "var(--foreground)",
            marginRight: 6,
          }}
        >
          Next:
        </span>
        {termination.reason === "gaps_complete"
          ? "All features are implemented. Review the code and create a PR."
          : "Review completed features and decide whether to continue with another loop."}
      </div>
    </div>
  );
}
