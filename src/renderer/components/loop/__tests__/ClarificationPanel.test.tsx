import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingRequest } from "../../../../core/humanInput.js";
import type { RunSnapshot } from "../../../../core/run-snapshot.js";

let held: unknown = null;
vi.mock("../../../hooks/useUserQuestion.js", () => ({
  useUserQuestion: () => ({
    pendingRequest: held,
    answerQuestion: vi.fn(),
    answerToolApproval: vi.fn(),
  }),
}));

import { ClarificationPanel } from "../ClarificationPanel.js";

const GATE: PendingRequest = {
  kind: "pause",
  id: "p-1",
  entryId: "001-alpha",
  askedAt: "t",
  reason: "gate",
  detail:
    "001-alpha · brief is done, and the queue gates it: review the result, then Resume to go on",
  options: ["Continue", "Stop"],
};

function snapshot(status: "paused" | "running", pending: PendingRequest[] = [GATE]): RunSnapshot {
  return {
    state: { status, pendingRequests: pending } as unknown as RunSnapshot["state"],
    queue: null,
    errors: [],
    digests: [],
  };
}

afterEach(() => {
  cleanup();
  held = null;
});

describe("ClarificationPanel", () => {
  it("shows the pause a paused run ended on; Continue resumes", () => {
    const onResume = vi.fn();
    render(
      <ClarificationPanel snapshot={snapshot("paused")} isRunning={false} onResume={onResume} />,
    );
    expect(screen.getByText("Review before the next stage")).toBeTruthy();
    expect(screen.getByTestId("pause-detail").textContent).toMatch(/brief is done/);
    fireEvent.click(screen.getByTestId("pause-option-continue"));
    fireEvent.click(screen.getByTestId("pause-option-continue"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("links the entry's digest when the pause wrote one, and only then", () => {
    const withDigest = { ...snapshot("paused"), digests: ["001-alpha"] };
    const { rerender } = render(
      <ClarificationPanel snapshot={withDigest} isRunning={false} onResume={() => {}} projectDir="/p" />,
    );
    expect(screen.getByTestId("pause-digest-link").textContent).toBe("Read the digest for 001-alpha");
    rerender(<ClarificationPanel snapshot={snapshot("paused")} isRunning={false} onResume={() => {}} projectDir="/p" />);
    expect(screen.queryByTestId("pause-digest-link")).toBeNull();
  });

  it("Stop closes the card and leaves the run paused", () => {
    const onResume = vi.fn();
    render(
      <ClarificationPanel snapshot={snapshot("paused")} isRunning={false} onResume={onResume} />,
    );
    fireEvent.click(screen.getByTestId("pause-option-stop"));
    expect(screen.queryByTestId("pause-card")).toBeNull();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("shows no pause while a run goes, or for a Stop (no pause request)", () => {
    const { rerender } = render(
      <ClarificationPanel snapshot={snapshot("paused")} isRunning={true} onResume={() => {}} />,
    );
    expect(screen.queryByTestId("pause-card")).toBeNull();
    rerender(
      <ClarificationPanel
        snapshot={snapshot("paused", [])}
        isRunning={false}
        onResume={() => {}}
      />,
    );
    expect(screen.queryByTestId("pause-card")).toBeNull();
  });

  it("a request an agent waits on comes before the pause", () => {
    held = {
      kind: "tool_approval",
      requestId: "req-2",
      toolName: "Bash",
      subject: "git push",
      input: {},
      source: "settings",
    };
    render(
      <ClarificationPanel snapshot={snapshot("paused")} isRunning={false} onResume={() => {}} />,
    );
    expect(screen.getByTestId("tool-approval-card")).toBeTruthy();
    expect(screen.queryByTestId("pause-card")).toBeNull();
  });
});
