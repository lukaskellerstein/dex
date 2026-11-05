import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolApprovalCard } from "../ToolApprovalCard.js";

const REQUEST = {
  kind: "tool_approval" as const,
  requestId: "req-2",
  toolName: "Bash",
  subject: "git push origin feature-x",
  input: { command: "git push origin feature-x", description: "Push the branch" },
  source: "settings" as const,
  reason: "projectSettings ask rule Bash(git push:*)",
};

afterEach(cleanup);

describe("ToolApprovalCard", () => {
  it("shows the tool, where the ask came from, the subject and the full input", () => {
    render(<ToolApprovalCard request={REQUEST} onAnswer={() => {}} />);
    expect(screen.getByText("An agent wants to run Bash")).toBeTruthy();
    expect(
      screen.getByText(/project settings — projectSettings ask rule Bash\(git push:\*\)/),
    ).toBeTruthy();
    expect(screen.getByTestId("tool-approval-subject").textContent).toBe(
      "git push origin feature-x",
    );
    expect(screen.getByText(/"description": "Push the branch"/)).toBeTruthy();
  });

  it("Approve answers approve once; the buttons lock after the first answer", () => {
    const onAnswer = vi.fn();
    render(<ToolApprovalCard request={REQUEST} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByTestId("tool-approval-approve"));
    fireEvent.click(screen.getByTestId("tool-approval-deny"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith("req-2", "approve", undefined);
  });

  it("Deny carries the typed reason to the agent", () => {
    const onAnswer = vi.fn();
    render(
      <ToolApprovalCard
        request={{ ...REQUEST, source: "policy", reason: "pushes need a human" }}
        onAnswer={onAnswer}
      />,
    );
    expect(
      screen.getByText(/Dex policy \(\.dex\/policy\.json\) — pushes need a human/),
    ).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Reason for a denial/), {
      target: { value: "  not on Fridays " },
    });
    fireEvent.click(screen.getByTestId("tool-approval-deny"));
    expect(onAnswer).toHaveBeenCalledWith("req-2", "deny", "not on Fridays");
  });
});
