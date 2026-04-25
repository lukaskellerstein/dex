import { ListChecks, GitBranch } from "lucide-react";

export type TopTab = "steps" | "timeline";

interface Props {
  active: TopTab;
  onChange: (tab: TopTab) => void;
}

const TABS: { id: TopTab; label: string; Icon: typeof ListChecks }[] = [
  { id: "steps", label: "Steps", Icon: ListChecks },
  { id: "timeline", label: "Timeline", Icon: GitBranch },
];

export function TopTabBar({ active, onChange }: Props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        height: 36,
        paddingLeft: 14,
        WebkitAppRegion: "no-drag",
      } as React.CSSProperties}
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            data-testid={`top-tab-${id}`}
            aria-pressed={isActive}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "0 14px",
              height: "100%",
              background: "transparent",
              border: "none",
              borderBottom: isActive
                ? "2px solid var(--primary)"
                : "2px solid transparent",
              color: isActive ? "var(--foreground)" : "var(--foreground-muted)",
              fontSize: "0.82rem",
              fontWeight: isActive ? 600 : 500,
              cursor: "pointer",
              transition: "color 120ms, border-color 120ms",
            }}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--foreground)";
            }}
            onMouseLeave={(e) => {
              if (!isActive)
                e.currentTarget.style.color = "var(--foreground-muted)";
            }}
          >
            <Icon size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
