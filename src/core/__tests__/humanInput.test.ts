/**
 * Questions have defaults (015 US5, research R6/R7): in recommended-then-review
 * a question whose every sub-question has a `(Recommended)` option is answered
 * at once and listed for review; anything else waits. Waiting requests persist,
 * and the answer book answers a re-asked request.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { OrchestratorEvent } from "../events.ts";
import {
  askQuestions,
  cancelAll,
  isRecommended,
  questionKey,
  requestToolApproval,
  resolveRequest,
  toolKey,
} from "../humanInput.ts";
import { createInitialState, loadState, mutateState, readState, saveState } from "../state.ts";
import type { RunConfig, UserInputQuestion } from "../types.ts";
import { rmTmp } from "./helpers/git.ts";
import { mkTmpProject } from "./helpers/project.ts";

let dir: string;
let events: OrchestratorEvent[];
const io = () => ({
  projectDir: dir,
  runId: "run-1",
  emit: (e: OrchestratorEvent) => events.push(e),
});

const CONFIG: RunConfig = {
  projectDir: "",
  specDir: "",
  mode: "loop",
  model: "m",
  maxIterations: 1,
  maxTurns: 1,
  taskPhases: "all",
};

beforeEach(async () => {
  dir = mkTmpProject({});
  events = [];
  await saveState(
    dir,
    createInitialState({ ...CONFIG, projectDir: dir }, "run-1", {
      kind: "existing",
      runBranch: null,
    }),
  );
});

afterEach(() => {
  cancelAll();
  rmTmp(dir);
});

function question(text: string, labels: string[]): UserInputQuestion {
  return {
    question: text,
    header: text.slice(0, 10),
    multiSelect: false,
    options: labels.map((label) => ({ label, description: `${label} option` })),
  };
}

const PROVIDER = question("Which payment provider?", ["Stripe (Recommended)", "Adyen"]);
const RUNNER = question("Which test runner?", ["Use vitest (recommended) ", "jest"]);
const OPEN = question("What is the SLA?", ["99.9%", "99.99%"]);

/** Lets a held promise show whether it has settled. */
async function settled<T>(p: Promise<T>): Promise<boolean> {
  let done = false;
  p.then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  return done;
}

test("isRecommended: the label ends in (Recommended), any case, trailing space allowed", () => {
  assert.equal(isRecommended("Use vitest (Recommended)"), true);
  assert.equal(isRecommended("Use vitest (recommended)  "), true);
  assert.equal(isRecommended("Use vitest"), false);
  assert.equal(isRecommended("(Recommended) Use vitest"), false);
});

test("recommended-then-review: every sub-question has a recommended option → answered now, listed for review", async () => {
  const answers = await askQuestions(io(), "004-product-recommendations", [PROVIDER, RUNNER], {
    mode: "recommended-then-review",
    step: "clarify",
  });
  assert.deepEqual(answers, {
    "Which payment provider?": "Stripe (Recommended)",
    "Which test runner?": "Use vitest (recommended) ",
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["user_input_request", "user_input_response", "request_resolved"],
  );
  const resolved = events[2];
  assert.equal(resolved.type === "request_resolved" && resolved.by, "default");
  const state = readState(dir);
  assert.deepEqual(state?.pendingRequests, []);
  assert.deepEqual(
    state?.reviewList.map(({ question: q, answer, entryId, stage }) => ({
      q,
      answer,
      entryId,
      stage,
    })),
    [
      {
        q: "Which payment provider?",
        answer: "Stripe (Recommended)",
        entryId: "004-product-recommendations",
        stage: "clarify",
      },
      {
        q: "Which test runner?",
        answer: "Use vitest (recommended) ",
        entryId: "004-product-recommendations",
        stage: "clarify",
      },
    ],
  );
  const md = fs.readFileSync(path.join(dir, ".dex/questions.md"), "utf-8");
  assert.match(md, /## Answered by default — review \(recommended-then-review\)/);
  assert.match(
    md,
    /- \(004-product-recommendations · clarify\) "Which payment provider\?" → \*\*Stripe\*\* \(recommended\)/,
  );
});

test("recommended-then-review: one sub-question without a marker → the whole question waits", async () => {
  const held = askQuestions(io(), null, [PROVIDER, OPEN], {
    mode: "recommended-then-review",
    step: "plan",
  });
  assert.equal(await settled(held), false);
  const pending = readState(dir)?.pendingRequests ?? [];
  assert.equal(pending.length, 1);
  assert.equal(readState(dir)?.reviewList.length, 0);
  assert.ok(
    resolveRequest(pending[0].id, { kind: "question", answers: { "What is the SLA?": "99.9%" } }),
  );
  assert.deepEqual(await held, { "What is the SLA?": "99.9%" });
});

test("wait mode: even an all-recommended question waits", async () => {
  const held = askQuestions(io(), null, [PROVIDER], { mode: "wait", step: "clarify" });
  assert.equal(await settled(held), false);
  assert.equal(readState(dir)?.pendingRequests.length, 1);
});

test("a waiting question is in state.json and .dex/questions.md, and reads back after a restart", async () => {
  void askQuestions(io(), "004-product-recommendations", [OPEN], { mode: "wait", step: "clarify" });
  const fromDisk = await loadState(dir);
  assert.equal(fromDisk?.pendingRequests[0]?.kind, "question");
  assert.equal(
    fromDisk?.pendingRequests[0]?.kind === "question" &&
      fromDisk.pendingRequests[0].questions[0].question,
    "What is the SLA?",
  );
  const md = fs.readFileSync(path.join(dir, ".dex/questions.md"), "utf-8");
  assert.match(md, /^# Dex — waiting for you$/m);
  assert.match(md, /What is the SLA\?/);
});

test("answer book: a matching key answers the re-asked request and is consumed", async () => {
  mutateState(dir, (s) => ({
    ...s,
    answerBook: [
      { key: questionKey("  What is the SLA? "), answer: "99.99%", at: "t" },
      { key: toolKey("Bash", "git push origin feature-x"), answer: "deny", at: "t" },
      { key: questionKey("Unrelated?"), answer: "x", at: "t" },
    ],
  }));
  assert.deepEqual(await askQuestions(io(), null, [OPEN], { mode: "wait", step: "implement" }), {
    "What is the SLA?": "99.99%",
  });
  const approval = await requestToolApproval(io(), null, {
    toolName: "Bash",
    subject: "git push origin feature-x",
    input: { command: "git push origin feature-x" },
    source: "settings",
  });
  assert.equal(approval.decision, "deny");
  assert.deepEqual(
    readState(dir)?.answerBook.map((b) => b.key),
    [questionKey("Unrelated?")],
  );
  assert.deepEqual(
    events
      .filter((e) => e.type === "request_resolved")
      .map((e) => e.type === "request_resolved" && e.by),
    ["answer_book", "answer_book"],
  );
  assert.deepEqual(readState(dir)?.pendingRequests, []);
});
