import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  collapseDotSegments,
  isAbsOrTildeBlockPath,
  isRepoRelativeBlockPath,
  normalizeRepoBlockPath,
} from "../core/block-paths.js";
import {
  expandTilde,
  isPathInside,
  normalizeAbsForPlatform,
  parseCardLine,
  validateCard,
} from "../desk/cards-record.js";
import { resolveRockyPaths } from "../core/state-paths.js";
import { useTempRockyHome } from "./temp-rocky-home.js";

const rockyHome = useTempRockyHome("rocky-cards-record-");

test("tests run under a temp rocky home", () => {
  assert.equal(resolveRockyPaths().home, rockyHome.dir());
});

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    card_id: "c1",
    rev: 1,
    repo_id: "repo-1",
    root: "/work/app",
    main_root: null,
    branch: "main",
    session_id: "s1",
    agent_id: "a1",
    agent_type: "",
    parent_card_id: null,
    started_ms: 1000,
    ended_ms: 2000,
    status: "done",
    prompt: "p",
    prompt_truncated: false,
    importance: "medium",
    blocks: [],
    more_count: 0,
    flow: [],
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "complete", reasons: [] },
    ...overrides,
  };
}

test("parseCardLine returns a card for a valid line", () => {
  const parsed = parseCardLine(Buffer.from(JSON.stringify(card())));
  assert.equal(parsed.kind, "card");
  if (parsed.kind === "card") assert.equal(parsed.card.card_id, "c1");
});

test("parseCardLine tolerates a trailing carriage return", () => {
  assert.equal(parseCardLine(Buffer.from(`${JSON.stringify(card())}\r`)).kind, "card");
});

test("parseCardLine treats blank lines as blank", () => {
  assert.equal(parseCardLine(Buffer.from("  \r")).kind, "blank");
  assert.equal(parseCardLine(Buffer.alloc(0)).kind, "blank");
});

test("parseCardLine marks bad json, bad utf8, and invalid cards as invalid", () => {
  assert.equal(parseCardLine(Buffer.from("{nope")).kind, "invalid");
  assert.equal(parseCardLine(Buffer.from([0xff, 0xfe, 0x7b])).kind, "invalid");
  assert.equal(parseCardLine(Buffer.from(JSON.stringify({ card_id: "x" }))).kind, "invalid");
});

test("validateCard rejects non-objects and wrong versions", () => {
  assert.equal(validateCard(card()), true);
  assert.equal(validateCard(null), false);
  assert.equal(validateCard([]), false);
  assert.equal(validateCard(card({ v: 2 })), false);
});

test("parseCardLine accepts flow steps with optional exit_code and error", () => {
  const stepWithFailure = { kind: "cmd", text: "npm test", ok: false, dur_ms: 120, seqs: [], exit_code: 1, error: "Error: x" };
  const stepWithNegativeExit = { kind: "cmd", text: "pwsh", ok: false, dur_ms: 50, seqs: [], exit_code: -1, error: null };
  const stepWithoutFailure = { kind: "cmd", text: "npm run build", ok: true, dur_ms: 80, seqs: [1] };
  const stepWithNulls = { kind: "cmd", text: "pwsh", ok: false, dur_ms: 30, seqs: [], exit_code: null, error: null };

  const parsed = parseCardLine(
    Buffer.from(JSON.stringify(card({ flow: [stepWithFailure, stepWithNegativeExit, stepWithoutFailure, stepWithNulls] }))),
  );
  assert.equal(parsed.kind, "card");
  if (parsed.kind === "card") {
    assert.equal(parsed.card.flow?.[0]?.exit_code, 1);
    assert.equal(parsed.card.flow?.[0]?.error, "Error: x");
    assert.equal(parsed.card.flow?.[1]?.exit_code, -1);
    assert.equal(parsed.card.flow?.[1]?.error, null);
    assert.equal(parsed.card.flow?.[2]?.exit_code, undefined);
    assert.equal(parsed.card.flow?.[2]?.error, undefined);
    assert.equal(parsed.card.flow?.[3]?.exit_code, null);
    assert.equal(parsed.card.flow?.[3]?.error, null);
  }
});

test("parseCardLine rejects flow steps with wrong exit_code or error types", () => {
  const baseStep = { kind: "cmd", text: "npm test", ok: false, dur_ms: 120, seqs: [] };
  assert.equal(
    parseCardLine(Buffer.from(JSON.stringify(card({ flow: [{ ...baseStep, exit_code: "1" }] })))).kind,
    "invalid",
  );
  assert.equal(
    parseCardLine(Buffer.from(JSON.stringify(card({ flow: [{ ...baseStep, exit_code: 1.5 }] })))).kind,
    "invalid",
  );
  assert.equal(
    parseCardLine(Buffer.from(JSON.stringify(card({ flow: [{ ...baseStep, error: 5 }] })))).kind,
    "invalid",
  );
});

test("parseCardLine keeps valid flow step timing, cwd, tool_use_id, and desc fields", () => {
  const fullStep = {
    kind: "cmd",
    text: "npm test",
    ok: true,
    dur_ms: 250,
    seqs: [1],
    start_ms: 1700000000000,
    end_ms: 1700000000250,
    cwd: "/work/app/pkg",
    tool_use_id: "toolu_01",
    desc: "Run package tests",
  };
  const zeroAndEmptyDesc = {
    kind: "cmd",
    text: "true",
    ok: true,
    dur_ms: 0,
    seqs: [],
    start_ms: 0,
    end_ms: 0,
    desc: "",
  };
  const legacyStep = { kind: "cmd", text: "npm run build", ok: true, dur_ms: 80, seqs: [2] };

  const parsed = parseCardLine(
    Buffer.from(JSON.stringify(card({ flow: [fullStep, zeroAndEmptyDesc, legacyStep] }))),
  );
  assert.equal(parsed.kind, "card");
  if (parsed.kind === "card") {
    assert.deepEqual(parsed.card.flow?.[0], fullStep);
    assert.deepEqual(parsed.card.flow?.[1], zeroAndEmptyDesc);
    assert.deepEqual(parsed.card.flow?.[2], legacyStep);
    assert.equal("start_ms" in (parsed.card.flow?.[2] ?? {}), false);
    assert.equal("end_ms" in (parsed.card.flow?.[2] ?? {}), false);
    assert.equal("cwd" in (parsed.card.flow?.[2] ?? {}), false);
    assert.equal("tool_use_id" in (parsed.card.flow?.[2] ?? {}), false);
    assert.equal("desc" in (parsed.card.flow?.[2] ?? {}), false);
  }
});

test("parseCardLine drops only invalid optional flow step fields without rejecting the card", () => {
  const badStart = {
    kind: "cmd",
    text: "npm test",
    ok: true,
    dur_ms: 100,
    seqs: [],
    start_ms: -1,
    end_ms: 200,
    cwd: "/work/app/sub",
    tool_use_id: "toolu_02",
    desc: "Run tests",
  };
  const badCwd = {
    kind: "cmd",
    text: "npm test",
    ok: true,
    dur_ms: 100,
    seqs: [],
    start_ms: 100,
    end_ms: 1.5,
    cwd: 5,
    tool_use_id: "",
    desc: 42,
  };
  const emptyCwdAndNulls = {
    kind: "cmd",
    text: "npm test",
    ok: true,
    dur_ms: 100,
    seqs: [],
    start_ms: null,
    end_ms: null,
    cwd: "",
    tool_use_id: null,
    desc: null,
  };

  const parsed = parseCardLine(
    Buffer.from(JSON.stringify(card({ flow: [badStart, badCwd, emptyCwdAndNulls] }))),
  );
  assert.equal(parsed.kind, "card");
  if (parsed.kind === "card") {
    const first = parsed.card.flow?.[0];
    assert.ok(first);
    assert.equal("start_ms" in first, false);
    assert.equal(first.end_ms, 200);
    assert.equal(first.cwd, "/work/app/sub");
    assert.equal(first.tool_use_id, "toolu_02");
    assert.equal(first.desc, "Run tests");

    const second = parsed.card.flow?.[1];
    assert.ok(second);
    assert.equal(second.start_ms, 100);
    assert.equal("end_ms" in second, false);
    assert.equal("cwd" in second, false);
    assert.equal("tool_use_id" in second, false);
    assert.equal("desc" in second, false);

    const third = parsed.card.flow?.[2];
    assert.ok(third);
    assert.equal("start_ms" in third, false);
    assert.equal("end_ms" in third, false);
    assert.equal("cwd" in third, false);
    assert.equal("tool_use_id" in third, false);
    assert.equal("desc" in third, false);
  }
});

test("collapseDotSegments handles drives, unc, dots, and escapes", () => {
  assert.deepEqual(collapseDotSegments("C:\\a\\.\\b\\..\\c"), { prefix: "C:/", segments: ["a", "c"], hadEscape: false });
  assert.deepEqual(collapseDotSegments("../x"), { prefix: "", segments: ["x"], hadEscape: true });
  assert.equal(collapseDotSegments("//host/share/a").prefix, "//host/share/");
});

test("normalizeRepoBlockPath rejects absolute and escaping paths", () => {
  assert.equal(normalizeRepoBlockPath("src\\A.ts", "linux"), "src/A.ts");
  assert.equal(normalizeRepoBlockPath("src\\A.ts", "win32"), "src/a.ts");
  assert.equal(normalizeRepoBlockPath("/abs/x", "linux"), undefined);
  assert.equal(normalizeRepoBlockPath("../x", "linux"), undefined);
  assert.equal(normalizeRepoBlockPath(".", "linux"), undefined);
});

test("normalizeAbsForPlatform folds case on win32 only", () => {
  assert.equal(normalizeAbsForPlatform("C:\\Work\\App", "win32"), "c:/work/app");
  assert.equal(normalizeAbsForPlatform("/Work/App", "linux"), "/Work/App");
});

test("expandTilde uses the injected home", () => {
  assert.equal(expandTilde("~/a/b", "/h/"), "/h/a/b");
  assert.equal(expandTilde("~", "/h"), "/h");
  assert.equal(expandTilde("/x", "/h"), "/x");
});

test("isAbsOrTildeBlockPath classifies spellings", () => {
  for (const yes of ["~", "~/a", "~\\a", "C:\\a", "c:/a", "/a", "\\a"]) assert.equal(isAbsOrTildeBlockPath(yes), true, yes);
  for (const no of ["a/b", "./a", "../a"]) assert.equal(isAbsOrTildeBlockPath(no), false, no);
});

test("isRepoRelativeBlockPath accepts only non-empty non-drive non-escaping relative paths", () => {
  for (const yes of ["src/a.ts", "a.ts", "src/a..b.ts", "dir/~file.ts"]) {
    assert.equal(isRepoRelativeBlockPath(yes), true, yes);
  }
  for (const no of [
    "",
    "~",
    "~/x.ts",
    "~\\x.ts",
    "/abs/x.ts",
    "\\abs\\x.ts",
    "//host/share/x.ts",
    "D:private.ts",
    "d:private.ts",
    "D:/outside/x.ts",
    "D:\\outside\\x.ts",
    "../x.ts",
    "..\\x.ts",
    "src/../../x.ts",
    "src/..",
  ]) {
    assert.equal(isRepoRelativeBlockPath(no), false, no);
  }
});

test("isPathInside matches whole segments only", () => {
  const o = { platform: "linux" as const, home: "/h" };
  assert.equal(isPathInside("/work/app/src/a.ts", "/work/app", o), true);
  assert.equal(isPathInside("/work/app", "/work/app", o), true);
  assert.equal(isPathInside("/work/app2/a.ts", "/work/app", o), false);
  assert.equal(isPathInside("/work/app/../app2/a.ts", "/work/app", o), false);
});

test("isPathInside folds case and slashes on win32 only", () => {
  assert.equal(isPathInside("C:\\Work\\App\\Src\\a.ts", "c:/work/app", { platform: "win32", home: "C:/h" }), true);
  assert.equal(isPathInside("/Work/App/a.ts", "/work/app", { platform: "linux", home: "/h" }), false);
});

test("isPathInside expands ~/ against the injected home", () => {
  const o = { platform: "linux" as const, home: "/home/u" };
  assert.equal(isPathInside("~/proj/a.ts", "/home/u/proj", o), true);
  assert.equal(isPathInside("/home/u/proj/a.ts", "~/proj", o), true);
  assert.equal(isPathInside("~/other/a.ts", "/home/u/proj", o), false);
});

test("isPathInside never matches relative paths", () => {
  const o = { platform: "linux" as const, home: "/h" };
  assert.equal(isPathInside("src/a.ts", "/work/app", o), false);
  assert.equal(isPathInside("/work/app/a.ts", "work/app", o), false);
  assert.equal(isPathInside("../a.ts", "/work", o), false);
});

test("isPathInside keeps trailing whitespace and format characters", () => {
  const o = { platform: "linux" as const, home: "/h" };
  assert.equal(isPathInside("/work/app ", "/work/app", o), false);
  assert.equal(isPathInside("/work/app/a.ts", "/work/app ", o), false);
  assert.equal(isPathInside("/work/app\u200b/a.ts", "/work/app", o), false);
  assert.equal(isPathInside("/work/app\u0007/a.ts", "/work/app", o), false);
});

test("isPathInside on linux collapses separators before dot segments", () => {
  const o = { platform: "linux" as const, home: "/h" };
  assert.equal(isPathInside("//work/app/../other/a.ts", "/work/app", o), false);
  assert.equal(isPathInside("//work//app//src/a.ts", "/work/app", o), true);
});

test("isPathInside fails closed when dot segments climb above the root", () => {
  const o = { platform: "linux" as const, home: "/h" };
  assert.equal(isPathInside("/../work/app/a.ts", "/work/app", o), false);
  assert.equal(isPathInside("/work/app/a.ts", "/../work/app", o), false);
});

test("isPathInside understands win32 unc paths", () => {
  const o = { platform: "win32" as const, home: "C:/h" };
  assert.equal(isPathInside("\\\\server\\share\\repo\\a.ts", "\\\\server\\share\\repo", o), true);
  assert.equal(isPathInside("\\\\server\\share\\repo2\\a.ts", "\\\\server\\share\\repo", o), false);
  assert.equal(isPathInside("\\\\server\\share\\..\\x", "\\\\server\\share", o), false);
});

test("parseCardLine accepts a valid fix_after_fail sequence", () => {
  const withErr = card({
    sequence: {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [1, 2],
      error_names: "auth.ts",
    },
  });
  const parsedWithErr = parseCardLine(Buffer.from(JSON.stringify(withErr)));
  assert.equal(parsedWithErr.kind, "card");
  if (parsedWithErr.kind === "card") {
    assert.deepEqual(parsedWithErr.card.sequence, {
      pattern: "fix_after_fail",
      command: "npm test",
      exit_code: 1,
      edit_seqs: [1, 2],
      error_names: "auth.ts",
    });
  }

  const withoutErr = card({
    sequence: {
      pattern: "fix_after_fail",
      command: "pwsh -Command test",
      exit_code: -1,
      edit_seqs: [3],
    },
  });
  const parsedWithoutErr = parseCardLine(Buffer.from(JSON.stringify(withoutErr)));
  assert.equal(parsedWithoutErr.kind, "card");
  if (parsedWithoutErr.kind === "card") {
    assert.deepEqual(parsedWithoutErr.card.sequence, {
      pattern: "fix_after_fail",
      command: "pwsh -Command test",
      exit_code: -1,
      edit_seqs: [3],
    });
  }
});

test("validateCard drops an unknown sequence pattern without rejecting the card", () => {
  const unknownObj = card({
    sequence: {
      pattern: "future_pattern",
      count: 3,
    },
  });
  assert.equal(validateCard(unknownObj), true);
  assert.equal(unknownObj.sequence, undefined);

  const parsed = parseCardLine(
    Buffer.from(JSON.stringify(card({ sequence: { pattern: "retry_loop", steps: [1, 2] } }))),
  );
  assert.equal(parsed.kind, "card");
  if (parsed.kind === "card") {
    assert.equal(parsed.card.sequence, undefined);
  }
});

test("validateCard rejects wrong-typed sequence fields", () => {
  const validSeq = {
    pattern: "fix_after_fail",
    command: "npm test",
    exit_code: 1,
    edit_seqs: [1],
  };
  assert.equal(validateCard(card({ sequence: { ...validSeq, exit_code: "1" } })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, exit_code: 1.5 } })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, command: 42 } })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, edit_seqs: ["1"] } })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, edit_seqs: [-1] } })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, error_names: 123 } })), false);
  assert.equal(validateCard(card({ sequence: "not-an-object" })), false);
  assert.equal(validateCard(card({ sequence: { ...validSeq, pattern: 99 } })), false);
});
