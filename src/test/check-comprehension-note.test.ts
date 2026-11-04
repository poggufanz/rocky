import assert from "node:assert/strict";
import test from "node:test";
import { comprehensionNote } from "../commands/check.js";

const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const LOCATION = { cwd: "/work/repo", cmd: "1111111 2222222", file: "src/token.ts", line: 12 } as const;

test("comprehension note redacts secrets from the stored subject and answer", () => {
  const note = comprehensionNote({
    ...LOCATION,
    subject: `const t = "${GITHUB_TOKEN}"`,
    answer: `uses ${GITHUB_TOKEN}`,
  });

  assert.doesNotMatch(note.subject, /ghp_abcdef/u);
  assert.doesNotMatch(note.answer, /ghp_abcdef/u);
  assert.match(note.subject, /\[redacted/u);
  assert.match(note.answer, /\[redacted/u);
});

test("comprehension note scrubs a token fragment left by the subject cap", () => {
  // The caller caps the risky line at 200 characters, so a token can end
  // mid-way. 34 characters is below the 36 a complete github token needs.
  const cutToken = GITHUB_TOKEN.slice(0, 34);
  const note = comprehensionNote({
    ...LOCATION,
    subject: `${"x".repeat(160)} ${cutToken}`,
    answer: "no secret here",
  });

  assert.doesNotMatch(note.subject, /ghp_abcdef/u);
});

test("comprehension note keeps plain text and the location fields untouched", () => {
  const input = { ...LOCATION, subject: "const answer = 42;", answer: "keeps the answer constant" };

  assert.deepEqual(comprehensionNote(input), input);
});
