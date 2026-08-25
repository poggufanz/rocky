// src/test/teach-command.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teach, type TeachDeps } from "../commands/teach.js";
import { recordExplain } from "../core/memory.js";
import { resolveRockyPaths } from "../core/state-paths.js";

const EMPTY_STATE = "not heard why yet. agent explains when it writes. ask agent, rocky remembers, question";
const WITNESS_HEADER = "rocky heard this. agent say why, rocky remember";
const LADDER_HEADER = "rocky not hear this. assembled from evidence, not witnessed";

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
  assert.ok(blockLines.some((line) => line.startsWith("form: async because await used at line 5")));
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