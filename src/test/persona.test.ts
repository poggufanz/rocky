import test from "node:test";
import assert from "node:assert/strict";
import { phrase, phraseForAct, phraseKeys, validateRockyPhrase } from "../ui/phrases.js";
import { prompt } from "../ui/rocky.js";

test("phrase validator rejects visual language, emoji, and question marks", () => {
  assert.deepEqual(validateRockyPhrase("I see the answer now? 👀"), [
    "question-mark", "visual-language", "article", "emoji",
  ]);
});

test("phrase validator rejects first-person visual verbs with a modal", () => {
  assert.deepEqual(validateRockyPhrase("I can see memory now."), ["visual-language"]);
});

test("phrase validator rejects first-person visual verbs through common auxiliary chains", () => {
  for (const value of [
    "I may see memory.",
    "I might look at memory.",
    "I should watch logs.",
    "I must observe evidence.",
    "I will be seeing memory.",
    "I do not see memory.",
  ]) {
    assert.deepEqual(validateRockyPhrase(value), ["visual-language"], value);
  }
});

test("phrase validator leaves third-person and nonvisual phrases alone", () => {
  assert.deepEqual(validateRockyPhrase("model may see memory."), []);
  assert.deepEqual(validateRockyPhrase("I may remember memory."), []);
});

test("phrase validator requires question-marked lines to end with question suffix", () => {
  assert.deepEqual(validateRockyPhrase("memory asks question"), ["question-suffix"]);
  assert.deepEqual(validateRockyPhrase("memory asks, question"), []);
});

test("every catalog phrase follows Rocky voice rules", () => {
  for (const key of phraseKeys) assert.deepEqual(validateRockyPhrase(phrase(key)), [], key);
});

test("check prompts use stable voice IDs and keep the question suffix last", () => {
  assert.ok(phraseKeys.includes("check-answer"));
  assert.equal(phrase("check-answer"), "answer, question");
  assert.match(prompt(phrase("check-registry-consent")), /\[Rocky\].*\[y\/N\], question $/);
  assert.equal(prompt(phrase("check-answer")), "[Rocky] answer, question ");
});

test("every v0.5.2 Fix 1 possible-fix string follows Rocky voice rules", () => {
  const strings = [
    "no confirmed fix. but after error, you run this:",
    "maybe fix, maybe not. check, question",
    "different program. maybe fix, maybe not. check, question",
    "but this comes from other place.",
    "no fix in memory yet. you fix, I remember. this is good trade.",
    "different program, 2 hours later. maybe not fix. check, question",
    "different program, under 1 minute later. maybe not fix. check, question",
    "same program, under 1 minute later. maybe not fix. check, question",
    "same command, under 1 minute later. strong.",
  ];
  for (const value of strings) assert.deepEqual(validateRockyPhrase(value), [], value);
});

test("link and recurrence lines state what Rocky heard and never claim a fix", () => {
  assert.equal(
    phrase("fix-linked"),
    "command works now. same command fail before. I link them. I not hear what change. good good good.",
  );
  assert.equal(
    phrase("fix-recurrence-same"),
    "last time, same command work again after. I not hear what change.",
  );
  for (const key of ["fix-linked", "fix-recurrence-same"] as const) {
    assert.ok(phraseKeys.includes(key), `${key} must be registered so the catalog lint covers it`);
    assert.doesNotMatch(phrase(key), /\bfix(?:ed|es)?\b/i, `${key} must not claim a remedy`);
    assert.doesNotMatch(phrase(key), /something between|I remember/i, `${key} must not read like confusion`);
  }
});

test("every AI act uses its dedicated catalog phrase", () => {
  assert.equal(phraseForAct("known_fix"), phrase("ai-known-fix"));
  assert.equal(phraseForAct("unresolved"), phrase("ai-unresolved"));
  assert.equal(phraseForAct("ambiguous"), phrase("ai-ambiguous"));
});
