import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../../../../core/run-snapshot.js";
import { QueuePanel } from "../QueuePanel.js";

const SNAPSHOT: RunSnapshot = {
  state: {
    reviewList: [
      {
        question: "Which store?",
        answer: "Postgres (Recommended)",
        entryId: "001-alpha",
        stage: "clarify",
        at: "t",
      },
    ],
  } as unknown as RunSnapshot["state"],
  queue: {
    kind: "existing",
    entries: [
      {
        id: "001-alpha",
        title: "Alpha",
        status: "done",
        nextStage: null,
        reason: "verify passed",
        taskPhase: null,
        costUsd: 1.5,
      },
      {
        id: "002-beta",
        title: "Beta",
        status: "active",
        nextStage: "implement",
        reason: "phase 2 open",
        taskPhase: 2,
        costUsd: 0.25,
      },
      {
        id: "003-gamma",
        title: "Gamma",
        status: "pending",
        nextStage: "specify",
        reason: "no spec",
        taskPhase: null,
        costUsd: 0,
      },
    ],
  },
  errors: [],
  digests: ["002-beta"],
};

vi.mock("../../../services/projectService.js", () => ({
  projectService: {
    getDigest: vi.fn(async (_dir: string, id: string) => ({
      markdown: `# ${id} — paused at implement: stalled\n\n**Cost**: $0.25 this entry, this run\n`,
      path: `/p/.dex/digests/${id}.md`,
    })),
  },
}));

afterEach(cleanup);

describe("QueuePanel", () => {
  it("one row per entry: status, next stage with its task phase, cost; the total in the heading", () => {
    render(<QueuePanel snapshot={SNAPSHOT} />);
    expect(screen.getAllByTestId("queue-row")).toHaveLength(3);
    expect(screen.getAllByTestId("queue-row-status").map((e) => e.textContent)).toEqual([
      "done",
      "active",
      "pending",
    ]);
    expect(screen.getAllByTestId("queue-row-next").map((e) => e.textContent)).toEqual([
      "—",
      "implement · phase 2",
      "specify",
    ]);
    expect(screen.getByText("$1.75")).toBeTruthy();
  });

  it("lists the answers given by default for review", () => {
    render(<QueuePanel snapshot={SNAPSHOT} />);
    expect(screen.getByTestId("review-list").textContent).toMatch(
      /\(001-alpha · clarify\) “Which store\?” → Postgres \(Recommended\)/,
    );
  });

  it("shows a validation error with no queue, and nothing without a queue or an error", () => {
    const { rerender } = render(
      <QueuePanel
        snapshot={{
          state: null,
          queue: null,
          errors: ["queue.json: entries must not be empty"],
          digests: [],
        }}
      />,
    );
    expect(screen.getByTestId("queue-errors").textContent).toMatch(/entries must not be empty/);
    rerender(<QueuePanel snapshot={{ state: null, queue: null, errors: [], digests: [] }} />);
    expect(screen.queryByTestId("queue-panel")).toBeNull();
  });

  it("a Digest button only on an entry with a digest; it opens the digest view, which closes", async () => {
    render(<QueuePanel snapshot={SNAPSHOT} projectDir="/p" />);
    const buttons = screen.getAllByTestId("queue-row-digest");
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(await screen.findByText("002-beta — paused at implement: stalled")).toBeTruthy();
    expect(screen.getByText("/p/.dex/digests/002-beta.md")).toBeTruthy();
    fireEvent.click(screen.getByTestId("digest-close"));
    expect(screen.queryByTestId("digest-view")).toBeNull();
  });

  it("no Digest button without a project dir", () => {
    render(<QueuePanel snapshot={SNAPSHOT} />);
    expect(screen.queryByTestId("queue-row-digest")).toBeNull();
  });
});
