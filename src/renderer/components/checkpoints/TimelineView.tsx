import { useEffect, useState } from "react";
import { TimelinePanel } from "./TimelinePanel";
import { RecBadge } from "./RecBadge";
import { useRecordMode } from "./hooks/useRecordMode";
import { usePauseAfterStage } from "./hooks/usePauseAfterStage";
import { TryNWaysModal } from "./TryNWaysModal";
import { AttemptCompareModal } from "./AttemptCompareModal";
import type { StepType } from "../../../core/types.js";
import { STAGE_ORDER_RENDERER } from "./stageOrder";

interface Props {
  projectDir: string;
}

/**
 * Full-page Timeline tab. Hosts the Record / Pause toggles, the timeline
 * graph (TimelinePanel), and the variant-spawn / attempt-compare modals.
 */
export function TimelineView({ projectDir }: Props) {
  const { recordMode, setRecordMode } = useRecordMode(projectDir);
  const { pauseAfterStage, setPauseAfterStage } = usePauseAfterStage(projectDir);

  const [repoReady, setRepoReady] = useState(true);
  const [tryNWaysTag, setTryNWaysTag] = useState<string | null>(null);
  const [compareTarget, setCompareTarget] = useState<null | {
    a: string;
    b: string;
    step: StepType | null;
  }>(null);
  const [compareSourceA, setCompareSourceA] = useState<string | null>(null);

  useEffect(() => {
    window.dexAPI.checkpoints
      .checkIsRepo(projectDir)
      .then(setRepoReady)
      .catch(() => setRepoReady(false));
  }, [projectDir]);

  const handleTryNWays = (tag: string) => setTryNWaysTag(tag);

  const handleConfirmSpawn = async (n: number) => {
    if (!tryNWaysTag) return;
    const parsedStage = parseStageFromTag(tryNWaysTag);
    const nextStage = nextStageOf(parsedStage);
    const letters = ["a", "b", "c", "d", "e"].slice(0, n);
    const r = await window.dexAPI.checkpoints.spawnVariants(projectDir, {
      fromCheckpoint: tryNWaysTag,
      variantLetters: letters,
      step: nextStage,
    });
    setTryNWaysTag(null);
    if (!r.ok) {
      console.warn("[timeline-view] spawnVariants failed", r.error);
    }
  };

  const handleCompareStart = (branch: string) => {
    if (!compareSourceA) {
      setCompareSourceA(branch);
      return;
    }
    setCompareTarget({ a: compareSourceA, b: branch, step: null });
    setCompareSourceA(null);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
          }}
        >
          <input
            type="checkbox"
            checked={recordMode}
            onChange={(e) => setRecordMode(e.target.checked)}
          />
          Record mode
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
          }}
        >
          <input
            type="checkbox"
            checked={pauseAfterStage}
            onChange={(e) => setPauseAfterStage(e.target.checked)}
          />
          Pause after each step
        </label>
        <RecBadge recordMode={recordMode} />
        {compareSourceA && (
          <div style={{ fontSize: 11, color: "var(--foreground-muted)" }}>
            Comparing from <code>{compareSourceA}</code> — click Compare on
            another attempt…
            <button
              onClick={() => setCompareSourceA(null)}
              style={{
                marginLeft: 6,
                background: "transparent",
                border: "none",
                color: "var(--foreground-dim)",
                cursor: "pointer",
              }}
            >
              cancel
            </button>
          </div>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "12px 14px",
          minHeight: 0,
        }}
      >
        <TimelinePanel
          projectDir={projectDir}
          disabled={!repoReady}
          disabledReason={
            !repoReady
              ? "Initialize version control to enable the timeline."
              : undefined
          }
          onTryNWays={handleTryNWays}
          onCompareStart={handleCompareStart}
          canTryNWays
        />
      </div>

      {tryNWaysTag && (
        <TryNWaysModal
          projectDir={projectDir}
          tag={tryNWaysTag}
          nextStage={nextStageOf(parseStageFromTag(tryNWaysTag))}
          onCancel={() => setTryNWaysTag(null)}
          onConfirm={handleConfirmSpawn}
        />
      )}
      {compareTarget && (
        <AttemptCompareModal
          projectDir={projectDir}
          branchA={compareTarget.a}
          branchB={compareTarget.b}
          step={compareTarget.step}
          onClose={() => setCompareTarget(null)}
        />
      )}
    </div>
  );
}

function parseStageFromTag(tag: string): StepType {
  const m = tag.match(/^checkpoint\/(?:cycle-\d+-)?after-(.+)$/);
  if (!m) return "plan";
  return m[1].replaceAll("-", "_") as StepType;
}

function nextStageOf(step: StepType): StepType {
  const idx = STAGE_ORDER_RENDERER.indexOf(step);
  if (idx < 0 || idx >= STAGE_ORDER_RENDERER.length - 1) return step;
  return STAGE_ORDER_RENDERER[idx + 1];
}
