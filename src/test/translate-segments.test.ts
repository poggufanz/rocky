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
