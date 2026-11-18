import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { why, type DictionaryCommandDeps } from "../commands/dictionary.js";
import type { GitDiffOptions, GitDiffResult } from "../core/git-diff.js";
import {
  MEMORY_FORMAT_VERSION,
  type MemoryCoverage,
  type MemoryRecord,
  type TripleRecord,
} from "../core/memory-read.js";
import type { CardsForFile, StoredBlock, StoredCard } from "../desk/cards-read.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { validateOutputLine } from "../ui/phrases.js";

function localHm(ms: number): string {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function localDateHm(ms: number): string {
  const date = new Date(ms);
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mon = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mon}-${dd} ${localHm(ms)}`;
}

function makeSinks() {
  const errLines: string[] = [];
  const outLines: string[] = [];
  return {
    errLines,
    outLines,
    say: (line: string) => { errLines.push(line); },
    out: (line: string) => { outLines.push(line); },
  };
}

function completeCoverage(overrides: Partial<MemoryCoverage> = {}): MemoryCoverage {
  return {
    version: MEMORY_FORMAT_VERSION,
    scanned: 0,
    skipped: 0,
    truncated: 0,
    bytesScanned: 0,
    bytesTotal: 0,
    complete: true,
    ...overrides,
  };
}

function makeTriple(id: string, filePath: string, intentText: string, ts: number, cwd = process.cwd()): TripleRecord {
  return {
    kind: "triple",
    id,
    ts,
    cwd,
    schemaV: 1,
    agent: "claude-code",
    origin: "agent-hook",
    intent: { text: intentText },
    mechanism: {
      files: [{ path: filePath, plusMinus: [4, 1], props: ["function:applyDiscount"], provenance: "tool-observed" }],
      truncatedFiles: 0,
      baseline: "captured",
      coverageStatus: "complete",
    },
  };
}

function makeBlock(overrides: Partial<StoredBlock> = {}): StoredBlock {
  return {
    seq: 1,
    path: "src/cart.ts",
    symbol: {
      kind: "function",
      name: "applyDiscount",
      container: null,
      exported: true,
    },
    labels: [{ id: "symbol_added" }],
    importance: "medium",
    via: "edit",
    bash: null,
    recorded: true,
    quote: null,
    ...overrides,
  };
}

function makeCard(overrides: Partial<StoredCard> = {}): StoredCard {
  const ended = new Date(2026, 10, 15, 14, 2, 0).getTime();
  const block = makeBlock();
  return {
    v: 1,
    card_id: "card-1",
    rev: 1,
    root: process.cwd(),
    agent_type: "",
    parent_card_id: null,
    started_ms: ended - 15_000,
    ended_ms: ended,
    prompt: "Add member discount to the cart",
    blocks: [block],
    ...overrides,
  };
}

function makeResult(cards: StoredCard[], coverage: CardsForFile["coverage"] = { complete: true, skipped: 0 }): CardsForFile {
  const matched = new Map<string, StoredBlock[]>();
  for (const card of cards) {
    matched.set(card.card_id, card.blocks);
  }
  return { cards, matched, coverage };
}

function withTempRockyHome<T>(fn: (home: string) => T): T {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-why-home-")));
  const prevHome = process.env.ROCKY_HOME;
  try {
    process.env.ROCKY_HOME = home;
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function freshRepoAndHome(): { home: string; repoRoot: string; cleanup: () => void } {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-why-home-")));
  const repoRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-why-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repoRoot });
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "cart.ts"), "export const applyDiscount = () => 1;\n", "utf8");
  return {
    home,
    repoRoot,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

test("why prints nothing extra when no cards exist (mocked and empty ROCKY_HOME)", () => {
  const now = new Date(2026, 10, 15, 15, 0, 0).getTime();
  const baseDeps: DictionaryCommandDeps = {
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult([]),
  };
  const emptySinks = makeSinks();
  const code = why(["ghost.css"], { ...baseDeps, ...emptySinks });
  assert.equal(code, 0);
  assert.equal(emptySinks.errLines.some((line) => line.includes("Agent changes to")), false);
  assert.equal(emptySinks.outLines.length, 0);

  const { home, repoRoot, cleanup } = freshRepoAndHome();
  const prevHome = process.env.ROCKY_HOME;
  const prevCwd = process.cwd();
  try {
    process.env.ROCKY_HOME = home;
    process.chdir(repoRoot);
    const realSinks = makeSinks();
    const realCode = why(["src/cart.ts"], {
      say: realSinks.say,
      out: realSinks.out,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
    });
    assert.equal(realCode, 0);
    assert.equal(realSinks.errLines.some((line) => line.includes("Agent changes to")), false);
    assert.equal(realSinks.outLines.length, 0);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevHome;
    cleanup();
  }
});

test("why formats brief example card with time, quote, no-quote block, and symbol kind", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const ended = new Date(2026, 10, 15, 14, 2, 0).getTime();
  const card = makeCard({
    ended_ms: ended,
    started_ms: ended - 10_000,
    prompt: "Add member discount to the cart",
    blocks: [
      makeBlock({
        seq: 1,
        symbol: { kind: "function", name: "applyDiscount", container: null, exported: true },
        labels: [{ id: "symbol_added" }],
        quote: { text: "Split the discount so it can be tested alone", shared: true },
      }),
      makeBlock({
        seq: 2,
        symbol: { kind: "const", name: "maxDiscount", container: null, exported: false },
        labels: [{ id: "symbol_added" }],
        quote: null,
      }),
    ],
  });

  const sinks = makeSinks();
  const code = why(["src/cart.ts"], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult([card]),
  });

  assert.equal(code, 0);
  assert.deepEqual(sinks.errLines.slice(-1), ["Agent changes to src/cart.ts (newest first)"]);
  assert.deepEqual(sinks.outLines, [
    `  ${localHm(ended)}  Add member discount to the cart`,
    '         applyDiscount: new function. Agent said: "Split the discount so it can be tested alone". Recorded, not verified.',
    "         maxDiscount: new const.",
  ]);
  for (const line of [...sinks.errLines, ...sinks.outLines]) {
    assert.deepEqual(validateOutputLine(line), []);
  }
});

test("why appends cards after every exit-0 path and preserves prior lines, while skipping --add and usage errors", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const ended = new Date(2026, 10, 15, 14, 2, 0).getTime();
  const card = makeCard({ ended_ms: ended });
  const cardResult = makeResult([card]);
  const emptyResult = makeResult([]);

  const scenarios: Array<{
    name: string;
    argv: string[];
    memory: MemoryRecord[];
    cov: MemoryCoverage;
    gitDiff?: (options: GitDiffOptions) => GitDiffResult | undefined;
  }> = [
    {
      name: "main hit path",
      argv: ["src/cart.ts"],
      memory: [makeTriple("t1", "src/cart.ts", "Keep member discounts separate", now - 60_000)],
      cov: completeCoverage({ scanned: 1 }),
    },
    {
      name: "empty complete path",
      argv: ["src/cart.ts"],
      memory: [],
      cov: completeCoverage(),
    },
    {
      name: "empty incomplete coverage path",
      argv: ["src/cart.ts"],
      memory: [],
      cov: completeCoverage({ complete: false, truncated: 1, reason: "record-cap" }),
    },
    {
      name: "ambiguousPath path",
      argv: ["cart.ts"],
      memory: [
        makeTriple("t-a", "src/a/cart.ts", "Cart A", now - 60_000),
        makeTriple("t-b", "src/b/cart.ts", "Cart B", now - 30_000),
      ],
      cov: completeCoverage({ scanned: 2 }),
    },
    {
      name: "--diff path",
      argv: ["--diff", "src/cart.ts"],
      memory: [makeTriple("t1", "src/cart.ts", "Keep member discounts separate", now - 60_000)],
      cov: completeCoverage({ scanned: 1 }),
      gitDiff: () => ({
        commit: "abc1234567",
        diff: "+export const memberDiscount = 0.1;\n",
      }),
    },
  ];

  for (const scenario of scenarios) {
    const baseSinks = makeSinks();
    const baseCode = why(scenario.argv, {
      ...baseSinks,
      load: () => scenario.memory,
      coverage: () => scenario.cov,
      now,
      gitDiff: scenario.gitDiff,
      cards: () => emptyResult,
    });
    const withCardsSinks = makeSinks();
    const withCardsCode = why(scenario.argv, {
      ...withCardsSinks,
      load: () => scenario.memory,
      coverage: () => scenario.cov,
      now,
      gitDiff: scenario.gitDiff,
      cards: () => cardResult,
    });

    assert.equal(baseCode, 0, scenario.name);
    assert.equal(withCardsCode, 0, scenario.name);
    assert.deepEqual(
      withCardsSinks.errLines.slice(0, baseSinks.errLines.length),
      baseSinks.errLines,
      `${scenario.name}: prior say lines unchanged`,
    );
    assert.deepEqual(
      withCardsSinks.outLines.slice(0, baseSinks.outLines.length),
      baseSinks.outLines,
      `${scenario.name}: prior out lines unchanged`,
    );
    assert.deepEqual(
      withCardsSinks.errLines.slice(baseSinks.errLines.length),
      [`Agent changes to ${scenario.argv[scenario.argv.length - 1]} (newest first)`],
      `${scenario.name}: appends heading`,
    );
    assert.equal(
      withCardsSinks.outLines.length > baseSinks.outLines.length,
      true,
      `${scenario.name}: appends card lines`,
    );
    if (scenario.gitDiff) {
      assert.equal(
        withCardsSinks.outLines.some((line) => line.includes("+export const memberDiscount = 0.1;")),
        true,
        "--diff still renders diff lines",
      );
    }
  }

  let cardCalls = 0;
  const nonQueryDeps = (): DictionaryCommandDeps => ({
    ...makeSinks(),
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => {
      cardCalls += 1;
      return cardResult;
    },
  });

  withTempRockyHome((home) => {
    const addSinks = makeSinks();
    assert.equal(why(["--add", "src/cart.ts", "Because discounts stack"], { ...nonQueryDeps(), ...addSinks }), 0);
    assert.equal(cardCalls, 0);
    assert.equal(existsSync(join(home, "memory.jsonl")), true);
  });

  const missingSinks = makeSinks();
  assert.equal(why([], { ...nonQueryDeps(), ...missingSinks }), 2);
  assert.equal(cardCalls, 0);

  const badFlagSinks = makeSinks();
  assert.equal(why(["--unknown-flag", "src/cart.ts"], { ...nonQueryDeps(), ...badFlagSinks }), 2);
  assert.equal(cardCalls, 0);
});

test("why formats cross-day date, ended_ms fallback, subagent prefix, containers, file-level, empty labels, and bash blocks", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const yesterdayStart = new Date(2026, 10, 14, 9, 5, 0).getTime();
  const card = makeCard({
    card_id: "card-sub",
    agent_type: "code-reviewer",
    started_ms: yesterdayStart,
    ended_ms: null,
    prompt: "Check edge cases",
    blocks: [
      makeBlock({
        seq: 1,
        symbol: { kind: "method", name: "apply", container: "Discount", exported: true },
        labels: [{ id: "call_added", args: { name: "taxRate" } }],
      }),
      makeBlock({
        seq: 2,
        symbol: null,
        labels: [],
        via: "bash",
        bash: { cmd: "npm run fmt", candidates: 2 },
      }),
      makeBlock({
        seq: 3,
        symbol: { kind: "function", name: "normalize", container: null, exported: false },
        labels: [{ id: "body_changed" }],
        quote: { text: "Clean up whitespace", shared: false },
        via: "bash",
        bash: { cmd: "sed -i s/a/b/ src/cart.ts", candidates: 1 },
      }),
    ],
  });

  const sinks = makeSinks();
  const code = why(["src/cart.ts"], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult([card]),
  });

  assert.equal(code, 0);
  assert.deepEqual(sinks.outLines, [
    `  ${localDateHm(yesterdayStart)}  code-reviewer › Check edge cases`,
    "         Discount.apply: calls taxRate.",
    "         file: changed. (via npm run fmt)",
    '         normalize: body changed. Agent said: "Clean up whitespace". Recorded, not verified. (via sed -i s/a/b/ src/cart.ts)',
  ]);
});

test("why enforces 5-card cap, 5-block cap with +N more, and character cuts (title 100, quote 120, bash 60)", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const baseTime = new Date(2026, 10, 15, 14, 0, 0).getTime();

  const longTitle = `${"𝄞".repeat(105)}`;
  const longQuote = `${"q".repeat(125)}`;
  const longBash = `${"b".repeat(65)}`;

  const sevenBlocks: StoredBlock[] = Array.from({ length: 7 }, (_, index) =>
    makeBlock({
      seq: index + 1,
      symbol: { kind: "function", name: `fn${index + 1}`, container: null, exported: true },
      labels: [{ id: "body_changed" }],
      ...(index === 0 ? { quote: { text: longQuote, shared: true }, via: "bash" as const, bash: { cmd: longBash, candidates: 2 } } : {}),
    }),
  );

  const sevenCards: StoredCard[] = Array.from({ length: 7 }, (_, index) =>
    makeCard({
      card_id: `card-${index + 1}`,
      ended_ms: baseTime + index * 60_000,
      prompt: index === 0 ? longTitle : `Task ${index + 1}`,
      blocks: index === 0 ? sevenBlocks : [makeBlock({ seq: 1 })],
    }),
  );

  const sinks = makeSinks();
  const code = why(["src/cart.ts"], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult(sevenCards),
  });

  assert.equal(code, 0);
  const cardHeaders = sinks.outLines.filter((line) => line.startsWith("  ") && !line.startsWith("         "));
  assert.equal(cardHeaders.length, 5);
  assert.equal(sinks.outLines.includes("  14:05  Task 6"), false);
  assert.equal(sinks.outLines.includes("  14:06  Task 7"), false);

  assert.equal(cardHeaders[0], `  ${localHm(baseTime)}  ${"𝄞".repeat(99)}…`);
  assert.equal(
    sinks.outLines[1],
    `         fn1: body changed. Agent said: "${"q".repeat(119)}…". Recorded, not verified. (via ${"b".repeat(59)}…)`,
  );
  assert.equal(sinks.outLines.includes("         fn6: body changed."), false);
  assert.equal(sinks.outLines.includes("         +2 more"), true);
});

test("why formats harness prompt envelopes via promptTitle", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const t1 = new Date(2026, 10, 15, 14, 1, 0).getTime();
  const t2 = new Date(2026, 10, 15, 14, 2, 0).getTime();
  const t3 = new Date(2026, 10, 15, 14, 3, 0).getTime();

  const cards: StoredCard[] = [
    makeCard({ card_id: "c1", ended_ms: t1, prompt: "<task-notification>build complete</task-notification>" }),
    makeCard({ card_id: "c2", ended_ms: t2, prompt: '<cross-session-message from="worker">ping</cross-session-message>' }),
    makeCard({ card_id: "c3", ended_ms: t3, prompt: "<command-name>/review</command-name><command-args>src/cart.ts</command-args>" }),
  ];

  const sinks = makeSinks();
  const code = why(["src/cart.ts"], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult(cards),
  });

  assert.equal(code, 0);
  const cardHeaders = sinks.outLines.filter((line) => line.startsWith("  ") && !line.startsWith("         "));
  assert.deepEqual(cardHeaders, [
    `  ${localHm(t1)}  Background task notice`,
    `  ${localHm(t2)}  Message from another session`,
    `  ${localHm(t3)}  /review src/cart.ts`,
  ]);
});

test("why neutralizes terminal-hostile text and bounds every output line to 512 bytes", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const card = makeCard({
    agent_type: "\u001b[31magent\u202e?\u200b",
    prompt: `\u001b]0;pwn\u0007Bad\r\nprompt\t?\uFF1F\u2066${"é".repeat(300)}`,
    blocks: [
      makeBlock({
        symbol: {
          kind: "function",
          name: "bad\u001b[2JName?\u202e",
          container: "Box\r\nName\u200b",
          exported: true,
        },
        labels: [{ id: "call_added", args: { name: "arg\u001b[33m?\u2066" } }],
        quote: { text: `\u001b[31mWhy?\r\nsecret\u202e${"ü".repeat(300)}`, shared: true },
        via: "bash",
        bash: { cmd: "echo \u001b[31mhi\u0007\nworld?", candidates: 1 },
      }),
    ],
  });

  const sinks = makeSinks();
  const hostilePath = "src/\u001b[31mcart?\r\n.ts\u202e";
  const code = why([hostilePath], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult([card]),
  });

  assert.equal(code, 0);
  const allLines = [...sinks.errLines, ...sinks.outLines];
  assert.equal(sinks.errLines.length, 2);
  assert.equal(sinks.outLines.length, 2);
  assert.equal(allLines.length, 4);
  for (const line of allLines) {
    assert.equal(Buffer.byteLength(line, "utf8") <= 512, true, `line exceeded 512 bytes: ${line}`);
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff?？]/u.test(line), false, line);
  }
});

test("why preserves Recorded, not verified. and Bash suffix across multibyte quotes and long symbol or label text", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const multibyteQuote = "𝄞".repeat(120);
  const card = makeCard({
    blocks: [
      makeBlock({
        seq: 1,
        symbol: { kind: "function", name: "applyDiscount", container: null, exported: true },
        labels: [{ id: "symbol_added" }],
        quote: { text: multibyteQuote, shared: true },
        via: "bash",
        bash: { cmd: "npm run fmt", candidates: 1 },
      }),
      makeBlock({
        seq: 2,
        symbol: {
          kind: "method",
          name: "applyLongDiscountCalculationMethodName".repeat(4),
          container: "VeryLongCartDiscountContainerBox".repeat(5),
          exported: true,
        },
        labels: [{ id: "call_added", args: { name: "calculateLongMemberDiscountRate".repeat(5) } }],
        quote: { text: multibyteQuote, shared: true },
        via: "bash",
        bash: { cmd: `npm run ${"𐍈".repeat(52)}`, candidates: 2 },
      }),
      makeBlock({
        seq: 3,
        symbol: {
          kind: "method",
          name: "removeDiscountRule".repeat(8),
          container: "CheckoutDiscountRegistry".repeat(6),
          exported: true,
        },
        labels: [{ id: "call_removed", args: { name: "legacyTaxCalculationHelper".repeat(5) } }],
        quote: null,
        via: "bash",
        bash: { cmd: "𐍈".repeat(60), candidates: 1 },
      }),
      makeBlock({
        seq: 4,
        symbol: { kind: "function", name: "applyDiscount", container: null, exported: true },
        labels: [{ id: "body_changed" }],
        quote: { text: multibyteQuote, shared: true },
        via: "bash",
        bash: { cmd: "\u001b[31m", candidates: 1 },
      }),
    ],
  });

  const sinks = makeSinks();
  const code = why(["src/cart.ts"], {
    ...sinks,
    load: () => [],
    coverage: () => completeCoverage(),
    now,
    cards: () => makeResult([card]),
  });

  assert.equal(code, 0);
  assert.equal(sinks.outLines.length, 5);
  for (const line of [...sinks.errLines, ...sinks.outLines]) {
    assert.equal(Buffer.byteLength(line, "utf8") <= 512, true, `line exceeded 512 bytes: ${line}`);
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff?？]/u.test(line), false, line);
  }

  const block1 = sinks.outLines[1]!;
  assert.equal(block1.startsWith("         applyDiscount: new function. "), true, block1);
  assert.equal(block1.includes('Agent said: "'), true, block1);
  assert.equal(block1.includes('". Recorded, not verified.'), true, block1);
  assert.equal(block1.endsWith(" (via npm run fmt)"), true, block1);

  const block2 = sinks.outLines[2]!;
  assert.equal(block2.startsWith("         "), true, block2);
  assert.equal(block2.includes(": calls "), true, block2);
  assert.equal(block2.includes('Agent said: "'), true, block2);
  assert.equal(block2.includes('". Recorded, not verified.'), true, block2);
  assert.equal(block2.includes(" (via npm run "), true, block2);
  assert.equal(block2.endsWith(")"), true, block2);

  const block3 = sinks.outLines[3]!;
  assert.equal(block3.includes(": no longer calls "), true, block3);
  assert.equal(block3.includes("Agent said:"), false, block3);
  assert.equal(block3.includes(" (via "), true, block3);
  assert.equal(block3.endsWith(")"), true, block3);

  const block4 = sinks.outLines[4]!;
  assert.equal(block4.includes('". Recorded, not verified.'), true, block4);
  assert.equal(block4.endsWith(" (via bash)"), true, block4);
});

test("why emits partial-read coverage line and suppresses errors from card reader", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const card = makeCard();

  const partialByReason = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...partialByReason,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([card], { complete: false, reason: "line-cap", skipped: 4 }),
    }),
    0,
  );
  const partialLine = "Change cards were only partly read (line-cap); older changes may be missing.";
  assert.equal(partialByReason.outLines.at(-1), partialLine);
  assert.deepEqual(validateOutputLine(partialLine), []);

  const partialSkippedOnly = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...partialSkippedOnly,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([card], { complete: false, skipped: 3 }),
    }),
    0,
  );
  assert.equal(
    partialSkippedOnly.outLines.at(-1),
    "Change cards were only partly read (3 skipped); older changes may be missing.",
  );

  const throwSinks = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...throwSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => {
        throw new Error("corrupt card store");
      },
    }),
    0,
  );
  assert.equal(throwSinks.errLines.some((line) => line.includes("Agent changes to")), false);
  assert.equal(throwSinks.outLines.length, 0);
});

test("why reads real change cards end-to-end via cardsForFile and ROCKY_HOME", () => {
  const { home, repoRoot, cleanup } = freshRepoAndHome();
  const prevHome = process.env.ROCKY_HOME;
  const prevCwd = process.cwd();
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const olderEnded = new Date(2026, 10, 14, 11, 20, 0).getTime();
  const newerEnded = new Date(2026, 10, 15, 14, 2, 0).getTime();

  const diskRecord = (card: StoredCard) => JSON.stringify({
    v: 1,
    card_id: card.card_id,
    rev: card.rev,
    repo_id: "repo-1",
    root: repoRoot,
    main_root: null,
    branch: null,
    session_id: "sess-1",
    agent_id: "agent-1",
    agent_type: card.agent_type ?? "",
    parent_card_id: card.parent_card_id ?? null,
    started_ms: card.started_ms,
    ended_ms: card.ended_ms,
    status: "done",
    prompt: card.prompt,
    prompt_truncated: false,
    importance: "medium",
    blocks: card.blocks.map((block) => ({
      ...block,
      tool_use_ids: ["tool-1"],
      before: null,
      after: null,
      line: 10,
      added: 4,
      removed: 0,
    })),
    more_count: 0,
    flow: [],
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "full", reasons: [] },
  });

  try {
    process.env.ROCKY_HOME = home;
    process.chdir(repoRoot);

    const cardsPath = cardsFilePath(repoRoot, home);
    mkdirSync(join(home, "desk", "cards"), { recursive: true });
    const older = makeCard({
      card_id: "older-1",
      rev: 1,
      root: repoRoot,
      started_ms: olderEnded - 5_000,
      ended_ms: olderEnded,
      prompt: "Initialize cart helper",
      blocks: [
        makeBlock({
          seq: 1,
          symbol: null,
          labels: [{ id: "file_new" }],
        }),
      ],
    });
    const newerRev1 = makeCard({
      card_id: "newer-1",
      rev: 1,
      root: repoRoot,
      started_ms: newerEnded - 5_000,
      ended_ms: newerEnded,
      prompt: "Draft member discount",
      blocks: [makeBlock({ seq: 1 })],
    });
    const newerRev2 = makeCard({
      card_id: "newer-1",
      rev: 2,
      root: repoRoot,
      started_ms: newerEnded - 5_000,
      ended_ms: newerEnded,
      prompt: "Add member discount to the cart",
      blocks: [
        makeBlock({
          seq: 1,
          symbol: { kind: "function", name: "applyDiscount", container: null, exported: true },
          labels: [{ id: "symbol_added" }],
          quote: { text: "Split the discount so it can be tested alone", shared: true },
        }),
        makeBlock({
          seq: 2,
          symbol: { kind: "const", name: "maxDiscount", container: null, exported: false },
          labels: [{ id: "symbol_added" }],
          quote: null,
        }),
      ],
    });

    writeFileSync(
      cardsPath,
      `${[diskRecord(older), diskRecord(newerRev1), diskRecord(newerRev2)].join("\n")}\n`,
      "utf8",
    );

    const sinks = makeSinks();
    const code = why(["src/cart.ts"], {
      say: sinks.say,
      out: sinks.out,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
    });

    assert.equal(code, 0);
    assert.deepEqual(sinks.errLines, [
      'No record names "src/cart.ts". It is not known whether an agent touched it.',
      "Agent changes to src/cart.ts (newest first)",
    ]);
    assert.deepEqual(sinks.outLines, [
      `  ${localHm(newerEnded)}  Add member discount to the cart`,
      '         applyDiscount: new function. Agent said: "Split the discount so it can be tested alone". Recorded, not verified.',
      "         maxDiscount: new const.",
      `  ${localDateHm(olderEnded)}  Initialize cart helper`,
      "         file: new file.",
    ]);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevHome;
    cleanup();
  }
});

test("why emits partial-read coverage line even with zero matching cards and handles non-bash string via", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();

  const partialZero = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...partialZero,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([], { complete: false, reason: "file-size-cap", skipped: 0 }),
    }),
    0,
  );
  assert.equal(partialZero.errLines.some((line) => line.includes("Agent changes to")), false);
  assert.deepEqual(partialZero.outLines, [
    "Change cards were only partly read (file-size-cap); older changes may be missing.",
  ]);

  const unknownViaCard = makeCard({
    blocks: [makeBlock({ via: "python", bash: { cmd: "ignored", candidates: 1 } })],
  });
  const unknownViaSinks = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...unknownViaSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([unknownViaCard]),
    }),
    0,
  );
  const blockLine = unknownViaSinks.outLines[1] ?? "";
  assert.equal(blockLine.includes("(via "), false, blockLine);
});

test("why prints Sequence line only when edit_seqs touches a matched block for that file and runs through terminalSafe", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();
  const cartBlock = makeBlock({ seq: 2, path: "src/cart.ts", symbol: { kind: "function", name: "applyDiscount", container: null, exported: true } });
  const otherBlock = makeBlock({ seq: 1, path: "src/tax.ts", symbol: null });

  const matchingCard = makeCard({
    card_id: "card-seq-match",
    blocks: [otherBlock, cartBlock],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [1, 2],
      error_names: "tax.ts",
    },
  });
  const matchingResult: CardsForFile = {
    cards: [matchingCard],
    matched: new Map([[matchingCard.card_id, [cartBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const matchSinks = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...matchSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => matchingResult,
    }),
    0,
  );
  const seqLine = matchSinks.outLines.find((line) => line.includes("Sequence:"));
  assert.equal(
    seqLine,
    "         Sequence: `npm test` failed (exit 1). The error names tax.ts. Edited src/tax.ts and 1 more. `npm test` passed.",
  );
  assert.deepEqual(validateOutputLine(seqLine!.trim()), []);
  assert.doesNotMatch(seqLine!, /\b(?:because|so that|in order to|to ensure|fixed|resolved)\b/i);

  // Card has a sequence for seq 1 (src/tax.ts), while this file only matched seq 2 (src/cart.ts).
  const nonMatchingCard = makeCard({
    card_id: "card-seq-other",
    blocks: [otherBlock, cartBlock],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [1],
    },
  });
  const nonMatchingResult: CardsForFile = {
    cards: [nonMatchingCard],
    matched: new Map([[nonMatchingCard.card_id, [cartBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const noMatchSinks = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...noMatchSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => nonMatchingResult,
    }),
    0,
  );
  assert.equal(noMatchSinks.outLines.some((line) => line.includes("Sequence:")), false);

  // Control/ANSI/question mark in command or error_names is neutralized by terminalSafe.
  const hostileCard = makeCard({
    card_id: "card-seq-hostile",
    blocks: [makeBlock({ seq: 1, path: "src/cart.ts", symbol: null })],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm\u001b[31m test? --ok",
      exit_code: 1,
      edit_seqs: [1],
      error_names: "cart.ts?\u202e",
    },
  });
  const hostileSinks = makeSinks();
  assert.equal(
    why(["src/cart.ts"], {
      ...hostileSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([hostileCard]),
    }),
    0,
  );
  const safeSeqLine = hostileSinks.outLines.find((line) => line.includes("Sequence:")) ?? "";
  assert.ok(safeSeqLine.length > 0);
  assert.equal(safeSeqLine.includes("?"), false);
  assert.equal(safeSeqLine.includes("\u001b"), false);
  assert.equal(safeSeqLine.includes("\u202e"), false);
});

test("why keeps Sequence fixed clauses and passing outcome under the 512-byte limit for multibyte and long fields", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();

  // 80-character command with 75 4-byte U+20000 characters (305 bytes per command occurrence).
  const multibyteCmd = `echo ${"\u{20000}".repeat(75)}`;
  const multibyteCard = makeCard({
    card_id: "card-seq-multibyte",
    blocks: [makeBlock({ seq: 1, path: "src/auth.ts", symbol: null })],
    sequence: {
      pattern: "fix_after_fail",
      command: multibyteCmd,
      exit_code: 1,
      edit_seqs: [1],
    },
  });
  const multibyteSinks = makeSinks();
  assert.equal(
    why(["src/auth.ts"], {
      ...multibyteSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([multibyteCard]),
    }),
    0,
  );
  const mbLine = multibyteSinks.outLines.find((line) => line.includes("Sequence:")) ?? "";
  assert.ok(mbLine.length > 0);
  assert.ok(Buffer.byteLength(mbLine, "utf8") <= 512, `byte length was ${Buffer.byteLength(mbLine, "utf8")}`);
  assert.ok(mbLine.endsWith("\u2026` passed."), mbLine);
  assert.ok(mbLine.includes("`echo "), mbLine);
  assert.ok(mbLine.includes("failed (exit 1). Edited src/auth.ts."), mbLine);
  assert.deepEqual(validateOutputLine(mbLine.trim()), []);

  // Long ASCII path and error_names with an 80-character ASCII command.
  const longAsciiCmd = "c".repeat(80);
  const longPath = `src/${"nested/".repeat(40)}auth.ts`;
  const longErr = `${"longerror_".repeat(30)}auth.ts`;
  const longFieldsCard = makeCard({
    card_id: "card-seq-long-fields",
    blocks: [makeBlock({ seq: 1, path: longPath, symbol: null })],
    sequence: {
      pattern: "fix_after_fail",
      command: longAsciiCmd,
      exit_code: 2,
      edit_seqs: [1],
      error_names: longErr,
    },
  });
  const longSinks = makeSinks();
  assert.equal(
    why([longPath], {
      ...longSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => makeResult([longFieldsCard]),
    }),
    0,
  );
  const longLine = longSinks.outLines.find((line) => line.includes("Sequence:")) ?? "";
  assert.ok(longLine.length > 0);
  assert.ok(Buffer.byteLength(longLine, "utf8") <= 512, `byte length was ${Buffer.byteLength(longLine, "utf8")}`);
  assert.ok(longLine.endsWith(`\`${longAsciiCmd}\` passed.`), longLine);
  assert.ok(longLine.includes(`\`${longAsciiCmd}\` failed (exit 2). The error names `), longLine);
  assert.ok(longLine.includes(" Edited "), longLine);
  assert.deepEqual(validateOutputLine(longLine.trim()), []);
});

test("why omits Sequence line when command or first edit head sanitizes to empty and drops empty error_names clause", () => {
  const now = new Date(2026, 10, 15, 16, 0, 0).getTime();

  // First edit block path is only U+202E, second edit at src/auth.ts, edit_seqs: [1, 2]: omit Sequence line.
  const firstBidiBlock = makeBlock({ seq: 1, path: "\u202e", symbol: null });
  const secondAuthBlock = makeBlock({ seq: 2, path: "src/auth.ts", symbol: null });
  const bidiEditCard = makeCard({
    card_id: "card-seq-bidi-edit",
    blocks: [firstBidiBlock, secondAuthBlock],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [1, 2],
    },
  });
  const bidiEditResult: CardsForFile = {
    cards: [bidiEditCard],
    matched: new Map([[bidiEditCard.card_id, [secondAuthBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const bidiEditSinks = makeSinks();
  assert.equal(
    why(["src/auth.ts"], {
      ...bidiEditSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => bidiEditResult,
    }),
    0,
  );
  assert.equal(bidiEditSinks.outLines.some((line) => line.includes("Sequence:")), false);

  // When command sanitizes to empty, omit the Sequence line.
  const bidiCmdCard = makeCard({
    card_id: "card-seq-bidi-cmd",
    blocks: [secondAuthBlock],
    sequence: {
      pattern: "fix_after_fail",
      command: "\u202e",
      exit_code: 2,
      edit_seqs: [2],
      error_names: "auth.ts",
    },
  });
  const bidiCmdResult: CardsForFile = {
    cards: [bidiCmdCard],
    matched: new Map([[bidiCmdCard.card_id, [secondAuthBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const bidiCmdSinks = makeSinks();
  assert.equal(
    why(["src/auth.ts"], {
      ...bidiCmdSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => bidiCmdResult,
    }),
    0,
  );
  assert.equal(bidiCmdSinks.outLines.some((line) => line.includes("Sequence:")), false);

  // When only error_names sanitizes to empty, keep the Sequence line and drop the "The error names ..." clause.
  const bidiErrCard = makeCard({
    card_id: "card-seq-bidi-err",
    blocks: [secondAuthBlock],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 2,
      edit_seqs: [2],
      error_names: "\u202e",
    },
  });
  const bidiErrResult: CardsForFile = {
    cards: [bidiErrCard],
    matched: new Map([[bidiErrCard.card_id, [secondAuthBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const bidiErrSinks = makeSinks();
  assert.equal(
    why(["src/auth.ts"], {
      ...bidiErrSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => bidiErrResult,
    }),
    0,
  );
  const errLine = bidiErrSinks.outLines.find((line) => line.includes("Sequence:"));
  assert.equal(
    errLine,
    "         Sequence: `npm test` failed (exit 2). Edited src/auth.ts. `npm test` passed.",
  );
  assert.deepEqual(validateOutputLine(errLine!.trim()), []);
  assert.doesNotMatch(errLine!, /\b(?:because|so that|in order to|to ensure|fixed|resolved)\b/i);

  // Data rule preserved: when no seq in edit_seqs resolves to a block on card.blocks, no Sequence line is emitted.
  const unresolvableCard = makeCard({
    card_id: "card-seq-unresolvable",
    blocks: [],
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [2],
    },
  });
  const unresolvableResult: CardsForFile = {
    cards: [unresolvableCard],
    matched: new Map([[unresolvableCard.card_id, [secondAuthBlock]]]),
    coverage: { complete: true, skipped: 0 },
  };
  const unresolvableSinks = makeSinks();
  assert.equal(
    why(["src/auth.ts"], {
      ...unresolvableSinks,
      load: () => [],
      coverage: () => completeCoverage(),
      now,
      cards: () => unresolvableResult,
    }),
    0,
  );
  assert.equal(unresolvableSinks.outLines.some((line) => line.includes("Sequence:")), false);
});
