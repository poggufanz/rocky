import test from "node:test";
import assert from "node:assert/strict";
import { composeBrief, parseGitLog, topLevelArea, type BriefInput } from "../core/brief.js";
import { validateOutputLine } from "../ui/phrases.js";

test("parseGitLog reads hash/subject headers and numstat file lines", () => {
  const stdout = [
    "abc1234\tfix: retry once",
    "3\t1\tsrc/payment/retry.ts",
    "10\t0\tsrc/payment/worker.ts",
    "",
    "def5678\tdocs: update readme",
    "-\t-\tassets/logo.png",
  ].join("\n");
  const commits = parseGitLog(stdout);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].hash, "abc1234");
  assert.equal(commits[0].subject, "fix: retry once");
  assert.deepEqual(commits[0].files, [
    { path: "src/payment/retry.ts", churn: 4 },
    { path: "src/payment/worker.ts", churn: 10 },
  ]);
  assert.deepEqual(commits[1].files, [{ path: "assets/logo.png", churn: 0 }]);
});

test("topLevelArea groups by first path segment", () => {
  assert.equal(topLevelArea("src/payment/retry.ts"), "src");
  assert.equal(topLevelArea("README.md"), "(root)");
  assert.equal(topLevelArea("docs\\schema.md"), "docs");
});

function sampleInput(): BriefInput {
  return {
    windowLabel: "24h",
    commits: [
      {
        hash: "abc1234", subject: "fix: retry once",
        files: [{ path: "src/payment/retry.ts", churn: 4 }, { path: "src/payment/worker.ts", churn: 10 }],
      },
    ],
    memoryHits: [{ kind: "failure", ts: 1_800_000_000_000, cmd: "npm test", excerpt: "1 failing" }],
    invariantTouches: [{ invariant: "payment may commit at most once", path: "src/payment/retry.ts" }],
  };
}

test("composeBrief emits five blocks in fixed order", () => {
  const lines = composeBrief(sampleInput());
  const text = lines.join("\n");
  const summaryAt = text.indexOf("1 commit, 2 files");
  const areasAt = text.indexOf("changes by area:");
  const memoryAt = text.indexOf("failures and fixes in window:");
  const invariantAt = text.indexOf('src/payment/retry.ts changed. This path guards: "payment may commit at most once". Worth checking?');
  const explainAt = text.indexOf("explain-ready:");
  assert.ok(summaryAt >= 0 && areasAt > summaryAt && memoryAt > areasAt && invariantAt > memoryAt && explainAt > invariantAt);
  assert.ok(text.includes("  Why did src change?"));
  assert.ok(text.includes("  What is the impact of the change to src/payment/worker.ts?"));
});

test("composeBrief picks the impact file by total churn across commits, not a single commit's peak", () => {
  const input: BriefInput = {
    windowLabel: "24h",
    commits: [
      {
        hash: "aaa1111", subject: "fix: part one",
        files: [
          { path: "src/payment/retry.ts", churn: 30 },
          { path: "src/payment/onceoff.ts", churn: 50 },
        ],
      },
      {
        hash: "bbb2222", subject: "fix: part two",
        files: [{ path: "src/payment/retry.ts", churn: 30 }],
      },
    ],
    memoryHits: [],
    invariantTouches: [],
  };
  const lines = composeBrief(input);
  const text = lines.join("\n");
  assert.ok(text.includes("What is the impact of the change to src/payment/retry.ts?"));
  assert.ok(!text.includes("What is the impact of the change to src/payment/onceoff.ts?"));
});

test("composeBrief with empty window says so and stays quiet on invariants", () => {
  const lines = composeBrief({ windowLabel: "24h", commits: [], memoryHits: [], invariantTouches: [] });
  const text = lines.join("\n");
  assert.ok(text.includes("0 commits"));
  assert.ok(text.includes("none remembered"));
  assert.ok(!text.includes("guards"));
});

test("composeBrief question lines end with a question mark and pass the output rules", () => {
  const lines = composeBrief(sampleInput());
  const questions = lines.filter((line) => line.endsWith("?"));
  // invariant check, one per area, and the biggest-churn impact question
  assert.equal(questions.length, 3);
  for (const line of questions) assert.deepEqual(validateOutputLine(line.trim()), [], line);
  assert.ok(lines.every((line) => !line.includes(", question")));
});

test("composeBrief empty window explains nothing without a question", () => {
  const lines = composeBrief({ windowLabel: "24h", commits: [], memoryHits: [], invariantTouches: [] });
  assert.ok(lines.includes("  Nothing to explain. No changes in this window."));
  assert.ok(lines.every((line) => !line.endsWith("?")));
});
