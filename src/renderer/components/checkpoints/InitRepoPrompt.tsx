import { CheckpointModal } from "./Modal";

interface Props {
  projectDir: string;
  onSkip: () => void;
  onInit: () => Promise<void>;
}

/**
 * Shown at project-open when .git/ is absent. Without git, checkpoints cannot
 * exist — we offer to git init + initial commit, or let the user skip (timeline
 * becomes disabled with a banner).
 */
export function InitRepoPrompt({ projectDir, onSkip, onInit }: Props) {
  return (
    <CheckpointModal
      title="Initialize version control?"
      onClose={onSkip}
      footer={
        <>
          <button className="btn-secondary" onClick={onSkip}>
            Skip
          </button>
          <button className="btn-primary" onClick={onInit}>
            Initialize
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 10 }}>
        <code style={{ fontFamily: "var(--font-mono)" }}>{projectDir}</code> is not under version
        control.
      </p>
      <p style={{ color: "var(--foreground-muted)", fontSize: 13 }}>
        Dex's checkpoint system uses git under the hood. Initialize now to turn on the Timeline —
        jump back to any stage, remove a version, or promote one to main. You can skip — the
        timeline will stay disabled with a banner until you come back to it.
      </p>
    </CheckpointModal>
  );
}
