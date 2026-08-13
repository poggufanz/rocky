import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { how, what } from "../commands/dictionary.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";

export function seeded(): MemoryRecord[] {
  const triple: TripleRecord = {
    kind: "triple", id: "t1", ts: Date.now() - 60_000, cwd: "/w", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: "naikin dikit buttonnya" },
    rationale: { text: "margin adds space", tags: ["spacing"], source: "transcript" },
    mechanism: { files: [{ path: "src/app.css", plusMinus: [3, 1], props: ["margin-top"] }], truncatedFiles: 0 },
  };
  return [triple];
}

function multiSeeded(): MemoryRecord[] {
  const makeTriple = (id: string, ts: number, path: string, property: string): TripleRecord => ({
    kind: "triple", id, ts, cwd: "/w", schemaV: 1, agent: "claude-code", origin: "agent-hook",
    intent: { text: "naikin button" },
    rationale: { text: "small change", tags: ["button"], source: "transcript" },
    mechanism: { files: [{ path, plusMinus: [1, 0], props: [property] }], truncatedFiles: 0 },
  });
  return [
    makeTriple("t1", 1, "src/first.css", "margin-top"),
    makeTriple("t2", 2, "src/second.css", "color"),
    makeTriple("t3", 3, "src/third.css", "padding"),
  ];
}

export function sinks() {
  const sayLines: string[] = [];
  const outLines: string[] = [];
  return { sayLines, outLines, deps: { say: (l: string) => sayLines.push(l), out: (l: string) => outLines.push(l) } };
}

test("what speaks tentative mapping and evidence for a hit", async () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await what(["naikin"], { load: seeded, ...deps }), 0);
  assert.deepEqual(sayLines, ['you say "naikin". it is margin-top. I think. check, question']);
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
  assert.ok(!sayLines.some((line) => line.includes("src/app.css")));
  assert.ok(!outLines.some((line) => line.includes("you say")));
});

test("what with no memory stays in voice and returns 0", async () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await what(["gibberish-zz"], { load: () => [], ...deps }), 0);
  assert.equal(sayLines.length, 1);
  assert.ok(sayLines[0]?.includes("I not hear this before"));
  assert.deepEqual(outLines, []);
});

test("how reminds vocabulary without writing a prompt", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(how(["naikin"], { load: seeded, ...deps }), 0);
  assert.equal(sayLines.length, 1);
  assert.ok(sayLines[0]?.includes('last time you say "naikin", it become margin-top'));
  assert.ok(sayLines[0]?.includes("maybe you mean margin-top, question"));
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
  assert.ok(!outLines.some((line) => line.includes("last time you say")));
});

test("missing query argument returns 2", async () => {
  const whatSinks = sinks();
  assert.equal(await what([], { load: () => [], ...whatSinks.deps }), 2);
  assert.equal(whatSinks.sayLines.length, 1);
  assert.deepEqual(whatSinks.outLines, []);
  const howSinks = sinks();
  assert.equal(how([], { load: () => [], ...howSinks.deps }), 2);
  assert.equal(howSinks.sayLines.length, 1);
  assert.deepEqual(howSinks.outLines, []);
});

test("hostile dictionary values stay bounded, terminal-safe, and question-free", async () => {
  const hostile = seeded()[0] as TripleRecord;
  hostile.intent = { text: `naikin\u001b[31m?\n${"i".repeat(8_000)}\u200b` };
  hostile.mechanism.files[0] = {
    path: `src/\u001b]8;;https://evil.test\u0007${"p".repeat(8_000)}\n.css`,
    plusMinus: [3, 1],
    props: [`margin?\u0000${"x".repeat(8_000)}`],
  };
  const hostileQuery = `naikin?\u001b[2J\n${"q".repeat(8_000)}\u200b`;
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await what([hostileQuery], { load: () => [hostile], ...deps }), 0);

  for (const line of [...sayLines, ...outLines]) {
    assert.ok(!line.includes("\n"), JSON.stringify(line));
    assert.ok(!line.includes("\r"), JSON.stringify(line));
    assert.ok(!line.includes("?"), JSON.stringify(line));
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line), JSON.stringify(line));
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
  }
});

test("what --ai strips flag, ranks deterministic hits, and keeps headline", async () => {
  const { sayLines, outLines, deps } = sinks();
  let calls = 0;
  let observedQuery = "";
  const rank = {
    async run(query: string, hits: readonly { triple: { id: string } }[]) {
      calls += 1;
      observedQuery = query;
      assert.equal(hits.length, 1);
      return ["t1"];
    },
  };
  assert.equal(await what(["--ai", "naikin"], { load: seeded, rank, ...deps }), 0);
  assert.equal(calls, 1);
  assert.equal(observedQuery, "naikin");
  assert.deepEqual(sayLines, ['you say "naikin". it is margin-top. I think. check, question']);
  assert.equal(outLines.length, 1);
});

test("what --ai reorders known hits and appends every omitted hit exactly once", async () => {
  const { sayLines, outLines, deps } = sinks();
  const rank = {
    async run(_query: string, hits: readonly { triple: { id: string } }[]) {
      assert.equal(hits.length, 3);
      return ["t1", "unknown", "t1", "t2"];
    },
  };
  assert.equal(await what(["--ai", "naikin", "button"], { load: multiSeeded, rank, ...deps }), 0);
  assert.equal(sayLines[0], 'you say "naikin button". it is margin-top. I think. check, question');
  assert.equal(outLines.length, 3);
  const expectedOrder = ["src/first.css", "src/second.css", "src/third.css"];
  assert.deepEqual(outLines.map((line) => expectedOrder.find((path) => line.includes(path))), expectedOrder);
  for (const path of expectedOrder) {
    assert.equal(outLines.filter((line) => line.includes(path)).length, 1, path);
  }
  assert.ok(!outLines.some((line) => line.includes("unknown")));
});

test("what --ai speaks model sleeps and keeps evidence on rank failure", async () => {
  const { sayLines, outLines, deps } = sinks();
  const rank = { async run() { return undefined; } };
  assert.equal(await what(["--ai", "naikin"], { load: seeded, rank, ...deps }), 0);
  assert.deepEqual(sayLines, ["model sleeps. I use my own ears.", 'you say "naikin". it is margin-top. I think. check, question']);
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
});

test("what without --ai never touches rank port", async () => {
  const { sayLines, outLines, deps } = sinks();
  let calls = 0;
  const rank = { async run() { calls += 1; return ["t1"]; } };
  assert.equal(await what(["naikin"], { load: seeded, rank, ...deps }), 0);
  assert.equal(calls, 0);
  assert.equal(sayLines.length, 1);
  assert.equal(outLines.length, 1);
});

test("what --ai requests an exact ten-second caller signal", async () => {
  const { sayLines, outLines, deps } = sinks();
  const expectedSignal = new AbortController().signal;
  let observedSignal: AbortSignal | undefined;
  let observedTimeout: number | undefined;
  const originalDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  try {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      enumerable: originalDescriptor?.enumerable ?? false,
      writable: true,
      value: (milliseconds: number) => {
        observedTimeout = milliseconds;
        return expectedSignal;
      },
    });
    const rank = {
      async run(_query: string, _hits: readonly unknown[], signal: AbortSignal) {
        observedSignal = signal;
        return ["t1"];
      },
    };
    assert.equal(await what(["--ai", "naikin"], { load: seeded, rank, ...deps }), 0);
    assert.equal(observedTimeout, 10_000);
    assert.equal(observedSignal, expectedSignal);
    assert.equal(sayLines.length, 1);
    assert.equal(outLines.length, 1);
  } finally {
    if (originalDescriptor) Object.defineProperty(AbortSignal, "timeout", originalDescriptor);
    else Reflect.deleteProperty(AbortSignal, "timeout");
  }
});
