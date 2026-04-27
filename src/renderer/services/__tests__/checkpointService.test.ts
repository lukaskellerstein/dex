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
  estimateVariantCost: ReturnType<typeof vi.fn>;
  readPendingVariantGroups: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
  unmark: ReturnType<typeof vi.fn>;
  unselect: ReturnType<typeof vi.fn>;
  syncStateFromHead: ReturnType<typeof vi.fn>;
  jumpTo: ReturnType<typeof vi.fn>;
  spawnVariants: ReturnType<typeof vi.fn>;
  cleanupVariantGroup: ReturnType<typeof vi.fn>;
  initRepo: ReturnType<typeof vi.fn>;
  setIdentity: ReturnType<typeof vi.fn>;
  compareAttempts: ReturnType<typeof vi.fn>;
};

function makeApi(): CheckpointsApiMock {
  return {
    listTimeline: vi.fn(),
    checkIsRepo: vi.fn(),
    checkIdentity: vi.fn(),
    estimateVariantCost: vi.fn(),
    readPendingVariantGroups: vi.fn(),
    promote: vi.fn(),
    unmark: vi.fn(),
    unselect: vi.fn(),
    syncStateFromHead: vi.fn(),
    jumpTo: vi.fn(),
    spawnVariants: vi.fn(),
    cleanupVariantGroup: vi.fn(),
    initRepo: vi.fn(),
    setIdentity: vi.fn(),
    compareAttempts: vi.fn(),
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
      attempts: [],
      currentAttempt: null,
      pending: [],
      captureBranches: [],
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

  it("promote, unmark, unselect, syncStateFromHead pass projectDir + args through", async () => {
    api.promote.mockResolvedValue({ ok: true });
    api.unmark.mockResolvedValue({ ok: true, deleted: ["t1"] });
    api.unselect.mockResolvedValue({ ok: true, switchedTo: "main", deleted: "x" });
    api.syncStateFromHead.mockResolvedValue({ ok: true, updated: false });

    await checkpointService.promote("/p", "checkpoint/x", "sha");
    await checkpointService.unmark("/p", "sha");
    await checkpointService.unselect("/p", "branch");
    await checkpointService.syncStateFromHead("/p");

    expect(api.promote).toHaveBeenCalledWith("/p", "checkpoint/x", "sha");
    expect(api.unmark).toHaveBeenCalledWith("/p", "sha");
    expect(api.unselect).toHaveBeenCalledWith("/p", "branch");
    expect(api.syncStateFromHead).toHaveBeenCalledWith("/p");
  });

  it("spawnVariants forwards request payload", async () => {
    api.spawnVariants.mockResolvedValue({ ok: true, result: { groupId: "g", variants: [] } });
    const req = { fromCheckpoint: "checkpoint/y", variantLetters: ["a", "b"], step: "specify" } as never;
    await checkpointService.spawnVariants("/p", req);
    expect(api.spawnVariants).toHaveBeenCalledWith("/p", req);
  });

  it("estimateVariantCost forwards step + variantCount", async () => {
    api.estimateVariantCost.mockResolvedValue({
      perVariantMedian: 1,
      perVariantP75: 2,
      totalMedian: 3,
      totalP75: 4,
      sampleSize: 5,
    });
    await checkpointService.estimateVariantCost("/p", "specify" as never, 3);
    expect(api.estimateVariantCost).toHaveBeenCalledWith("/p", "specify", 3);
  });

  it("compareAttempts forwards branchA, branchB, step", async () => {
    api.compareAttempts.mockResolvedValue({ ok: true, diff: "", mode: "stat" });
    await checkpointService.compareAttempts("/p", "a", "b", "tasks" as never);
    expect(api.compareAttempts).toHaveBeenCalledWith("/p", "a", "b", "tasks");
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
    { name: "WORKTREE_LOCKED", thrown: new Error("worktree lock present"), expectedCode: "WORKTREE_LOCKED" },
    { name: "INVALID_TAG", thrown: new Error("invalid tag name"), expectedCode: "INVALID_TAG" },
    { name: "TAG_NOT_FOUND", thrown: new Error("tag fixture/x not found"), expectedCode: "TAG_NOT_FOUND" },
    { name: "VARIANT_GROUP_MISSING", thrown: new Error("variant-group missing for g"), expectedCode: "VARIANT_GROUP_MISSING" },
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
      "estimateVariantCost",
      "readPendingVariantGroups",
      "promote",
      "unmark",
      "unselect",
      "syncStateFromHead",
      "jumpTo",
      "spawnVariants",
      "cleanupVariantGroup",
      "initRepo",
      "setIdentity",
      "compareAttempts",
    ];
    for (const m of expected) {
      expect(typeof (checkpointService as Record<string, unknown>)[m]).toBe("function");
    }
  });
});
