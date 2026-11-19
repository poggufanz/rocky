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

test("wrapped url excludes closing emphasis marker before attached prose", () => {
  const q = prepareQuote("lihat **https://x.dev/a**—situs resmi");
  const line = q.lines[0]!;
  assert.equal(line.html, 'lihat <x id="0"></x>—situs resmi');
  assert.deepEqual(line.codes, [{ text: "https://x.dev/a", spaceBefore: true, spaceAfter: false }]);
  assert.equal(q.prose, "lihat —situs resmi");
  assert.equal(restoreLine('see <x id="0"></x>—official site', line), "see https://x.dev/a—official site");
});

test("bare globs do not truncate an unwrapped url ending in stars", () => {
  const q = prepareQuote("lihat src/**/*.ts dan https://x.dev/objects/** sekarang");
  const line = q.lines[0]!;
  assert.equal(line.html, 'lihat <x id="0"></x> dan <x id="1"></x> sekarang');
  assert.deepEqual(line.codes.map((c) => c.text), ["src/**/*.ts", "https://x.dev/objects/**"]);
  assert.equal(q.prose, "lihat dan sekarang");
});

test("filename stays protected before an attached sentence", () => {
  const attached = prepareQuote("Buka config.json.Berikutnya ulangi.");
  const line = attached.lines[0]!;
  assert.equal(line.html, 'Buka <x id="0"></x>.Berikutnya ulangi.');
  assert.deepEqual(line.codes, [{ text: "config.json", spaceBefore: true, spaceAfter: false }]);
  assert.match(attached.prose, /Berikutnya/);
  assert.doesNotMatch(attached.prose, /config\.json/);

  const multiDot = prepareQuote("cek foo.test.ts dulu").lines[0]!;
  assert.deepEqual(multiDot.codes.map((c) => c.text), ["foo.test.ts"]);

  const trailingPeriod = prepareQuote("ubah a.ts.").lines[0]!;
  assert.equal(trailingPeriod.html, 'ubah <x id="0"></x>.');
  assert.deepEqual(trailingPeriod.codes.map((c) => c.text), ["a.ts"]);

  const nonCode = prepareQuote("Selesai.Lanjut 1.5").lines[0]!;
  assert.deepEqual(nonCode.codes, []);
});

test("emphasis tracking across prose and code tokens", () => {
  const cases: Array<{
    input: string;
    codes: string[];
    forbiddenInHtml?: string[];
    proseIncludes?: string[];
    restored: string;
  }> = [
    {
      input: "lihat **https://x.dev/a** dulu",
      codes: ["https://x.dev/a"],
      forbiddenInHtml: ["**"],
      restored: "lihat https://x.dev/a dulu",
    },
    {
      input: "lihat **https://x.dev/a**—situs resmi",
      codes: ["https://x.dev/a"],
      forbiddenInHtml: ["**"],
      proseIncludes: ["—situs resmi"],
      restored: "lihat https://x.dev/a—situs resmi",
    },
    {
      input: "Tolong **buka https://x.dev/a** lalu lanjut.",
      codes: ["https://x.dev/a"],
      forbiddenInHtml: ["**"],
      restored: "Tolong buka https://x.dev/a lalu lanjut.",
    },
    {
      input: "Tolong **buka src/a.ts** lalu lanjut.",
      codes: ["src/a.ts"],
      forbiddenInHtml: ["**"],
      restored: "Tolong buka src/a.ts lalu lanjut.",
    },
    {
      input: "lihat src/**/*.ts dan https://x.dev/objects/** sekarang",
      codes: ["src/**/*.ts", "https://x.dev/objects/**"],
      restored: "lihat src/**/*.ts dan https://x.dev/objects/** sekarang",
    },
    {
      input: "Buka https://x.dev/?q=*foo* sekarang.",
      codes: ["https://x.dev/?q=*foo*"],
      restored: "Buka https://x.dev/?q=*foo* sekarang.",
    },
    {
      input: "Buka config.json.Berikutnya ulangi.",
      codes: ["config.json"],
      proseIncludes: ["Berikutnya"],
      restored: "Buka config.json.Berikutnya ulangi.",
    },
    {
      input: "ubah *src/a.ts* dan ~~b.ts~~",
      codes: ["src/a.ts", "b.ts"],
      forbiddenInHtml: ["*", "~~"],
      restored: "ubah src/a.ts dan b.ts",
    },
    {
      input: "Tolong **buka (**src/a.ts**) lalu lanjut.",
      codes: ["src/a.ts"],
      forbiddenInHtml: ["**"],
      restored: "Tolong buka (src/a.ts) lalu lanjut.",
    },
    {
      input: "lihat **https://x.dev/a*** dulu",
      codes: ["https://x.dev/a"],
      forbiddenInHtml: ["*"],
      restored: "lihat https://x.dev/a dulu",
    },
    {
      input: "lihat ~~https://x.dev/a~~~~ dulu",
      codes: ["https://x.dev/a"],
      forbiddenInHtml: ["~"],
      restored: "lihat https://x.dev/a dulu",
    },
    {
      input: "Buka --via-https://x.dev/a sekarang.",
      codes: ["--via-https://x.dev/a"],
      restored: "Buka --via-https://x.dev/a sekarang.",
    },
    {
      input: "Buka config.ahttps://x.dev/a sekarang.",
      codes: ["config.ahttps://x.dev/a"],
      restored: "Buka config.ahttps://x.dev/a sekarang.",
    },
    {
      input: "Buka --url=https://x.dev/a(b)c sekarang.",
      codes: ["--url=https://x.dev/a(b)c"],
      restored: "Buka --url=https://x.dev/a(b)c sekarang.",
    },
    {
      input: "Buka --url=https://[::1]/health sekarang.",
      codes: ["--url=https://[::1]/health"],
      restored: "Buka --url=https://[::1]/health sekarang.",
    },
    {
      input: "lihat **https://x.dev/**src/**/*.ts",
      codes: ["https://x.dev/", "src/**/*.ts"],
      restored: "lihat https://x.dev/src/**/*.ts",
    },
  ];

  for (const row of cases) {
    const q = prepareQuote(row.input);
    assert.equal(q.lines.length, 1, row.input);
    const line = q.lines[0]!;
    assert.deepEqual(
      line.codes.map((c) => c.text),
      row.codes,
      row.input,
    );
    for (const marker of row.forbiddenInHtml ?? []) {
      assert.equal(line.html.includes(marker), false, `${row.input}: unexpected ${marker} in html`);
    }
    for (const expectedProse of row.proseIncludes ?? []) {
      assert.equal(q.prose.includes(expectedProse), true, `${row.input}: expected ${expectedProse} in prose`);
    }
    for (const code of row.codes) {
      assert.equal(q.prose.includes(code), false, `${row.input}: code leaked into prose: ${code}`);
    }
    const restored = restoreLine(line.html, line);
    assert.equal(restored, row.restored, row.input);
    for (const code of row.codes) {
      assert.equal(restored!.includes(code), true, `${row.input}: restored missing ${code}`);
    }
  }
});

test("marker runs and url precedence stay whole across edge boundaries", () => {
  const leadingFlag = prepareQuote("Tolong **buka (**--watch**) lalu lanjut.").lines[0]!;
  assert.deepEqual(leadingFlag.codes.map((c) => c.text), ["--watch"]);
  assert.equal(leadingFlag.html, 'Tolong buka (<x id="0"></x>) lalu lanjut.');

  const leadingQuoted = prepareQuote('Tolong **buka "**src/a.ts**" lalu lanjut.').lines[0]!;
  assert.deepEqual(leadingQuoted.codes.map((c) => c.text), ["src/a.ts"]);
  assert.equal(leadingQuoted.html, 'Tolong buka "<x id="0"></x>" lalu lanjut.');

  const closedBeforeGlob = prepareQuote("**lihat**src/**/*.ts").lines[0]!;
  assert.deepEqual(closedBeforeGlob.codes.map((c) => c.text), ["src/**/*.ts"]);
  assert.equal(closedBeforeGlob.html, 'lihat<x id="0"></x>');

  const splitAfterUrl = prepareQuote("lihat **https://x.dev/a**src/b.ts").lines[0]!;
  assert.deepEqual(splitAfterUrl.codes.map((c) => c.text), ["https://x.dev/a", "src/b.ts"]);
  assert.equal(splitAfterUrl.html, 'lihat <x id="0"></x><x id="1"></x>');

  const trailingRunBeforePunct = prepareQuote("lihat **https://x.dev/a***!").lines[0]!;
  assert.deepEqual(trailingRunBeforePunct.codes.map((c) => c.text), ["https://x.dev/a"]);
  assert.equal(trailingRunBeforePunct.html, 'lihat <x id="0"></x>!');

  const fourStarsAndStrike = prepareQuote("lihat **https://x.dev/a**** dan ~~https://x.dev/b~~~~ dan ~~c.ts~~").lines[0]!;
  assert.deepEqual(fourStarsAndStrike.codes.map((c) => c.text), ["https://x.dev/a", "https://x.dev/b", "c.ts"]);
  assert.equal(fourStarsAndStrike.html, 'lihat <x id="0"></x> dan <x id="1"></x> dan <x id="2"></x>');

  const closedParenProse = prepareQuote("Tolong **buka (penting)**—lanjut.").lines[0]!;
  assert.deepEqual(closedParenProse.codes, []);
  assert.equal(closedParenProse.html, "Tolong buka (penting)—lanjut.");

  const wrappedPrefixedUrl = prepareQuote("lihat **--url=https://x.dev/a(b)c** dulu").lines[0]!;
  assert.deepEqual(wrappedPrefixedUrl.codes.map((c) => c.text), ["--url=https://x.dev/a(b)c"]);
  assert.equal(wrappedPrefixedUrl.html, 'lihat <x id="0"></x> dulu');

  const closedAfterTrimmedPunct = prepareQuote("lihat **https://x.dev/a.**src/**/*.ts").lines[0]!;
  assert.deepEqual(closedAfterTrimmedPunct.codes.map((c) => c.text), ["https://x.dev/a", "src/**/*.ts"]);
  assert.equal(closedAfterTrimmedPunct.html, 'lihat <x id="0"></x>.<x id="1"></x>');
});

test("restore adds space when engine drops punctuation against alnum, unless source touched alnum", () => {
  const colonDropped = prepareQuote("`npm test`: gagal").lines[0]!;
  assert.equal(restoreLine('<x id="0"></x>Failed', colonDropped), "npm test Failed");

  const commaDropped = prepareQuote("`tmp/ready`, tanpa").lines[0]!;
  assert.equal(restoreLine('<x id="0"></x>without', commaDropped), "tmp/ready without");

  const punctKept = prepareQuote("`a.ts`: ok").lines[0]!;
  assert.equal(restoreLine('<x id="0"></x>: ok', punctKept), "a.ts: ok");

  const leftColonDropped = prepareQuote("lihat: `a.ts`").lines[0]!;
  assert.equal(restoreLine('see<x id="0"></x>', leftColonDropped), "see a.ts");

  const touchedRight = prepareQuote("`a.ts`nya").lines[0]!;
  assert.equal(touchedRight.codes[0].alnumAfter, true);
  assert.equal(restoreLine('<x id="0"></x>nya', touchedRight), "a.tsnya");

  const touchedLeft = prepareQuote("**lihat**src/**/*.ts").lines[0]!;
  assert.equal(touchedLeft.codes[0].alnumBefore, true);
  assert.equal(restoreLine('lihat<x id="0"></x>', touchedLeft), "lihatsrc/**/*.ts");
});

test("restore spaces adjacent placeholders unless the same codes were joined in source", () => {
  const leadingMoved = prepareQuote("`a.ts`: cek (`b.ts`).").lines[0]!;
  assert.equal(restoreLine('See (<x id="1"></x><x id="0"></x>).', leadingMoved), "See (b.ts a.ts).");

  const trailingMoved = prepareQuote("(`a.ts`) cek: `b.ts`").lines[0]!;
  assert.equal(restoreLine('See <x id="1"></x><x id="0"></x>.', trailingMoved), "See b.ts a.ts.");

  const joinedSource = prepareQuote("lihat `a.ts`src/b.ts").lines[0]!;
  assert.equal(joinedSource.html, 'lihat <x id="0"></x><x id="1"></x>');
  assert.equal(joinedSource.codes[1].joinedToPrev, true);
  assert.equal(restoreLine('see <x id="0"></x><x id="1"></x>', joinedSource), "see a.tssrc/b.ts");
  assert.equal(restoreLine('see <x id="0"></x> <x id="1"></x>', joinedSource), "see a.tssrc/b.ts");
  assert.equal(restoreLine('see <x id="1"></x><x id="0"></x>', joinedSource), "see src/b.ts a.ts");

  const punctBetweenDropped = prepareQuote("lihat `a.ts`:`b.ts`").lines[0]!;
  assert.equal(restoreLine('see <x id="0"></x><x id="1"></x>', punctBetweenDropped), "see a.ts b.ts");
});
