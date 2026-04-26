import { useEffect, useState, useCallback } from "react";
import { TimelinePanel } from "./TimelinePanel";
import { TryNWaysModal } from "./TryNWaysModal";
import type { VariantSlotState } from "./AgentProfileForm";
import { STAGE_ORDER_RENDERER } from "./stageOrder";
import type { TimelineCommit } from "../../../core/checkpoints.js";
import type { ClaudeProfile } from "../../../core/agent-profile.js";
import type { StepType } from "../../../core/types.js";

interface Props {
  projectDir: string;
}

function tagFor(step: string, cycleNumber: number): string {
  const slug = step.replaceAll("_", "-");
  return cycleNumber === 0
    ? `checkpoint/after-${slug}`
    : `checkpoint/cycle-${cycleNumber}-after-${slug}`;
}

function nextStageOf(step: StepType): StepType {
  const idx = STAGE_ORDER_RENDERER.indexOf(step);
  if (idx < 0 || idx >= STAGE_ORDER_RENDERER.length - 1) return step;
  return STAGE_ORDER_RENDERER[idx + 1];
}

interface TryNWaysAnchor {
  tag: string;
  nextStage: StepType;
}

/**
 * 010 Timeline tab. Hosts the Record / Pause toggles, the Timeline canvas,
 * and the variant-spawn modal triggered by the right-click menu (US3).
 *
 * The variant modal is still on its 008 body in this iteration — US4 rebuilds
 * it around the per-variant agent profile picker.
 */
export function TimelineView({ projectDir }: Props) {
  const [repoReady, setRepoReady] = useState(true);
  const [tryNWaysAnchor, setTryNWaysAnchor] = useState<TryNWaysAnchor | null>(null);

  useEffect(() => {
    window.dexAPI.checkpoints
      .checkIsRepo(projectDir)
      .then(setRepoReady)
      .catch(() => setRepoReady(false));
  }, [projectDir]);

  /**
   * The 008 spawnVariants flow takes a checkpoint tag, not a SHA. To wire the
   * 010 right-click "Try N ways from here" without changing 008's interface,
   * we ensure the target commit carries its canonical step tag (auto-promote
   * if not) before opening the modal. US4 will rebuild the modal to accept a
   * SHA directly and remove this stitch.
   */
  const handleTryNWaysAt = useCallback(
    async (commit: TimelineCommit) => {
      const tag = tagFor(commit.step, commit.cycleNumber);
      if (!commit.hasCheckpointTag) {
        const r = await window.dexAPI.checkpoints.promote(projectDir, tag, commit.sha);
        if (!("ok" in r) || !r.ok) {
          console.warn("[timeline-view] auto-promote before try-n-ways failed", r);
          return;
        }
      }
      setTryNWaysAnchor({ tag, nextStage: nextStageOf(commit.step as StepType) });
    },
    [projectDir],
  );

  const handleConfirmSpawn = useCallback(
    async (n: number, slots: VariantSlotState[]) => {
      if (!tryNWaysAnchor) return;
      const letters = ["a", "b", "c", "d", "e"].slice(0, n);
      // Build per-variant profile bindings. A slot with `selectedName === null`
      // means "(none)" — runner uses orchestrator defaults, no overlay.
      // Slots that picked a profile populate a transient ClaudeProfile that
      // mirrors what the picker showed (model / persona / allowed-tools), with
      // agentDir resolved from the project's .dex/agents/<name>/ folder.
      const profiles = slots.map((slot, i): { letter: string; profile: ClaudeProfile | null } => {
        if (!slot.selectedName) return { letter: letters[i], profile: null };
        return {
          letter: letters[i],
          profile: {
            name: slot.selectedName,
            agentDir: `${projectDir}/.dex/agents/${slot.selectedName}`,
            agentRunner: "claude-sdk",
            model: slot.model,
            systemPromptAppend: slot.systemPromptAppend || undefined,
            allowedTools: slot.allowedTools.length > 0 ? slot.allowedTools : undefined,
          },
        };
      });
      const r = await window.dexAPI.checkpoints.spawnVariants(projectDir, {
        fromCheckpoint: tryNWaysAnchor.tag,
        variantLetters: letters,
        step: tryNWaysAnchor.nextStage,
        profiles,
      });
      setTryNWaysAnchor(null);
      if (!("ok" in r) || !r.ok) {
        console.warn("[timeline-view] spawnVariants failed", r);
      }
    },
    [projectDir, tryNWaysAnchor],
  );

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
          flex: 1,
          // Inner TimelineGraph wrapper scrolls in both axes; this container
          // just provides the padding around it without competing for scroll.
          display: "flex",
          flexDirection: "column",
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
          onTryNWaysAt={handleTryNWaysAt}
        />
      </div>

      {tryNWaysAnchor && (
        <TryNWaysModal
          projectDir={projectDir}
          tag={tryNWaysAnchor.tag}
          nextStage={tryNWaysAnchor.nextStage}
          onCancel={() => setTryNWaysAnchor(null)}
          onConfirm={handleConfirmSpawn}
        />
      )}
    </div>
  );
}
