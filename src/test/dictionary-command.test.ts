import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digest, exportCommand, how, quiz, what, why } from "../commands/dictionary.js";
import type { MemoryCoverage, MemoryRecord, RationaleRecord, TripleRecord } from "../core/memory-read.js";
import { pathIdentityHash } from "../core/memory-read.js";
import { MAX_WHY_RECORDS } from "../core/memory-query.js";
import { phrase, validateOutputLine } from "../ui/phrases.js";
import { prompt } from "../ui/rocky.js";
import { setVerbose } from "./verbose-switch.js";

const noRecordNamesFile = (path: string): string => `No record names "${path}". It is not known whether an agent touched it.`;
const coverageIncompleteLine = (path: string): string => `Coverage is incomplete, so it is not known whether an agent touched "${path}".`;
/** What what and how print when the read was incomplete and nothing matched. */
const COVERAGE_UNKNOWN_MATCH = "Memory coverage is incomplete, so it is not known whether anything matches. See the coverage line below.";
/** The claims of absence that an incomplete or unmatched answer must never make. */
const CLAIMS_NOBODY_TOUCHED = /nobody touched|no agent touched|never touched/iu;
/** A rocky-authored question closes its line with `?`; recorded text never brings one onto a line. */
const hasInnerQuestionMark = (line: string): boolean => line.slice(0, -1).includes("?");
/** The record ids and internal labels that default output must not print. */
const INTERNAL_LABELS = /id=|triple-|confidence=|source=|\bts=|fidelity=|coverage=/u;

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
  assert.deepEqual(sayLines, ['Possible match for "naikin": a recorded intent became margin-top. Check the evidence.']);
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
  assert.ok(!sayLines.some((line) => line.includes("src/app.css")));
  assert.ok(!outLines.some((line) => line.includes("Possible match")));
});

test("what and how disclose incomplete coverage even when a hit exists", async () => {
  const incomplete: MemoryCoverage = {
    version: 1,
    scanned: 1,
    skipped: 1,
    truncated: 0,
    bytesScanned: 10,
    bytesTotal: 10,
    complete: false,
  };
  const whatOutput = sinks();
  assert.equal(await what(["naikin"], {
    load: seeded,
    coverage: () => incomplete,
    ...whatOutput.deps,
  }), 0);
  assert.ok(whatOutput.outLines.some((line) => line.includes("memory coverage incomplete")));

  const howOutput = sinks();
  assert.equal(how(["naikin"], {
    load: seeded,
    coverage: () => incomplete,
    ...howOutput.deps,
  }), 0);
  assert.ok(howOutput.outLines.some((line) => line.includes("memory coverage incomplete")));
});

test("an incomplete read never answers as if nothing matched, was quiet, or was old enough", async () => {
  const incomplete: MemoryCoverage = {
    version: 1, scanned: 1, skipped: 1, truncated: 0, bytesScanned: 10, bytesTotal: 10, complete: false,
  };
  const base = { load: () => [] as MemoryRecord[], coverage: () => incomplete };
  const expectations: ReadonlyArray<readonly [string, () => Promise<ReturnType<typeof sinks>>, string]> = [
    ["what", async () => { const o = sinks(); await what(["naikin"], { ...base, ...o.deps }); return o; }, COVERAGE_UNKNOWN_MATCH],
    ["how", async () => { const o = sinks(); how(["naikin"], { ...base, ...o.deps }); return o; }, COVERAGE_UNKNOWN_MATCH],
    ["digest", async () => { const o = sinks(); digest([], { ...base, ...o.deps }); return o; },
      "Memory coverage is incomplete, so it is not known whether the week was quiet. See the coverage line below."],
    ["quiz", async () => { const o = sinks(); await quiz([], { ...base, ask: async () => "x", ...o.deps }); return o; },
      "Memory coverage is incomplete, so it is not known whether anything is old enough to ask about. See the coverage line below."],
  ];
  for (const [name, run, expected] of expectations) {
    const output = await run();
    assert.deepEqual(output.sayLines, [expected], name);
    assert.equal(output.outLines.length, 1, `${name} prints the coverage line below it`);
    assert.deepEqual(validateOutputLine(expected), [], name);
  }

  const exported = sinks();
  assert.equal(exportCommand([], { ...base, stdout: () => assert.fail("nothing may be exported"), ...exported.deps }), 1);
  assert.deepEqual(exported.sayLines, ["Memory coverage is incomplete. Nothing was exported, because a partial export could pass for a complete one."]);
  assert.equal(exported.outLines.length, 1);
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
  assert.deepEqual(sayLines, ["Exported 4 records."]);
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
  assert.deepEqual(sayLines, ["Exported 2 records."]);
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
  assert.deepEqual(sayLines, ["Exported 2 records."]);
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
  assert.deepEqual(sayLines, ["Exported 2 records."]);
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
  assert.deepEqual(sayLines, ["Exported 2 records."]);
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
  assert.deepEqual(sayLines, ["Exported 0 records."]);
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
  assert.deepEqual(sayLines, ["Export takes --kind failure|fix|note|triple and --since 30d."]);
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
    assert.deepEqual(sayLines, ["Export takes --kind failure|fix|note|triple and --since 30d."], argv.join(" "));
  }
});

test("what with no memory says no record matches and returns 0", async () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await what(["gibberish-zz"], { load: () => [], ...deps }), 0);
  assert.deepEqual(sayLines, ['No record matches "gibberish-zz".']);
  assert.deepEqual(validateOutputLine(sayLines[0] ?? ""), []);
  assert.deepEqual(outLines, []);
});

test("what and how do not conclude from intent-only triples", async () => {
  const intentOnly: TripleRecord = {
    ...seeded()[0] as TripleRecord,
    id: "intent-only",
    intent: { text: "change button" },
    mechanism: { files: [], truncatedFiles: 0, baseline: "captured", coverageStatus: "complete" },
  };
  const whatOutput = sinks();
  assert.equal(await what(["change", "button"], { load: () => [intentOnly], now: intentOnly.ts, ...whatOutput.deps }), 0);
  assert.deepEqual(whatOutput.sayLines, ['No record matches "change button".']);
  assert.equal(whatOutput.sayLines.some((line) => line.includes("Possible match")), false);
  assert.deepEqual(whatOutput.outLines, []);

  const howOutput = sinks();
  assert.equal(how(["change", "button"], { load: () => [intentOnly], now: intentOnly.ts, ...howOutput.deps }), 0);
  assert.deepEqual(howOutput.sayLines, ['No record matches "change button".']);
  assert.equal(howOutput.sayLines.some((line) => line.includes("it became")), false);
  assert.deepEqual(howOutput.outLines, []);
});

test("how reminds vocabulary without writing a prompt", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(how(["naikin"], { load: seeded, ...deps }), 0);
  assert.equal(sayLines.length, 1);
  assert.equal(sayLines[0], 'Last time you said "naikin", it became margin-top. You may mean margin-top.');
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
  assert.ok(!outLines.some((line) => line.includes("Last time you said")));
});

test("why quotes rationale as hearsay, newest first", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why(["src/app.css"], { load: seeded, ...deps }), 0);
  const joined = [...sayLines, ...outLines].join("\n");
  assert.ok(joined.includes("Agent said: margin adds space. Recorded, not verified."));
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
  assert.ok(sayLines.some((line) => line.includes("Agent said: keep styles aligned")));
});

test("why chooses exact witness before a suffix in one triple", () => {
  const triple: TripleRecord = {
    kind: "triple", id: "exact-before-suffix", ts: Date.now(), cwd: "/w", schemaV: 1,
    agent: "codex", origin: "agent-hook", rationale: { text: "exact witness", tags: [], source: "notify" },
    mechanism: {
      files: [
        { path: "web/src/index.ts", plusMinus: [1, 0], props: ["suffix"] },
        { path: "src/index.ts", plusMinus: [9, 2], props: ["exact"] },
      ],
      truncatedFiles: 0,
    },
  };
  const output = sinks();
  assert.equal(why(["src/index.ts"], { load: () => [triple], ...output.deps }), 0);
  assert.ok(output.outLines.some((line) => line.includes("src/index.ts +9 -2")));
  assert.equal(output.outLines.some((line) => line.includes("web/src/index.ts +1 -0")), false);
});

test("why discloses ambiguous index suffixes instead of choosing one rationale", () => {
  const make = (id: string, path: string): TripleRecord => ({
    kind: "triple", id, ts: 100, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    rationale: { text: id, tags: [], source: "notify" },
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  const output = sinks();
  assert.equal(why(["index.ts"], { load: () => [make("one", "one/index.ts"), make("two", "two/index.ts")], ...output.deps, now: 100 }), 0);
  assert.ok(output.sayLines.some((line) => line.includes("matches more than one path")));
  assert.equal(output.sayLines.some((line) => line.includes("Agent said: one")), false);
  assert.equal(output.sayLines.some((line) => line.includes("Agent said: two")), false);
});

test("why keeps unmatched relative-root paths unknown", () => {
  const triple: TripleRecord = {
    ...seeded()[0] as TripleRecord,
    id: "known-relative",
    ts: 100,
    cwd: "project",
    platform: "linux",
    mechanism: {
      files: [{ path: "src/known.ts", plusMinus: [1, 0], props: ["known"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  assert.equal(why(["src/missing.ts"], { load: () => [triple], now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [noRecordNamesFile("src/missing.ts")]);
  assert.deepEqual(output.outLines, []);
  assert.equal(output.sayLines.some((line) => CLAIMS_NOBODY_TOUCHED.test(line)), false);
});

test("why displays the shared identity-hash witness selected by core", () => {
  const triple: TripleRecord = {
    ...seeded()[0] as TripleRecord,
    id: "hashed-witness-cli",
    ts: 100,
    cwd: "/repo",
    platform: "linux",
    mechanism: {
      files: [
        {
          path: "[redacted]",
          identityHash: pathIdentityHash("/repo/src/index.ts", { platform: "linux", canonical: true }),
          plusMinus: [9, 2], props: ["hashed"], provenance: "tool-observed",
        },
        { path: "web/src/index.ts", plusMinus: [1, 0], props: ["suffix"], provenance: "tool-observed" },
      ],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  assert.equal(why(["src/index.ts"], { load: () => [triple], now: 100, ...output.deps }), 0);
  assert.ok(output.outLines.some((line) => line.includes("[redacted] +9 -2")));
  assert.equal(output.outLines.some((line) => line.includes("web/src/index.ts +1 -0")), false);
});

test("why rejects absolute cross-root legacy suffixes without platform", () => {
  const triple: TripleRecord = {
    ...seeded()[0] as TripleRecord,
    id: "cross-root-legacy-cli",
    ts: 100,
    cwd: "/repo",
    mechanism: {
      files: [{ path: "/other/src/index.ts", plusMinus: [1, 0], props: ["other"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  assert.equal(why(["src/index.ts"], { load: () => [triple], now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [noRecordNamesFile("src/index.ts")]);
  assert.deepEqual(output.outLines, []);
  assert.equal(output.sayLines.some((line) => CLAIMS_NOBODY_TOUCHED.test(line)), false);
});

test("future dictionary evidence is reported as unused and does not enter teaching answers", async () => {
  const future: TripleRecord = { ...(seeded()[0] as TripleRecord), id: "future-triple", ts: 101 };
  const note: MemoryRecord = {
    kind: "note", id: "future-note", ts: 102, cwd: "/w", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "future cache", answer: "banana",
  };
  const output = sinks();
  assert.equal(await what(["naikin"], { load: () => [future, note], now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, ['No match for "naikin" yet. Matching evidence is dated in the future, so it was not used.']);
  const quizOutput = sinks();
  assert.equal(await quiz([], { load: () => [future, note], now: 100, ask: async () => "answer", ...quizOutput.deps }), 0);
  assert.deepEqual(quizOutput.sayLines, ["The only candidates are dated in the future, so none were used. Come back later."]);
  assert.equal(quizOutput.sayLines.some((line) => line.includes("banana")), false);
});

const OLD_NOTE: MemoryRecord = {
  kind: "note", id: "old-note", ts: 1, cwd: "/w", cmd: "rocky note",
  file: "src/app.ts", line: 1, subject: "cache", answer: "banana",
};

async function quizOverOldNote() {
  const output = sinks();
  const asked: string[] = [];
  assert.equal(await quiz([], {
    load: () => [OLD_NOTE], now: 2 * 24 * 60 * 60 * 1000, ask: async (message) => { asked.push(message); return "x"; }, ...output.deps,
  }), 0);
  return { output, asked };
}

test("quiz repeats deterministic note candidates and labels answer as unverified", async (t) => {
  setVerbose(t, undefined);
  const first = await quizOverOldNote();
  const second = await quizOverOldNote();
  assert.deepEqual(first.asked, [prompt(phrase("check-answer"))]);
  assert.deepEqual(first.output.sayLines, second.output.sayLines);
  assert.ok(first.output.sayLines.includes("Your recorded answer: banana. Not verified."), first.output.sayLines.join("\n"));
  assert.deepEqual(validateOutputLine("Your recorded answer: banana. Not verified."), []);
  assert.deepEqual(first.output.outLines, ["Your answer, recorded and not verified."]);
  assert.equal(first.output.sayLines.some((line) => line.includes("wrong") || line.includes("score")), false);
  assert.doesNotMatch([...first.output.sayLines, ...first.output.outLines].join("\n"), INTERNAL_LABELS);
});

test("quiz keeps the confidence label and the full provenance line under ROCKY_VERBOSE", async (t) => {
  setVerbose(t, "1");
  const { output } = await quizOverOldNote();
  assert.ok(output.sayLines.includes("Your recorded answer: banana. confidence=possible"), output.sayLines.join("\n"));
  assert.deepEqual(output.outLines, [
    "id=old-note ts=1 source=note file=src/app.ts coverage=single-file note confidence=possible reason=user comprehension note is a recorded answer, not verified ground truth",
  ]);
});

test("why without rationale reports change without reason", () => {
  const records = seeded().map((record) => record.kind === "triple" ? { ...record, rationale: undefined } : record);
  const { sayLines, outLines, deps } = sinks();
  assert.equal(why(["src/app.css"], { load: () => records, ...deps }), 0);
  assert.ok([...sayLines, ...outLines].join("\n").includes("Change recorded. No reason recorded for this change."));
});

test("why on unknown file and missing arg", () => {
  const unknown = sinks();
  assert.equal(why(["ghost.css"], { load: () => [], ...unknown.deps }), 0);
  assert.deepEqual(unknown.sayLines, [noRecordNamesFile("ghost.css")]);
  assert.deepEqual(unknown.outLines, []);
  assert.equal(CLAIMS_NOBODY_TOUCHED.test(unknown.sayLines.join("\n")), false);

  const missing = sinks();
  assert.equal(why([], { load: () => [], ...missing.deps }), 2);
  assert.equal(missing.outLines.length, 0);
});

test("why on a fresh memory says no record names the file and claims nothing was omitted", () => {
  const complete: MemoryCoverage = { version: 1, scanned: 0, skipped: 0, truncated: 0, bytesScanned: 0, bytesTotal: 0, complete: true };
  for (const coverage of [undefined, () => complete]) {
    const output = sinks();
    assert.equal(why(["package.json"], { load: () => [], ...(coverage === undefined ? {} : { coverage }), ...output.deps }), 0);
    assert.deepEqual(output.sayLines, [noRecordNamesFile("package.json")]);
    assert.deepEqual(output.outLines, []);
    const printed = [...output.sayLines, ...output.outLines].join("\n");
    assert.equal(printed.includes("possible path was omitted"), false);
    assert.doesNotMatch(printed, /coverage/iu);
  }
  assert.deepEqual(validateOutputLine(noRecordNamesFile("package.json")), []);
});

const MAY_HIDE_THE_FILE: TripleRecord = {
  kind: "triple", id: "may-hide", ts: 100, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
  mechanism: {
    files: [{ path: "src/other.ts", plusMinus: [1, 0], props: [], provenance: "tool-observed" }],
    truncatedFiles: 4, baseline: "captured", coverageStatus: "truncated",
  },
};

test("why keeps possible path omitted when a record may hide the file", (t) => {
  setVerbose(t, undefined);
  const output = sinks();
  assert.equal(why(["src/missing.ts"], { load: () => [MAY_HIDE_THE_FILE], now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("src/missing.ts")]);
  assert.deepEqual(output.outLines, ["A possible path was omitted."]);
  assert.equal([...output.sayLines, ...output.outLines].some((line) => line.includes("No record names")), false);
  assert.deepEqual(validateOutputLine("A possible path was omitted."), []);
});

test("why keeps the coverage status word on the possible path line under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const output = sinks();
  assert.equal(why(["src/missing.ts"], { load: () => [MAY_HIDE_THE_FILE], now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("src/missing.ts")]);
  assert.deepEqual(output.outLines, ["coverage status: unknown; possible path omitted."]);
});

test("why discloses an incomplete memory scan without claiming a path was omitted", (t) => {
  setVerbose(t, undefined);
  const incomplete: MemoryCoverage = { version: 1, scanned: 3, skipped: 0, truncated: 1, bytesScanned: 10, bytesTotal: 20, complete: false, reason: "file-size-cap" };
  const output = sinks();
  assert.equal(why(["package.json"], { load: () => fillerRecords(3), coverage: () => incomplete, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("package.json")]);
  assert.deepEqual(output.outLines, [
    "memory coverage incomplete: memory file too big. first 3 records heard, later lines not heard.",
  ]);
  assert.equal([...output.sayLines, ...output.outLines].some((line) => line.includes("possible path was omitted") || line.includes("No record names")), false);
});

test("why keeps the raw memory counters under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const incomplete: MemoryCoverage = { version: 1, scanned: 3, skipped: 0, truncated: 1, bytesScanned: 10, bytesTotal: 20, complete: false, reason: "file-size-cap" };
  const output = sinks();
  assert.equal(why(["package.json"], { load: () => fillerRecords(3), coverage: () => incomplete, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("package.json")]);
  assert.deepEqual(output.outLines, [
    "memory coverage incomplete: version 1; scanned 3; skipped 0; truncated 1; bytes 10/20; reason file-size-cap",
  ]);
});

function fillerRecords(count: number): MemoryRecord[] {
  return Array.from({ length: count }, (_, index): MemoryRecord => ({
    kind: "failure", id: `filler-${index}`, ts: 1, cwd: "/w", cmd: "x", exitCode: 1, fingerprint: "fp", signature: [], excerpt: "",
  }));
}

// The loader held every record, so its scan is whole. The why reader still examined only the first MAX_WHY_RECORDS.
const WHOLE_SCAN_PAST_THE_READER_BOUND: MemoryCoverage = {
  version: 1, scanned: MAX_WHY_RECORDS + 1, skipped: 0, truncated: 0, bytesScanned: 1, bytesTotal: 1, complete: true,
};

test("why does not call a reader that stopped at its record bound whole", (t) => {
  setVerbose(t, undefined);
  const output = sinks();
  assert.equal(why(["package.json"], { load: () => fillerRecords(MAX_WHY_RECORDS + 1), coverage: () => WHOLE_SCAN_PAST_THE_READER_BOUND, now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("package.json")]);
  assert.deepEqual(output.outLines, ["Some path may be omitted."]);
  assert.equal([...output.sayLines, ...output.outLines].some((line) => line.includes("No record names") || line.includes("possible path was omitted")), false);
  assert.deepEqual(validateOutputLine("Some path may be omitted."), []);
});

test("why keeps the coverage status word on the some-path line under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const output = sinks();
  assert.equal(why(["package.json"], { load: () => fillerRecords(MAX_WHY_RECORDS + 1), coverage: () => WHOLE_SCAN_PAST_THE_READER_BOUND, now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [coverageIncompleteLine("package.json")]);
  assert.deepEqual(output.outLines, ["coverage status: unknown; some path may be omitted."]);
});

test("why still calls a memory of exactly the reader's record bound whole", () => {
  const whole: MemoryCoverage = { version: 1, scanned: MAX_WHY_RECORDS, skipped: 0, truncated: 0, bytesScanned: 1, bytesTotal: 1, complete: true };
  const output = sinks();
  assert.equal(why(["package.json"], { load: () => fillerRecords(MAX_WHY_RECORDS), coverage: () => whole, now: 100, ...output.deps }), 0);
  assert.deepEqual(output.sayLines, [noRecordNamesFile("package.json")]);
  assert.deepEqual(output.outLines, []);
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
  assert.ok(sayLines.some((line) => line.startsWith("Agent said:")));
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
  assert.ok(sayLines.join("\n").includes('3 intents this week. "flexbox" appears in 3 of them.'));
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
  assert.ok(sayLines[0]?.startsWith("2 intents this week."));
  assert.equal(outLines.filter((line) => line.startsWith("flexbox:")).length, 1);
  assert.equal(outLines.filter((line) => line.startsWith("spacing:")).length, 1);
});

test("digest empty week says no intents were recorded", () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(digest([], { load: () => [], now: Date.now(), ...deps }), 0);
  assert.ok(sayLines.join("\n").includes("No intents recorded this week."));
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
  assert.deepEqual(sayLines, ['Possible match for "naikin": a recorded intent became margin-top. Check the evidence.']);
  assert.equal(outLines.length, 1);
});

test("what --ai reorders known hits and appends every omitted hit exactly once", async () => {
  const { sayLines, outLines, deps } = sinks();
  const rank = {
    async run(_query: string, hits: readonly { triple: { id: string } }[]) {
      assert.equal(hits.length, 3);
      return ["t2", "t1"];
    },
  };
  assert.equal(await what(["--ai", "naikin", "button"], { load: multiSeeded, rank, ...deps }), 0);
  assert.equal(sayLines[0], 'Possible match for "naikin button": a recorded intent became color. Check the evidence.');
  assert.equal(outLines.length, 3);
  const expectedOrder = ["src/second.css", "src/first.css", "src/third.css"];
  assert.deepEqual(outLines.map((line) => expectedOrder.find((path) => line.includes(path))), expectedOrder);
  for (const path of expectedOrder) {
    assert.equal(outLines.filter((line) => line.includes(path)).length, 1, path);
  }
  assert.ok(!outLines.some((line) => line.includes("unknown")));
});

test("what --ai cannot mutate or invent evidence metadata", async (t) => {
  setVerbose(t, "1");
  const { sayLines, outLines, deps } = sinks();
  const rank = {
    async run(_query: string, hits: readonly { triple: TripleRecord }[]) {
      const first = hits[0]?.triple;
      if (first !== undefined) {
        first.intent = { text: "invented intent" };
        first.mechanism.files[0]!.path = "invented/path.ts";
      }
      return ["invented-id", "t1"];
    },
  };
  assert.equal(await what(["--ai", "naikin"], { load: seeded, rank, ...deps }), 0);
  assert.equal(sayLines.some((line) => line.includes("invented")), false);
  assert.ok(outLines[0]?.includes("src/app.css"));
  assert.ok(outLines[0]?.includes("id=t1"));
  assert.ok(outLines[0]?.includes("confidence=incomplete"));
  assert.ok(outLines[0]?.includes("reason=file coverage incomplete"));
});

test("what --ai fallback keeps deterministic note and triple order", async () => {
  const now = Date.now();
  const triple: TripleRecord = {
    kind: "triple", id: "triple-order", ts: now - 1, cwd: "/w", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "naikin button extra" },
    mechanism: { files: [{ path: "src/app.css", plusMinus: [1, 0], props: ["margin"] }], truncatedFiles: 0 },
  };
  const note: MemoryRecord = {
    kind: "note", id: "note-order", ts: now, cwd: "/w", cmd: "", file: "src/app.ts", line: 1,
    subject: "naikin", answer: "remember",
  };
  const records = () => [triple, note];
  const plain = sinks();
  assert.equal(await what(["naikin", "src", "app"], { load: records, now, ...plain.deps }), 0);
  const deterministicEvidence = plain.outLines.map((line) => line.startsWith("note ") ? "note-order" : "triple-order");
  assert.deepEqual(deterministicEvidence, ["note-order", "triple-order"]);

  // No answer and an answer that fails the checks are different facts, so each says its own.
  for (const [rank, disclosure] of [
    [{ async run() { return undefined; } }, phrase("ai-unavailable")],
    [{ async run() { return ["unknown-id"]; } }, phrase("ai-fallback")],
  ] as const) {
    const fallback = sinks();
    assert.equal(await what(["--ai", "naikin", "src", "app"], { load: records, now, rank, ...fallback.deps }), 0);
    assert.deepEqual(fallback.outLines.map((line) => line.startsWith("note ") ? "note-order" : "triple-order"), deterministicEvidence);
    assert.deepEqual(fallback.sayLines.filter((line) => line === disclosure), [disclosure]);
    assert.equal(fallback.sayLines.filter((line) => line !== disclosure).join("\n"), plain.sayLines.join("\n"));
  }
});

test("long triple and note evidence retain bounded provenance fields", async (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const longId = "i".repeat(512);
  const triple: TripleRecord = {
    kind: "triple", id: longId, ts: now - 1, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: `lesson ${"x".repeat(96)}` },
    mechanism: {
      files: [{ path: `src/${"p".repeat(166)}.ts`, plusMinus: [3, 1], props: ["q".repeat(120)], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const note: MemoryRecord = {
    kind: "note", id: longId.replace(/i/gu, "n"), ts: now - 2, cwd: "/repo", cmd: "rocky note",
    file: `src/${"n".repeat(166)}.ts`, line: 7, subject: `lesson ${"s".repeat(113)}`, answer: `remember ${"a".repeat(119)}`,
  };
  const output = sinks();
  assert.equal(await what(["lesson"], { load: () => [triple, note], now, ...output.deps }), 0);
  assert.ok(output.outLines.some((line) => line.includes(triple.id)));
  assert.ok(output.outLines.some((line) => line.includes(note.id)));
  const tripleLine = output.outLines.find((line) => line.includes("agent="));
  assert.ok(tripleLine);
  for (const label of ["id=", "ts=", "source=", "agent=", "files=", "coverage=", "confidence=", "reason="]) {
    assert.ok(tripleLine!.includes(label), label);
  }
  const noteLine = output.outLines.find((line) => line.includes("source=note") && line.includes("id=split"));
  assert.ok(noteLine);
  for (const label of ["id=", "ts=", "source=", "file=", "coverage=", "confidence=", "reason="]) {
    assert.ok(noteLine!.includes(label), label);
  }
  assert.ok(noteLine!.includes("full-id-next-line"));
  for (const line of [...output.sayLines, ...output.outLines]) assert.ok(Buffer.byteLength(line, "utf8") <= 512);
});

test("full-id continuation neutralizes zero-width joiners and fullwidth question marks", async (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const hostileId = `${"safe-"}${"i".repeat(505)}\u200c\u200d\uFF1F`;
  const triple: TripleRecord = {
    kind: "triple", id: hostileId, ts: now - 1, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "change button" },
    mechanism: {
      files: [{ path: "src/button.ts", plusMinus: [1, 0], props: ["button"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  assert.equal(await what(["button"], { load: () => [triple], now, ...output.deps }), 0);
  const lines = [...output.sayLines, ...output.outLines];
  assert.ok(lines.some((line) => line.includes("full-id-next-line")));
  assert.match(lines.join("\n"), /safe-i/u);
  assert.doesNotMatch(lines.join("\n"), /[\u200c\u200d\uFF1F]/u);
  for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= 512);
});

test("long why provenance stays recoverable for rationale and no-rationale triples", (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const path = `src/${"p".repeat(166)}.ts`;
  const make = (id: string, rationale: TripleRecord["rationale"]): TripleRecord => ({
    kind: "triple", id, ts: now - 1, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: `change ${"x".repeat(120)}` }, rationale,
    mechanism: {
      files: [{ path, plusMinus: [3, 1], props: [`prop-${"q".repeat(120)}\u001b[31m`], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  const assertOutput = (output: ReturnType<typeof sinks>, id: string) => {
    const lines = [...output.sayLines, ...output.outLines];
    assert.ok(lines.some((line) => line.includes(id)), "full id must remain recoverable");
    const provenance = lines.find((line) => line.includes("full-id-next-line") && line.includes("agent="));
    assert.ok(provenance, "bounded provenance continuation must be present");
    for (const label of ["id=", "ts=", "source=", "agent=", "files=", "coverage=", "confidence=", "reason="]) {
      assert.ok(provenance!.includes(label), label);
    }
    for (const line of lines) {
      assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    }
  };

  const withReason = sinks();
  const reasonId = "w".repeat(512);
  assert.equal(why([path], { load: () => [make(reasonId, {
    text: `reason ${"r".repeat(120)}\u001b[31m`, tags: [`tag-${"t".repeat(120)}\u0000`], source: "notify",
  })], now, ...withReason.deps }), 0);
  assertOutput(withReason, reasonId);

  const withoutReason = sinks();
  const noReasonId = "n".repeat(512);
  assert.equal(why([path], { load: () => [make(noReasonId, undefined)], now, ...withoutReason.deps }), 0);
  assertOutput(withoutReason, noReasonId);
  assert.ok(withoutReason.sayLines.some((line) => line.includes("Change recorded. No reason recorded for this change.")));
  assert.equal(withoutReason.sayLines.some((line) => line.includes("id=")), false);
});

test("quiz long note and triple reveals keep bounded provenance and full ids", async (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const noteId = "n".repeat(512);
  const tripleId = "t".repeat(512);
  const note: MemoryRecord = {
    kind: "note", id: noteId, ts: now - 2 * 24 * 60 * 60 * 1000, cwd: "/repo", cmd: "rocky note",
    file: `src/${"n".repeat(166)}.ts`, line: 7, subject: `subject-${"s".repeat(113)}\u001b[31m`,
    answer: `remember ${"a".repeat(119)}\u0000`,
  };
  const triple: TripleRecord = {
    kind: "triple", id: tripleId, ts: now - 3 * 24 * 60 * 60 * 1000, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: `change ${"x".repeat(120)}` },
    rationale: { text: "remembered reason", tags: ["tag"], source: "notify" },
    mechanism: {
      files: [{ path: `src/${"p".repeat(166)}.ts`, plusMinus: [3, 1], props: [`prop-${"q".repeat(120)}`], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  const asked: string[] = [];
  assert.equal(await quiz([], {
    load: () => [triple, note], now,
    ask: async (message) => { asked.push(message); return "my answer"; },
    ...output.deps,
  }), 0);
  const lines = [...output.sayLines, ...output.outLines];
  assert.deepEqual(asked, [prompt(phrase("check-answer")), prompt(phrase("check-answer"))]);
  assert.ok(output.sayLines.some((line) => line.includes("Your recorded answer:")));
  assert.ok(output.sayLines.some((line) => line.includes("Recorded: it became")));
  assert.equal(lines.some((line) => line.includes("wrong") || line.includes("correct!") || line.includes("score") || hasInnerQuestionMark(line)), false);
  assert.ok(lines.some((line) => line.includes(noteId)), "full note id must remain recoverable");
  assert.ok(lines.some((line) => line.includes(tripleId)), "full triple id must remain recoverable");
  const noteProvenance = output.outLines.find((line) => line.includes("full-id-next-line") && line.includes("source=note"));
  assert.ok(noteProvenance);
  for (const label of ["id=", "ts=", "source=", "file=", "coverage=", "confidence=", "reason="]) {
    assert.ok(noteProvenance!.includes(label), label);
  }
  const tripleProvenance = output.outLines.find((line) => line.includes("full-id-next-line") && line.includes("agent="));
  assert.ok(tripleProvenance);
  for (const label of ["id=", "ts=", "source=", "agent=", "files=", "coverage=", "confidence=", "reason="]) {
    assert.ok(tripleProvenance!.includes(label), label);
  }
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
    assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
  }
});

test("what --ai does not call model for note-only evidence", async (t) => {
  setVerbose(t, "1");
  const note: MemoryRecord = {
    kind: "note", id: "note-only", ts: Date.now(), cwd: "/w", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "cache", answer: "remember cache",
  };
  const output = sinks();
  let calls = 0;
  const rank = { async run() { calls += 1; return ["forged-id"]; } };
  assert.equal(await what(["--ai", "cache"], { load: () => [note], rank, ...output.deps }), 0);
  assert.equal(calls, 0);
  assert.ok(output.outLines[0]?.includes("source=note"));
  assert.ok(output.outLines[0]?.includes("confidence=possible"));
});

test("what --ai says the local model did not answer and keeps evidence on rank failure", async () => {
  const { sayLines, outLines, deps } = sinks();
  const rank = { async run() { return undefined; } };
  assert.equal(await what(["--ai", "naikin"], { load: seeded, rank, ...deps }), 0);
  assert.deepEqual(sayLines, [phrase("ai-unavailable"), 'Possible match for "naikin": a recorded intent became margin-top. Check the evidence.']);
  assert.equal(outLines.length, 1);
  assert.ok(outLines[0]?.includes("src/app.css"));
});

test("what --ai says the local model is off when no model is configured, and keeps evidence", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-dictionary-ai-off-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await what(["--ai", "naikin"], { load: seeded, ...deps }), 0);
  assert.deepEqual(sayLines, [phrase("ai-disabled"), 'Possible match for "naikin": a recorded intent became margin-top. Check the evidence.']);
  assert.equal(outLines.length, 1);
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

/** Everything rocky wrote to stderr while `fn` ran, the bytes a terminal would show. */
async function printedOnStderr(fn: () => Promise<unknown> | unknown): Promise<string> {
  const original = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return printed;
  } finally {
    process.stderr.write = original;
  }
}

/** The seeded triple remembered 90 seconds ago, so `ago` says "1 minute ago" however slow the run. */
function seededMinuteAgo(): MemoryRecord[] {
  return seeded().map((record) => ({ ...record, ts: Date.now() - 90_000 }) as MemoryRecord);
}

/** A triple whose file list is complete by every check, remembered 90 seconds ago. */
function completeTriple(): TripleRecord {
  return {
    kind: "triple", id: "complete-triple", ts: Date.now() - 90_000, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: "tighten spacing between rows" },
    rationale: { text: "rows were touching", tags: [], source: "notify" },
    mechanism: {
      files: [{ path: "src/rows.css", plusMinus: [2, 1], props: ["gap"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
}

test("default what, how and why print no record id and no internal label", async (t) => {
  setVerbose(t, undefined);
  const printed = await printedOnStderr(async () => {
    assert.equal(await what(["naikin"], { load: seeded }), 0);
    assert.equal(how(["naikin"], { load: seeded }), 0);
    assert.equal(why(["src/app.css"], { load: seeded }), 0);
  });
  assert.match(printed, /margin-top/u);
  assert.match(printed, /by claude-code\. Some changed files may be missing\./u);
  assert.doesNotMatch(printed, /id=|triple-|confidence=|source=|\bts=/u);
  assert.doesNotMatch(printed, INTERNAL_LABELS);
  assert.doesNotMatch(printed, /\bt1\b/u, "the record id itself must not be printed");
});

test("default evidence line names who said it and how far to trust the file list", async (t) => {
  setVerbose(t, undefined);
  const whatOutput = sinks();
  assert.equal(await what(["naikin"], { load: seededMinuteAgo, ...whatOutput.deps }), 0);
  const howOutput = sinks();
  assert.equal(how(["naikin"], { load: seededMinuteAgo, ...howOutput.deps }), 0);
  const whyOutput = sinks();
  assert.equal(why(["src/app.css"], { load: seededMinuteAgo, ...whyOutput.deps }), 0);
  const evidenceLine = "naikin dikit buttonnya -> margin-top  (src/app.css +3 -1, 1 minute ago; by claude-code. Some changed files may be missing.)";
  assert.deepEqual(whatOutput.outLines, [evidenceLine]);
  assert.deepEqual(howOutput.outLines, [evidenceLine]);
  assert.deepEqual(whyOutput.outLines, [
    "Some path may be omitted.",
    "  (src/app.css +3 -1, 1 minute ago, tags: spacing; by claude-code. Some changed files may be missing.)",
  ]);
  assert.deepEqual(validateOutputLine("by claude-code. Some changed files may be missing."), []);
});

test("default evidence says the file list is complete only as the agent reported it", async (t) => {
  setVerbose(t, undefined);
  const output = sinks();
  assert.equal(await what(["tighten"], { load: () => [completeTriple()], ...output.deps }), 0);
  assert.deepEqual(output.outLines, [
    "tighten spacing between rows -> gap  (src/rows.css +2 -1, 1 minute ago; by codex. File list complete, as the agent reported.)",
  ]);
  assert.doesNotMatch(output.outLines.join("\n"), /\b(?:sure|true|right|correct|fixed|verified)\b/iu);
  assert.deepEqual(validateOutputLine("by codex. File list complete, as the agent reported."), []);
});

test("default evidence for a remembered note says it is the user's answer, not verified", async (t) => {
  setVerbose(t, undefined);
  const note: MemoryRecord = {
    kind: "note", id: "note-cache", ts: Date.now() - 2 * 24 * 60 * 60 * 1000 - 90_000, cwd: "/w", cmd: "rocky note",
    file: "src/app.ts", line: 1, subject: "cache", answer: "banana",
  };
  const output = sinks();
  assert.equal(await what(["cache"], { load: () => [note], ...output.deps }), 0);
  assert.deepEqual(output.outLines, ["note cache: banana  (src/app.ts, 2 days ago; Your answer, recorded and not verified.)"]);
  assert.doesNotMatch(output.outLines.join("\n"), INTERNAL_LABELS);
  assert.deepEqual(validateOutputLine("Your answer, recorded and not verified."), []);
});

test("default evidence with long values splits into bounded lines and still prints no id", async (t) => {
  setVerbose(t, undefined);
  const now = Date.now();
  const triple: TripleRecord = {
    kind: "triple", id: "i".repeat(512), ts: now - 400 * 24 * 60 * 60 * 1000, cwd: "/repo", platform: "linux", schemaV: 1,
    agent: "codex", origin: "agent-hook", intent: { text: `${"工".repeat(60)} lesson` },
    mechanism: {
      files: [{
        path: `src/${"p".repeat(176)}.ts`, plusMinus: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        props: ["q".repeat(130)], provenance: "tool-observed",
      }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const output = sinks();
  assert.equal(await what(["lesson"], { load: () => [triple], now, ...output.deps }), 0);
  assert.equal(output.outLines.length, 2, output.outLines.join("\n"));
  for (const line of output.outLines) assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
  assert.equal(output.outLines[1], "by codex. File list complete, as the agent reported.");
  assert.equal(output.outLines.some((line) => line.includes("i".repeat(32))), false, "the full record id must not be printed");
});

test("ROCKY_VERBOSE keeps the full triple provenance line byte for byte in what, how and why", async (t) => {
  setVerbose(t, "1");
  const records = seededMinuteAgo();
  const { ts } = records[0] as TripleRecord;
  const legacy = `id=t1 ts=${ts} source=agent-hook agent=claude-code files=1; witness=src/app.css coverage=incomplete confidence=incomplete reason=file coverage incomplete; full change not recorded`;
  const whatOutput = sinks();
  assert.equal(await what(["naikin"], { load: () => records, ...whatOutput.deps }), 0);
  const howOutput = sinks();
  assert.equal(how(["naikin"], { load: () => records, ...howOutput.deps }), 0);
  const whyOutput = sinks();
  assert.equal(why(["src/app.css"], { load: () => records, ...whyOutput.deps }), 0);
  const evidenceLine = `naikin dikit buttonnya -> margin-top  (src/app.css +3 -1, 1 minute ago; ${legacy})`;
  assert.deepEqual(whatOutput.outLines, [evidenceLine]);
  assert.deepEqual(howOutput.outLines, [evidenceLine]);
  assert.deepEqual(whyOutput.outLines, [
    "coverage status: unknown; some path may be omitted.",
    `  (src/app.css +3 -1, 1 minute ago, tags: spacing; ${legacy})`,
  ]);
});

test("ROCKY_VERBOSE keeps the note provenance line byte for byte", async (t) => {
  setVerbose(t, "1");
  const output = sinks();
  assert.equal(await what(["cache"], { load: () => [OLD_NOTE], now: 2 * 24 * 60 * 60 * 1000, ...output.deps }), 0);
  assert.deepEqual(output.outLines, [
    "note old-note ts=1 source=note file=src/app.ts coverage=single-file note confidence=possible reason=user comprehension note is a recorded answer, not verified ground truth; subject=cache answer=banana",
  ]);
});

function ambiguousIndexRecords(): MemoryRecord[] {
  const make = (id: string, path: string): TripleRecord => ({
    kind: "triple", id, ts: 100, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    rationale: { text: id, tags: [], source: "notify" },
    mechanism: {
      files: [{ path, plusMinus: [1, 0], props: [id], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  });
  return [make("one", "one/index.ts"), make("two", "two/index.ts")];
}

test("why says an ambiguous path in plain words", (t) => {
  setVerbose(t, undefined);
  const output = sinks();
  assert.equal(why(["index.ts"], { load: ambiguousIndexRecords, now: 100, ...output.deps }), 0);
  assert.deepEqual(output.outLines, ["The path fits more than one file. No reason was picked."]);
  assert.deepEqual(validateOutputLine("The path fits more than one file. No reason was picked."), []);
  assert.doesNotMatch(output.outLines.join("\n"), INTERNAL_LABELS);
});

test("why keeps the status and confidence labels on an ambiguous path under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const output = sinks();
  assert.equal(why(["index.ts"], { load: ambiguousIndexRecords, now: 100, ...output.deps }), 0);
  assert.deepEqual(output.outLines, ["coverage status: unknown; no silent rationale selection; confidence=incomplete reason=ambiguous path"]);
});

function linkedReasonRecords(now: number): MemoryRecord[] {
  const triple: TripleRecord = {
    kind: "triple", id: "triple-linked", ts: now - 1_000, cwd: "/repo", platform: "linux", schemaV: 1, agent: "codex", origin: "agent-hook",
    mechanism: {
      files: [{ path: "src/app.css", plusMinus: [3, 1], props: ["margin-top"], provenance: "tool-observed" }],
      truncatedFiles: 0, baseline: "captured", coverageStatus: "complete",
    },
  };
  const reason: RationaleRecord = {
    kind: "rationale", id: "r-notify", ts: now, v: 1, cwd: "/repo", agent: "claude-code",
    rationale_fidelity: "summary", source: "notify", excerpt: "rows stay apart", links: { tripleId: "triple-linked" },
  };
  return [triple, reason];
}

test("why names a linked reason by when and who said it, with no id", (t) => {
  setVerbose(t, undefined);
  const now = Date.now();
  const output = sinks();
  assert.equal(why(["src/app.css"], { load: () => linkedReasonRecords(now), now, ...output.deps }), 0);
  assert.ok(output.sayLines.includes("Agent said: rows stay apart"), output.sayLines.join("\n"));
  assert.equal(output.outLines.at(-1), "  (just now, claude-code)");
  assert.doesNotMatch([...output.sayLines, ...output.outLines].join("\n"), INTERNAL_LABELS);
});

test("why keeps the linked reason id and fidelity under ROCKY_VERBOSE", (t) => {
  setVerbose(t, "1");
  const now = Date.now();
  const output = sinks();
  assert.equal(why(["src/app.css"], { load: () => linkedReasonRecords(now), now, ...output.deps }), 0);
  assert.ok(output.sayLines.includes("Agent said: rows stay apart"), output.sayLines.join("\n"));
  assert.equal(output.outLines.at(-1), "  (rationale id=r-notify, just now, agent=claude-code, fidelity=summary)");
});

test("quiz reveals a triple with the agent and file-list words and no id by default", async (t) => {
  setVerbose(t, undefined);
  const old = seeded().map((record) => ({ ...record, ts: Date.now() - 3 * 24 * 60 * 60 * 1000 }));
  const output = sinks();
  assert.equal(await quiz([], { load: () => old as MemoryRecord[], now: Date.now(), ask: async () => "margin", ...output.deps }), 0);
  assert.deepEqual(output.outLines, ["  (src/app.css +3 -1, 3 days ago; by claude-code. Some changed files may be missing.)"]);
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
  assert.ok(joined.includes('You said "naikin dikit buttonnya". What did it become?'));
  assert.ok(joined.includes("Recorded: it became margin-top."));
  assert.ok(joined.includes("Quiz finished."));
  assert.deepEqual(asked, [prompt(phrase("check-answer"))]);
  for (const banned of ["wrong", "correct!", "score"]) assert.ok(!joined.includes(banned));
  assert.ok(![...sayLines, ...outLines].some(hasInnerQuestionMark), "only the closing question mark of a question may print");
});

test("quiz with nothing old enough", async () => {
  const { sayLines, outLines, deps } = sinks();
  assert.equal(await quiz([], { load: seeded, now: Date.now(), ask: async () => "x", ...deps }), 0);
  assert.deepEqual(sayLines, ["Nothing is old enough to ask about yet. Come back later."]);
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
    assert.deepEqual(sayLines, ["Quiz needs an interactive terminal. Run rocky quiz from one."]);
    assert.deepEqual(outLines, []);
  } finally {
    if (descriptor === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", descriptor);
  }
});

test("quiz keeps hostile memory text bounded, terminal-safe, and free of stray question marks", async () => {
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
    assert.ok(!hasInnerQuestionMark(line), JSON.stringify(line));
    assert.ok(!line.includes("\u001b"), JSON.stringify(line));
    assert.ok(!/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(line), JSON.stringify(line));
    assert.ok(Buffer.byteLength(line, "utf8") <= 512, String(Buffer.byteLength(line, "utf8")));
  }
});
