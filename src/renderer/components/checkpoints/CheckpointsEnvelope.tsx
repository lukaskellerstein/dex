import { useCallback, useEffect, useRef, useState } from "react";
import { IdentityPrompt } from "./IdentityPrompt";
import { InitRepoPrompt } from "./InitRepoPrompt";
import { CandidatePrompt } from "./CandidatePrompt";
import { VariantCompareModal } from "./VariantCompareModal";
import { ContinueVariantGroupModal } from "./ContinueVariantGroupModal";
import type { VariantGroupFile } from "../../../core/checkpoints.js";
import type { StepType } from "../../../core/types.js";

interface Props {
  projectDir: string | null;
}

interface CandidateInfo {
  step: StepType;
  cycleNumber: number;
  checkpointTag: string;
  candidateSha: string;
  attemptBranch: string;
}

/**
 * Top-level envelope that owns every project-level checkpoint modal and
 * subscribes to orchestrator events so the right modal opens at the right
 * moment. Mounts inside AppShell after a project is open.
 */
export function CheckpointsEnvelope({ projectDir }: Props) {
  const [needsRepoInit, setNeedsRepoInit] = useState(false);
  const [needsIdentity, setNeedsIdentity] = useState<null | {
    name: string | null;
    email: string | null;
    suggestedName: string;
    suggestedEmail: string;
  }>(null);

  const [candidate, setCandidate] = useState<CandidateInfo | null>(null);
  const [variantCompare, setVariantCompare] = useState<VariantGroupFile | null>(null);
  const [variantResume, setVariantResume] = useState<VariantGroupFile | null>(null);

  const lastStageRef = useRef<CandidateInfo | null>(null);

  // Project-open checks: repo exists + identity set
  useEffect(() => {
    if (!projectDir) return;
    (async () => {
      const isRepo = await window.dexAPI.checkpoints.checkIsRepo(projectDir);
      if (!isRepo) {
        setNeedsRepoInit(true);
        return;
      }
      const id = await window.dexAPI.checkpoints.checkIdentity(projectDir);
      if (!id.name || !id.email) {
        setNeedsIdentity(id);
      }
      // Surface any stranded variant group immediately
      const pending = await window.dexAPI.checkpoints.readPendingVariantGroups(projectDir);
      if (pending.length > 0) {
        setVariantResume(pending[0] as unknown as VariantGroupFile);
      }
    })();
  }, [projectDir]);

  // Subscribe to orchestrator events → open modals
  useEffect(() => {
    if (!projectDir) return;
    const off = window.dexAPI.onOrchestratorEvent((raw) => {
      const e = raw as unknown as {
        type?: string;
        cycleNumber?: number;
        step?: StepType;
        checkpointTag?: string;
        candidateSha?: string;
        attemptBranch?: string;
        reason?: string;
        groupId?: string;
      };
      switch (e.type) {
        case "stage_candidate":
          if (
            e.checkpointTag &&
            e.candidateSha &&
            e.step &&
            e.attemptBranch !== undefined &&
            e.cycleNumber !== undefined
          ) {
            lastStageRef.current = {
              step: e.step,
              cycleNumber: e.cycleNumber,
              checkpointTag: e.checkpointTag,
              candidateSha: e.candidateSha,
              attemptBranch: e.attemptBranch,
            };
          }
          break;
        case "paused":
          if (e.reason === "step_mode" && lastStageRef.current) {
            setCandidate(lastStageRef.current);
          }
          break;
        case "variant_group_complete":
          if (e.groupId) {
            // Need to fetch the group file to render compare.
            window.dexAPI.checkpoints
              .readPendingVariantGroups(projectDir)
              .then((groups) => {
                const match = (groups as unknown as VariantGroupFile[]).find(
                  (g) => g.groupId === e.groupId,
                );
                if (match) setVariantCompare(match);
              });
          }
          break;
        case "variant_group_resume_needed":
          if (e.groupId) {
            window.dexAPI.checkpoints
              .readPendingVariantGroups(projectDir)
              .then((groups) => {
                const match = (groups as unknown as VariantGroupFile[]).find(
                  (g) => g.groupId === e.groupId,
                );
                if (match) setVariantResume(match);
              });
          }
          break;
      }
    });
    return off;
  }, [projectDir]);

  const handleInitRepo = useCallback(async () => {
    if (!projectDir) return;
    const r = await window.dexAPI.checkpoints.initRepo(projectDir);
    if (r.ok) {
      setNeedsRepoInit(false);
      const id = await window.dexAPI.checkpoints.checkIdentity(projectDir);
      if (!id.name || !id.email) setNeedsIdentity(id);
    }
  }, [projectDir]);

  const handleSaveIdentity = useCallback(
    async (name: string, email: string) => {
      if (!projectDir) return;
      await window.dexAPI.checkpoints.setIdentity(projectDir, name, email);
      setNeedsIdentity(null);
    },
    [projectDir],
  );

  const handleKeepCandidate = useCallback(async () => {
    if (!projectDir || !candidate) return;
    await window.dexAPI.checkpoints.promote(
      projectDir,
      candidate.checkpointTag,
      candidate.candidateSha,
    );
    setCandidate(null);
  }, [projectDir, candidate]);

  const handleTryAgainCandidate = useCallback(async () => {
    if (!projectDir || !candidate) return;
    // The candidate's checkpointTag is the *would-be* tag; for "Try again" we
    // need to roll back to the *previous* step's checkpoint. Since we don't
    // have its identifier here, we go back to the fresh candidate (no tag
    // moved) — the user's next Start picks up from this checkpoint anyway.
    // Real "Try again" flow lands in a future slice that threads the parent
    // tag through the stage_candidate event.
    setCandidate(null);
  }, [projectDir, candidate]);

  const handleKeepVariant = useCallback(
    async (letter: string) => {
      if (!projectDir || !variantCompare) return;
      const variant = variantCompare.variants.find((v) => v.letter === letter);
      if (!variant || !variant.candidateSha) return;
      // Promote the picked variant's candidate to the checkpoint that was
      // being fanned out. The group's `step` + fromCheckpoint tell us which.
      // fromCheckpoint is the parent; the new canonical tag is determined by
      // the stage_candidate event that fired at variant completion. We use
      // the checkpointTag computed from step + cycleNumber of fromCheckpoint + 1
      // — but since we don't have cycle context here, we pick the variant's
      // candidate's matching checkpoint tag via the orchestrator's emission.
      // Simpler approach: promote the tag we'd expect (same step, same cycle
      // extracted from the parent). For MVP we just tag with
      // `checkpoint/variant-<groupId>-<letter>`.
      const tag = `checkpoint/variant-${variantCompare.groupId.slice(0, 6)}-${letter}`;
      await window.dexAPI.checkpoints.promote(projectDir, tag, variant.candidateSha);
      await window.dexAPI.checkpoints.cleanupVariantGroup(
        projectDir,
        variantCompare.groupId,
        "keep",
        letter,
      );
      setVariantCompare(null);
    },
    [projectDir, variantCompare],
  );

  const handleDiscardAllVariants = useCallback(async () => {
    if (!projectDir || !variantCompare) return;
    await window.dexAPI.checkpoints.cleanupVariantGroup(
      projectDir,
      variantCompare.groupId,
      "discard",
    );
    setVariantCompare(null);
  }, [projectDir, variantCompare]);

  const handleContinueResume = useCallback(async () => {
    // The orchestrator's resume flow picks up pending variants on the next
    // start; here we just dismiss the modal so the UI is out of the way.
    setVariantResume(null);
  }, []);

  const handleDiscardResume = useCallback(async () => {
    if (!projectDir || !variantResume) return;
    await window.dexAPI.checkpoints.cleanupVariantGroup(
      projectDir,
      variantResume.groupId,
      "discard",
    );
    setVariantResume(null);
  }, [projectDir, variantResume]);

  return (
    <>
      {needsRepoInit && projectDir && (
        <InitRepoPrompt
          projectDir={projectDir}
          onSkip={() => setNeedsRepoInit(false)}
          onInit={handleInitRepo}
        />
      )}
      {needsIdentity && (
        <IdentityPrompt
          suggestedName={needsIdentity.suggestedName}
          suggestedEmail={needsIdentity.suggestedEmail}
          initialName={needsIdentity.name}
          initialEmail={needsIdentity.email}
          onSkip={() => setNeedsIdentity(null)}
          onSave={handleSaveIdentity}
        />
      )}
      {candidate && (
        <CandidatePrompt
          step={candidate.step}
          cycleNumber={candidate.cycleNumber}
          checkpointTag={candidate.checkpointTag}
          candidateSha={candidate.candidateSha}
          onKeep={handleKeepCandidate}
          onTryAgain={handleTryAgainCandidate}
          onDismiss={() => setCandidate(null)}
        />
      )}
      {variantCompare && projectDir && (
        <VariantCompareModal
          projectDir={projectDir}
          group={variantCompare}
          onKeep={handleKeepVariant}
          onDiscardAll={handleDiscardAllVariants}
          onClose={() => setVariantCompare(null)}
        />
      )}
      {variantResume && !variantCompare && (
        <ContinueVariantGroupModal
          group={variantResume}
          onContinue={handleContinueResume}
          onDiscard={handleDiscardResume}
        />
      )}
    </>
  );
}
