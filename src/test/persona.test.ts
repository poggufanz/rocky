import test from "node:test";
import assert from "node:assert/strict";
import { phrase, phraseForAct, phraseKeys, validateRockyPhrase } from "../ui/phrases.js";

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

test("every AI act uses its dedicated catalog phrase", () => {
  assert.equal(phraseForAct("known_fix"), phrase("ai-known-fix"));
  assert.equal(phraseForAct("unresolved"), phrase("ai-unresolved"));
  assert.equal(phraseForAct("ambiguous"), phrase("ai-ambiguous"));
});
