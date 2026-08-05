import test from "node:test";
import assert from "node:assert/strict";
import type { RecallWithAiPort } from "../ai/port.js";
import { formatModelExplanation } from "../ai/recall-ai.js";
import { parseRecallArgs, recall } from "../commands/recall.js";
import type { MemoryQueries, RecallHit } from "../core/memory-query.js";
import { phrase, phraseForAct } from "../ui/phrases.js";

function hit(id: string, command = `command-${id}`): RecallHit {
  return {
    failure: {
      kind: "failure",
      id,
      ts: 1_700_000_000_000 + Number(id.slice(1)),
      cwd: "/tmp/recall-command",
      cmd: command,
      exitCode: 1,
      fingerprint: `fp-${id}`,
      signature: [`error-${id}`],
      excerpt: `excerpt-${id}`,
    },
    score: 1,
  };
}

function memoryReturning(
  hits: readonly RecallHit[],
  recent: readonly RecallHit[] = hits,
): { memory: MemoryQueries; inputs: Parameters<MemoryQueries["recall"]>[0][] } {
  const inputs: Parameters<MemoryQueries["recall"]>[0][] = [];
  return {
    inputs,
    memory: {
      recall(input) {
        inputs.push(input);
        return [...hits];
      },
      recentFailures() { return recent.map(({ failure, fix }) => ({ failure, ...(fix === undefined ? {} : { fix }) })); },
      stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
    },
  };
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string; stdout: string }> {
  const originalStderr = process.stderr.write;
  const originalStdout = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), stderr, stdout };
  } finally {
    process.stderr.write = originalStderr;
    process.stdout.write = originalStdout;
  }
}

test("recall parser accepts only a leading ai option and preserves literal query tokens", () => {
  assert.deepEqual(parseRecallArgs(["--ai", "module", "missing"]), { useAi: true, query: "module missing" });
  assert.deepEqual(parseRecallArgs(["--", "--ai", "literal"]), { useAi: false, query: "--ai literal" });
  assert.deepEqual(parseRecallArgs(["error", "--ai"]), { useAi: false, query: "error --ai" });
  assert.throws(() => parseRecallArgs(["--unknown"]), /unknown option/);
});

test("ordinary recall preserves deterministic output and does not invoke the AI port", async () => {
  const source = memoryReturning([hit("c1", "npm test")]);
  const ai: RecallWithAiPort = {
    async run() { throw new Error("AI must not run without --ai"); },
  };
  const output = await captureStderr(() => recall(["npm", "test"], { memory: source.memory, recallWithAi: ai }));

  assert.equal(output.code, 0);
  assert.deepEqual(source.inputs, [{ query: "npm test" }]);
  assert.match(output.stderr, /I remember 1 thing/);
  assert.match(output.stderr, /1\. npm test/);
  assert.equal(output.stdout, "");
});

test("ai recall caps evidence at five, uses raw caller exposure, and renders only validated ranked hits", async () => {
  const source = memoryReturning([hit("c1"), hit("c2"), hit("c3"), hit("c4"), hit("c5"), hit("c6")]);
  let received: Parameters<RecallWithAiPort["run"]>[0] | undefined;
  const ai: RecallWithAiPort = {
    async run(input, signal) {
      received = input;
      assert.equal(signal.aborted, false);
      return {
        aiStatus: "used",
        act: "known_fix",
        rankedCandidateIds: ["c4", "untrusted-id", "c2", "c4"],
        explanation: 'rm -rf / && echo "quoted"\n',
      };
    },
  };
  const output = await captureStderr(() => recall(["--ai", "error"], {
    memory: source.memory,
    recallWithAi: ai,
  }));

  assert.equal(output.code, 0);
  assert.deepEqual(source.inputs, [{ query: "error", limit: 5 }]);
  assert.equal(received?.exposure, "raw");
  assert.deepEqual(received?.hits.map((entry) => entry.failure.id), ["c1", "c2", "c3", "c4", "c5"]);
  assert.match(output.stderr, new RegExp(phraseForAct("known_fix")));
  assert.match(output.stderr, new RegExp(formatModelExplanation('rm -rf / && echo "quoted"\n').replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const headings = [...output.stderr.matchAll(/\d+\. command-(c\d)/g)].map((match) => match[1]);
  assert.deepEqual(headings, ["c4", "c2", "c1", "c3", "c5"]);
  assert.doesNotMatch(output.stderr, /command-c6/);
  assert.equal(output.stdout, "");
});

test("AI failures and non-used outcomes retain deterministic hits and valid recall exit zero", async (t) => {
  const cases: Array<{ name: string; ai: RecallWithAiPort; phrase: string }> = [
    {
      name: "rejected port",
      ai: { async run() { throw new Error("unavailable"); } },
      phrase: phrase("ai-unavailable"),
    },
    {
      name: "low confidence outcome",
      ai: {
        async run() {
          return { aiStatus: "low_confidence", rankedCandidateIds: ["c2", "c1"] };
        },
      },
      phrase: phrase("ai-fallback"),
    },
    {
      name: "malformed port outcome",
      ai: {
        async run() {
          return { aiStatus: "used", rankedCandidateIds: null } as unknown as Awaited<ReturnType<RecallWithAiPort["run"]>>;
        },
      },
      phrase: phrase("ai-unavailable"),
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const source = memoryReturning([hit("c1"), hit("c2")]);
      const output = await captureStderr(() => recall(["--ai", "error"], {
        memory: source.memory,
        recallWithAi: entry.ai,
      }));

      assert.equal(output.code, 0);
      assert.match(output.stderr, new RegExp(entry.phrase));
      const headings = [...output.stderr.matchAll(/\d+\. command-(c\d)/g)].map((match) => match[1]);
      assert.deepEqual(headings, ["c1", "c2"]);
    });
  }
});

test("ai recall with no deterministic hit returns normal no-match exit without inference", async () => {
  const source = memoryReturning([], [hit("remembered-but-not-matching")]);
  let calls = 0;
  const ai: RecallWithAiPort = {
    async run() {
      calls += 1;
      return { aiStatus: "used", rankedCandidateIds: [] };
    },
  };
  const output = await captureStderr(() => recall(["--ai", "unknown"], {
    memory: source.memory,
    recallWithAi: ai,
  }));

  assert.equal(output.code, 1);
  assert.equal(calls, 0);
  assert.match(output.stderr, /nothing match/);
});

test("empty memory retains Rocky's successful empty-memory result without inference", async () => {
  const source = memoryReturning([]);
  let calls = 0;
  const output = await captureStderr(() => recall(["--ai", "unknown"], {
    memory: source.memory,
    recallWithAi: {
      async run() {
        calls += 1;
        return { aiStatus: "used", rankedCandidateIds: [] };
      },
    },
  }));

  assert.equal(output.code, 0);
  assert.equal(calls, 0);
  assert.match(output.stderr, /memory is empty/);
});

test("unknown leading recall options return usage before reading memory", async () => {
  const source = memoryReturning([hit("c1")]);
  const output = await captureStderr(() => recall(["--unknown"], {
    memory: source.memory,
    recallWithAi: { async run() { throw new Error("AI must not run"); } },
  }));

  assert.equal(output.code, 2);
  assert.deepEqual(source.inputs, []);
  assert.match(output.stderr, /unknown option/);
});
