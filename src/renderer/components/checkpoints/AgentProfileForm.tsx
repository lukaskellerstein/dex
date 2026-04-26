import { useMemo } from "react";
import type {
  ProfileEntry,
  ClaudeProfile,
  AgentRunnerKind,
} from "../../../core/agent-profile.js";

/**
 * Per-variant slot state shape. Drives the form below + flows into the spawn
 * request as `request.profiles[i].profile`.
 */
export interface VariantSlotState {
  /** Name of the selected profile folder, or null for "(none)" / project default. */
  selectedName: string | null;
  agentRunner: AgentRunnerKind;
  model: string;
  systemPromptAppend: string;
  allowedTools: string[]; // empty = no restriction (use whatever the project allows)
}

export const DEFAULT_SLOT: VariantSlotState = {
  selectedName: null,
  agentRunner: "claude-sdk",
  model: "claude-sonnet-4-6",
  systemPromptAppend: "",
  allowedTools: [],
};

const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

const PERSONA_QUICK_FILLS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Conservative", value: "Minimize change. Prefer the smallest diff that satisfies the requirement. Avoid introducing new dependencies." },
  { label: "Standard", value: "" },
  { label: "Innovative", value: "Use modern libraries and idioms freely. Refactor opportunistically for clarity. Prefer clean abstractions over preserving legacy patterns." },
];

interface Props {
  entries: ProfileEntry[];
  value: VariantSlotState;
  onChange: (next: VariantSlotState) => void;
  /** When true, all controls except the profile dropdown are read-only (B/C… in "Apply same" mode). */
  disabledExceptDropdown?: boolean;
  onSaveBack?: (name: string, slot: VariantSlotState) => Promise<void>;
  /** Slot label like "A", "B", "C" — rendered in the row header. */
  slotLabel: string;
  /** When true, the "Save changes to profile" button is hidden (e.g., empty-profiles stub). */
  hideSaveBack?: boolean;
}

function summaryChip(entries: ProfileEntry[], name: string | null): string {
  if (!name) return "(no .claude/ overlay — uses project defaults)";
  const e = entries.find((x) => x.kind === "ok" && x.profile.name === name);
  if (!e || e.kind !== "ok") return "(profile invalid)";
  const s = e.overlaySummary;
  if (!s.hasClaude) return "(no .claude/ overlay)";
  const parts: string[] = [];
  if (s.hasClaudeMd) parts.push("CLAUDE.md");
  if (s.skills) parts.push(`${s.skills} skill${s.skills === 1 ? "" : "s"}`);
  if (s.subagents) parts.push(`${s.subagents} subagent${s.subagents === 1 ? "" : "s"}`);
  if (s.mcpServers) parts.push(`${s.mcpServers} MCP server${s.mcpServers === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : "(empty .claude/)";
}

export function AgentProfileForm({
  entries,
  value,
  onChange,
  disabledExceptDropdown,
  onSaveBack,
  slotLabel,
  hideSaveBack,
}: Props) {
  const okEntries = useMemo(
    () => entries.filter((e): e is Extract<ProfileEntry, { kind: "ok" }> => e.kind === "ok"),
    [entries],
  );
  const warnEntries = useMemo(
    () => entries.filter((e): e is Extract<ProfileEntry, { kind: "warn" }> => e.kind === "warn"),
    [entries],
  );

  const handleProfilePick = (name: string | "" /* = none */) => {
    if (!name) {
      onChange({ ...DEFAULT_SLOT, selectedName: null });
      return;
    }
    const e = okEntries.find((x) => x.profile.name === name);
    if (!e) return;
    const p = e.profile as ClaudeProfile;
    onChange({
      selectedName: p.name,
      agentRunner: p.agentRunner,
      model: p.model,
      systemPromptAppend: p.systemPromptAppend ?? "",
      allowedTools: p.allowedTools ?? [],
    });
  };

  const ro = !!disabledExceptDropdown;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            fontFamily: "var(--font-mono)",
            color: "var(--primary, #5865f2)",
            minWidth: 14,
          }}
        >
          {slotLabel}
        </span>
        <select
          data-testid={`slot-${slotLabel}-profile`}
          value={value.selectedName ?? ""}
          onChange={(e) => handleProfilePick(e.target.value)}
          style={{
            flex: 1,
            padding: "4px 6px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 12,
          }}
        >
          <option value="">(none — project default)</option>
          {okEntries.map((e) => (
            <option key={e.profile.name} value={e.profile.name}>
              {e.profile.name}
            </option>
          ))}
        </select>
      </div>

      {warnEntries.length > 0 && (
        <div style={{ fontSize: "0.66rem", color: "var(--status-warning, #f59e0b)", paddingLeft: 22 }}>
          {warnEntries.length} folder{warnEntries.length === 1 ? "" : "s"} skipped:{" "}
          {warnEntries.map((w) => `${w.folder} (${w.reason})`).join(" · ")}
        </div>
      )}

      <div style={{ paddingLeft: 22, display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: "0.7rem", color: "var(--foreground-muted)" }}>Model:</label>
        <select
          value={value.model}
          disabled={ro}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          style={{
            flex: 1,
            padding: "3px 6px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          {CLAUDE_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
          {/* Allow whatever the profile already has, even if not in the canonical list. */}
          {!CLAUDE_MODELS.includes(value.model as typeof CLAUDE_MODELS[number]) && (
            <option key={value.model} value={value.model}>{value.model}</option>
          )}
        </select>
      </div>

      <div style={{ paddingLeft: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: "0.7rem", color: "var(--foreground-muted)" }}>Persona:</span>
          {PERSONA_QUICK_FILLS.map((p) => (
            <button
              key={p.label}
              type="button"
              disabled={ro}
              onClick={() => onChange({ ...value, systemPromptAppend: p.value })}
              style={{
                fontSize: "0.66rem",
                padding: "2px 6px",
                background: "var(--surface-elevated)",
                color: "var(--foreground-muted)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                cursor: ro ? "not-allowed" : "pointer",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <textarea
          value={value.systemPromptAppend}
          disabled={ro}
          placeholder="Free-form persona / instruction addendum (appended to the assembled system prompt)"
          onChange={(e) => onChange({ ...value, systemPromptAppend: e.target.value })}
          style={{
            width: "100%",
            minHeight: 40,
            padding: "4px 6px",
            background: "var(--surface-elevated)",
            color: "var(--foreground)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            resize: "vertical",
          }}
        />
      </div>

      <div style={{ paddingLeft: 22, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: "0.66rem",
            color: "var(--foreground-dim)",
            fontStyle: "italic",
          }}
        >
          {summaryChip(entries, value.selectedName)}
        </span>
        {!hideSaveBack && value.selectedName && onSaveBack && (
          <button
            type="button"
            disabled={ro}
            onClick={() => onSaveBack(value.selectedName!, value)}
            style={{
              fontSize: "0.68rem",
              padding: "3px 8px",
              background: "transparent",
              color: "var(--primary)",
              border: "1px solid var(--primary)",
              borderRadius: "var(--radius)",
              cursor: ro ? "not-allowed" : "pointer",
            }}
          >
            Save changes to profile
          </button>
        )}
      </div>
    </div>
  );
}
