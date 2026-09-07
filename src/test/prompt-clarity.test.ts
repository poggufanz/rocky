import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clarityNudgeLine,
  countNumberedSteps,
  countVaguePronouns,
  countWords,
  hasCodeRef,
  hasImperativeStart,
  hdd,
  mtld,
  renderClarityCard,
  scorePrompt,
  tokenizePrompt,
  typeTokenRatio,
  CLARITY_MTLD_CAP,
} from "../core/prompt-clarity.js";
import { check, parsePromptRequest } from "../commands/check.js";

const VARIED = [
  "amber", "bridge", "cinder", "drift", "ember", "flint", "grove", "harbor",
  "ivory", "jungle", "karma", "lantern", "meadow", "north", "orchard", "prairie",
  "quartz", "ridge", "sable", "tundra", "umber", "valley", "willow", "xenon",
  "yonder", "zephyr", "acorn", "birch", "cedar", "dune", "eagle", "fern",
  "glacier", "heath", "iris", "juniper", "kelp", "larch", "moss", "nectar",
  "onyx", "prism", "quill", "raven", "stone", "thistle", "upland", "vortex",
  "wren", "yarrow",
].join(" ");
const REPEATED = Array.from({ length: 20 }, () => "fix the bug").join(" ");
const VAGUE = "it is broken, this thing does that stuff with those things and it fails";
const CLEAR = [
  "Fix login retry in src/auth/login.ts",
  "1. Reproduce the timeout with npm test",
  "2. Add backoff to the retry helper",
  "3. Verify with npm test and check logs",
].join("\n");

function withRockyHome(t: import("node:test").TestContext, home: string): void {
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

function withEnv(t: import("node:test").TestContext, name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("tokenizer lowercases and keeps apostrophes", () => {
  assert.deepEqual(tokenizePrompt("Fix Don't STOP"), ["fix", "don't", "stop"]);
  assert.deepEqual(tokenizePrompt(""), []);
  assert.deepEqual(tokenizePrompt("a b c"), ["a", "b", "c"]);
});

test("type-token ratio is 1 for varied text, near 0 for repeated text", () => {
  assert.equal(typeTokenRatio(tokenizePrompt(VARIED)), 1);
  assert.ok(typeTokenRatio(tokenizePrompt(REPEATED)) < 0.1);
  assert.equal(typeTokenRatio([]), 0);
});

test("HD-D is monotonic: varied text outranks repeated text", () => {
  const varied = hdd(tokenizePrompt(VARIED));
  const repeated = hdd(tokenizePrompt(REPEATED));
  assert.ok(varied > repeated, `varied HD-D ${varied} must exceed repeated ${repeated}`);
  assert.equal(hdd([]), 0);
});

test("MTLD is monotonic: varied text outranks repeated text, capped at 200", () => {
  const varied = mtld(tokenizePrompt(VARIED));
  const repeated = mtld(tokenizePrompt(REPEATED));
  assert.ok(varied > repeated, `varied MTLD ${varied} must exceed repeated ${repeated}`);
  assert.equal(mtld([]), 0);
  const longUnique = Array.from({ length: 300 }, (_, i) => `word${i}`);
  assert.equal(mtld(longUnique), CLARITY_MTLD_CAP);
});

test("imperative-verb start skips a leading step marker", () => {
  assert.equal(hasImperativeStart("Fix the login retry"), true);
  assert.equal(hasImperativeStart("1. Fix the login retry"), true);
  assert.equal(hasImperativeStart("it is broken"), false);
  assert.equal(hasImperativeStart("Testing the waters here"), false);
  assert.equal(hasImperativeStart(""), false);
});

test("vague-pronoun count, step count, code refs, word count", () => {
  assert.equal(countVaguePronouns(tokenizePrompt(VAGUE)), 8);
  assert.equal(countVaguePronouns(tokenizePrompt("fix login retry")), 0);
  assert.equal(countNumberedSteps(CLEAR), 3);
  assert.equal(countNumberedSteps("no steps here"), 0);
  assert.equal(hasCodeRef(CLEAR), true);
  assert.equal(hasCodeRef("```\nconst a = 1;\n```"), true);
  assert.equal(hasCodeRef("it broke and/or that failed"), false);
  assert.equal(countWords("  one two  three "), 3);
  assert.equal(countWords("   "), 0);
});

test("vague text scores below 40 with the pronoun suggestion", () => {
  const result = scorePrompt(VAGUE);
  assert.ok(result.score < 40, `vague score ${result.score} must be < 40`);
  assert.equal(result.band, "vague");
  assert.ok(
    result.suggestions.some((s) => s.includes("name the file and behavior")),
    `suggestions: ${JSON.stringify(result.suggestions)}`,
  );
  assert.ok(result.suggestions.length <= 3);
});

test("clear imperative stepped text scores at least 70", () => {
  const result = scorePrompt(CLEAR);
  assert.ok(result.score >= 70, `clear score ${result.score} must be >= 70`);
  assert.equal(result.band, "clear");
  assert.equal(result.metrics.hasVerb, true);
  assert.equal(result.metrics.steps, 3);
  assert.equal(result.metrics.hasCodeRef, true);
});

test("empty input fails open with a neutral score", () => {
  for (const empty of ["", "   ", "\n\t "]) {
    const result = scorePrompt(empty);
    assert.equal(result.score, 50);
    assert.equal(result.band, "needs-detail");
  }
});

test("long stepless text suggests steps; repeated failure suggests new info", () => {
  const long = `Update ${Array.from({ length: 30 }, (_, i) => `token${i}`).join(" ")}`;
  assert.ok(countWords(long) > 25);
  const stepless = scorePrompt(long);
  assert.ok(stepless.suggestions.some((s) => s.includes("numbered steps")));

  const withoutFlag = scorePrompt(REPEATED);
  const withFlag = scorePrompt(REPEATED, { repeatedFailure: true });
  assert.ok(!withoutFlag.suggestions.some((s) => s.includes("not a paraphrase")));
  assert.ok(withFlag.suggestions.some((s) => s.includes("not a paraphrase")));

  const everything = `${VAGUE} ${long} extra padding words to stay long`;
  const capped = scorePrompt(everything, { repeatedFailure: true });
  assert.ok(capped.suggestions.length <= 3);
});

test("rendered card and nudge lines never contain a question mark", () => {
  for (const text of [VAGUE, CLEAR, "", longText()]) {
    for (const line of renderClarityCard(scorePrompt(text))) assert.doesNotMatch(line, /\?/);
    const nudge = clarityNudgeLine(text);
    if (nudge !== undefined) {
      assert.doesNotMatch(nudge, /\?/);
      assert.match(nudge, /, question$/);
    }
  }
  assert.equal(clarityNudgeLine(CLEAR), undefined, "clear prompts stay silent");
  assert.equal(clarityNudgeLine(""), undefined, "empty input stays silent");
  assert.equal(clarityNudgeLine(undefined), undefined, "non-string input stays silent");
});

function longText(): string {
  return `please kindly look at it when this happens with that stuff ${"extra ".repeat(30)}`;
}

test("parsePromptRequest splits prompt flags from the rest", () => {
  assert.deepEqual(parsePromptRequest(["--prompt", "hello", "--quiet"]), {
    prompt: "hello",
    stdin: false,
    rest: ["--quiet"],
  });
  assert.deepEqual(parsePromptRequest(["--prompt=hi", "--stdin"]), {
    prompt: "hi",
    stdin: true,
    rest: [],
  });
  assert.throws(() => parsePromptRequest(["--prompt"]), /needs text/);
  assert.throws(() => parsePromptRequest(["--prompt", "--quiet"]), /needs text/);
  assert.throws(() => parsePromptRequest(["--prompt", "a", "--prompt", "b"]), /unexpected option/);
  assert.throws(() => parsePromptRequest(["--stdin", "--stdin"]), /unexpected option/);
});

test("check --prompt is advisory: exit 0 for vague and clear alike", async () => {
  assert.equal(await check(["--prompt", VAGUE, "--quiet"]), 0);
  assert.equal(await check(["--prompt", CLEAR, "--quiet"]), 0);
  assert.equal(await check(["--prompt", "", "--quiet"]), 0);
  assert.equal(await check(["--prompt", VAGUE, "--offline"]), 2, "conflicting modes refuse");
});

function gatePayload(session: string, file: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: session,
    tool_name: "Edit",
    tool_input: { file_path: file },
    cwd: "/work/repo",
    ...extra,
  });
}

test("gate advisory appends to the deny reason but never decides", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-clarity-gate-"))));
  const { gateEvent } = await import("../agent/gate.js");

  const denied = gateEvent("claude-code", gatePayload("s1", "/work/repo/src/q.ts", { rationale: VAGUE }));
  assert.equal(denied.exitCode, 0);
  const reason = (JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason as string);
  assert.match(reason, /prompt vague/);

  withEnv(t, "ROCKY_CLARITY_ADVISORY", "off");
  const silent = gateEvent("claude-code", gatePayload("s2", "/work/repo/src/q.ts", { rationale: VAGUE }));
  assert.equal(JSON.parse(silent.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(
    JSON.parse(silent.stdout).hookSpecificOutput.permissionDecisionReason as string,
    /prompt vague/,
  );
});

test("gate advisory never denies: opt-out and corrupt rationale allow", async (t) => {
  withRockyHome(t, realpathSync(mkdtempSync(join(tmpdir(), "rocky-clarity-gate2-"))));
  withEnv(t, "ROCKY_RATIONALE_GATE", "off");
  const { gateEvent } = await import("../agent/gate.js");
  assert.equal(gateEvent("claude-code", gatePayload("s1", "/a.ts", { rationale: VAGUE })).stdout, "{}");

  withEnv(t, "ROCKY_RATIONALE_GATE", undefined);
  const corrupt = gateEvent("claude-code", gatePayload("s9", "/b.ts", { rationale: 42 }));
  assert.equal(corrupt.exitCode, 0);
  assert.equal(JSON.parse(corrupt.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(
    JSON.parse(corrupt.stdout).hookSpecificOutput.permissionDecisionReason as string,
    /prompt /,
  );
});
