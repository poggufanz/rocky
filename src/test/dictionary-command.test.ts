import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { digest, exportCommand, how, quiz, what, why } from "../commands/dictionary.js";
import type { MemoryRecord, TripleRecord } from "../core/memory-read.js";

const fullHostileMatrix = [
  "unicode-🪨-工程-e\u0301",
  "\u001b[2J\u001b[H",
  "\u001b]0;fixture-title\u0007",
  "\u001b]8;;https://fixture.invalid\u001b\\link\u001b]8;;\u001b\\",
  "\u001b]52;c;Zml4dHVyZQ==\u0007",
  "\u001bP1;2|dcs\u001b\\",
  "\u001b_apc\u001b\\",
  "bell\u0007back\bcr\r",
  "bidi\u202eoverride\u202c\u2066isolate\u2069",
].join("|");

const terminalInstruction = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function fullHostileRecords(now = Date.now()): { triple: TripleRecord; note: MemoryRecord } {
  const triple: TripleRecord = {
    kind: "triple", id: "hostile-triple", ts: now - 3 * 24 * 60 * 60 * 1000,
    cwd: `cwd-${fullHostileMatrix}`, schemaV: 1, agent: "codex", origin: "agent-hook",
    intent: { text: `matrixneedle ${fullHostileMatrix}` },
    rationale: { text: `reason ${fullHostileMatrix}`, tags: [`tag-${fullHostileMatrix}`], source: "notify" },
    mechanism: {
      head: `head-${fullHostileMatrix}`,
      files: [{
        path: `src/matrixneedle-${fullHostileMatrix}.ts`, plusMinus: [4, 2],
        props: [`prop-${fullHostileMatrix}`], excerpt: `excerpt-${fullHostileMatrix}`,
      }],
      truncatedFiles: 0,
    },
  };
  const note: MemoryRecord = {
    kind: "note", id: "hostile-note", ts: now, cwd: `cwd-${fullHostileMatrix}`,
    cmd: `note-cmd-${fullHostileMatrix}`, file: `file-${fullHostileMatrix}`,
    line: 7, subject: `subject-${fullHostileMatrix}`, answer: `answer-${fullHostileMatrix}`,
  };
  return { triple, note };
}

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

function exportSeeded(now = Date.UTC(2026, 0, 31, 12, 0, 0)): MemoryRecord[] {
  const triple = seeded()[0] as TripleRecord;
  return [
    {
      kind: "failure", id: "f1", ts: now - 2 * 24 * 60 * 60 * 1000, cwd: "/w", cmd: "npm test",
      exitCode: 1, fingerprint: "fp", signature: ["Error"], excerpt: "Error",
    },
    {
      kind: "fix", id: "x1", ts: now - 24 * 60 * 60 * 1000, cwd: "/w", cmd: "npm install", failureIds: ["f1"],
    },
    {
      kind: "note", id: "n1", ts: now - 12 * 60 * 60 * 1000, cwd: "/w", cmd: "rocky note",
      file: "src/app.ts", line: 7, subject: "button", answer: "margin-top",
    },
    { ...triple, id: "t1", ts: now },
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

test("export emits every raw record once in loaded order and keeps sinks separate", () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  const records = exportSeeded(now);
  const stdout: string[] = [];
  const { sayLines, outLines, deps } = sinks();
  let loads = 0;
  assert.equal(exportCommand([], {
    load: () => { loads += 1; return records; },
    stdout: (line: string) => stdout.push(line),
    now,
    ...deps,
  }), 0);
  assert.equal(loads, 1);
  assert.deepEqual(stdout, records.map((record) => JSON.stringify(record)));
  assert.deepEqual(stdout.map((line) => JSON.parse(line)), records);
  assert.deepEqual(sayLines, ["4 record go out. memory is yours. always."]);
  assert.deepEqual(outLines, []);
});

test("explicit raw export preserves the full hostile note and triple records exactly", () => {
  const records = fullHostileRecords();
  const selected: MemoryRecord[] = [records.note, records.triple];
  const stdout: string[] = [];
  const { sayLines, deps } = sinks();
  assert.equal(exportCommand([], {
    load: () => selected,
    stdout: (line: string) => stdout.push(line),
    ...deps,
  }), 0);
  assert.deepEqual(stdout, selected.map((record) => JSON.stringify(record)));
  assert.deepEqual(stdout.map((line) => JSON.parse(line)), selected);
  assert.ok(stdout.some((line) => line.includes("\\u001b[2J")));
  assert.ok(stdout.some((line) => line.includes("\\u001bP1;2|dcs")));
  assert.ok(stdout.some((line) => line.includes("\\u001b_apc")));
  assert.ok(stdout.some((line) => line.includes("\u202eoverride")));
  assert.deepEqual(sayLines, ["2 record go out. memory is yours. always."]);
});

test("dictionary terminal surfaces inertly render the full hostile triple and never render note fields", async () => {
  const now = Date.now();
  const { triple, note } = fullHostileRecords(now);
  const records: MemoryRecord[] = [note, triple];
  const rendered: string[] = [];
  const capture = () => {
    const output = sinks();
    return {
      ...output,
      deps: {
        load: () => records,
        say: (line: string) => { output.sayLines.push(line); rendered.push(line); },
        out: (line: string) => { output.outLines.push(line); rendered.push(line); },
      },
    };
  };

  const whatOutput = capture();
  assert.equal(await what(["matrixneedle"], whatOutput.deps), 0);
  const howOutput = capture();
  assert.equal(how(["matrixneedle"], howOutput.deps), 0);
  const whyOutput = capture();
  assert.equal(why([triple.mechanism.files[0]!.path], whyOutput.deps), 0);
  const digestOutput = capture();
  assert.equal(digest([], { ...digestOutput.deps, now }), 0);
  const quizOutput = capture();
  assert.equal(await quiz([], { ...quizOutput.deps, now, ask: async () => "fixture" }), 0);

  assert.ok(rendered.some((line) => line.includes("unicode-🪨-工程-e\u0301")));
  assert.ok(rendered.every((line) => !line.includes("answer-")), "note answer must not become terminal output");
  for (const line of rendered) {
    assert.doesNotMatch(line, terminalInstruction, JSON.stringify(line));
    assert.doesNotMatch(line, /\u001b/u, JSON.stringify(line));
    assert.doesNotMatch(line, /[\r\n]/u, JSON.stringify(line));
  }
});

test("export repeated kinds form an ordered union without duplicate records", () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  const records = exportSeeded(now);
  const stdout: string[] = [];
  const { sayLines, deps } = sinks();
  assert.equal(exportCommand(["--kind", "failure", "--kind", "triple", "--kind", "failure"], {
    load: () => records,
    stdout: (line: string) => stdout.push(line),
    now,
    ...deps,
  }), 0);
  assert.deepEqual(stdout.map((line) => (JSON.parse(line) as { id: string }).id), ["f1", "t1"]);
  assert.deepEqual(sayLines, ["2 record go out. memory is yours. always."]);
});

test("export since Nd uses invocation time and includes the exact boundary", () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  const records: MemoryRecord[] = [
    { kind: "failure", id: "old", ts: now - 30 * 24 * 60 * 60 * 1000 - 1, cwd: "/w", cmd: "old", exitCode: 1, fingerprint: "old", signature: [], excerpt: "" },
    { kind: "failure", id: "boundary", ts: now - 30 * 24 * 60 * 60 * 1000, cwd: "/w", cmd: "boundary", exitCode: 1, fingerprint: "boundary", signature: [], excerpt: "" },
    { kind: "failure", id: "future", ts: now + 1, cwd: "/w", cmd: "future", exitCode: 1, fingerprint: "future", signature: [], excerpt: "" },
  ];
  const stdout: string[] = [];
  const { sayLines, deps } = sinks();
  assert.equal(exportCommand(["--since", "30d"], { load: () => records, stdout: (line: string) => stdout.push(line), now, ...deps }), 0);
  assert.deepEqual(stdout.map((line) => (JSON.parse(line) as { id: string }).id), ["boundary", "future"]);
  assert.deepEqual(sayLines, ["2 record go out. memory is yours. always."]);
});

test("export since ISO uses an inclusive timestamp cutoff", () => {
  const now = Date.UTC(2026, 0, 31, 12, 0, 0);
  const cutoff = Date.UTC(2026, 0, 15, 0, 0, 0);
  const records: MemoryRecord[] = [
    { kind: "failure", id: "before", ts: cutoff - 1, cwd: "/w", cmd: "before", exitCode: 1, fingerprint: "before", signature: [], excerpt: "" },
    { kind: "failure", id: "at", ts: cutoff, cwd: "/w", cmd: "at", exitCode: 1, fingerprint: "at", signature: [], excerpt: "" },
    { kind: "failure", id: "after", ts: cutoff + 1, cwd: "/w", cmd: "after", exitCode: 1, fingerprint: "after", signature: [], excerpt: "" },
  ];
  const stdout: string[] = [];
  const { sayLines, deps } = sinks();
  assert.equal(exportCommand(["--since", new Date(cutoff).toISOString()], { load: () => records, stdout: (line: string) => stdout.push(line), now, ...deps }), 0);
  assert.deepEqual(stdout.map((line) => (JSON.parse(line) as { id: string }).id), ["at", "after"]);
  assert.deepEqual(sayLines, ["2 record go out. memory is yours. always."]);
});

test("export with zero matches emits no data and still speaks summary", () => {
  const stdout: string[] = [];
  const { sayLines, outLines, deps } = sinks();
  assert.equal(exportCommand(["--kind", "note"], {
    load: seeded,
    stdout: (line: string) => stdout.push(line),
    ...deps,
  }), 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(sayLines, ["0 record go out. memory is yours. always."]);
  assert.deepEqual(outLines, []);
});

test("export invalid kind is rejected before memory load or stdout", () => {
  const stdout: string[] = [];
  const { sayLines, deps } = sinks();
  let loads = 0;
  assert.equal(exportCommand(["--kind", "hologram"], {
    load: () => { loads += 1; return exportSeeded(); },
    stdout: (line: string) => stdout.push(line),
    ...deps,
  }), 2);
  assert.equal(loads, 0);
  assert.deepEqual(stdout, []);
  assert.deepEqual(sayLines, ["export takes --kind failure|fix|note|triple and --since 30d. try again, question"]);
});

test("export missing or invalid values, unknown flags, and positional junk are rejected atomically", () => {
  const cases: string[][] = [
    ["--kind"],
    ["--since"],
    ["--since", "not-a-date"],
    ["--unknown"],
    ["memory.jsonl"],
    ["--kind", "failure", "junk"],
  ];
  for (const argv of cases) {
    const stdout: string[] = [];
    const { sayLines, deps } = sinks();
    let loads = 0;
    assert.equal(exportCommand(argv, {
      load: () => { loads += 1; return exportSeeded(); },
      stdout: (line: string) => stdout.push(line),
      ...deps,
    }), 2, argv.join(" "));
    assert.equal(loads, 0, argv.join(" "));
    assert.deepEqual(stdout, [], argv.join(" "));
    assert.deepEqual(sayLines, ["export takes --kind failure|fix|note|triple and --since 30d. try again, question"], argv.join(" "));
  }
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

test("why quotes rationale as hearsay, newest first", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why(["src/app.css"], { load: seeded, ...deps }), 0);
  const joined = [...sayLines, ...outLines].join("\n");
  assert.ok(joined.includes("agent say: margin adds space. I only hear. correct, question"));
  assert.ok(!joined.includes("?"));
});

test("why renders evidence for queried second file in one multi-file triple", () => {
  const triple: TripleRecord = {
    kind: "triple", id: "multi-file-why", ts: Date.now(), cwd: "/w", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "change two files" },
    rationale: { text: "keep styles aligned", tags: [], source: "notify" },
    mechanism: {
      files: [
        { path: "src/first.ts", plusMinus: [2, 0], props: ["first"] },
        { path: "src/second.ts", plusMinus: [7, 3], props: ["second"] },
      ],
      truncatedFiles: 0,
    },
  };
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why(["src/second.ts"], { load: () => [triple], ...deps }), 0);
  assert.ok(outLines.some((line) => line.includes("src/second.ts +7 -3")));
  assert.equal(outLines.some((line) => line.includes("src/first.ts +2 -0")), false);
  assert.ok(sayLines.some((line) => line.includes("agent say: keep styles aligned")));
});

test("why without rationale reports change without reason", () => {
  const records = seeded().map((record) => record.kind === "triple" ? { ...record, rationale: undefined } : record);
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why(["src/app.css"], { load: () => records, ...deps }), 0);
  assert.ok([...sayLines, ...outLines].join("\n").includes("change happen. no reason I hear."));
});

test("why on unknown file and missing arg", () => {
  const unknown = sinks();
  assert.equal(why(["ghost.css"], { load: () => [], ...unknown.deps }), 0);
  assert.ok(unknown.sayLines.join("\n").includes("I not know if agent touch"));
  assert.equal(unknown.sayLines.join("\n").includes("nobody touch this while I listen"), false);

  const missing = sinks();
  assert.equal(why([], { load: () => [], ...missing.deps }), 2);
  assert.equal(missing.outLines.length, 0);
});

test("why keeps hostile rationale, tags, and paths bounded and terminal-safe", () => {
  const hostile = seeded()[0] as TripleRecord;
  const hostilePath = `src/\u001b]8;;https://evil.test\u0007${"p".repeat(8_000)}\n.css`;
  hostile.rationale = {
    text: `agent?\u001b[31m\n${"r".repeat(8_000)}`,
    tags: [`tag?\u0000${"t".repeat(8_000)}`],
    source: "transcript",
  };
  hostile.mechanism.files[0] = {
    path: hostilePath,
    plusMinus: [3, 1],
    props: ["margin-top"],
  };
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why([hostilePath], { load: () => [hostile], ...deps }), 0);
  assert.ok(sayLines.some((line) => line.startsWith("agent say:")));
  assert.ok(outLines.some((line) => line.includes("tags:")));

  for (const line of [...sayLines, ...outLines]) {
    assert.ok(!line.includes("\n"), JSON.stringify(line));
    assert.ok(!line.includes("\r"), JSON.stringify(line));
    assert.ok(!line.includes("?"), JSON.stringify(line));
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line), JSON.stringify(line));
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
  }
});

test("digest speaks pattern headline and bucket lines", () => {
  const t = (ts: number, intent: string, tags: string[]) => ({
    ...seeded()[0],
    id: intent,
    ts,
    intent: { text: intent },
    rationale: { text: "r", tags, source: "transcript" as const },
  });
  const now = Date.now();
  const records = [
    t(now - 1_000, "a", ["flexbox"]),
    t(now - 2_000, "b", ["flexbox"]),
    t(now - 3_000, "c", ["flexbox"]),
  ] as MemoryRecord[];
  const { sayLines, outLines, deps } = sinks();
  assert.equal(digest([], { load: () => records, now, ...deps }), 0);
  assert.ok(sayLines.join("\n").includes("3 intent this week. flexbox again and again. pattern, question"));
  assert.ok(outLines.join("\n").includes("flexbox: 3"));
  assert.ok(![...sayLines, ...outLines].join("\n").includes("?"));
});

test("digest counts triples directly when one triple has multiple tags", () => {
  const now = Date.now();
  const records = [seeded()[0], {
    ...seeded()[0],
    id: "multi-tag",
    ts: now - 1_000,
    rationale: { text: "r", tags: ["flexbox", "spacing"], source: "transcript" as const },
  }] as MemoryRecord[];
  const { sayLines, outLines, deps } = sinks();
  assert.equal(digest([], { load: () => records, now, ...deps }), 0);
  assert.ok(sayLines[0]?.startsWith("2 intent this week."));
  assert.equal(outLines.filter((line) => line.startsWith("flexbox:")).length, 1);
  assert.equal(outLines.filter((line) => line.startsWith("spacing:")).length, 1);
});

test("digest empty week stays quiet good", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(digest([], { load: () => [], now: Date.now(), ...deps }), 0);
  assert.ok(sayLines.join("\n").includes("quiet week. no intent I hear. quiet good good."));
  assert.deepEqual(outLines, []);
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

test("quiz asks from own history, reveals, never grades", async () => {
  const old = seeded().map((record) => ({ ...record, ts: Date.now() - 3 * 24 * 60 * 60 * 1000 }));
  const { sayLines, outLines, deps } = sinks();
  const asked: string[] = [];
  const code = await quiz([], {
    load: () => old as MemoryRecord[],
    now: Date.now(),
    ask: async (message) => { asked.push(message); return "margin"; },
    ...deps,
  });
  assert.equal(code, 0);
  const joined = [...sayLines, ...outLines].join("\n");
  assert.ok(joined.includes('you say "naikin dikit buttonnya". what it become, question'));
  assert.ok(joined.includes("I remember: margin-top."));
  assert.ok(joined.includes("you know better than me. good good."));
  assert.deepEqual(asked, ["your answer: "]);
  for (const banned of ["wrong", "correct!", "score", "?"]) assert.ok(!joined.includes(banned));
});

test("quiz with nothing old enough", async () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await quiz([], { load: seeded, now: Date.now(), ask: async () => "x", ...deps }), 0);
  assert.ok(sayLines.join("\n").includes("nothing old enough to ask. work more, come back, question"));
  assert.deepEqual(outLines, []);
});

test("quiz refuses default reader when stdin is not a TTY", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  try {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    const { sayLines, outLines } = sinks();
    let loads = 0;
    assert.equal(await quiz([], {
      load: () => { loads += 1; throw new Error("memory must not load"); },
      say: (line) => sayLines.push(line),
      out: (line) => outLines.push(line),
    }), 0);
    assert.equal(loads, 0);
    assert.deepEqual(sayLines, ["quiz needs terminal with you in it. later, question"]);
    assert.deepEqual(outLines, []);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", descriptor);
  }
});

test("quiz keeps hostile memory text bounded, terminal-safe, and question-free", async () => {
  const hostile = seeded()[0] as TripleRecord;
  hostile.intent = { text: `naikin?\u001b[31m\n${"i".repeat(8_000)}\u200b` };
  hostile.mechanism.files[0] = {
    path: `src/\u001b]8;;https://evil.test\u0007${"p".repeat(8_000)}\n.css`,
    plusMinus: [3, 1],
    props: [`margin?\u0000${"x".repeat(8_000)}`],
  };
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await quiz([], {
    load: () => [{ ...hostile, ts: Date.now() - 3 * 24 * 60 * 60 * 1000 }],
    now: Date.now(),
    ask: async () => "x",
    ...deps,
  }), 0);
  for (const line of [...sayLines, ...outLines]) {
    assert.ok(!line.includes("\n"), JSON.stringify(line));
    assert.ok(!line.includes("\r"), JSON.stringify(line));
    assert.ok(!line.includes("?"), JSON.stringify(line));
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line), JSON.stringify(line));
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
  }
});
