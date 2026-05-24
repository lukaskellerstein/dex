import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointService,
  CheckpointError,
  type CheckpointErrorCode,
} from "../checkpointService.js";

type CheckpointsApiMock = {
  listTimeline: ReturnType<typeof vi.fn>;
  checkIsRepo: ReturnType<typeof vi.fn>;
  checkIdentity: ReturnType<typeof vi.fn>;
  deleteBranch: ReturnType<typeof vi.fn>;
  promoteSummary: ReturnType<typeof vi.fn>;
  mergeToMain: ReturnType<typeof vi.fn>;
  acceptResolverResult: ReturnType<typeof vi.fn>;
  abortResolverMerge: ReturnType<typeof vi.fn>;
  openInEditor: ReturnType<typeof vi.fn>;
  syncStateFromHead: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
  initRepo: ReturnType<typeof vi.fn>;
  setIdentity: ReturnType<typeof vi.fn>;
};

function makeApi(): CheckpointsApiMock {
  return {
    listTimeline: vi.fn(),
    checkIsRepo: vi.fn(),
    checkIdentity: vi.fn(),
    deleteBranch: vi.fn(),
    promoteSummary: vi.fn(),
    mergeToMain: vi.fn(),
    acceptResolverResult: vi.fn(),
    abortResolverMerge: vi.fn(),
    openInEditor: vi.fn(),
    syncStateFromHead: vi.fn(),
    jumpTo: vi.fn(),
    initRepo: vi.fn(),
    setIdentity: vi.fn(),
  };
}

let api: CheckpointsApiMock;

beforeEach(() => {
  api = makeApi();
  (globalThis as unknown as { window: { dexAPI: { checkpoints: CheckpointsApiMock } } }).window = {
    dexAPI: { checkpoints: api },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkpointService — IPC pass-through", () => {
  it("listTimeline calls dexAPI.checkpoints.listTimeline with projectDir", async () => {
    const snap = {
      checkpoints: [],
      pending: [],
      startingPoint: null,
      commits: [],
      selectedPath: [],
    };
    api.listTimeline.mockResolvedValue(snap);
    const result = await checkpointService.listTimeline("/proj");
    expect(api.listTimeline).toHaveBeenCalledWith("/proj");
    expect(result).toBe(snap);
  });

  it("jumpTo forwards projectDir, sha, and options", async () => {
    api.jumpTo.mockResolvedValue({ ok: true } as never);
    await checkpointService.jumpTo("/proj", "abc123", { force: "discard" });
    expect(api.jumpTo).toHaveBeenCalledWith("/proj", "abc123", { force: "discard" });
  });

  it("deleteBranch, syncStateFromHead pass projectDir + args through", async () => {
    api.deleteBranch.mockResolvedValue({ ok: true, switchedTo: "main", deleted: "x" });
    api.syncStateFromHead.mockResolvedValue({ ok: true, updated: false });

    await checkpointService.deleteBranch("/p", "dex/2026-05-04-abc");
    await checkpointService.deleteBranch("/p", "dex/2026-05-04-abc", { confirmedLoss: true });
    await checkpointService.syncStateFromHead("/p");

    expect(api.deleteBranch).toHaveBeenNthCalledWith(1, "/p", "dex/2026-05-04-abc", undefined);
    expect(api.deleteBranch).toHaveBeenNthCalledWith(2, "/p", "dex/2026-05-04-abc", { confirmedLoss: true });
    expect(api.syncStateFromHead).toHaveBeenCalledWith("/p");
  });
});

describe("checkpointService — error mapping", () => {
  const cases: Array<{
    name: string;
    thrown: Error;
    expectedCode: CheckpointErrorCode;
  }> = [
    { name: "BUSY", thrown: new Error("locked_by_other_instance"), expectedCode: "BUSY" },
    { name: "GIT_DIRTY", thrown: new Error("working tree has uncommitted changes"), expectedCode: "GIT_DIRTY" },
    { name: "INVALID_TAG", thrown: new Error("invalid tag name"), expectedCode: "INVALID_TAG" },
    { name: "TAG_NOT_FOUND", thrown: new Error("tag fixture/x not found"), expectedCode: "TAG_NOT_FOUND" },
    { name: "GIT_FAILURE (fallback)", thrown: new Error("some random git error"), expectedCode: "GIT_FAILURE" },
  ];

  for (const tc of cases) {
    it(`maps "${tc.name}" thrown by IPC to CheckpointError with code ${tc.expectedCode}`, async () => {
      api.listTimeline.mockRejectedValue(tc.thrown);
      await expect(checkpointService.listTimeline("/p")).rejects.toBeInstanceOf(CheckpointError);
      try {
        await checkpointService.listTimeline("/p");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(CheckpointError);
        expect((err as CheckpointError).code).toBe(tc.expectedCode);
        expect((err as CheckpointError).message).toBe(tc.thrown.message);
      }
    });
  }

  it("wraps non-Error throws as GIT_FAILURE", async () => {
    api.jumpTo.mockRejectedValue("plain string");
    try {
      await checkpointService.jumpTo("/p", "sha");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CheckpointError);
      expect((err as CheckpointError).code).toBe("GIT_FAILURE");
    }
  });

  it("preserves existing CheckpointError without re-wrapping", async () => {
    const original = new CheckpointError("INVALID_TAG", "already typed");
    api.listTimeline.mockRejectedValue(original);
    try {
      await checkpointService.listTimeline("/p");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(original);
    }
  });
});

describe("checkpointService — surface completeness", () => {
  it("exposes the documented method set", () => {
    const expected = [
      "listTimeline",
      "checkIsRepo",
      "checkIdentity",
      "deleteBranch",
      "promoteSummary",
      "mergeToMain",
      "acceptResolverResult",
      "abortResolverMerge",
      "openInEditor",
      "syncStateFromHead",
      "jumpTo",
      "initRepo",
      "setIdentity",
    ];
    for (const m of expected) {
      expect(typeof (checkpointService as Record<string, unknown>)[m]).toBe("function");
    }
  });
});
