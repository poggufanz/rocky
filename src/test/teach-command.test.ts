// src/test/teach-command.test.ts
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teach, type TeachDeps } from "../commands/teach.js";
import type { CardsForFile, StoredBlock, StoredCard } from "../desk/cards-read.js";
import { recordExplain } from "../core/memory.js";
import { loadMemoryChecked, MAX_SUPPORTED_MEMORY_RECORDS } from "../core/memory-read.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { validateOutputLine } from "../ui/phrases.js";
import { failureLines, failureLinesPastByteCap } from "./memory-cap-fixture.js";

const EMPTY_STATE = "No reason recorded for this code. No change card or local evidence matched it.";
const WITNESS_HEADER = "Witnessed: an agent stated why, and rocky recorded it.";
const LADDER_HEADER = "Assembled from evidence, not witnessed.";

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "rocky-teach-"));
  process.env.ROCKY_HOME = dir;
  return dir;
}

function fixture(dir: string, name: string, lines: readonly string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function sinks() {
  const sayLines: string[] = [];
  const headingLines: string[] = [];
  const blockLines: string[] = [];
  const detailLines: string[] = [];
  const deps: TeachDeps = {
    say: (line: string) => sayLines.push(line),
    heading: (line: string) => headingLines.push(line),
    block: (lines: string[]) => blockLines.push(...lines),
    detail: (line: string) => detailLines.push(line),
  };
  return { sayLines, headingLines, blockLines, detailLines, deps };
}

function feedFixture(dir: string, name: string): { path: string; lines: string[] } {
  const lines = [
    "export async function loadFeed() {",
    "  const first = await fetchRows();",
    "  const second = await fetchRows();",
    "  const third = await fetchRows();",
    "  const fourth = await fetchRows();",
    "  const fifth = await fetchRows();",
    "  const sixth = await fetchRows();",
    "  const seventh = await fetchRows();",
    "  const eighth = await fetchRows();",
    "  const ninth = await fetchRows();",
    "  const tenth = await fetchRows();",
    "  const eleventh = await fetchRows();",
    "  const twelfth = await fetchRows();",
    "  return first;",
    "}",
  ];
  return { path: fixture(dir, name, lines), lines };
}

test("teach renders a witness card when an explain record matches the selection", async () => {
  const home = freshHome();
  const { path, lines } = feedFixture(home, "witness.ts");
  const selection = lines.slice(4, 11).join("\n");
  recordExplain({
    cwd: process.cwd(),
    path,
    source: "agent:claude-code",
    code: "documents only, no duplicates",
    business: "journal accepts DOCENTRY documents only",
    snippet: selection,
  }, resolveRockyPaths());
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:8`], deps), 0);
  assert.deepEqual(headingLines, [WITNESS_HEADER]);
  assert.ok(blockLines.includes("code: documents only, no duplicates"));
  assert.ok(blockLines.includes("business: journal accepts DOCENTRY documents only"));
  assert.ok(blockLines.some((line) => line.startsWith("form: async because await used at line 8")));
  assert.ok(detailLines[0]?.startsWith("source: agent:claude-code"));
  assert.deepEqual(sayLines, []);
});

test("teach assembles an evidence ladder card when no witness exists", async () => {
  const home = freshHome();
  const path = fixture(home, "ladder.ts", [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ]);
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`], deps), 0);
  assert.deepEqual(headingLines, [LADDER_HEADER]);
  assert.ok(blockLines.some((line) => line.includes(`${path} · line 2`)));
  assert.ok(blockLines.some((line) => line.startsWith("reason: async because await used at line 2")));
  assert.ok(detailLines[0]?.startsWith("evidence: catalog"));
  assert.deepEqual(sayLines, []);
});

test("teach --ladder appends expanded hop lines to the ladder card", async () => {
  const home = freshHome();
  const path = fixture(home, "ladder-expand.ts", [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ]);
  const { blockLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`, "--ladder"], deps), 0);
  assert.ok(blockLines.some((line) => line.startsWith("why 1")));
  assert.ok(blockLines.some((line) => line.startsWith("why 2")));
});

test("teach missing file speaks the empty state and exits 0", async () => {
  const home = freshHome();
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${join(home, "ghost.ts")}:5`], deps), 0);
  assert.deepEqual(sayLines, [EMPTY_STATE]);
  assert.deepEqual(validateOutputLine(EMPTY_STATE), []);
  assert.deepEqual(headingLines, []);
  assert.deepEqual(blockLines, []);
  assert.deepEqual(detailLines, []);
});

test("teach empty ladder speaks the empty state and exits 0", async () => {
  const home = freshHome();
  const path = fixture(home, "empty.ts", [""]);
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:1`], deps), 0);
  assert.deepEqual(sayLines, [EMPTY_STATE]);
  assert.deepEqual(headingLines, []);
  assert.deepEqual(blockLines, []);
  assert.deepEqual(detailLines, []);
});

test("teach --quiet suppresses say output but keeps the card", async () => {
  const home = freshHome();
  const { path, lines } = feedFixture(home, "quiet.ts");
  recordExplain({
    cwd: process.cwd(),
    path,
    source: "agent:claude-code",
    code: "documents only, no duplicates",
    business: "journal accepts DOCENTRY documents only",
    snippet: lines.slice(4, 11).join("\n"),
  }, resolveRockyPaths());
  const witness = sinks();
  assert.equal(await teach(["--quiet", `${path}:8`], witness.deps), 0);
  assert.deepEqual(witness.sayLines, []);
  assert.deepEqual(witness.headingLines, [WITNESS_HEADER]);
  assert.ok(witness.blockLines.includes("code: documents only, no duplicates"));

  const missing = sinks();
  assert.equal(await teach(["--quiet", `${join(home, "ghost.ts")}:5`], missing.deps), 0);
  assert.deepEqual(missing.sayLines, []);
  assert.deepEqual(missing.headingLines, []);
  assert.deepEqual(missing.blockLines, []);
  assert.deepEqual(missing.detailLines, []);
});

test("teach --ladder on a git-tracked snippet shows commit author pointer, exit 0", async () => {
  freshHome();
  const dir = mkdtempSync(join(tmpdir(), "rocky-teach-git-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test Author"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "author@example.com"], { cwd: dir });
  writeFileSync(join(dir, "feed.ts"), [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ].join("\n"), "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "add feed"], { cwd: dir });
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    const { headingLines, blockLines, detailLines, deps } = sinks();
    assert.equal(await teach(["feed.ts:2", "--ladder"], deps), 0);
    assert.deepEqual(headingLines, [LADDER_HEADER]);
    assert.match(detailLines.join("\n"), /evidence-exhausted/);
    const expanded = blockLines.join("\n");
    assert.match(expanded, /[0-9a-f]{7}/);
    assert.match(expanded, /Test Author/);
  } finally {
    process.chdir(prevCwd);
  }
});

test("teach --ladder with exhausted provenance keeps the disclosure voice, exit 0", async () => {
  const home = freshHome();
  const path = fixture(home, "norepo.ts", [
    "export async function loadFeed() {",
    "  const rows = await fetchRows();",
    "  return rows;",
    "}",
  ]);
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`, "--ladder"], deps), 0);
  assert.deepEqual(headingLines, [LADDER_HEADER]);
  assert.ok(blockLines.includes("No git history found for these lines. Other evidence stays above."));
  assert.match(detailLines.join("\n"), /evidence-exhausted/);
  const userFacing = [...sayLines, ...headingLines, ...blockLines, ...detailLines].join("\n");
  assert.doesNotMatch(userFacing, /\?/);
  assert.doesNotMatch(userFacing, /asal usul|di atas/, "english output carries no indonesian disclosure");
  assert.doesNotMatch(userFacing, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

const COVERAGE_PREFIX = "memory coverage incomplete";
const CAP_LINE = `${COVERAGE_PREFIX}: Only the first ${MAX_SUPPORTED_MEMORY_RECORDS} records were read; later lines were not read. These counts do not cover all of memory.`;
const ASYNC_FIXTURE = [
  "export async function loadFeed() {",
  "  const rows = await fetchRows();",
  "  return rows;",
  "}",
];

/** Appends cheap failure records, so memory holds an exact record count. */
function appendFailures(home: string, count: number): void {
  appendFileSync(join(home, "memory.jsonl"), failureLines(count), "utf8");
}

function homeWithFailures(t: TestContext, count: number): string {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  appendFailures(home, count);
  return home;
}

/** One ordered log across every sink, so a test can say what came before what. */
function orderedSinks(): { events: string[]; deps: TeachDeps } {
  const events: string[] = [];
  const deps: TeachDeps = {
    say: (line: string) => events.push(`say ${line}`),
    heading: (line: string) => events.push(`heading ${line}`),
    block: (lines: string[]) => events.push(...lines.map((line) => `block ${line}`)),
    detail: (line: string) => events.push(`detail ${line}`),
  };
  return { events, deps };
}

test("teach over the record cap says which lines it did not hear, once, before the ladder card", async (t) => {
  const home = homeWithFailures(t, MAX_SUPPORTED_MEMORY_RECORDS + 1);
  const path = fixture(home, "capped-ladder.ts", ASYNC_FIXTURE);
  const { events, deps } = orderedSinks();
  assert.equal(await teach([`${path}:2`], deps), 0);
  assert.equal(events[0], `say ${CAP_LINE}`);
  assert.equal(events[1], `heading ${LADDER_HEADER}`);
  assert.equal(events.filter((event) => event.includes(COVERAGE_PREFIX)).length, 1, events.join("\n"));
});

test("teach over the record cap says so before a witness card from the lines it did hear", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { path, lines } = feedFixture(home, "capped-witness.ts");
  recordExplain({
    cwd: process.cwd(),
    path,
    source: "agent:claude-code",
    code: "documents only, no duplicates",
    business: "journal accepts DOCENTRY documents only",
    snippet: lines.slice(4, 11).join("\n"),
  }, resolveRockyPaths());
  // The witness is the first record. With the cap's worth of failures after it, the last one falls past the cap.
  appendFailures(home, MAX_SUPPORTED_MEMORY_RECORDS);
  const { events, deps } = orderedSinks();
  assert.equal(await teach([`${path}:8`], deps), 0);
  assert.equal(events[0], `say ${CAP_LINE}`);
  assert.equal(events[1], `heading ${WITNESS_HEADER}`);
  assert.equal(events.filter((event) => event.includes(COVERAGE_PREFIX)).length, 1, events.join("\n"));
});

test("teach over the file size cap says the memory file is too large and how many records it read", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const memoryPath = join(home, "memory.jsonl");
  writeFileSync(memoryPath, failureLinesPastByteCap(), "utf8");
  const heard = loadMemoryChecked(memoryPath);
  assert.equal(heard.coverage.reason, "file-size-cap", "the fixture must stop at the byte cap, not the record cap");
  const path = fixture(home, "big-memory.ts", ASYNC_FIXTURE);
  const { events, deps } = orderedSinks();
  assert.equal(await teach([`${path}:2`], deps), 0);
  assert.equal(
    events[0],
    `say ${COVERAGE_PREFIX}: The memory file is too large. Only the first ${heard.records.length} records were read; later lines were not read. These counts do not cover all of memory.`,
  );
  assert.equal(events[1], `heading ${LADDER_HEADER}`);
});

test("teach over the record cap says so before the empty state", async (t) => {
  const home = homeWithFailures(t, MAX_SUPPORTED_MEMORY_RECORDS + 1);
  const path = fixture(home, "capped-empty.ts", [""]);
  const { events, deps } = orderedSinks();
  assert.equal(await teach([`${path}:1`], deps), 0);
  assert.deepEqual(events, [`say ${CAP_LINE}`, `say ${EMPTY_STATE}`]);
});

test("teach --quiet stays silent about the record cap and keeps the card", async (t) => {
  const home = homeWithFailures(t, MAX_SUPPORTED_MEMORY_RECORDS + 1);
  const path = fixture(home, "capped-quiet.ts", ASYNC_FIXTURE);
  const { events, deps } = orderedSinks();
  assert.equal(await teach(["--quiet", `${path}:2`], deps), 0);
  assert.deepEqual(events.filter((event) => event.startsWith("say ")), [], events.join("\n"));
  assert.ok(events.includes(`heading ${LADDER_HEADER}`), events.join("\n"));
});

test("teach over exactly the record cap says nothing about coverage", async (t) => {
  const home = homeWithFailures(t, MAX_SUPPORTED_MEMORY_RECORDS);
  const path = fixture(home, "full-ladder.ts", ASYNC_FIXTURE);
  const { events, deps } = orderedSinks();
  assert.equal(await teach([`${path}:2`], deps), 0);
  assert.ok(!events.some((event) => event.includes(COVERAGE_PREFIX)), events.join("\n"));
  assert.ok(events.includes(`heading ${LADDER_HEADER}`), events.join("\n"));
});

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entry = join(packageRoot, "dist", "index.js");
// Hang guard only: a loaded CI runner can spend seconds on Node startup alone.
const PROCESS_TIMEOUT_MS = 30_000;

function rockyTeach(home: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, ROCKY_HOME: home, ROCKY_TEST_POWERSHELL_HOSTS: "[]",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env.ROCKY_VERBOSE;
  return spawnSync(process.execPath, [entry, "teach", ...args], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    ...(input === undefined ? {} : { input }),
  });
}

test("rocky teach over the record cap says it on stderr, and --quiet does not", (t) => {
  const home = homeWithFailures(t, MAX_SUPPORTED_MEMORY_RECORDS + 1);
  const path = fixture(home, "capped-process.ts", ASYNC_FIXTURE);
  const loud = rockyTeach(home, [`${path}:2`]);
  assert.equal(loud.status, 0, loud.stderr);
  assert.ok(loud.stderr.includes(CAP_LINE), loud.stderr);
  const quiet = rockyTeach(home, ["--quiet", `${path}:2`]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.ok(!quiet.stderr.includes(COVERAGE_PREFIX), quiet.stderr);
});

const HASH_BEFORE = "0123456789abcdef".repeat(4);
const HASH_AFTER = "fedcba9876543210".repeat(4);

function inlineCardsForFile(
  file: string,
  options: {
    prompt?: string;
    symbolName?: string;
    symbol?: StoredBlock["symbol"];
    line?: number | null;
    added?: number | null;
    quoteText?: string;
    coverage?: CardsForFile["coverage"];
  } = {},
): CardsForFile {
  const symbol = options.symbol !== undefined
    ? options.symbol
    : { kind: "function", name: options.symbolName ?? "greetUser" };
  const block: StoredBlock = {
    seq: 1,
    path: file,
    symbol,
    labels: [{ id: "body_changed" }],
    importance: "medium",
    via: "edit",
    before: HASH_BEFORE,
    after: HASH_AFTER,
    recorded: true,
    line: options.line !== undefined ? options.line : 1,
    added: options.added !== undefined ? options.added : 3,
    removed: 0,
    quote: options.quoteText === undefined ? { text: "greets a user by name", shared: true } : { text: options.quoteText, shared: true },
  };
  const card: StoredCard = {
    v: 1,
    card_id: "card-1",
    rev: 1,
    root: process.cwd(),
    agent_type: "claude-code",
    started_ms: Date.UTC(2026, 10, 18, 12, 0, 0),
    ended_ms: Date.UTC(2026, 10, 18, 12, 1, 0),
    prompt: options.prompt ?? "Add user greeting helper",
    blocks: [block],
  };
  return {
    cards: [card],
    matched: new Map([[card.card_id, [block]]]),
    coverage: options.coverage ?? { complete: true, skipped: 0 },
  };
}

test("teach falls back to change cards when no explain record matches", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lines = [
    "export function greetUser(name: string) {",
    '  return "hello " + name;',
    "}",
  ];
  const path = fixture(home, "greet.ts", lines);
  const found = inlineCardsForFile(path);
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`], { ...deps, readCards: () => found }), 0);
  assert.deepEqual(headingLines, ["greetUser, changed by claude-code on 2026-11-18 (from change card)"]);
  assert.ok(blockLines.includes('Asked: "Add user greeting helper"'), blockLines.join("\n"));
  assert.ok(blockLines.includes("Changed: body changed"), blockLines.join("\n"));
  assert.ok(blockLines.includes('Agent said: "greets a user by name"'), blockLines.join("\n"));
  assert.ok(blockLines.includes("Matched by function name; code not compared."), blockLines.join("\n"));
  assert.deepEqual(detailLines, ["Recorded, not verified."]);
  assert.deepEqual(sayLines, []);
});

test("teach whole-file query answers from change card", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = fixture(home, "whole.ts", [
    "export function greetUser(name: string) {",
    '  return "hello " + name;',
    "}",
  ]);
  const found = inlineCardsForFile(path);
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([path], { ...deps, readCards: () => found }), 0);
  assert.deepEqual(headingLines, ["greetUser, changed by claude-code on 2026-11-18 (from change card)"]);
  assert.ok(blockLines.includes("Matched by file; code not compared."), blockLines.join("\n"));
  assert.deepEqual(detailLines, ["Recorded, not verified."]);
  assert.deepEqual(sayLines, []);
});

test("teach --stdin snippet answers from change card by symbol tier", (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = fixture(home, "stdin-card.ts", ["// file content"]);
  const found = inlineCardsForFile(path, { symbolName: "greetUser" });
  const cardsDir = join(home, "desk", "cards");
  mkdirSync(cardsDir, { recursive: true });
  writeFileSync(join(cardsDir, "_none.jsonl"), `${JSON.stringify(found.cards[0])}\n`, "utf8");

  const result = rockyTeach(home, ["--stdin", path], "export function greetUser() { return 1; }\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /greetUser, changed by claude-code on 2026-11-18 \(from change card\)/);
  assert.match(result.stderr, /Matched by function name; code not compared\./);
});

test("teach missing file with whole-file query answers from change card, or speaks empty state with no cards", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const missingPath = join(home, "removed.ts");
  const found = inlineCardsForFile(missingPath, {
    coverage: { complete: false, reason: "line-cap", skipped: 1 },
  });
  const hitSinks = sinks();
  assert.equal(await teach([missingPath], { ...hitSinks.deps, readCards: () => found }), 0);
  assert.deepEqual(hitSinks.headingLines, ["greetUser, changed by claude-code on 2026-11-18 (from change card)"]);
  assert.ok(hitSinks.blockLines.includes("Matched by file; code not compared."), hitSinks.blockLines.join("\n"));
  assert.deepEqual(hitSinks.detailLines, [
    "Recorded, not verified.",
    "Change card coverage incomplete (line-cap).",
  ]);
  assert.deepEqual(hitSinks.sayLines, []);

  const emptyCards: CardsForFile = { cards: [], matched: new Map(), coverage: { complete: true, skipped: 0 } };
  const emptySinks = sinks();
  assert.equal(await teach([missingPath], { ...emptySinks.deps, readCards: () => emptyCards }), 0);
  assert.deepEqual(emptySinks.sayLines, [EMPTY_STATE]);
  assert.deepEqual(emptySinks.headingLines, []);
  assert.deepEqual(emptySinks.blockLines, []);
  assert.deepEqual(emptySinks.detailLines, []);
});

test("teach line past end of file consults change cards before empty state", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = fixture(home, "short.ts", ["const x = 1;"]);
  const found = inlineCardsForFile(path, { symbol: null, line: 20, added: 3 });
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:21`], { ...deps, readCards: () => found }), 0);
  assert.deepEqual(headingLines, [`${path}, changed by claude-code on 2026-11-18 (from change card)`]);
  assert.ok(blockLines.includes("Matched by line; code not compared."), blockLines.join("\n"));
  assert.deepEqual(detailLines, ["Recorded, not verified."]);
  assert.deepEqual(sayLines, []);
});

test("teach still prefers a matching explain record over a matching change card", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { path, lines } = feedFixture(home, "witness-over-card.ts");
  const selection = lines.slice(4, 11).join("\n");
  recordExplain({
    cwd: process.cwd(),
    path,
    source: "agent:claude-code",
    code: "documents only, no duplicates",
    business: "journal accepts DOCENTRY documents only",
    snippet: selection,
  }, resolveRockyPaths());
  const found = inlineCardsForFile(path, { symbolName: "loadFeed" });
  let cardReads = 0;
  const { headingLines, blockLines, deps } = sinks();
  assert.equal(
    await teach([`${path}:8`], {
      ...deps,
      readCards: () => {
        cardReads += 1;
        return found;
      },
    }),
    0,
  );
  assert.equal(cardReads, 0);
  assert.deepEqual(headingLines, [WITNESS_HEADER]);
  assert.ok(blockLines.includes("code: documents only, no duplicates"));
  assert.ok(blockLines.includes("business: journal accepts DOCENTRY documents only"));
});

test("teach falls through to ladder when readCards throws", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = fixture(home, "card-throw-ladder.ts", ASYNC_FIXTURE);
  const baseline = sinks();
  assert.equal(await teach([`${path}:2`], baseline.deps), 0);

  const thrown = sinks();
  assert.equal(
    await teach([`${path}:2`], {
      ...thrown.deps,
      readCards: () => {
        throw new Error("card read failed");
      },
    }),
    0,
  );
  assert.deepEqual(thrown.sayLines, baseline.sayLines);
  assert.deepEqual(thrown.headingLines, [LADDER_HEADER]);
  assert.deepEqual(thrown.headingLines, baseline.headingLines);
  assert.deepEqual(thrown.blockLines, baseline.blockLines);
  assert.deepEqual(thrown.detailLines, baseline.detailLines);
});

test("teach speaks the new empty state when neither change cards nor ladder rungs match", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = fixture(home, "no-cards-no-ladder.ts", [""]);
  const emptyCards: CardsForFile = { cards: [], matched: new Map(), coverage: { complete: true, skipped: 0 } };
  const { sayLines, headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:1`], { ...deps, readCards: () => emptyCards }), 0);
  assert.deepEqual(sayLines, [EMPTY_STATE]);
  assert.deepEqual(validateOutputLine(EMPTY_STATE), []);
  assert.deepEqual(headingLines, []);
  assert.deepEqual(blockLines, []);
  assert.deepEqual(detailLines, []);
});

test("teach strips terminal escapes and redacts secrets in change card output", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lines = [
    "export function greetUser(name: string) {",
    '  return "hello " + name;',
    "}",
  ];
  const path = fixture(home, "sanitize-card.ts", lines);
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const found = inlineCardsForFile(path, {
    prompt: `Fix \u001b[31m${token}\u001b[0m handling`,
  });
  const { headingLines, blockLines, detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`], { ...deps, readCards: () => found }), 0);
  const rendered = [...headingLines, ...blockLines, ...detailLines].join("\n");
  assert.ok(!rendered.includes("\u001b"), rendered);
  assert.ok(!rendered.includes(token), rendered);
  assert.ok(blockLines.includes('Asked: "Fix [redacted github token] handling"'), blockLines.join("\n"));
});

test("teach prints coverage incomplete detail when change card coverage is incomplete", async (t) => {
  const home = freshHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lines = [
    "export function greetUser(name: string) {",
    '  return "hello " + name;',
    "}",
  ];
  const path = fixture(home, "incomplete-card.ts", lines);
  const found = inlineCardsForFile(path, {
    coverage: { complete: false, reason: "line-cap", skipped: 1 },
  });
  const { detailLines, deps } = sinks();
  assert.equal(await teach([`${path}:2`], { ...deps, readCards: () => found }), 0);
  assert.deepEqual(detailLines, [
    "Recorded, not verified.",
    "Change card coverage incomplete (line-cap).",
  ]);

  const noReason = inlineCardsForFile(path, {
    coverage: { complete: false, skipped: 1 },
  });
  const second = sinks();
  assert.equal(await teach([`${path}:2`], { ...second.deps, readCards: () => noReason }), 0);
  assert.deepEqual(second.detailLines, [
    "Recorded, not verified.",
    "Change card coverage incomplete (unknown).",
  ]);
});