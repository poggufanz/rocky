import { test } from "node:test";
import assert from "node:assert/strict";
import { isConfidentlyIn, type Pair } from "../translate/language.js";
import { translateQuote, type TranslatorLoad } from "../translate/quote.js";

function makeFakeLoad(
  impl?: (htmlLines: string[]) => string[],
): {
  load: (pair: Pair) => Promise<TranslatorLoad>;
  pairs: Pair[];
  calls: string[][];
} {
  const pairs: Pair[] = [];
  const calls: string[][] = [];
  const load = async (pair: Pair): Promise<TranslatorLoad> => {
    pairs.push(pair);
    return {
      ok: true,
      translator: {
        translate(htmlLines: string[]): string[] {
          calls.push([...htmlLines]);
          return impl ? impl(htmlLines) : [...htmlLines];
        },
      },
    };
  };
  return { load, pairs, calls };
}

test("confident language needs two common words and a lead of two", () => {
  assert.equal(isConfidentlyIn("Saya sudah ubah yang ini dan itu", "id"), true);
  assert.equal(isConfidentlyIn("Merah. Implementasi.", "id"), false);
  assert.equal(isConfidentlyIn("the test and the build", "en"), true);
  assert.equal(isConfidentlyIn("the yang dan", "id"), false); // id 2, en 1: lead 1
  assert.equal(isConfidentlyIn("the yang dan", "en"), false);
  assert.equal(isConfidentlyIn("YANG, dan!", "id"), true);
});

test("same language is skipped without loading", async () => {
  const fake = makeFakeLoad();
  const result = await translateQuote("Saya sudah ubah yang ini dan itu.", "id", fake.load);
  assert.deepEqual(result, { ok: false, reason: "same-language" });
  assert.equal(fake.pairs.length, 0);

  const enResult = await translateQuote("I fixed the test and the build.", "en", fake.load);
  assert.deepEqual(enResult, { ok: false, reason: "same-language" });
  assert.equal(fake.pairs.length, 0);
});

test("a quote with no prose is skipped", async () => {
  const fake = makeFakeLoad();
  const result = await translateQuote("`npm test`", "en", fake.load);
  assert.deepEqual(result, { ok: false, reason: "no-prose" });
  assert.equal(fake.pairs.length, 0);

  const fenced = await translateQuote("```ts\nconst x = 1;\n```", "id", fake.load);
  assert.deepEqual(fenced, { ok: false, reason: "no-prose" });
  assert.equal(fake.pairs.length, 0);
});

test("a short or mixed quote is translated from the other language", async () => {
  const fake = makeFakeLoad();
  const result = await translateQuote("Merah. Implementasi.", "en", fake.load);
  assert.deepEqual(fake.pairs, ["id-en"]);
  assert.deepEqual(result, { ok: true, from: "id", text: "Merah. Implementasi." });

  const mixedFake = makeFakeLoad();
  const mixed = await translateQuote("the yang dan", "id", mixedFake.load);
  assert.deepEqual(mixedFake.pairs, ["en-id"]);
  assert.deepEqual(mixed, { ok: true, from: "en", text: "the yang dan" });
});

test("only prose lines reach the engine, and lines keep their shape", async () => {
  const fake = makeFakeLoad();
  const text = "Baris satu.\n\n- **Dua:** `a.ts`\n```\ncode\n```";
  const result = await translateQuote(text, "en", fake.load);

  assert.deepEqual(fake.pairs, ["id-en"]);
  assert.deepEqual(fake.calls, [["Baris satu.", 'Dua: <x id="0"></x>']]);
  for (const line of fake.calls[0]) {
    assert.equal(line.includes("a.ts"), false);
    assert.equal(line.includes("code"), false);
  }
  assert.deepEqual(result, {
    ok: true,
    from: "id",
    text: "Baris satu.\n\nDua: a.ts\ncode",
  });

  const mixedFake = makeFakeLoad();
  const withCodeOnlyLine = await translateQuote("`npm test`\nBaris dua.", "en", mixedFake.load);
  assert.deepEqual(mixedFake.calls, [["Baris dua."]]);
  assert.deepEqual(withCodeOnlyLine, {
    ok: true,
    from: "id",
    text: "npm test\nBaris dua.",
  });
});

test("translated prose is assembled with restored code placeholders", async () => {
  const fake = makeFakeLoad((lines) => {
    assert.deepEqual(lines, ['Ubah <x id="0"></x> sekarang.']);
    return ['Change <x id="0"></x> now.'];
  });
  const result = await translateQuote("Ubah `src/a.ts` sekarang.", "en", fake.load);
  assert.deepEqual(result, {
    ok: true,
    from: "id",
    text: "Change src/a.ts now.",
  });
});

test("engine drift fails the whole quote", async () => {
  const stripFake = makeFakeLoad((lines) =>
    lines.map((line) => line.replace(/<x id="\d+"><\/x>/g, "")),
  );
  const stripped = await translateQuote("Baris satu.\nUbah `a.ts` dulu.", "en", stripFake.load);
  assert.deepEqual(stripped, { ok: false, reason: "placeholder-mismatch" });

  const repeatedFake = makeFakeLoad((lines) => [
    lines[0],
    'Change <x id="0"></x> <x id="0"></x> first.',
  ]);
  const repeated = await translateQuote("Baris satu.\nUbah `a.ts` dulu.", "en", repeatedFake.load);
  assert.deepEqual(repeated, { ok: false, reason: "placeholder-mismatch" });

  const inventedFake = makeFakeLoad((lines) => [
    lines[0],
    'Change <x id="0"></x> <x id="1"></x> first.',
  ]);
  const invented = await translateQuote("Baris satu.\nUbah `a.ts` dulu.", "en", inventedFake.load);
  assert.deepEqual(invented, { ok: false, reason: "placeholder-mismatch" });

  const fewerFake = makeFakeLoad((lines) => lines.slice(0, -1));
  const fewer = await translateQuote("Baris satu.\nBaris dua.", "en", fewerFake.load);
  assert.deepEqual(fewer, { ok: false, reason: "placeholder-mismatch" });

  const extraFake = makeFakeLoad((lines) => [...lines, "Extra line."]);
  const extra = await translateQuote("Baris satu.\nBaris dua.", "en", extraFake.load);
  assert.deepEqual(extra, { ok: false, reason: "placeholder-mismatch" });

  const strayTagFake = makeFakeLoad((lines) => [lines[0], "<b>Line two</b>"]);
  const strayTag = await translateQuote("Baris satu.\nBaris dua.", "en", strayTagFake.load);
  assert.deepEqual(strayTag, { ok: false, reason: "placeholder-mismatch" });

  const embeddedLfFake = makeFakeLoad((lines) => [`${lines[0]}\nExtra`, lines[1]]);
  const embeddedLf = await translateQuote("Baris satu.\nBaris dua.", "en", embeddedLfFake.load);
  assert.deepEqual(embeddedLf, { ok: false, reason: "placeholder-mismatch" });

  const embeddedCrFake = makeFakeLoad((lines) => [lines[0], `${lines[1]}\rExtra`]);
  const embeddedCr = await translateQuote("Baris satu.\nBaris dua.", "en", embeddedCrFake.load);
  assert.deepEqual(embeddedCr, { ok: false, reason: "placeholder-mismatch" });
});

test("load failure and engine throw are reported", async () => {
  const missingLoad = async (): Promise<TranslatorLoad> => ({
    ok: false,
    reason: "model-missing",
  });
  const missingResult = await translateQuote("Merah. Implementasi.", "en", missingLoad);
  assert.deepEqual(missingResult, { ok: false, reason: "model-missing" });

  const rejectingLoad = async (): Promise<TranslatorLoad> => {
    throw new Error("boom");
  };
  const rejectingResult = await translateQuote("Merah. Implementasi.", "en", rejectingLoad);
  assert.deepEqual(rejectingResult, { ok: false, reason: "load-failed" });

  const throwingFake = makeFakeLoad(() => {
    throw new Error("boom");
  });
  const errorResult = await translateQuote("Merah. Implementasi.", "en", throwingFake.load);
  assert.deepEqual(errorResult, { ok: false, reason: "engine-error" });
});
