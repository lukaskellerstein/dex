import { useState } from "react";
import { CheckpointModal } from "./Modal";

interface Props {
  suggestedName: string;
  suggestedEmail: string;
  initialName: string | null;
  initialEmail: string | null;
  onSkip: () => void;
  onSave: (name: string, email: string) => Promise<void>;
}

/**
 * Offered at project-open when git identity is unset. Writes to local config
 * only; never --global. Users can skip — identity is only strictly required
 * for checkpoint commits and tagging.
 */
export function IdentityPrompt({
  suggestedName,
  suggestedEmail,
  initialName,
  initialEmail,
  onSkip,
  onSave,
}: Props) {
  const [name, setName] = useState(initialName ?? suggestedName);
  const [email, setEmail] = useState(initialEmail ?? suggestedEmail);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(name.trim(), email.trim());
    } finally {
      setSaving(false);
    }
  };

  return (
    <CheckpointModal
      title="Set up git identity for this project"
      onClose={onSkip}
      footer={
        <>
          <button className="btn-secondary" onClick={onSkip}>
            Skip
          </button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !email.trim()}
          >
            Save
          </button>
        </>
      }
    >
      <p style={{ marginBottom: 12, color: "var(--foreground-muted)", fontSize: 12 }}>
        Checkpoints tag real git commits, which need a name and email. These are
        written only to this project's <code>.git/config</code>, never globally.
      </p>
      <label style={{ display: "block", marginBottom: 10 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>Name</div>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 8px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        />
      </label>
      <label style={{ display: "block" }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>Email</div>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 8px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        />
      </label>
    </CheckpointModal>
  );
}
