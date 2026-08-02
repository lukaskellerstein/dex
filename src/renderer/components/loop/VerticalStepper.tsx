import { Check, ExternalLink, Loader, Pause, X } from "lucide-react";
import { useState } from "react";

export type StepStatus = "pending" | "active" | "completed" | "skipped" | "failed" | "paused";

export interface StepItem {
  id: string;
  title: string;
  description?: string;
  status: StepStatus;
  /** Right-side metadata like cost/duration */
  meta?: React.ReactNode;
  /** Clickable to view details/trace */
  onClick?: () => void;
  /** Expandable nested content */
  children?: React.ReactNode;
}

function StepCircle({ status }: { status: StepStatus }) {
  const size = 28;

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "all 0.25s",
  };

  switch (status) {
    case "completed":
      return (
        <div
          style={{
            ...baseStyle,
            background: "var(--status-success)",
            color: "#fff",
          }}
        >
          <Check size={15} strokeWidth={2.5} />
        </div>
      );
    case "active":
      return (
        <div
          style={{
            ...baseStyle,
            background: "color-mix(in srgb, var(--status-info) 12%, var(--surface-elevated))",
            border: "2.5px solid var(--status-info)",
            color: "var(--status-info)",
            boxShadow: "0 0 0 4px color-mix(in srgb, var(--status-info) 10%, transparent)",
            position: "relative",
          }}
        >
          <Loader size={13} style={{ animation: "spin 1.5s linear infinite" }} />
          <div
            style={{
              position: "absolute",
              inset: -5,
              borderRadius: "50%",
              border: "2px solid var(--status-info)",
              opacity: 0.2,
              animation: "pulse-ring 2s ease-out infinite",
            }}
          />
        </div>
      );
    case "paused":
      return (
        <div
          style={{
            ...baseStyle,
            background:
              "color-mix(in srgb, var(--status-warning, #f59e0b) 15%, var(--surface-elevated))",
            border: "2.5px solid var(--status-warning, #f59e0b)",
            color: "var(--status-warning, #f59e0b)",
          }}
        >
          <Pause size={13} fill="currentColor" />
        </div>
      );
    case "failed":
      return (
        <div
          style={{
            ...baseStyle,
            background: "color-mix(in srgb, var(--status-error) 15%, var(--surface-elevated))",
            border: "2.5px solid var(--status-error)",
            color: "var(--status-error)",
          }}
        >
          <X size={14} strokeWidth={2.5} />
        </div>
      );
    case "skipped":
      return (
        <div
          style={{
            ...baseStyle,
            background: "var(--surface-elevated)",
            border: "2px dashed var(--border-bright)",
          }}
        />
      );
    default: // pending
      return (
        <div
          style={{
            ...baseStyle,
            background: "var(--surface-elevated)",
            border: "2.5px solid var(--border-bright)",
          }}
        />
      );
  }
}

function StepRow({ step, isLast }: { step: StepItem; isLast: boolean }) {
  const [hovered, setHovered] = useState(false);
  const isClickable = !!step.onClick;

  return (
    <div style={{ display: "flex", gap: 0 }}>
      {/* Left: circle + connector line */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          width: 28,
          flexShrink: 0,
        }}
      >
        <StepCircle status={step.status} />
        {!isLast && (
          <div
            style={{
              width: 2.5,
              flex: 1,
              minHeight: 20,
              background:
                step.status === "completed"
                  ? "var(--status-success)"
                  : step.status === "paused"
                    ? "var(--status-warning, #f59e0b)"
                    : step.status === "failed"
                      ? "var(--status-error)"
                      : "var(--border-bright)",
              borderRadius: 2,
              transition: "background 0.3s",
            }}
          />
        )}
      </div>

      {/* Right: content — two-column: text left, meta right (vertically centered) */}
      <div
        onClick={isClickable ? step.onClick : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          gap: 12,
          paddingLeft: 14,
          cursor: isClickable ? "pointer" : "default",
          borderRadius: "var(--radius)",
          transition: "background 0.15s",
          marginRight: 4,
          padding: isClickable ? "6px 10px 6px 14px" : "0 0 0 14px",
          marginBottom: isLast ? 0 : 8,
          background:
            hovered && isClickable
              ? "color-mix(in srgb, var(--status-info) 5%, transparent)"
              : "transparent",
        }}
      >
        {/* Left: title + description */}
        <div
          style={{
            flex: 1,
            minHeight: 28,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              fontSize: "0.84rem",
              fontWeight:
                step.status === "active" ||
                step.status === "completed" ||
                step.status === "failed" ||
                step.status === "paused"
                  ? 600
                  : 400,
              color:
                hovered && isClickable
                  ? "var(--status-info)"
                  : step.status === "pending" || step.status === "skipped"
                    ? "var(--foreground-dim)"
                    : "var(--foreground)",
              transition: "color 0.15s",
            }}
          >
            {step.title}
          </span>

          {step.description && (
            <div
              style={{
                fontSize: "0.74rem",
                color: "var(--foreground-dim)",
                lineHeight: 1.5,
                marginTop: 2,
                maxWidth: 480,
              }}
            >
              {step.description}
            </div>
          )}

          {/* Nested content */}
          {step.children}
        </div>

        {/* Right: meta + open icon (vertically centered with the row) */}
        {(step.meta || isClickable) && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {step.meta}
            {isClickable && (
              <ExternalLink
                size={13}
                style={{
                  color: "var(--status-info)",
                  opacity: hovered ? 1 : 0,
                  transition: "opacity 0.15s",
                  flexShrink: 0,
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function VerticalStepper({ steps }: { steps: StepItem[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {steps.map((step, i) => (
        <StepRow key={step.id} step={step} isLast={i === steps.length - 1} />
      ))}
    </div>
  );
}
