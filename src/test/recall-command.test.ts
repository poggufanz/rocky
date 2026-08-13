import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { OllamaClient } from "../ai/ollama.js";
import type { RecallWithAiPort } from "../ai/port.js";
import { createRecallAiPort, formatModelExplanation } from "../ai/recall-ai.js";
import { parseRecallArgs, recall } from "../commands/recall.js";
import type { FixLink } from "../core/memory-read.js";
import type { MemoryQueries, RecallHit } from "../core/memory-query.js";
import { MAX_FIELD_BYTES } from "../mcp/privacy.js";
import { phrase, phraseForAct, validateRockyPhrase } from "../ui/phrases.js";
import { elapsed } from "../ui/rocky.js";

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

function hitWithFix(id: string, fixElapsedMs: number, links?: FixLink[]): RecallHit {
  const base = hit(id);
  return {
    ...base,
    fix: {
      kind: "fix",
      id: `fix-${id}`,
      ts: base.failure.ts + fixElapsedMs,
      cwd: base.failure.cwd,
      cmd: `fix-for-${id}`,
      failureIds: [base.failure.id],
      ...(links === undefined ? {} : { links }),
    },
  };
}

function maximumRawHit(index: number, marker: string): RecallHit {
  const field = String(index).repeat(MAX_FIELD_BYTES);
  return {
    failure: {
      kind: "failure", id: field, ts: index, cwd: field, cmd: `${marker} ${field}`, exitCode: 1,
      fingerprint: field, signature: [field], excerpt: field,
    },
    fix: {
      kind: "fix", id: field, ts: index, cwd: field, cmd: field, failureIds: [field],
    },
    score: 1,
  };
}

function enabledAiPort(output: Record<string, unknown>, prompts: string[]): RecallWithAiPort {
  const ollama: OllamaClient = {
    async listInstalledModels() { return []; },
    async probeModel() { return { supported: true }; },
    async generateStructured(_model, prompt) {
      prompts.push(prompt);
      return output;
    },
  };
  return createRecallAiPort({
    loadConfig: () => ({
      status: "valid",
      path: "/test/config.json",
      config: { version: 1, ai: { enabled: true, provider: "ollama", model: "test-model", exposure: "raw" } },
    }),
    ollama,
  });
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
      searchKnowledge() { return []; }, fetchRecord() { return undefined; }, whyFile() { return []; },
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

test("elapsed returns the bare span with no suffix", () => {
  assert.equal(elapsed(0), "just now");
  assert.equal(elapsed(59_000), "just now");
  assert.equal(elapsed(60_000), "1 minute");
  assert.equal(elapsed(120_000), "2 minutes");
  assert.equal(elapsed(6 * 3600_000), "6 hours");
  assert.equal(elapsed(3 * 86_400_000), "3 days");
});

test("recall speaks a strong link for a same-command fix", async () => {
  const source = memoryReturning([hitWithFix("c1", 2 * 60_000, [{ id: "c1", basis: "signature" }])]);
  const noAi: RecallWithAiPort = { async run() { throw new Error("AI must not run without --ai"); } };
  const output = await captureStderr(() => recall(["npm", "test"], { memory: source.memory, recallWithAi: noAi }));

  assert.equal(output.code, 0);
  assert.match(output.stderr, /fixed with: fix-for-c1/);
  assert.match(output.stderr, /same command, 2 minutes later\. strong\./);
  assert.deepEqual(validateRockyPhrase("same command, 2 minutes later. strong."), []);
});

test("recall speaks a weak link for a same-program fix", async () => {
  const source = memoryReturning([hitWithFix("c1", 6 * 3600_000, [{ id: "c1", basis: "program" }])]);
  const noAi: RecallWithAiPort = { async run() { throw new Error("AI must not run without --ai"); } };
  const output = await captureStderr(() => recall(["npm", "test"], { memory: source.memory, recallWithAi: noAi }));

  assert.equal(output.code, 0);
  assert.match(output.stderr, /same program, 6 hours later\. maybe not fix\. check, question/);
  assert.deepEqual(validateRockyPhrase("same program, 6 hours later. maybe not fix. check, question"), []);
});

test("recall stays silent about link basis when links are missing or don't cover this failure", async () => {
  const source = memoryReturning([
    hitWithFix("c1", 60_000), // v0.2.1-era fix record: no links field at all
    hitWithFix("c2", 60_000, [{ id: "not-c2", basis: "signature" }]), // links present, none match this failure
  ]);
  const noAi: RecallWithAiPort = { async run() { throw new Error("AI must not run without --ai"); } };
  const output = await captureStderr(() => recall(["npm", "test"], { memory: source.memory, recallWithAi: noAi }));

  assert.equal(output.code, 0);
  assert.doesNotMatch(output.stderr, /same command,/);
  assert.doesNotMatch(output.stderr, /same program,/);
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
        evidenceRefs: ["c4.failure"],
        confidence: 0.82,
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

test("CLI renders the original c3 when raw projection skips oversized c2", async () => {
  const third = hit("c3", "original third command");
  const source = memoryReturning([
    maximumRawHit(1, "original first command"),
    maximumRawHit(2, "oversized middle command"),
    third,
  ]);
  const prompts: string[] = [];
  const port = enabledAiPort({
    act: "unresolved",
    ranked_candidates: ["c3", "c1"],
    evidence_refs: ["c3.failure"],
    confidence: 0.9,
    explanation: "Third failure is strongest match.",
  }, prompts);

  const output = await captureStderr(() => recall(["--ai", "error"], {
    memory: source.memory,
    recallWithAi: port,
  }));
  const prompt = JSON.parse(prompts[0]) as { candidates: Array<{ id: string; failure: { command: string } }> };

  assert.equal(output.code, 0);
  assert.deepEqual(prompt.candidates.map((candidate) => candidate.id), ["c1", "c3"]);
  assert.equal(prompt.candidates.find((candidate) => candidate.id === "c3")?.failure.command, "original third command");
  assert.match(output.stderr, /1\. original third command/);
  assert.ok(output.stderr.indexOf("original third command") < output.stderr.indexOf("original first command"));
  assert.ok(output.stderr.indexOf("original first command") < output.stderr.indexOf("oversized middle command"));
});

test("CLI bounds a 500k AI query within a conservative runtime", { timeout: 30_000 }, async () => {
  const source = memoryReturning([hit("c1", "query target")]);
  const prompts: string[] = [];
  const port = enabledAiPort({
    act: "unresolved",
    ranked_candidates: ["c1"],
    evidence_refs: ["c1.failure"],
    confidence: 0.9,
    explanation: "One deterministic match.",
  }, prompts);
  const query = "q".repeat(500_000);
  const started = performance.now();

  const output = await captureStderr(() => recall(["--ai", query], {
    memory: source.memory,
    recallWithAi: port,
  }));
  const elapsedMs = performance.now() - started;
  const prompt = JSON.parse(prompts[0]) as { query: string; truncatedFields: string[] };

  assert.equal(output.code, 0);
  assert.ok(Buffer.byteLength(prompts[0], "utf8") <= 8 * 1024);
  assert.ok(prompt.truncatedFields.includes("query"));
  assert.ok(prompt.query.length < query.length);
  assert.ok(elapsedMs < 5_000, `500k CLI recall took ${elapsedMs.toFixed(1)}ms`);
});

test("AI failures and malformed used outcomes retain deterministic hits and valid recall exit zero", async (t) => {
  const cases: Array<{ name: string; ai: RecallWithAiPort; phrase: string; unsafeExplanation?: string }> = [
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
      phrase: phrase("ai-fallback"),
    },
    {
      name: "used outcome with invalid act",
      ai: {
        async run() {
          return {
            aiStatus: "used",
            act: "not-an-act",
            rankedCandidateIds: ["c2", "c1"],
            explanation: "invalid act explanation must not render",
          } as unknown as Awaited<ReturnType<RecallWithAiPort["run"]>>;
        },
      },
      phrase: phrase("ai-fallback"),
      unsafeExplanation: "invalid act explanation must not render",
    },
    {
      name: "used outcome without act",
      ai: {
        async run() {
          return {
            aiStatus: "used",
            rankedCandidateIds: ["c2", "c1"],
            explanation: "missing act explanation must not render",
          };
        },
      },
      phrase: phrase("ai-fallback"),
      unsafeExplanation: "missing act explanation must not render",
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
      if (entry.unsafeExplanation !== undefined) assert.doesNotMatch(output.stderr, new RegExp(entry.unsafeExplanation));
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

test("a memory read failure on the second (recentFailures) call cannot leak a raw Node error (Minor 3)", async () => {
  const memory: MemoryQueries = {
    recall() { return []; },
    recentFailures() { throw new Error("EISDIR: illegal operation on a directory"); },
    stats() { return { failures: 0, fixEvents: 0, resolved: 0, unresolved: 0 }; },
    searchKnowledge() { return []; }, fetchRecord() { return undefined; }, whyFile() { return []; },
  };
  const output = await captureStderr(() => recall(["nothing", "matches"], {
    memory,
    recallWithAi: { async run() { throw new Error("AI must not run"); } },
  }));

  assert.equal(output.code, 1);
  assert.match(output.stderr, /memory file does not open for me\. I answer from nothing\./);
  assert.doesNotMatch(output.stderr, /EISDIR/);
});
