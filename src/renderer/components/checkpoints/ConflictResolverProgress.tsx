import { useEffect, useReducer } from "react";
import { CheckpointModal } from "./Modal";
import {
  RESOLVER_PROGRESS_TITLE,
  RESOLVER_PROGRESS_ITERATION,
} from "./branchOps/copy";
import { orchestratorService } from "../../services/orchestratorService.js";
import type { OrchestratorEvent } from "../../../core/types.js";

interface Props {
  /** Resolved when terminal `done` event arrives. Caller (TimelinePanel) handles routing to success toast / failure modal. */
  onDone: (ok: boolean, costTotal: number, reason: string | null) => void;
  /** User clicked Cancel — caller should propagate via the abort IPC. */
  onCancel: () => void;
}

interface State {
  totalFiles: number;
  currentFile: string | null;
  currentIndex: number;
  iteration: number;
  costSoFar: number;
  resolvedFiles: string[];
  failedFiles: string[];
  done: boolean;
}

type Action = OrchestratorEvent | { type: "reset" };

const INITIAL: State = {
  totalFiles: 0,
  currentFile: null,
  currentIndex: 0,
  iteration: 0,
  costSoFar: 0,
  resolvedFiles: [],
  failedFiles: [],
  done: false,
};

function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "conflict-resolver:file-start":
      return {
        ...state,
        totalFiles: action.total,
        currentFile: action.file,
        currentIndex: action.index,
      };
    case "conflict-resolver:iteration":
      return {
        ...state,
        iteration: action.n,
        costSoFar: action.costSoFar,
        currentFile: action.currentFile,
      };
    case "conflict-resolver:file-done":
      if (action.ok) {
        return { ...state, resolvedFiles: [...state.resolvedFiles, action.file] };
      }
      return { ...state, failedFiles: [...state.failedFiles, action.file] };
    case "conflict-resolver:done":
      return { ...state, done: true };
    case "reset":
      return { ...INITIAL };
    default:
      return state;
  }
}

/**
 * Live progress modal for the conflict resolver. Subscribes to
 * `orchestrator:event` and reduces every `conflict-resolver:*` event into
 * the displayed state. Closes itself when the terminal `done` event arrives,
 * forwarding the outcome to the caller via `onDone`.
 */
export function ConflictResolverProgress({ onDone, onCancel }: Props) {
  const [state, dispatch] = useReducer(reduce, INITIAL);

  useEffect(() => {
    const off = orchestratorService.subscribeEvents((evt) => {
      const t = (evt as { type?: string }).type;
      if (typeof t !== "string" || !t.startsWith("conflict-resolver:")) return;
      dispatch(evt as Action);
      if (evt.type === "conflict-resolver:done") {
        onDone(evt.ok, evt.costTotal, evt.reason ?? null);
      }
    });
    return off;
  }, [onDone]);

  const total = state.totalFiles || "?";
  const currentLabel =
    state.totalFiles > 0
      ? RESOLVER_PROGRESS_ITERATION(state.currentIndex, state.totalFiles)
      : "Starting…";

  return (
    <CheckpointModal
      title={RESOLVER_PROGRESS_TITLE}
      onClose={onCancel}
      footer={
        <button
          className="btn-secondary"
          onClick={onCancel}
          data-testid="resolver-progress-cancel"
        >
          Cancel
        </button>
      }
    >
      <div data-testid="resolver-progress-status" style={{ fontSize: 13, marginBottom: 12 }}>
        {currentLabel}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--foreground-muted)",
          marginBottom: 8,
        }}
      >
        Iteration <strong>{state.iteration || 0}</strong> · cost so far{" "}
        <strong>${state.costSoFar.toFixed(4)}</strong>
      </div>
      {state.currentFile && (
        <div
          data-testid="resolver-progress-current-file"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            background: "var(--surface-elevated)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            marginBottom: 8,
          }}
        >
          {state.currentFile}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--foreground-dim)" }}>
        Resolved {state.resolvedFiles.length} / {total}
        {state.failedFiles.length > 0 && (
          <>
            {" "}· failed {state.failedFiles.length}
          </>
        )}
      </div>
    </CheckpointModal>
  );
}
