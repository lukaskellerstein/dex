import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigestMarkdown, DigestView } from "../DigestView.js";

const getDigest = vi.fn();
vi.mock("../../../services/projectService.js", () => ({
  projectService: { getDigest: (...args: unknown[]) => getDigest(...args) },
}));

const PAGE = [
  "# 003-promo — paused at implement: plan_changed",
  "**Why**: tasks.md changed: T004 was reworded",
  "**Checks**: unit ✗ (red 3 runs in a row) · lint ✓ (flaky ×1)",
  "**Verifier** (review, done gate failed): 1 blocking, 0 minor — one gap\n\n- blocking: empty name greets (src/greet.ts:3)",
  "**Cost**: $1.84 this entry, this run",
].join("\n\n");

afterEach(() => {
  cleanup();
  getDigest.mockReset();
});

describe("DigestMarkdown", () => {
  it("renders the title, bold section labels and the findings list, as text only", () => {
    render(<DigestMarkdown markdown={`${PAGE}\n\n<img src=x onerror=alert(1)>`} />);
    expect(screen.getByRole("heading").textContent).toBe("003-promo — paused at implement: plan_changed");
    expect(screen.getByText("Why").tagName).toBe("STRONG");
    expect(screen.getByRole("listitem").textContent).toBe("blocking: empty name greets (src/greet.ts:3)");
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("DigestView", () => {
  it("fetches the entry's digest and shows it with its path; Close calls back", async () => {
    getDigest.mockResolvedValue({ markdown: PAGE, path: "/p/.dex/digests/003-promo.md" });
    const onClose = vi.fn();
    render(<DigestView projectDir="/p" entryId="003-promo" onClose={onClose} />);
    expect(await screen.findByText("/p/.dex/digests/003-promo.md")).toBeTruthy();
    expect(getDigest).toHaveBeenCalledWith("/p", "003-promo");
    expect(screen.getByTestId("digest-body").textContent).toMatch(/\$1\.84 this entry/);
    fireEvent.click(screen.getByTestId("digest-close"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says so when there is no digest yet", async () => {
    getDigest.mockResolvedValue(null);
    render(<DigestView projectDir="/p" entryId="003-promo" onClose={() => {}} />);
    expect((await screen.findByTestId("digest-none")).textContent).toBe("No digest for 003-promo yet.");
  });
});
