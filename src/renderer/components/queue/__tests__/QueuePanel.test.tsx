import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSnapshot } from "../../../../core/run-snapshot.js";
import { QueuePanel } from "../QueuePanel.js";

const SNAPSHOT: RunSnapshot = {
  state: {
    reviewList: [{ question: "Which store?", answer: "Postgres (Recommended)", entryId: "001-alpha", stage: "clarify", at: "t" }],
  } as unknown as RunSnapshot["state"],
  queue: {
    kind: "existing",
    entries: [
      { id: "001-alpha", title: "Alpha", status: "done", nextStage: null, reason: "verify passed", taskPhase: null, costUsd: 1.5 },
      { id: "002-beta", title: "Beta", status: "active", nextStage: "implement", reason: "phase 2 open", taskPhase: 2, costUsd: 0.25 },
      { id: "003-gamma", title: "Gamma", status: "pending", nextStage: "specify", reason: "no spec", taskPhase: null, costUsd: 0 },
    ],
  },
  errors: [],
};

afterEach(cleanup);

describe("QueuePanel", () => {
  it("one row per entry: status, next stage with its task phase, cost; the total in the heading", () => {
    render(<QueuePanel snapshot={SNAPSHOT} />);
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    expect(screen.getAllByTestId("queue-row-status").map((e) => e.textContent)).toEqual(["done", "active", "pending"]);
    expect(screen.getAllByTestId("queue-row-next").map((e) => e.textContent)).toEqual([
      "—",
      "implement · phase 2",
      "specify",
    ]);
    expect(screen.getByText("$1.75")).toBeTruthy();
  });

  it("lists the answers given by default for review", () => {
    render(<QueuePanel snapshot={SNAPSHOT} />);
    expect(screen.getByTestId("review-list").textContent).toMatch(/\(001-alpha · clarify\) “Which store\?” → Postgres \(Recommended\)/);
  });

  it("shows a validation error with no queue, and nothing without a queue or an error", () => {
    const { rerender } = render(<QueuePanel snapshot={{ state: null, queue: null, errors: ["queue.json: entries must not be empty"] }} />);
    expect(screen.getByTestId("queue-errors").textContent).toMatch(/entries must not be empty/);
    rerender(<QueuePanel snapshot={{ state: null, queue: null, errors: [] }} />);
    expect(screen.queryByTestId("queue-panel")).toBeNull();
  });
});
