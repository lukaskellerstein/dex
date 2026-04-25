import type { TaskPhase, Task } from "../../../core/types.js";
import type { SpecSummary } from "../../hooks/useProject.js";
import { SpecCard } from "./SpecCard.js";

interface ProjectOverviewProps {
  specSummaries: SpecSummary[];
  onSelectSpec: (spec: string) => void;

  isRunning: boolean;
  activeSpecDir: string | null;
  activePhase: TaskPhase | null;
  activeTask: Task | null;
}

export function ProjectOverview({ specSummaries, onSelectSpec, isRunning, activeSpecDir, activePhase, activeTask }: ProjectOverviewProps) {
  if (specSummaries.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          paddingTop: 80,
          color: "var(--foreground-dim)",
        }}
      >
        No specs found in this project
      </div>
    );
  }

  return (
    <div style={{ padding: 20, overflow: "auto", height: "100%" }}>
      <div
        style={{
          fontSize: "0.77rem",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--foreground-dim)",
          marginBottom: 16,
        }}
      >
        Specs
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        {specSummaries.map((s) => {
          const isActive = activeSpecDir !== null && (activeSpecDir === s.name || activeSpecDir.endsWith(`/${s.name}`) || s.name.endsWith(`/${activeSpecDir}`));
          return (
            <SpecCard
              key={s.name}
              summary={s}
              onClick={() => onSelectSpec(s.name)}

              isActive={isActive}
              isRunning={isRunning}
              activePhase={isActive ? activePhase : null}
              activeTask={isActive ? activeTask : null}
            />
          );
        })}
      </div>
    </div>
  );
}
