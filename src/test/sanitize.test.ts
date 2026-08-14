import test from "node:test";
import assert from "node:assert/strict";
import { safeTerminalBlock, safeTerminalLine } from "../ui/sanitize.js";

const hostile = [
  "plain",
  "\u001b[2J\u001b[Hcsi",
  "\u001b]0;title\u0007osc0",
  "\u001b]8;;https://fixture.invalid\u001b\\link\u001b]8;;\u001b\\",
  "\u001b]52;c;Zml4dHVyZQ==\u0007osc52",
  "\u001bP1;2|dcs\u001b\\",
  "\u001b_apc\u001b\\",
  "bell\u0007back\bcr\r",
  "c1\u009b2J\u009dtitle\u009c",
  "bidi\u202eoverride\u202c\u2066isolate\u2069",
].join("|");

const activeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

test("safeTerminalLine removes terminal instructions and visibly escapes line controls", () => {
  const output = safeTerminalLine(`${hostile}\nnext\tcell\u2028separator`);
  assert.doesNotMatch(output, activeControl);
  assert.doesNotMatch(output, /\u001b/u);
  assert.match(output, /plain/);
  assert.match(output, /\\nnext\\tcell\\u2028separator/);
  assert.equal(output.includes("\n"), false);
  assert.equal(output.includes("\t"), false);
});

test("safeTerminalBlock preserves only LF structure and treats every line as untrusted", () => {
  const output = safeTerminalBlock(`${hostile}\rforged\n[Rocky] fixture\tline\nthird`);
  assert.doesNotMatch(output, activeControl);
  assert.doesNotMatch(output, /\u001b/u);
  assert.equal(output.split("\n").length, 3);
  assert.match(output, /\\rforged\n\[remembered Rocky\] fixture\\tline\nthird$/);
});

test("terminal sanitizing preserves ordinary Unicode, emoji, CJK, and combining marks", () => {
  const ordinary = "cafe\u0301 — 工程 — rocky 🪨 — family 👨‍👩‍👧‍👦";
  assert.equal(safeTerminalLine(ordinary), ordinary);
  assert.equal(safeTerminalBlock(ordinary), ordinary);
});
