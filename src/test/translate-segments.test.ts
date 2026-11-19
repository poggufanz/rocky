import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareQuote, restoreLine } from "../translate/segments.js";

test("code spans become numbered placeholders", () => {
  const [line] = prepareQuote("Saya ubah `src/mul.js` lalu npm test --watch di C:\\repo\\a.ts dan https://x.dev/a, commit 3f2a9c1, exit 1.").lines;
  assert.equal(line!.html, 'Saya ubah <x id="0"></x> lalu npm test <x id="1"></x> di <x id="2"></x> dan <x id="3"></x>, commit <x id="4"></x>, <x id="5"></x>.');
  assert.deepEqual(line!.codes.map((c) => c.text), ["src/mul.js", "--watch", "C:\\repo\\a.ts", "https://x.dev/a", "3f2a9c1", "exit 1"]);
  assert.deepEqual(line!.codes.at(-1), { text: "exit 1", spaceBefore: true, spaceAfter: false });
});
test("plain words are not code", () => {
  // re-run, kata-kata, defaced (all hex letters, no digit), 3 jam
  assert.deepEqual(prepareQuote("re-run kata-kata defaced 3 jam").lines[0]!.codes, []);
});
test("markdown is stripped and prose escaped", () => {
  const q = prepareQuote("## Ringkas\n- **Merah:** a < b & `x<y`\nLihat [docs](https://x.dev/a). hasil 2*3 dan *miring* a * b");
  assert.equal(q.lines[0]!.html, "Ringkas");
  assert.equal(q.lines[1]!.html, 'Merah: a &lt; b &amp; <x id="0"></x>');
  assert.deepEqual(q.lines[1]!.codes.map((c) => c.text), ["x<y"]);
  assert.equal(q.lines[2]!.html, "Lihat docs. hasil 2*3 dan miring a * b");
});
test("fenced lines are kept as plain and never sent", () => {
  const q = prepareQuote("Lihat:\n```js\nconst a = 1;\n```\nSelesai.");
  assert.deepEqual(q.lines.map((l) => l && [l.send, l.plain]), [[true, "Lihat:"], [false, "const a = 1;"], [true, "Selesai."]]);
});
test("blank runs become one paragraph break, edges trimmed", () => {
  assert.deepEqual(prepareQuote("\n\na\n\n\nb\n\n").lines.map((l) => l && l.plain), ["a", null, "b"]);
});
test("prose never holds code", () => {
  const { prose } = prepareQuote("yang `the and to` dan src/the.ts");
  assert.match(prose, /yang/); assert.match(prose, /dan/); assert.doesNotMatch(prose, /the/);
});
test("restore puts codes back and tidies spacing", () => {
  const line = prepareQuote("Saya ubah `src/mul.js`, lalu (`npm test`).").lines[0]!;
  assert.equal(restoreLine('I changed  <x id="0"></x>, then ( <x id="1"></x>).', line), "I changed src/mul.js, then (npm test).");
  const two = prepareQuote("ubah `a.ts` supaya `b.ts` lulus").lines[0]!;
  assert.equal(restoreLine('changed  <x id="0"></x>in order to  <x id="1"></x>pass.', two), "changed a.ts in order to b.ts pass.");
  const quoted = prepareQuote('file "src/a.ts" gagal').lines[0]!;
  assert.equal(restoreLine('file " <x id="0"></x> " failed', quoted), 'file "src/a.ts" failed');
  const edge = prepareQuote("src/a.ts gagal").lines[0]!;
  assert.equal(restoreLine(' <x id="0"></x>Failed', edge), "src/a.ts Failed");
});
test("restore unescapes prose only", () => {
  const line = prepareQuote("a < b `&amp;`").lines[0]!;
  assert.equal(restoreLine('a &lt; b <x id="0"></x>', line), "a < b &amp;");
});
test("literal placeholder text in prose stays text", () => {
  const line = prepareQuote('tulis <x id="0"> di sini').lines[0]!;
  assert.equal(line.html, 'tulis &lt;x id="0"&gt; di sini');
  assert.equal(restoreLine(line.html, line), 'tulis <x id="0"> di sini');
});
test("placeholder drift fails closed", () => {
  const line = prepareQuote("ubah `a.ts` dan `b.ts`").lines[0]!;
  assert.equal(restoreLine('change <x id="0"></x> and', line), undefined);                        // missing
  assert.equal(restoreLine('<x id="0"></x> <x id="0"></x> <x id="1"></x>', line), undefined);     // repeated
  assert.equal(restoreLine('<x id="0"></x> <x id="1"></x> <x id="7"></x>', line), undefined);     // invented
  assert.equal(restoreLine('<x id="0"></x> <b>and</b> <x id="1"></x>', line), undefined);         // stray tag
});

test("restore keeps spacing for parenthesized bare path", () => {
  const line = prepareQuote("lihat (src/a.ts) sekarang").lines[0]!;
  assert.deepEqual(line.codes, [{ text: "src/a.ts", spaceBefore: false, spaceAfter: false }]);
  assert.equal(restoreLine('see ( <x id="0"></x> ) now', line), "see (src/a.ts) now");
});

test("restore keeps spacing for backtick span before period", () => {
  const line = prepareQuote("ubah `a.ts`.").lines[0]!;
  assert.deepEqual(line.codes, [{ text: "a.ts", spaceBefore: true, spaceAfter: false }]);
  assert.equal(restoreLine('changed  <x id="0"></x> .', line), "changed a.ts.");
});

test("literal full placeholder tag in prose and html-like code round-trip", () => {
  const literal = prepareQuote('tulis <x id="0"></x> di sini').lines[0]!;
  assert.deepEqual(literal.codes, []);
  assert.equal(literal.html, 'tulis &lt;x id="0"&gt;&lt;/x&gt; di sini');
  assert.equal(restoreLine(literal.html, literal), 'tulis <x id="0"></x> di sini');
  const htmlCode = prepareQuote("cek `x<y` dulu").lines[0]!;
  assert.equal(restoreLine('check <x id="0"></x> first', htmlCode), "check x<y first");
});

test("unterminated markdown link does not stall preparation", () => {
  const input = `lihat [docs](${"a".repeat(500)}`;
  const [line] = prepareQuote(input).lines;
  assert.equal(line!.html, input);
  assert.deepEqual(line!.codes, []);
});

test("links unlink after word characters and across inline code labels", () => {
  const glued = prepareQuote("Lihat[docs](https://x.dev/a).").lines[0]!;
  assert.equal(glued.html, "Lihatdocs.");
  assert.deepEqual(glued.codes, []);

  const codeOnlyLabel = prepareQuote("Lihat [`src/a.ts`](https://x.dev/a) dulu").lines[0]!;
  assert.equal(codeOnlyLabel.html, 'Lihat <x id="0"></x> dulu');
  assert.deepEqual(codeOnlyLabel.codes.map((c) => c.text), ["src/a.ts"]);

  const mixedLabel = prepareQuote("Lihat [file `src/a.ts` ini](https://x.dev/a).").lines[0]!;
  assert.equal(mixedLabel.html, 'Lihat file <x id="0"></x> ini.');
  assert.deepEqual(mixedLabel.codes.map((c) => c.text), ["src/a.ts"]);
});

test("urls in paired emphasis exclude wrapper markers", () => {
  const bold = prepareQuote("lihat **https://x.dev/a** dulu").lines[0]!;
  assert.equal(bold.html, 'lihat <x id="0"></x> dulu');
  assert.deepEqual(bold.codes.map((c) => c.text), ["https://x.dev/a"]);

  const italicAndStrike = prepareQuote("lihat *https://x.dev/a* dan ~~https://x.dev/b~~ dulu").lines[0]!;
  assert.equal(italicAndStrike.html, 'lihat <x id="0"></x> dan <x id="1"></x> dulu');
  assert.deepEqual(italicAndStrike.codes.map((c) => c.text), ["https://x.dev/a", "https://x.dev/b"]);
});

test("unicode paths and hyphen-prefixed filenames stay protected", () => {
  const unicodePath = prepareQuote("查看 源/文件");
  assert.equal(unicodePath.lines[0]!.html, '查看 <x id="0"></x>');
  assert.deepEqual(unicodePath.lines[0]!.codes.map((c) => c.text), ["源/文件"]);
  assert.equal(unicodePath.prose, "查看");

  const hyphenFile = prepareQuote("ubah -config.json dulu");
  assert.equal(hyphenFile.lines[0]!.html, 'ubah <x id="0"></x> dulu');
  assert.deepEqual(hyphenFile.lines[0]!.codes.map((c) => c.text), ["-config.json"]);
  assert.equal(hyphenFile.prose, "ubah dulu");
});

test("fenced blank lines stay unsent without collapsing or trimming", () => {
  const q = prepareQuote("Lihat:\n```js\n\nconst a = 1;\n\n\nconst b = 2;\n\n```\nSelesai.");
  assert.equal(q.lines.includes(null), false);
  assert.deepEqual(
    q.lines.map((l) => l && [l.send, l.plain]),
    [
      [true, "Lihat:"],
      [false, ""],
      [false, "const a = 1;"],
      [false, ""],
      [false, ""],
      [false, "const b = 2;"],
      [false, ""],
      [true, "Selesai."],
    ],
  );
  assert.deepEqual(q.lines[1], { send: false, html: "", codes: [], plain: "" });
});

test("restore rejects raw tags with non-ascii letters", () => {
  const line = prepareQuote("ubah `a.ts` dulu").lines[0]!;
  assert.equal(restoreLine('change <x id="0"></x> <é> first', line), undefined);
  assert.equal(restoreLine('change <x id="0"></x> &lt;é&gt; first', line), "change a.ts <é> first");
});

test("restore trims unicode horizontal spaces at placeholder boundaries", () => {
  const line = prepareQuote("lihat (src/a.ts) sekarang").lines[0]!;
  assert.equal(restoreLine('see (\u00a0<x id="0"></x>\u00a0) now', line), "see (src/a.ts) now");
  assert.equal(restoreLine('see (\u202f<x id="0"></x>\u2009) now', line), "see (src/a.ts) now");
});

test("block markers loop and markup-only lines drop without paragraph breaks", () => {
  const nested = prepareQuote("> ## Title\n## > x\n> - item");
  assert.deepEqual(nested.lines.map((l) => l && l.plain), ["Title", "x", "item"]);

  const markupOnly = prepareQuote("a\n- \nb\n>\nc\n##\nd\n- *\ne");
  assert.deepEqual(markupOnly.lines.map((l) => l && l.plain), ["a", "b", "c", "d", "e"]);

  const blankLine = prepareQuote("a\n\nb");
  assert.deepEqual(blankLine.lines.map((l) => l && l.plain), ["a", null, "b"]);
});

test("restore spaces a code span moved off a source line edge", () => {
  const leading = prepareQuote("src/a.ts gagal").lines[0]!;
  assert.equal(leading.codes[0].spaceBefore, false);
  assert.equal(leading.codes[0].spaceAfter, true);
  assert.equal(restoreLine('Failed <x id="0"></x>', leading), "Failed src/a.ts");
  assert.equal(restoreLine(' <x id="0"></x>Failed', leading), "src/a.ts Failed");

  const trailing = prepareQuote("gagal src/a.ts").lines[0]!;
  assert.equal(trailing.codes[0].spaceBefore, true);
  assert.equal(trailing.codes[0].spaceAfter, false);
  assert.equal(restoreLine('<x id="0"></x> failed', trailing), "src/a.ts failed");
  assert.equal(restoreLine('Check <x id="0"></x>.', trailing), "Check src/a.ts.");

  const sole = prepareQuote("src/a.ts").lines[0]!;
  assert.equal(restoreLine('Check (<x id="0"></x>).', sole), "Check (src/a.ts).");
});
