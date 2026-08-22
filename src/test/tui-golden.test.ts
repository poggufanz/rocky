import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as B from "../ui/tui/cards/build.js";
import { COMMANDS } from "../ui/tui/surface/registry.js";
import type { Card } from "../ui/tui/cards/card.js";
import {
  initialCompareState,
  initialShell,
  updateShell,
  type ShellState,
} from "../ui/tui/surface/shell.js";
import { surfaceRoot } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";
import { getCachedDiff, clearDiffCache, type CompareRec } from "../ui/tui/surface/compare-data.js";
import { deriveHome, type HomeData } from "../ui/tui/surface/home-data.js";
import type { MemoryRecord } from "../core/memory-read.js";

// Goldens must be byte-stable across runs and machines: ambient memory and the
// ambient clock are banned. `initialShell` reads ROCKY_HOME at state-build
// time, so point it at an empty scratch dir before any test touches a shell.
const hermeticHome = mkdtempSync(join(tmpdir(), "rocky-golden-home-"));
process.env.ROCKY_HOME = hermeticHome;
process.on("exit", () => {
  try {
    rmSync(hermeticHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// scripts/test.mjs compiles this file into .test-dist (wiped after the run),
// so fixtures are resolved against the package source tree like every other
// test fixture here — committed goldens gate future renders.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(packageRoot, "src", "test", "fixtures", "tui-golden");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function golden(name: string, lines: string[]): void {
  const file = join(DIR, `${name}.txt`);
  const body = lines.map(strip).join("\n") + "\n";
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, body, "utf8");
    return;
  }
  const stored = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.equal(body, stored, `golden drift: ${name} (UPDATE_GOLDEN=1 to accept)`);
}

// Fixed anchor shared with tui-home.test.ts. Every fixture ts derives from it;
// render paths receive it explicitly through surfaceRoot's `now`.
const NOW = 1_756_000_000_000;
const SIZES: Array<[number, number]> = [
  [80, 24],
  [100, 30],
  [120, 40],
];

// A github token shape redactSecretsAtBoundary masks; its raw form must never
// reach a rendered frame even though it sits inside fixture evidence.
const SECRET = "ghp_111122223333444455556666777788889999";

const rec = (kind: string, ts: number, extra: object = {}): MemoryRecord =>
  ({ v: 1, kind, ts, cwd: "/repo", ...extra }) as any;

const FIXTURE_RECORDS: MemoryRecord[] = [
  rec("failure", NOW - 120_000, { cmd: `git push https://${SECRET}@github.com/repo.git` }),
  rec("fix", NOW - 3_600_000, { cmd: "npm ci" }),
  rec("triple", NOW - 7_200_000, {
    agent: "claude-code",
    origin: "agent-hook",
    intent: { text: `pin parser stems before memoizing because ${SECRET} leaked into CI logs` },
    mechanism: {
      head: "b47c0ffee1234567890",
      files: [{ path: "src/parser.ts", plusMinus: [12, 3], props: [], excerpt: "cache.warm(stems)" }],
      truncatedFiles: 0,
      coverageStatus: "complete",
    },
  }),
  rec("triple", NOW - 26 * 3_600_000, {
    agent: "claude-code",
    intent: { text: "split parser stems before memoizing" },
    mechanism: {
      head: "a1b2c3d4e5f6789012",
      files: [{ path: "src/parser.ts", plusMinus: [4, 1], props: [] }],
      truncatedFiles: 0,
      coverageStatus: "complete",
    },
  }),
  rec("triple", NOW - 5 * 60_000, {
    agent: "claude-code",
    intent: { text: "<task-notification><task-id>task-9</task-id><summary>review finished clean</summary></task-notification>" },
    mechanism: {
      files: [{ path: "src/config.ts", plusMinus: [1, 0], props: [] }],
      truncatedFiles: 0,
      coverageStatus: "complete",
    },
  }),
  rec("rationale", NOW - 45 * 60_000, {
    subject: "memory append",
    rationale: { text: "append-only memory keeps evidence honest" },
  }),
  rec("note", NOW - 30 * 3_600_000, { cmd: "rocky dash", subject: "setup" }),
];

const homeOf = (records: MemoryRecord[], coverageReason?: string): HomeData =>
  deriveHome(records, coverageReason, NOW);

const deps = { exists: () => false, home: () => hermeticHome };
const type = (s: ShellState, text: string): ShellState =>
  [...text].reduce((st, ch) => updateShell(st, { type: "key", key: { name: "char", ch } }, deps), s);

// Task 3's builder fixture set: one card of each builder, verbatim values.
const hits = [
  { label: "npm test", agoText: "2d ago", source: "hook", machine: false },
  { label: 'Agent "review" finished', agoText: "5h ago", source: "claude-code", machine: true },
];

const STREAM_CARDS: Card[] = [
  B.buildRecall("token expiry", hits),
  B.buildRecall("nothing here", []),
  B.buildWhy("memory.ts", [{ text: "append-only, reader bounded", source: "claude-code", agoText: "5d ago" }]),
  B.buildWhy("ghost.ts", []),
  B.buildSessions([{ index: 1, cwdTail: "proj/rocky", count: 12, endedAgo: "2h ago" }]),
  B.buildStats([{ kind: "triple", count: 422 }, { kind: "failure", count: 46 }], 468, "4d ago"),
  B.buildBrief({ heard: 176, failures: 10, fixes: 6, whys: 163 }, hits),
  B.buildRun("npm test", { displayCode: 0, out: ["ok"], err: [] }),
  B.buildRun("npm test", { displayCode: -4058, out: [], err: ["ENOENT"] }),
  B.buildHelp(COMMANDS),
  B.buildYou("recall token"),
  B.buildError("frobnicate", COMMANDS),
];

const LONG_TOKEN = "x".repeat(160);
const LONG_PROSE =
  "parser stems cache misses warm entries after every rewrite so rocky wraps this long sentence across many stream lines without dropping any words at all";

// Fixed patch served by the stubbed diff io for every compare golden.
const STUB_PATCH = [
  "diff --git a/src/parser.ts b/src/parser.ts",
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -12,7 +12,9 @@ export function parse(input)",
  "   const stems = new Set()",
  "-  const stale = true",
  "+  const stale = false",
  "+  cache.warm(stems)",
  "   return walk(input)",
].join("\n");

const stubDiffIo = {
  exists: (p: string) => {
    const n = p.replace(/\\/g, "/");
    if (n.endsWith("/.git")) return n === "/repo/.git";
    return n.startsWith("/repo");
  },
  lsFiles: () => [] as string[],
  resolve: () => ({ commit: "b47c0ffe", diff: STUB_PATCH }),
  lastShaBefore: () => "",
};

function seedDiffs(comp: ReturnType<typeof initialCompareState>): void {
  clearDiffCache();
  for (const entry of comp.files) {
    for (const r of entry.recs) getCachedDiff(entry.path, r, stubDiffIo);
  }
}

function parserEntry(comp: ReturnType<typeof initialCompareState>) {
  return comp.files.find((f) => f.path === "/repo/src/parser.ts")!;
}

function compareTwoMoments(): ShellState {
  const comp = initialCompareState(FIXTURE_RECORDS);
  const entry = parserEntry(comp);
  const recA: CompareRec = entry.recs[0];
  const recB: CompareRec = entry.recs[1];
  return {
    ...initialShell("/proj/demo"),
    view: "compare",
    compare: {
      ...comp,
      file: entry,
      mode: "two",
      focus: "recB",
      A: recA.ts,
      B: recB.ts,
      recA,
      recB,
    },
  };
}

/** Driven through updateShell: enter -> scope -> two moments -> lock A. */
function comparePickerPhase2(): ShellState {
  const comp = initialCompareState(FIXTURE_RECORDS);
  let s: ShellState = {
    ...initialShell("/proj/demo"),
    view: "compare",
    compare: comp,
  };
  const press = (name: string, ch?: string) =>
    (s = updateShell(s, { type: "key", key: (ch !== undefined ? { name: "char", ch } : { name }) as any }, deps));
  press("enter"); // open scope modal on files[0] (parser.ts)
  press("down"); // msel = 1: two moments
  press("enter"); // timeline picker, phase 1
  press("enter"); // lock A -> phase 2 with live preview
  assert.equal(s.compare?.modal, "timeline");
  assert.equal(s.compare?.picker.markA, true);
  return s;
}

const browseRow = (id: string, badge: "fail" | "fix" | "why" | "guard", label: string, ts: number, kind: string, json: object) => ({
  id,
  badge,
  label,
  ts,
  kind,
  json: JSON.stringify(json),
});

function frame(
  name: string,
  state: ShellState,
  cols: number,
  rows: number,
  data: HomeData,
): void {
  const node = surfaceRoot(state, { cols, rows }, 0, false, data, false, NOW);
  const lines = renderToLines(node, cols, rows, 24);
  assert.equal(lines.length, rows, `${name} ${cols}x${rows}: line count`);
  const stripped = lines.map(strip);
  for (let i = 0; i < stripped.length; i++) {
    assert.equal(stringWidth(stripped[i]), cols, `${name} ${cols}x${rows}: line ${i + 1} width`);
  }
  const body = stripped.join("\n");
  assert.ok(!body.includes(SECRET), `${name} ${cols}x${rows}: raw secret reached the frame`);
  assert.ok(!/[\u{1F000}-\u{1FAFF}\u{2705}\u{274C}\u{26A1}\u{2B50}]/u.test(body), `${name} ${cols}x${rows}: emoji in frame`);
  golden(`${name}-${cols}x${rows}`, lines);
}

test("golden: home-empty at three sizes", () => {
  const data = homeOf([]);
  const state = initialShell("/proj/demo");
  for (const [cols, rows] of SIZES) frame("home-empty", state, cols, rows, data);
});

test("golden: home-populated at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS);
  const state = initialShell("/proj/demo");
  for (const [cols, rows] of SIZES) frame("home-populated", state, cols, rows, data);
});

test("golden: stream-cards at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS);
  const state: ShellState = { ...initialShell("/proj/demo"), view: "stream", cards: STREAM_CARDS };
  for (const [cols, rows] of SIZES) frame("stream-cards", state, cols, rows, data);
});

test("golden: stream-wrapped-long-value at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS);
  const cards: Card[] = [
    B.buildRun("npm run wrap-demo", { displayCode: 0, out: [LONG_TOKEN], err: [] }),
    B.buildWhy("cache.ts", [{ text: LONG_PROSE, source: "hook", agoText: "3h ago" }]),
  ];
  const state: ShellState = { ...initialShell("/proj/demo"), view: "stream", cards };
  for (const [cols, rows] of SIZES) frame("stream-wrapped-long-value", state, cols, rows, data);
});

test("golden: slash-menu-open at three sizes", () => {
  const data = homeOf([]);
  const state = type(initialShell("/proj/demo"), "/");
  for (const [cols, rows] of SIZES) frame("slash-menu-open", state, cols, rows, data);
});

test("golden: browse-overlay at three sizes", () => {
  const data = homeOf([]);
  const state: ShellState = {
    ...initialShell("/proj/demo"),
    overlay: "browse",
    brows: [
      browseRow("r1", "why", "pin parser stems before memoizing", NOW - 7_200_000, "triple", {
        kind: "triple",
        ts: NOW - 7_200_000,
        file: "/repo/src/parser.ts",
        intent: { text: `because ${SECRET} leaked` },
      }),
      browseRow("r2", "fail", "npm test exits 1 on missing build", NOW - 120_000, "failure", {
        kind: "failure",
        ts: NOW - 120_000,
        cmd: "npm test",
      }),
      browseRow("r3", "fix", "npm ci restores the lockfile tree", NOW - 3_600_000, "fix", {
        kind: "fix",
        ts: NOW - 3_600_000,
        cmd: "npm ci",
      }),
      browseRow("r4", "guard", "rocky blocked rm -rf on repo root", NOW - 900_000, "invariant_touch", {
        kind: "invariant_touch",
        ts: NOW - 900_000,
        invariant: "no destructive rm",
      }),
    ],
    bsel: 0,
    bquery: "",
  };
  for (const [cols, rows] of SIZES) frame("browse-overlay", state, cols, rows, data);
});

test("golden: compare-two-moments at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS);
  const state = compareTwoMoments();
  seedDiffs(state.compare!);
  try {
    for (const [cols, rows] of SIZES) frame("compare-two-moments", state, cols, rows, data);
  } finally {
    clearDiffCache();
  }
});

test("golden: compare-picker-phase2 at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS);
  const state = comparePickerPhase2();
  seedDiffs(state.compare!);
  try {
    for (const [cols, rows] of SIZES) frame("compare-picker-phase2", state, cols, rows, data);
  } finally {
    clearDiffCache();
  }
});

test("golden: home-partial-coverage at three sizes", () => {
  const data = homeOf(FIXTURE_RECORDS, "file-size-cap");
  const state = initialShell("/proj/demo");
  for (const [cols, rows] of SIZES) frame("home-partial-coverage", state, cols, rows, data);
});
