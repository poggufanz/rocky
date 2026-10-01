import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERAGE_EMPTY_LINE,
  COVERAGE_MAX_LISTED,
  COVERAGE_MAX_SESSION_FILES,
  coverageDisclosureLines,
  coverageFromRecords,
  renderUntriedCard,
} from "../core/coverage.js";
import { deriveHome } from "../core/home-data.js";
import { briefCommand } from "../commands/brief.js";
import { validateRockyPhrase } from "../ui/phrases.js";
import type { MemoryRecord } from "../core/memory-read.js";

const NOW = 1_800_000_000_000;
const CWD = "/work/repo";

function triple(paths: string[], options: { ts?: number; rationale?: string; hunks?: boolean; cwd?: string } = {}): MemoryRecord {
  const [plus, minus] = options.hunks === false ? [0, 0] : [1, 0];
  return {
    kind: "triple",
    id: `t-${paths.join("+")}-${options.ts ?? NOW}`,
    ts: options.ts ?? NOW - 60_000,
    cwd: options.cwd ?? CWD,
    schemaV: 1,
    agent: "claude-code",
    origin: "agent-hook",
    ...(options.rationale === undefined ? {} : { rationale: { text: options.rationale, tags: [], source: "transcript" as const } }),
    mechanism: {
      files: paths.map((path) => ({ path, plusMinus: [plus, minus] as [number, number], props: [] as string[] })),
      truncatedFiles: 0,
    },
  } as unknown as MemoryRecord;
}

function rationale(files: string[], ts = NOW - 60_000): MemoryRecord {
  return {
    kind: "rationale", id: `r-${files.join("+")}-${ts}`, ts, v: 1, cwd: CWD,
    agent: "generic", rationale_fidelity: "summary", source: "notify",
    excerpt: "why text", files,
  } as MemoryRecord;
}

function isolateAgentLogEnv(home: string): { restore: () => void } {
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    DSH_SESSION_JSONL: process.env.DSH_SESSION_JSONL,
  };
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude-config-here");
  process.env.DSH_SESSION_JSONL = join(home, "no-dsh-log-here.jsonl.zstd");
  return {
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key as keyof typeof previous];
        else process.env[key as keyof typeof previous] = value;
      }
    },
  };
}

function makeRepo(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-coverage-")));
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  git("init");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "touched.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "untried.ts"), "export const b = 2;\n");
  git("add", ".");
  git("commit", "-m", "feat: touch two files");
  return dir;
}

async function captureStdio(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalStderr = process.stderr.write;
  const lines: string[] = [];
  let stderr = "";
  console.log = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as typeof console.log;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout: lines.join("\n"), stderr };
  } finally {
    console.log = originalLog;
    process.stderr.write = originalStderr;
  }
}

test("tried versus untried split: hunks and rationale files count, bare observations do not", () => {
  const records = [
    triple(["src/a.ts"]), // hunks [1, 0]: tried
    rationale(["src/b.ts"]), // rationale files entry: tried
    triple(["src/c.ts"], { hunks: false }), // bare [0, 0], no rationale: touched, not tried
  ];
  const result = coverageFromRecords(records, { sessionFiles: ["src/a.ts", "src/b.ts", "src/c.ts"], cwd: CWD });
  assert.equal(result.empty, false);
  assert.deepEqual(result.tried, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.untried, ["src/c.ts"]);
  assert.equal(result.triedTotal, 2);
  assert.equal(result.untriedTotal, 1);
  assert.equal(result.truncated, false);
});

test("a triple with rationale text counts as tried even without hunks", () => {
  const records = [triple(["src/d.ts"], { hunks: false, rationale: "retry loop guards double commit" })];
  const result = coverageFromRecords(records, { sessionFiles: ["src/d.ts"], cwd: CWD });
  assert.deepEqual(result.tried, ["src/d.ts"]);
  assert.deepEqual(result.untried, []);
});

test("explain and note records count as rationale evidence", () => {
  const explain = {
    kind: "explain", id: "e1", ts: NOW - 1000, v: 1, cwd: CWD,
    path: "src/e.ts", source: "agent:test", code: "code", business: "business",
  } as unknown as MemoryRecord;
  const note = {
    kind: "note", id: "n1", ts: NOW - 1000, cwd: CWD, cmd: "rocky why",
    file: "src/f.ts", line: 3, subject: "retry", answer: "backoff",
  } as unknown as MemoryRecord;
  const result = coverageFromRecords([explain, note], { sessionFiles: ["src/e.ts", "src/f.ts", "src/g.ts"], cwd: CWD });
  assert.deepEqual(result.tried, ["src/e.ts", "src/f.ts"]);
  assert.deepEqual(result.untried, ["src/g.ts"]);
});

test("out-of-window and out-of-repo evidence does not mark tried", () => {
  const stale = triple(["src/a.ts"], { ts: NOW - 30 * 24 * 60 * 60 * 1000 });
  const foreign = { ...rationale(["src/b.ts"]), cwd: "/elsewhere" } as MemoryRecord;
  const result = coverageFromRecords([stale, foreign], {
    sessionFiles: ["src/a.ts", "src/b.ts"],
    cwd: CWD,
    sinceTs: NOW - 60 * 60 * 1000,
    now: NOW,
  });
  assert.deepEqual(result.tried, []);
  assert.deepEqual(result.untried, ["src/a.ts", "src/b.ts"]);
});

test("records-only session derives heard files; untried lists at most COVERAGE_MAX_LISTED", () => {
  const files = Array.from({ length: 14 }, (_, index) => `src/file-${index}.ts`);
  const records = [triple(files, { hunks: false })];
  const result = coverageFromRecords(records);
  assert.equal(result.empty, false);
  assert.deepEqual(result.tried, []);
  assert.equal(result.untriedTotal, 14);
  assert.equal(result.untried.length, COVERAGE_MAX_LISTED);
  assert.equal(result.truncated, true);
  assert.equal(COVERAGE_MAX_LISTED, 10);
});

test("truncation flag propagates from memory disclosure and session cap", () => {
  const disclosed = coverageFromRecords([], { memoryTruncated: true });
  assert.equal(disclosed.empty, true);
  assert.equal(disclosed.truncated, true);
  const many = Array.from({ length: COVERAGE_MAX_SESSION_FILES + 5 }, (_, index) => `src/s-${index}.ts`);
  const capped = coverageFromRecords([], { sessionFiles: many });
  assert.equal(capped.truncated, true);
  // Totals count named files only; the flag discloses the over-cap remainder.
  assert.equal(capped.untriedTotal, COVERAGE_MAX_SESSION_FILES);
  assert.equal(capped.untried.length, COVERAGE_MAX_LISTED);
});

test("empty session returns the honest empty state, never all-covered", () => {
  const result = coverageFromRecords([]);
  assert.equal(result.empty, true);
  assert.deepEqual(result.tried, []);
  assert.deepEqual(result.untried, []);
  const card = renderUntriedCard(result);
  assert.deepEqual(card, [COVERAGE_EMPTY_LINE]);
  assert.match(card.join("\n"), /nothing untried, nothing tried/);
  assert.doesNotMatch(card.join("\n"), /all covered|all heard/);
});

test("rendered cards name counts and paths without shaming or question marks", () => {
  const split = coverageFromRecords([rationale(["src/a.ts"])], { sessionFiles: ["src/a.ts", "src/b.ts"], cwd: CWD });
  const card = renderUntriedCard(split);
  assert.match(card[0], /1 file touched but not heard why yet\./);
  assert.ok(card.includes("src/b.ts"));
  assert.doesNotMatch(card.join("\n"), /\?/);
  assert.doesNotMatch(card.join("\n"), /you ignored|you missed|shame|blame/);

  const allTried = renderUntriedCard(coverageFromRecords([rationale(["src/a.ts"])], { sessionFiles: ["src/a.ts"], cwd: CWD }));
  assert.match(allTried.join("\n"), /heard with why\. good good\./);
  assert.doesNotMatch(allTried.join("\n"), /\?/);

  for (const line of [...card, ...allTried, COVERAGE_EMPTY_LINE]) {
    assert.deepEqual(validateRockyPhrase(line), [], line);
  }
});

test("never throws on garbage input", () => {
  assert.doesNotThrow(() => coverageFromRecords(undefined));
  assert.doesNotThrow(() => coverageFromRecords("garbage", { sessionFiles: "nope" as unknown as readonly unknown[] }));
  assert.doesNotThrow(() => coverageFromRecords(null, { cwd: "", sinceTs: NaN, now: Infinity }));
  assert.deepEqual(renderUntriedCard(undefined), [COVERAGE_EMPTY_LINE]);
  assert.deepEqual(renderUntriedCard(null), [COVERAGE_EMPTY_LINE]);
  assert.deepEqual(renderUntriedCard("garbage"), [COVERAGE_EMPTY_LINE]);
});

test("dash home payload carries truncated flag and totals alongside the bounded lists", () => {
  const files = Array.from({ length: 14 }, (_, index) => `src/file-${index}.ts`);
  const home = deriveHome([triple(files, { hunks: false })], undefined, NOW);
  assert.equal(home.coverage.untriedTotal, 14);
  assert.equal(home.coverage.untried.length, COVERAGE_MAX_LISTED);
  assert.equal(home.coverage.truncated, true);
  assert.equal(home.coverage.triedTotal, 0);
});

test("dash home payload marks truncation from an incomplete memory read, even when empty", () => {
  const partial = deriveHome([], "file-size-cap", NOW);
  assert.equal(partial.coverage.truncated, true);
  assert.deepEqual(partial.coverage.tried, []);
  assert.deepEqual(partial.coverage.untried, []);
  const full = deriveHome([], undefined, NOW);
  assert.equal(full.coverage.truncated, false);
});

test("disclosure lines show both memory and list-cap lines when both hold, never shadowing", () => {
  const memory = { version: 1 as const, scanned: 10, skipped: 0, truncated: 2, bytesScanned: 100, bytesTotal: 200, complete: false as boolean };
  const capped = coverageFromRecords(
    [triple(Array.from({ length: 12 }, (_, index) => `src/u-${index}.ts`), { hunks: false })],
  );
  assert.equal(capped.truncated, true);
  const both = coverageDisclosureLines(capped, memory, true);
  assert.equal(both.length, 2);
  assert.match(both[0], /memory coverage: version 1, scanned 10, skipped 0, truncated 2, complete false/);
  assert.match(both[1], /coverage partial: names 10 at most, 12 untried named\./);
  assert.doesNotMatch(both.join("\n"), /\?/);

  const memoryOnly = coverageDisclosureLines(
    coverageFromRecords([rationale(["src/a.ts"])], { sessionFiles: ["src/a.ts"], cwd: CWD }),
    memory,
    true,
  );
  assert.equal(memoryOnly.length, 1);
  assert.match(memoryOnly[0], /memory coverage:/);

  const capOnly = coverageDisclosureLines(capped, undefined, false);
  assert.equal(capOnly.length, 1);
  assert.match(capOnly[0], /coverage partial:/);

  const clean = coverageDisclosureLines(
    coverageFromRecords([rationale(["src/a.ts"])], { sessionFiles: ["src/a.ts"], cwd: CWD }),
    { ...memory, complete: true as boolean },
    false,
  );
  assert.deepEqual(clean, []);
  assert.deepEqual(coverageDisclosureLines(undefined, undefined, false), []);
  assert.deepEqual(coverageDisclosureLines("garbage", "garbage" as unknown as typeof memory, true), []);
});

test("dash home payload carries bounded coverage tried and untried arrays", () => {
  const home = deriveHome([triple(["src/a.ts"]), triple(["src/b.ts"], { hunks: false })], undefined, NOW);
  assert.ok(Array.isArray(home.coverage.tried));
  assert.ok(Array.isArray(home.coverage.untried));
  assert.ok(home.coverage.tried.length <= COVERAGE_MAX_LISTED);
  assert.ok(home.coverage.untried.length <= COVERAGE_MAX_LISTED);
  assert.ok(home.coverage.tried.some((path) => path.includes("src/a.ts")));
  assert.ok(home.coverage.untried.some((path) => path.includes("src/b.ts")));
  // Existing dash shape unchanged around the new field.
  assert.equal(typeof home.total, "number");
  assert.ok(Array.isArray(home.recent));
});

test("brief appends an untried section without altering the decompose template", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    writeFileSync(
      join(home, "memory.jsonl"),
      `${JSON.stringify(triple(["touched.ts"], { cwd: dir, ts: Date.now() - 60_000 }))}\n`,
      "utf8",
    );
    const { code, stdout, stderr } = await captureStdio(
      () => briefCommand(["--since", "1d", "--quiet", "--decompose"], dir),
    );
    assert.equal(code, 0);
    // Untried section names the window file with no why evidence.
    assert.match(stderr, /untried/);
    assert.match(stderr, /untried\.ts/);
    assert.match(stderr, /not heard why yet/);
    assert.doesNotMatch(stderr, /\?/);
    // The hunk-backed window file is tried, so it stays out of the section.
    // (stdout still names it under changes by area; stderr must not.)
    assert.doesNotMatch(stderr, /touched\.ts/);
    // Task 3 template intact: the appended section changes nothing about it.
    assert.match(stdout, /^1\. behavior:/m);
    assert.match(stdout, /^2\. state:/m);
    assert.match(stdout, /^3\. verify:/m);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("brief with an empty window stays honest about coverage", async () => {
  const dir = makeRepo();
  const home = mkdtempSync(join(tmpdir(), "rocky-home-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  const agentLogs = isolateAgentLogEnv(home);
  try {
    const { code, stderr } = await captureStdio(
      () => briefCommand(["--since", "1d", "--quiet"], dir),
    );
    assert.equal(code, 0);
    assert.match(stderr, /untried/);
    // Window files exist here, so the honest line is the count line, and it
    // must never claim full coverage when nothing was heard.
    assert.match(stderr, /touched but not heard why yet/);
    assert.doesNotMatch(stderr, /all heard with why/);
  } finally {
    agentLogs.restore();
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});
