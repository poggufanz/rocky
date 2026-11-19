import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  MAX_KEY_CHARS,
  MAX_TEXT_CHARS,
  parseTranslateRequest,
  runTranslate,
  TRANSLATE_USAGE,
} from "../commands/translate.js";
import { MAX_LINE_BYTES } from "../commands/listen.js";
import type { Pair } from "../translate/language.js";
import type { TranslatorLoad } from "../translate/quote.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = join(packageRoot, "dist", "index.js");

function scratchDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  send(text: string): void;
  endInput(): void;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const child = spawn(process.execPath, [ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return {
    send: (text) => child.stdin.write(text),
    endInput: () => child.stdin.end(),
    done,
  };
}

test("parseTranslateRequest drops unaddressable lines and marks addressable bad lines", () => {
  assert.equal(MAX_KEY_CHARS, 128);
  assert.equal(MAX_TEXT_CHARS, 4000);

  for (const unaddressable of [
    "",
    "not json",
    "null",
    "[]",
    '"hello"',
    JSON.stringify({ key: "k1", to: "en", text: "Merah" }),
    JSON.stringify({ v: 2, key: "k1", to: "en", text: "Merah" }),
    JSON.stringify({ v: 1, to: "en", text: "Merah" }),
    JSON.stringify({ v: 1, key: "", to: "en", text: "Merah" }),
    JSON.stringify({ v: 1, key: 123, to: "en", text: "Merah" }),
    JSON.stringify({ v: 1, key: "k".repeat(MAX_KEY_CHARS + 1), to: "en", text: "Merah" }),
  ]) {
    assert.equal(parseTranslateRequest(unaddressable), undefined, unaddressable);
  }

  for (const bad of [
    JSON.stringify({ v: 1, key: "k1", to: "fr", text: "Merah" }),
    JSON.stringify({ v: 1, key: "k2", text: "Merah" }),
    JSON.stringify({ v: 1, key: "k3", to: 1, text: "Merah" }),
    JSON.stringify({ v: 1, key: "k4", to: "en" }),
    JSON.stringify({ v: 1, key: "k5", to: "en", text: 42 }),
    JSON.stringify({ v: 1, key: "k6", to: "en", text: null }),
    JSON.stringify({ v: 1, key: "k7", to: "id", text: "a".repeat(MAX_TEXT_CHARS + 1) }),
  ]) {
    const expectedKey = (JSON.parse(bad) as { key: string }).key;
    assert.deepEqual(parseTranslateRequest(bad), { key: expectedKey, bad: true }, bad);
  }

  const maxKey = "k".repeat(MAX_KEY_CHARS);
  const maxText = "a".repeat(MAX_TEXT_CHARS);
  assert.deepEqual(
    parseTranslateRequest(JSON.stringify({ v: 1, key: maxKey, to: "en", text: maxText })),
    { key: maxKey, to: "en", text: maxText },
  );
  assert.deepEqual(
    parseTranslateRequest(`${JSON.stringify({ v: 1, key: "k1", to: "id", text: "" })}\r`),
    { key: "k1", to: "id", text: "" },
  );
});

test("runTranslate answers in request order and drops unaddressable lines", async () => {
  const input = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  const loadCalls: Pair[] = [];

  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });

  const load = async (pair: Pair): Promise<TranslatorLoad> => {
    loadCalls.push(pair);
    await loadGate;
    return {
      ok: true,
      translator: {
        translate(htmlLines: string[]): string[] {
          return htmlLines.map((line) => (line === "Merah. Implementasi." ? "Red. Implementation." : line));
        },
      },
    };
  };

  const running = runTranslate(
    input,
    (line) => {
      replies.push(JSON.parse(line) as Record<string, unknown>);
    },
    load,
  );

  input.write(`${JSON.stringify({ v: 1, key: "k1", to: "en", text: "Merah. Implementasi." })}\n`);
  input.write("not json\n");
  input.write(`${JSON.stringify({ v: 1, key: "k2", to: "fr", text: "Merah" })}\n`);
  input.write(JSON.stringify({ v: 1, key: "k3", to: "en", text: "I fixed the test and the build." }));
  input.end();

  // Wait a microtask to verify the second/third lines did not overtake the blocked first request.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(replies, []);
  releaseLoad();

  await running;
  assert.deepEqual(loadCalls, ["id-en"]);
  assert.deepEqual(replies, [
    { v: 1, key: "k1", ok: true, from: "id", text: "Red. Implementation." },
    { v: 1, key: "k2", ok: false, reason: "bad-request" },
    { v: 1, key: "k3", ok: false, reason: "same-language" },
  ]);
});

test("runTranslate ignores lines above MAX_LINE_BYTES and continues serving", async () => {
  const input = new PassThrough();
  const replies: Record<string, unknown>[] = [];
  const load = async (): Promise<TranslatorLoad> => ({
    ok: true,
    translator: {
      translate: (lines) => lines,
    },
  });

  const running = runTranslate(
    input,
    (line) => replies.push(JSON.parse(line) as Record<string, unknown>),
    load,
  );

  input.write(`${JSON.stringify({ v: 1, key: "huge", to: "en", text: "x".repeat(MAX_LINE_BYTES) })}\n`);
  input.write(`${JSON.stringify({ v: 1, key: "after", to: "en", text: "Merah. Implementasi." })}\n`);
  input.end();

  await running;
  assert.deepEqual(replies, [
    { v: 1, key: "after", ok: true, from: "id", text: "Merah. Implementasi." },
  ]);
});

test("run spawned with an empty home reports engine-missing and prints no quote text", async (t) => {
  const home = scratchDir(t, "rocky-translate-empty-");
  const proc = spawnCli(["translate", "run"], {
    ROCKY_HOME: home,
    HOME: home,
    USERPROFILE: home,
  });
  proc.send('{"v":1,"key":"k1","to":"en","text":"Merah. Implementasi."}\n');
  proc.endInput();

  const res = await proc.done;
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, '{"v":1,"key":"k1","ok":false,"reason":"engine-missing"}\n');
  assert.equal(res.stderr.includes("Merah"), false);
  assert.equal(res.stderr, "");
});

test("bad arguments exit 2 without touching the network", async (t) => {
  assert.equal(
    TRANSLATE_USAGE,
    "Usage: rocky translate install --pair <id-en|en-id> | rocky translate run",
  );
  const home = scratchDir(t, "rocky-translate-badargs-");
  const cases = [
    ["translate"],
    ["translate", "bogus"],
    ["translate", "run", "extra"],
    ["translate", "install"],
    ["translate", "install", "--pair"],
    ["translate", "install", "--pair", "xx-yy"],
    ["translate", "install", "--pair", "id-en", "extra"],
  ];

  await Promise.all(
    cases.map(async (args) => {
      const proc = spawnCli(args, {
        ROCKY_HOME: home,
        HOME: home,
        USERPROFILE: home,
      });
      proc.endInput();
      const res = await proc.done;
      assert.equal(res.code, 2, `args: ${args.join(" ")}\nstderr: ${res.stderr}`);
      assert.equal(res.stdout, "", `stdout must be empty for: ${args.join(" ")}`);
      assert.ok(res.stderr.includes(TRANSLATE_USAGE), `usage missing for: ${args.join(" ")}`);
    }),
  );
});

test("translate is hidden from help output and translation runtime opens no network", async (t) => {
  const home = scratchDir(t, "rocky-translate-help-");
  for (const args of [["--help"], ["--help", "--all"]]) {
    const proc = spawnCli(args, { ROCKY_HOME: home, HOME: home, USERPROFILE: home });
    proc.endInput();
    const res = await proc.done;
    assert.equal(res.code, 0, res.stderr);
    assert.equal(/\btranslate\b/.test(res.stdout + res.stderr), false, `help must not list translate (${args.join(" ")})`);
  }

  const runtimeFiles = [
    "src/translate/engine.ts",
    "src/translate/quote.ts",
    "src/translate/segments.ts",
    "src/translate/language.ts",
  ];
  const network = /node:net|node:http|node:https|node:dgram|fetch\(/;
  for (const file of runtimeFiles) {
    const text = readFileSync(join(packageRoot, file), "utf8");
    assert.doesNotMatch(text, network, `${file} must not open a network connection`);
  }
});

test("runTranslate rejects without unhandledRejection when writer throws before EOF", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
  });

  for (const line of [
    JSON.stringify({ v: 1, key: "k1", to: "fr", text: "Merah" }),
    JSON.stringify({ v: 1, key: "k2", to: "en", text: "Merah. Implementasi." }),
  ]) {
    const input = new PassThrough();
    t.after(() => input.destroy());
    const boom = new Error("broken writer");

    const running = runTranslate(
      input,
      () => {
        throw boom;
      },
      async () => ({
        ok: true,
        translator: {
          translate: (lines) => lines,
        },
      }),
    );

    input.write(`${line}\n`);
    await assert.rejects(running, (err) => err === boom);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(unhandled, []);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("end"), 0);
    assert.equal(input.listenerCount("error"), 0);
    assert.equal(input.listenerCount("close"), 0);
  }
});
