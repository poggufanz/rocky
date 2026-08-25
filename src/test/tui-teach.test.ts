import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initialShell,
  initialTeachState,
  updateShell,
  type ShellDeps,
  type ShellState,
} from "../ui/tui/surface/shell.js";
import { surfaceRoot } from "../ui/tui/surface/views.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";
import { deriveHome, type HomeData } from "../ui/tui/surface/home-data.js";
import type { Key } from "../ui/tui/state.js";
import type { MemoryRecord } from "../core/memory-read.js";

// Goldens must be byte-stable across runs and machines: ambient memory and the
// ambient clock are banned. `initialShell` reads ROCKY_HOME at state-build
// time, so point it at an empty scratch dir before any test touches a shell.
const hermeticHome = mkdtempSync(join(tmpdir(), "rocky-teach-golden-home-"));
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

// Fixed anchor shared with tui-golden.test.ts. Every fixture ts derives from
// it; render paths receive it explicitly through surfaceRoot's `now`.
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

// On-disk content the read stub serves for the two teach files. Neither file
// carries the SECRET; the canary lives only inside the explain record, where
// the card path must redact it at the render boundary.
const WITNESS_TEXT = [
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
].join("\n");

const LADDER_TEXT = [
  "export async function loadFeed() {",
  "  const rows = await fetchRows();",
  "  return rows;",
  "}",
].join("\n");

// The exact selection the witness scenario teaches: lines 5..11, content-hash
// matched the same way `explainContentHash` normalizes before hashing.
const WITNESS_SNIPPET = WITNESS_TEXT.split(/\r?\n/).slice(4, 11).join("\n");
const WITNESS_HASH = createHash("sha256")
  .update(WITNESS_SNIPPET.replace(/\s+/gu, " ").trim(), "utf8")
  .digest("hex")
  .slice(0, 32);

const TEACH_FIXTURE_RECORDS: MemoryRecord[] = [
  rec("explain", NOW - 7_200_000, {
    path: "src/witness.ts",
    source: "agent:claude-code",
    code: "documents only, no duplicates",
    business: `journal accepts DOCENTRY documents only, token ${SECRET} stays local`,
    snippet: WITNESS_SNIPPET,
    contentHash: WITNESS_HASH,
  }),
  rec("explain", NOW - 86_400_000, {
    path: "src/ladder.ts",
    source: "agent:codex",
    code: "moves rows through the feed",
    business: "feed batches rows in one pass",
  }),
];

const homeOf = (records: MemoryRecord[], coverageReason?: string): HomeData =>
  deriveHome(records, coverageReason, NOW);

const teachRead = (p: string): string | undefined => {
  const n = p.replace(/\\/g, "/");
  if (n === "/repo/src/witness.ts") return WITNESS_TEXT;
  if (n === "/repo/src/ladder.ts") return LADDER_TEXT;
  return undefined;
};

const deps: ShellDeps = {
  exists: (p: string) => p.replace(/\\/g, "/").startsWith("/repo"),
  home: () => hermeticHome,
  read: teachRead,
  git: () => undefined,
};

function teachShell(): ShellState {
  return {
    ...initialShell("/proj/demo"),
    view: "teach",
    teach: initialTeachState(TEACH_FIXTURE_RECORDS),
  };
}

function press(state: ShellState, key: Key): ShellState {
  return updateShell(state, { type: "key", key }, deps);
}

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

test("golden: teach-file-list at three sizes", () => {
  const data = homeOf(TEACH_FIXTURE_RECORDS);
  const state = teachShell();
  for (const [cols, rows] of SIZES) frame("teach-file-list", state, cols, rows, data);
});

test("golden: teach-selection at three sizes", () => {
  const data = homeOf(TEACH_FIXTURE_RECORDS);
  let state = teachShell();
  state = press(state, { name: "enter" }); // pick witness.ts (files[0])
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" }); // cursor line 4
  state = press(state, { name: "char", ch: "s" }); // extend from anchor 4
  state = press(state, { name: "down" });
  state = press(state, { name: "down" }); // selection 4..6
  for (const [cols, rows] of SIZES) frame("teach-selection", state, cols, rows, data);
});

test("golden: teach-card-witness at three sizes", () => {
  const data = homeOf(TEACH_FIXTURE_RECORDS);
  let state = teachShell();
  state = press(state, { name: "enter" }); // pick witness.ts (files[0])
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" }); // cursor line 5
  state = press(state, { name: "char", ch: "s" }); // extend from anchor 5
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" });
  state = press(state, { name: "down" }); // cursor line 11, selection 5..11
  state = press(state, { name: "enter" }); // lookup -> witness card
  for (const [cols, rows] of SIZES) frame("teach-card-witness", state, cols, rows, data);
});

test("golden: teach-card-ladder at three sizes", () => {
  const data = homeOf(TEACH_FIXTURE_RECORDS);
  let state = teachShell();
  state = press(state, { name: "down" }); // ladder.ts (files[1])
  state = press(state, { name: "enter" }); // pick ladder.ts
  state = press(state, { name: "down" }); // cursor line 2
  state = press(state, { name: "enter" }); // lookup -> ladder card
  state = press(state, { name: "char", ch: "e" }); // expanded ladder
  for (const [cols, rows] of SIZES) frame("teach-card-ladder", state, cols, rows, data);
});