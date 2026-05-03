import { CheckpointModal } from "./Modal";

interface Props {
  tag: string;
  files: string[];
  onCancel: () => void;
  onChoose: (action: "save" | "discard") => void;
}

/**
 * Shown when checkpoints:goBack returns dirty_working_tree.
 * User picks Save (commit dirty changes onto the current branch before jumping), Discard, or Cancel.
 */
export function GoBackConfirm({ tag, files, onCancel, onChoose }: Props) {
  return (
    <CheckpointModal
      title="Uncommitted changes — how to proceed?"
      onClose={onCancel}
      footer={
        <>
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-secondary" onClick={() => onChoose("discard")}>
            Discard
          </button>
          <button className="btn-primary" onClick={() => onChoose("save")}>
            Save
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 10 }}>
        You have uncommitted changes. Going back to <code>{tag}</code> will reset
        them unless you choose <strong>Save</strong>.
      </p>
      <div
        style={{
          maxHeight: 200,
          overflow: "auto",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          background: "var(--surface-elevated)",
        }}
      >
        {files.length === 0 ? (
          <em>no files</em>
        ) : (
          files.map((f) => <div key={f}>{f}</div>)
        )}
      </div>
      <p style={{ marginTop: 10, color: "var(--foreground-muted)", fontSize: 12 }}>
        <strong>Save</strong> commits these changes to the current version so you can
        keep working with them later.
      </p>
    </CheckpointModal>
  );
}
