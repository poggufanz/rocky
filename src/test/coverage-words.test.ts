import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { conceptsCommand } from "../commands/concepts.js";
import { hookFail } from "../commands/hook.js";
import { recall } from "../commands/recall.js";
import { run } from "../commands/run.js";
import { watch } from "../commands/watch.js";
import { describeMemoryCoverage } from "../core/coverage.js";
import type { ExecResult } from "../core/exec.js";
import { MAX_SUPPORTED_MEMORY_RECORDS, type MemoryCoverage } from "../core/memory-read.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import { flushHookSpeech } from "../ui/rocky.js";
import { setVerbose } from "./verbose-switch.js";

const PREFIX = "memory coverage incomplete: ";
const COUNTS_WARNING = "counts here not all.";

function coverage(overrides: Partial<MemoryCoverage> = {}): MemoryCoverage {
  return { version: 1, scanned: 3, skipped: 0, truncated: 0, bytesScanned: 120, bytesTotal: 120, complete: true, ...overrides };
}

interface Shape {
  readonly name: string;
  readonly coverage: MemoryCoverage;
  readonly recordCount: number;
  /** What follows the persona prefix, or undefined when the read was whole. */
  readonly facts: string | undefined;
}

const SHAPES: readonly Shape[] = [
  { name: "a whole read", coverage: coverage(), recordCount: 3, facts: undefined },
  {
    name: "whitespace-only lines, where scanned exceeds records yet the read is whole",
    coverage: coverage({ scanned: 5 }), recordCount: 3, facts: undefined,
  },
  { name: "one skipped line", coverage: coverage({ skipped: 1, complete: false }), recordCount: 2, facts: "1 line I cannot use." },
  { name: "several skipped lines", coverage: coverage({ skipped: 4, complete: false }), recordCount: 2, facts: "4 lines I cannot use." },
  {
    name: "the record cap",
    coverage: coverage({ truncated: 1, complete: false, reason: "record-cap" }),
    recordCount: MAX_SUPPORTED_MEMORY_RECORDS,
    facts: `first ${MAX_SUPPORTED_MEMORY_RECORDS} records heard, later lines not heard.`,
  },
  {
    name: "the file size cap",
    coverage: coverage({ truncated: 1, complete: false, reason: "file-size-cap" }),
    recordCount: 812,
    facts: "memory file too big. first 812 records heard, later lines not heard.",
  },
  {
    name: "a read race",
    coverage: coverage({ scanned: 0, truncated: 1, complete: false, reason: "read-race" }),
    recordCount: 0,
    facts: "file did not hold still or open right. nothing heard this time.",
  },
  {
    name: "skipped lines plus the record cap",
    coverage: coverage({ skipped: 2, truncated: 1, complete: false, reason: "record-cap" }),
    recordCount: 40,
    facts: "2 lines I cannot use. first 40 records heard, later lines not heard.",
  },
  {
    name: "skipped lines plus the file size cap",
    coverage: coverage({ skipped: 1, truncated: 1, complete: false, reason: "file-size-cap" }),
    recordCount: 7,
    facts: "1 line I cannot use. memory file too big. first 7 records heard, later lines not heard.",
  },
  { name: "incomplete with no reason and nothing skipped", coverage: coverage({ complete: false }), recordCount: 3, facts: "some lines not heard." },
  {
    name: "truncated with no reason and nothing skipped",
    coverage: coverage({ truncated: 2, complete: false }), recordCount: 3, facts: "some lines not heard.",
  },
];

for (const shape of SHAPES) {
  test(`describeMemoryCoverage handles ${shape.name}`, () => {
    const plain = describeMemoryCoverage(shape.coverage, shape.recordCount, { counts: false });
    const counted = describeMemoryCoverage(shape.coverage, shape.recordCount, { counts: true });
    if (shape.facts === undefined) {
      assert.equal(plain, undefined);
      assert.equal(counted, undefined);
      return;
    }
    assert.equal(plain, `${PREFIX}${shape.facts}`);
    assert.equal(counted, `${PREFIX}${shape.facts} ${COUNTS_WARNING}`);
    assert.deepEqual(validateRockyPhrase(plain), []);
    assert.deepEqual(validateRockyPhrase(counted as string), []);
  });
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
// Hang guard only: a loaded CI runner can spend seconds on Node startup alone.
const PROCESS_TIMEOUT_MS = 30_000;

function failureLine(index: number): string {
  return JSON.stringify({
    kind: "failure", id: `r${index}`, ts: 1, cwd: "/words", cmd: "false", exitCode: 1,
    fingerprint: `r${index}`.padStart(16, "0"), signature: ["false"], excerpt: "false",
  });
}

function rockyStatsOver(t: TestContext, lines: readonly string[], rockyVerbose: "1" | undefined): SpawnSyncReturns<string> {
  const root = mkdtempSync(join(tmpdir(), "rocky-coverage-words-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rockyHome = join(root, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  writeFileSync(join(rockyHome, "memory.jsonl"), lines.map((line) => `${line}\n`).join(""), "utf8");
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: root, USERPROFILE: root, ROCKY_HOME: rockyHome, ROCKY_TEST_POWERSHELL_HOSTS: "[]",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.ROCKY_VERBOSE;
  if (rockyVerbose !== undefined) env.ROCKY_VERBOSE = rockyVerbose;
  return spawnSync(process.execPath, [entry, "stats"], {
    cwd: packageRoot, env, encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
}

test("rocky stats over a whole memory keeps counter text out of default output and prints it with ROCKY_VERBOSE", (t) => {
  const quiet = rockyStatsOver(t, [failureLine(0)], undefined);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /scanned|truncated|version 1/u);
  assert.doesNotMatch(quiet.stderr, /memory coverage/u);

  const loud = rockyStatsOver(t, [failureLine(0)], "1");
  assert.equal(loud.status, 0, loud.stderr);
  assert.match(loud.stderr, /memory coverage: version 1, scanned/u);
  // A read with no reason keeps the legacy counter text, byte for byte.
  assert.match(loud.stderr, /^memory coverage: version 1, scanned \d+, skipped 0, truncated 0, complete true$/mu);
});

test("rocky stats over exactly the record cap says nothing about coverage", (t) => {
  const lines = Array.from({ length: MAX_SUPPORTED_MEMORY_RECORDS }, (_, index) => failureLine(index));
  const result = rockyStatsOver(t, lines, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /memory coverage/u);
});

test("rocky stats over the record cap says coverage once, in plain words, and warns the counts are not all", (t) => {
  const lines = Array.from({ length: MAX_SUPPORTED_MEMORY_RECORDS + 1 }, (_, index) => failureLine(index));
  const result = rockyStatsOver(t, lines, undefined);
  assert.equal(result.status, 0, result.stderr);
  const said = result.stderr.split(/\r?\n/u).filter((line) => line.includes("memory coverage incomplete:"));
  assert.equal(said.length, 1, result.stderr);
  assert.ok(said[0]?.endsWith(COUNTS_WARNING), said[0]);
  assert.ok(said[0]?.includes(`first ${MAX_SUPPORTED_MEMORY_RECORDS} records heard, later lines not heard.`), said[0]);
  assert.doesNotMatch(result.stderr, /scanned|truncated|version 1/u);
});

test("rocky stats over the record cap ends its ROCKY_VERBOSE counter line with the reason", (t) => {
  const lines = Array.from({ length: MAX_SUPPORTED_MEMORY_RECORDS + 1 }, (_, index) => failureLine(index));
  const result = rockyStatsOver(t, lines, "1");
  assert.equal(result.status, 0, result.stderr);
  const counters = result.stderr.split(/\r?\n/u).filter((line) => line.startsWith("memory coverage: version"));
  assert.deepEqual(counters, [
    `memory coverage: version 1, scanned ${MAX_SUPPORTED_MEMORY_RECORDS}, skipped 0, truncated 1, complete false, reason record-cap`,
  ]);
});

/**
 * One valid record and one line that is not JSON: the read is whole except for a
 * line Rocky cannot use, so every site discloses the same skipped-only coverage.
 */
interface IncompleteMemory {
  readonly bytes: number;
}

function incompleteMemory(t: TestContext): IncompleteMemory {
  const root = mkdtempSync(join(tmpdir(), "rocky-coverage-sites-"));
  const home = join(root, "rocky-home");
  mkdirSync(home, { recursive: true });
  const body = `${failureLine(0)}\nthis line is not json\n`;
  writeFileSync(join(home, "memory.jsonl"), body, "utf8");
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { bytes: Buffer.byteLength(body) };
}

async function captureStderr(fn: () => Promise<unknown> | unknown): Promise<string> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return stderr;
  } finally {
    process.stderr.write = original;
  }
}

function captureHookSpeech(fn: () => unknown): string {
  const scratch = mkdtempSync(join(tmpdir(), "rocky-coverage-speech-"));
  const speechFile = join(scratch, "speech.txt");
  const previous = process.env.ROCKY_HOOK_SPEECH_FILE;
  process.env.ROCKY_HOOK_SPEECH_FILE = speechFile;
  try {
    fn();
    flushHookSpeech();
    return existsSync(speechFile) ? readFileSync(speechFile, "utf8") : "";
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOOK_SPEECH_FILE;
    else process.env.ROCKY_HOOK_SPEECH_FILE = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
}

const FAILED: ExecResult = { started: true, code: 1, stderr: "boom", tail: ["boom"], durationMs: 5 };
const WORDS = `${PREFIX}1 line I cannot use.`;

interface Site {
  readonly name: string;
  readonly speak: () => Promise<string> | string;
  readonly plainLine: string;
  readonly legacyLine: (memory: IncompleteMemory) => string;
}

const SITES: readonly Site[] = [
  {
    name: "run",
    speak: () => captureStderr(() => run("synthetic-failure", async () => FAILED)),
    plainLine: `    ${WORDS}`,
    legacyLine: () => "    memory coverage: version 1; scanned 2; skipped 1; truncated 0",
  },
  {
    name: "hook",
    speak: () => captureHookSpeech(() => hookFail("synthetic-failure", 1, process.cwd())),
    plainLine: `    ${WORDS}`,
    legacyLine: () => "    memory coverage: version 1; scanned 2; skipped 1; truncated 0",
  },
  {
    name: "watch",
    speak: () => captureStderr(() => watch(["synthetic-failure"], { notify: () => {}, runProcess: async () => FAILED })),
    plainLine: `    ${WORDS}`,
    legacyLine: () => "    memory coverage incomplete: version 1; scanned 2; skipped 1; truncated 0",
  },
  {
    name: "recall",
    speak: () => captureStderr(() => recall(["synthetic-query"])),
    plainLine: WORDS,
    legacyLine: () => "memory coverage incomplete: version 1, scanned 2, skipped 1, truncated 0, complete false",
  },
  {
    name: "concepts",
    speak: () => captureStderr(() => conceptsCommand([])),
    plainLine: WORDS,
    legacyLine: (memory) => `memory coverage incomplete: version 1; scanned 2; skipped 1; truncated 0; bytes ${memory.bytes}/${memory.bytes}`,
  },
];

function heardLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

for (const site of SITES) {
  test(`${site.name} says memory coverage in plain words by default`, async (t) => {
    setVerbose(t, undefined);
    incompleteMemory(t);
    const heard = await site.speak();
    assert.ok(heardLines(heard).includes(site.plainLine), heard);
    assert.doesNotMatch(heard, /scanned|truncated|version 1/u);
  });

  test(`${site.name} keeps its own counter text under ROCKY_VERBOSE`, async (t) => {
    setVerbose(t, "1");
    const memory = incompleteMemory(t);
    const heard = await site.speak();
    assert.ok(heardLines(heard).includes(site.legacyLine(memory)), heard);
    assert.ok(!heardLines(heard).includes(site.plainLine), heard);
  });
}
