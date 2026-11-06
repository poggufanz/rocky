import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateOutputLine } from "../ui/phrases.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), "utf8");

const LITERAL = /"((?:[^"\\\r\n]|\\.)*)"|'((?:[^'\\\r\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
// "answer answer-${kind}": class lists, not copy
const CLASS_LIST = /^[a-z0-9_-]+(?: [a-z0-9_${}-]+)+$/;

function copyFiles(): string[] {
  const sources = ["ai", "gui"].flatMap((dir) =>
    readdirSync(join(root, "src", dir)).filter((name) => name.endsWith(".ts")).map((name) => join("src", dir, name)));
  return [...sources, join("assets", "gui", "app.js"), join("assets", "gui", "chat.js"), join("assets", "gui", "index.html")];
}

/** Multiword strings a person can read: script literals, and HTML text, titles, labels and placeholders. */
function readableStrings(file: string, text: string): { line: number; value: string }[] {
  const found: { line: number; value: string }[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const candidates: string[] = [];
    if (file.endsWith(".html")) {
      for (const match of line.matchAll(/>([^<>]{6,})</g)) candidates.push(match[1]?.trim() ?? "");
      for (const match of line.matchAll(/(?:title|aria-label|placeholder)="([^"]+)"/g)) candidates.push(match[1] ?? "");
    } else {
      for (const match of line.matchAll(LITERAL)) candidates.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
    for (const value of candidates) {
      if (!/[A-Za-z]{3,}/.test(value) || !/\s/.test(value) || CLASS_LIST.test(value)) continue;
      found.push({ line: index + 1, value: value.replace(/\\n/g, "\n") });
    }
  });
  return found;
}

test("every readable string in the GUI and the AI layer follows the output rules", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const file of copyFiles()) {
    for (const { line, value } of readableStrings(file, read(file))) {
      checked += 1;
      const violations = validateOutputLine(value);
      if (violations.length > 0) offenders.push(`${file}:${line} [${violations.join(",")}] ${value.slice(0, 100)}`);
    }
  }
  assert.ok(checked > 400, "expected to check the GUI and AI strings");
  assert.deepEqual(offenders, []);
});

test("the page ships no mascot art or drawing code", () => {
  const html = read("assets", "gui", "index.html");
  const app = read("assets", "gui", "app.js");
  const chat = read("assets", "gui", "chat.js");
  const css = read("assets", "gui", "app.css");
  const everything = [html, app, chat, css].join("\n");
  assert.doesNotMatch(everything, /cx-face|rocky-load|rl-line|cx-doze|rocky-in\b/);
  assert.doesNotMatch(app, /\bconst FACE\b/);
  assert.doesNotMatch(everything, /rocky-pixel|<canvas/);
  assert.doesNotMatch(everything, /\bcx-ear\b|\blisten-ear\b|is-listening/);
});

test("the page uses no musical marker beside witnessed text", () => {
  assert.ok(!read("assets", "gui", "app.css").includes("♪"));
});

test("the why card tells a witness card from an assembled one by its shape, not by header words", () => {
  const app = read("assets", "gui", "app.js");
  assert.match(app, /const assembled = Array\.isArray\(data\.rungs\);/);
  assert.doesNotMatch(app, /header\.startsWith\(/);
});

test("the sidebar and the welcome block carry no persona copy", () => {
  const html = read("assets", "gui", "index.html");
  assert.match(html, /<h2 class="cx-hello">Ask what rocky recorded<\/h2>/);
  assert.match(html, /<button id="ask" class="ask" hidden>Why\?<\/button>/);
  assert.doesNotMatch(html, /Rocky|\bheard\b|, question/);
});
