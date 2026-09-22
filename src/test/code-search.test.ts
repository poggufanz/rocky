import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import {
  CODE_MAX_EXCERPTS,
  CODE_NO_MATCH,
  CODE_NO_MODEL,
  CODE_UNRANKED,
  buildCodePrompt,
  collectCodeEvidence,
  isCodeQuery,
  splitCodePrefix,
  validateCodeCitations,
  type CodeScanIo,
} from "../gui/code-search.js";
import { startGui, type GuiHandle } from "../gui/server.js";
import { writeSettings } from "../gui/settings.js";

/* --------------------------------------------------------------- fixtures */

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-code-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-code-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function writeRepoFile(root: string, rel: string, text: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

/** A git tree whose files are staged, so `git ls-files` lists them. */
function gitInit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
}

async function withGui(root: string, run: (handle: GuiHandle) => Promise<void>): Promise<void> {
  const handle = await startGui({ port: 0, root });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

interface CodeEvidenceWire {
  ref: string;
  path: string;
  startLine: number;
  endLine: number;
  lines: string;
  score: number;
}

interface ChatPayload extends Record<string, unknown> {
  text?: string;
  codeEvidence?: CodeEvidenceWire[];
  codeAnswer?: { text: string; model: string; status: string; stripped: number; disclosure?: string };
  codeTrace?: { mode: string; filesScanned: number; filesTotal: number; rounds: number; roundsExhausted: boolean; truncated: boolean };
}

const post = async (handle: GuiHandle, body: unknown): Promise<{ status: number; payload: ChatPayload }> => {
  const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
    method: "POST",
    headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as ChatPayload };
};

const failureRecord = (id: string, cmd: string): unknown => ({
  kind: "failure",
  id,
  ts: Date.now() - 1000,
  cwd: "/private/one",
  cmd,
  exitCode: 1,
  fingerprint: "a1b2c3d4e5f60718",
  signature: [cmd],
  excerpt: "plain excerpt",
});

const explainRecord = (id: string, root: string, path: string, snippet: string): unknown => ({
  kind: "explain",
  id,
  v: 1,
  ts: Date.now() - 60_000,
  cwd: root,
  path,
  source: "agent:test",
  code: snippet,
  business: "a heard file",
  snippet,
});

/** A keyed BYOK provider on loopback, the same shape the ask path uses. */
async function withProvider(
  reply: (prompt: string) => string,
  run: (endpoint: string, seen: string[]) => Promise<void>,
): Promise<void> {
  const seen: string[] = [];
  const provider: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: { content?: string }[] };
      const prompt = parsed.messages?.[0]?.content ?? "";
      seen.push(prompt);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: reply(prompt) } }] }));
    });
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const port = (provider.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/v1/chat/completions`, seen);
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
}

/* ---------------------------------------------------------------- trigger */

test("the prefix decides first: code: forces the scan, memory: suppresses it", () => {
  assert.deepEqual(splitCodePrefix("  code: where is parsePatch"), { mode: "code", query: "where is parsePatch", prefixEmpty: false });
  assert.deepEqual(splitCodePrefix("code:"), { mode: "code", query: "", prefixEmpty: true });
  assert.deepEqual(splitCodePrefix("memory: where is parsePatch"), { mode: "memory", query: "where is parsePatch", prefixEmpty: false });
  assert.deepEqual(splitCodePrefix("why did the build fail"), { mode: "auto", query: "why did the build fail", prefixEmpty: false });
});

test("the heuristic fires on code tokens and never on a memory question", () => {
  for (const message of [
    "where is fingerprint() defined",
    "src/core/memory.ts:120",
    "how does loadConfig read the file",
    "code: parsePatch",
    "what calls buildChatStructure",
    "explain the git-diff.ts module",
  ]) {
    assert.equal(isCodeQuery(message), true, `expected a code trigger: ${message}`);
  }
  for (const message of [
    "why did the build fail",
    "how do I fix the flaky test run",
    "what did you hear about the deploy",
    "npm run build",
    "Error: cannot find module 'left-pad'",
    "a1b2c3d4e5f60718",
    "kenapa build script sempat error",
  ]) {
    assert.equal(isCodeQuery(message), false, `expected no code trigger: ${message}`);
  }
  // a basename Rocky already heard is enough, even when nothing else about
  // the message looks like code: he is being asked for that file
  assert.equal(isCodeQuery("what happened in the Makefile", ["Makefile"]), true);
  assert.equal(isCodeQuery("what happened in the Makefile", []), false);
});

/* ------------------------------------------------------------- collection */

/** A fake tree: `lsFiles` lists it relatively, `readText` serves it, no disk. */
function fakeIo(root: string, files: Record<string, string>): CodeScanIo & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    lsFiles: () => Object.keys(files).map((full) => (full.startsWith(root + sep) ? full.slice(root.length + 1) : full)),
    statSize: (full) => (files[full] === undefined ? undefined : files[full].length),
    readText: (full) => {
      read.push(full);
      return files[full];
    },
  };
}

const inRoot = (root: string) => (candidate: string): string | undefined => {
  const full = resolve(root, candidate);
  return full === root || full.startsWith(root + sep) ? full : undefined;
};

test("ranking reads the file the question names, quotes it verbatim, and caps the excerpts", () => {
  const root = "/fake/root";
  const declaration = "export function fingerprint(stderr: string): string {";
  const io = fakeIo(root, {
    "/fake/root/src/core/fingerprint.ts": `${declaration}\n  return hash(text);\n}\n`,
    "/fake/root/src/gui/server.ts": "const unrelated = 1;\n",
    "/fake/root/docs/notes.md": "# notes\n",
    "/fake/root/../../etc/passwd": "root:x:0:0:root:/root:/bin/bash\n",
  });
  const result = collectCodeEvidence({
    root,
    query: "where is fingerprint defined",
    confine: inRoot(root),
    io,
    now: () => 0,
  });

  assert.equal(result.trace.mode, "ranked");
  assert.ok(result.evidence.length >= 1 && result.evidence.length <= CODE_MAX_EXCERPTS);
  assert.equal(result.evidence[0]?.path, "src/core/fingerprint.ts");
  assert.ok(result.evidence[0]?.lines.includes(declaration), "the declaration is quoted verbatim");
  assert.match(result.evidence[0]?.ref ?? "", /^src\/core\/fingerprint\.ts:\d+-\d+$/);
  for (const path of io.read) assert.ok(path.startsWith(root + sep), `read outside the root: ${path}`);
  for (const excerpt of result.evidence) assert.ok(!excerpt.path.includes(".."), `escape quoted: ${excerpt.path}`);
});

test("a symbol question finds a file whose name is only part of the symbol", () => {
  const root = "/fake/root";
  const io = fakeIo(root, {
    "/fake/root/src/memory.ts": "const A = 1;\nexport function loadMemory(path: string) {\n  return read(path);\n}\n",
    "/fake/root/src/other.ts": "const B = 2;\n",
  });
  const result = collectCodeEvidence({ root, query: "where is loadMemory defined", confine: inRoot(root), io, now: () => 0 });
  assert.equal(result.evidence[0]?.path, "src/memory.ts");
  assert.ok(result.evidence[0]?.lines.includes("export function loadMemory(path: string) {"));
});

test("a secret in a quoted window is redacted before it can leave", () => {
  const root = "/fake/root";
  const secret = "sk-ant-abcdefghijklmnopqrst123";
  const io = fakeIo(root, {
    "/fake/root/src/unit.ts": `export function loadConfig() {\n  const key = "${secret}";\n  return key;\n}\n`,
  });
  const result = collectCodeEvidence({ root, query: "where is loadConfig defined", confine: inRoot(root), io, now: () => 0 });
  assert.ok(result.evidence.length >= 1);
  const quoted = result.evidence.map((excerpt) => excerpt.lines).join("\n");
  assert.ok(!quoted.includes(secret), "the secret reached the evidence");
  assert.ok(quoted.includes("[redacted"), "the redaction placeholder is what remains");
});

test("a non-git root scans unranked over the memory-named files only", () => {
  const root = "/fake/root";
  const io: CodeScanIo = {
    lsFiles: () => undefined,
    statSize: (full) => (full.endsWith("a.ts") ? 40 : undefined),
    readText: (full) => (full.endsWith("a.ts") ? "export function parsePatch() {\n  return 1;\n}\n" : undefined),
  };
  const result = collectCodeEvidence({
    root,
    query: "where is parsePatch defined",
    confine: inRoot(root),
    witnessed: ["src/a.ts", "/etc/outside.ts"],
    io,
    now: () => 0,
  });
  assert.equal(result.trace.mode, "unranked");
  assert.equal(result.trace.filesTotal, 1);
  assert.ok(result.disclosures.includes(CODE_UNRANKED));
  assert.equal(result.evidence[0]?.path, "src/a.ts");
  assert.ok(!result.evidence.some((excerpt) => excerpt.path.includes("outside")), "an absolute outside path is not a candidate");
});

test("oversize files are a miss with a disclosure, and a spent round discloses its timeout", () => {
  const root = "/fake/root";
  const oversize = collectCodeEvidence({
    root,
    query: "where is parsePatch defined",
    confine: inRoot(root),
    io: { ...fakeIo(root, { "/fake/root/big.ts": "x".repeat(10) }), statSize: () => 4 * 1024 * 1024 },
    now: () => 0,
  });
  assert.deepEqual(oversize.evidence, []);
  assert.ok(oversize.disclosures.some((line) => line.includes("too big to quote")));
  assert.equal(oversize.trace.truncated, true);

  // a clock that advances a second per look runs the whole phase out of budget
  let clock = 0;
  const stalled = collectCodeEvidence({
    root,
    query: "where is parsePatch defined",
    confine: inRoot(root),
    io: fakeIo(root, Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`/fake/root/f${index}.ts`, "const x = 1;\n"]))),
    now: () => (clock += 1000),
  });
  assert.ok(stalled.trace.rounds >= 1 && stalled.trace.rounds <= 3);
  assert.equal(stalled.trace.roundsExhausted, true);
  assert.equal(stalled.trace.truncated, true);
  assert.ok(stalled.disclosures.some((line) => line.startsWith("code read timed out in round ")));
});

test("a citation the excerpts do not hold is stripped and counted", () => {
  const evidence = [{ ref: "src/a.ts:10-20", path: "src/a.ts", startLine: 10, endLine: 20, lines: "const a = 1;", score: 4 }];
  const check = validateCodeCitations("a.ts:12 is where it lives.\na.ts:900 is nowhere.\nplain line", evidence);
  assert.deepEqual(check.stripped.split("\n"), ["a.ts:12 is where it lives.", "plain line"]);
  assert.equal(check.dropped, 1);
});

test("the prompt always carries the memory block, the Jev block, and the pack", () => {
  const prompt = buildCodePrompt({
    preamble: "TEACH ENV",
    question: "where is fingerprint defined",
    memoryBlock: "",
    jevBlock: "",
    evidence: [{ ref: "src/a.ts:1-2", path: "src/a.ts", startLine: 1, endLine: 2, lines: "const a = 1;", score: 1 }],
  });
  assert.ok(prompt.includes("TEACH ENV"));
  assert.ok(prompt.includes("HARD STOP"));
  assert.ok(prompt.includes("no memory evidence for this query"));
  assert.ok(prompt.includes("no jev trace for this query"));
  assert.ok(prompt.includes("=== src/a.ts:1-2 ==="));
  assert.ok(prompt.includes("USER QUESTION: where is fingerprint defined"));
});

/* ---------------------------------------------------------------- through */

test("a memory-only question keeps today's payload and never scans", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("persisted-failure-one-9d3f", "npm run build")]);
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "why did the build fail" });
    assert.equal(answer.status, 200);
    assert.deepEqual(
      Object.keys(answer.payload).sort(),
      ["decisionTrace", "evidenceCards", "llm", "renderOrder", "text"],
    );
    assert.equal(answer.payload.codeEvidence, undefined);
    assert.equal(answer.payload.codeAnswer, undefined);
    assert.equal(answer.payload.codeTrace, undefined);
  });
});

test("a code question quotes the file with file:line and, with no model, says so", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build loadMemory")]);
  writeRepoFile(root, "src/memory.ts", [
    "const HEADER = 1;",
    "const OTHER = 2;",
    "const THIRD = 3;",
    "const FOURTH = 4;",
    "export function loadMemory(path: string) {",
    "  return read(path);",
    "}",
    "",
  ].join("\n"));
  writeRepoFile(root, "docs/notes.md", "# notes\n");
  gitInit(root);

  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "where is loadMemory defined" });
    assert.equal(answer.status, 200);
    const evidence = answer.payload.codeEvidence ?? [];
    assert.ok(evidence.length >= 1 && evidence.length <= CODE_MAX_EXCERPTS);
    const first = evidence[0];
    assert.ok(first !== undefined);
    assert.equal(first.path, "src/memory.ts");
    assert.ok(first.lines.includes("export function loadMemory(path: string) {"));
    assert.equal(answer.payload.codeTrace?.mode, "ranked");
    assert.equal(answer.payload.codeAnswer?.status, "no-model");
    const disclosure = String(answer.payload.codeAnswer?.disclosure ?? "");
    assert.ok(disclosure.includes(CODE_NO_MODEL));
    assert.ok(!disclosure.includes("budget spent"), "nothing was cut short by the round cap");
    assert.equal(answer.payload.codeAnswer?.stripped, 0);
    assert.ok(String(answer.payload.codeAnswer?.text ?? "").startsWith("code: quoted "));
  });
});

test("a path outside the launch root is a miss, never an error", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build")]);
  writeRepoFile(root, "src/a.ts", "export const a = 1;\n");
  gitInit(root);

  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "../../etc/passwd read this" });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.payload.codeEvidence, []);
    assert.ok(String(answer.payload.codeAnswer?.disclosure ?? "").includes(CODE_NO_MATCH));
    assert.equal(answer.payload.codeAnswer?.status, "no-model");
  });
});

test("no model configured: excerpts come back with CODE_NO_MODEL and nothing is sent", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build parsePatch")]);
  writeRepoFile(root, "src/patch.ts", "export function parsePatch(text: string) {\n  return text;\n}\n");
  gitInit(root);
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "where is parsePatch defined" });
    assert.ok((answer.payload.codeEvidence ?? []).length >= 1);
    assert.equal(answer.payload.codeAnswer?.status, "no-model");
    assert.ok(String(answer.payload.codeAnswer?.disclosure ?? "").includes(CODE_NO_MODEL));
  });
});

test("a configured model gets one code call, and its unbacked citations are stripped", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build loadMemory")]);
  writeRepoFile(root, "src/memory.ts", [
    "const A = 1;",
    "const B = 2;",
    "const C = 3;",
    "export function loadMemory(path: string) {",
    "  return read(path);",
    "}",
    "",
  ].join("\n"));
  gitInit(root);

  await withProvider(
    (prompt) => {
      const label = /=== ([\w./-]+):(\d+)-(\d+) ===/.exec(prompt);
      if (label === null) return "{\"text\":\"ok\"}";
      return `${label[1]}:${label[2]} mendefinisikan pengunci baca.\n${label[1]}:9999 tidak ada di kutipan.`;
    },
    async (endpoint, seen) => {
      writeSettings({ provider: "openai", endpoint, model: "stub-code-model", key: "sk-test-key" });
      await withGui(root, async (handle) => {
        const answer = await post(handle, { message: "where is loadMemory defined" });
        assert.equal(answer.status, 200);
        const codePrompts = seen.filter((prompt) => prompt.includes("CODE EXCERPTS"));
        assert.equal(codePrompts.length, 1, "exactly one code provider call per code question");
        const prompt = codePrompts[0] ?? "";
        assert.ok(prompt.includes("MEMORY EVIDENCE"));
        assert.ok(prompt.includes("npm run build loadMemory"), "the memory block carries the heard record");
        assert.ok(prompt.includes("JEV DECISION TRACE"));
        assert.ok(prompt.includes("HARD STOP"));
        assert.ok(prompt.includes("=== src/memory.ts:"));
        assert.equal(answer.payload.codeAnswer?.status, "used");
        assert.equal(answer.payload.codeAnswer?.stripped, 1);
        assert.ok(String(answer.payload.codeAnswer?.disclosure ?? "").includes("stripped"));
        assert.ok(String(answer.payload.codeAnswer?.text ?? "").includes("mendefinisikan"));
        assert.ok(!String(answer.payload.codeAnswer?.text ?? "").includes("9999"), "the unbacked line is gone");
      });
    },
  );
});

test("a seeded secret never reaches the evidence, the prompt, or the answer", async () => {
  const { home, root } = hermetic();
  const secret = "sk-ant-abcdefghijklmnopqrst123";
  seedMemory(home, [failureRecord("f-1", "npm run build loadConfig")]);
  writeRepoFile(root, "src/config.ts", [
    "const TOP = 1;",
    "export function loadConfig(path: string) {",
    `  const key = "${secret}";`,
    "  return key;",
    "}",
    "",
  ].join("\n"));
  gitInit(root);

  await withProvider(
    () => "{\"text\":\"ok\"}",
    async (endpoint, seen) => {
      writeSettings({ provider: "openai", endpoint, model: "stub-code-model", key: "sk-test-key" });
      await withGui(root, async (handle) => {
        const answer = await post(handle, { message: "where is loadConfig defined" });
        const evidence = answer.payload.codeEvidence ?? [];
        assert.ok(evidence.length >= 1);
        const quoted = evidence.map((excerpt) => excerpt.lines).join("\n");
        assert.ok(quoted.includes("[redacted"), "the window really covered the secret line");
        assert.ok(!JSON.stringify(answer.payload).includes(secret), "the secret reached the response");
        for (const prompt of seen) assert.ok(!prompt.includes(secret), "the secret reached the provider prompt");
      });
    },
  );
});

test("a budget-exhausting repo answers with roundsExhausted and a disclosure", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build")]);
  for (let index = 0; index < 45; index += 1) {
    writeRepoFile(root, `src/unit-${index}.ts`, `export const unit${index} = ${index};\n`);
  }
  gitInit(root);

  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "where is nothingHereDefinedInThisRepo" });
    assert.equal(answer.status, 200);
    const trace = answer.payload.codeTrace;
    assert.ok(trace !== undefined);
    assert.equal(trace.rounds, 3);
    assert.equal(trace.roundsExhausted, true);
    assert.equal(trace.truncated, true);
    assert.ok(trace.filesTotal >= 45);
    assert.ok(trace.filesScanned <= 40);
    const disclosure = String(answer.payload.codeAnswer?.disclosure ?? "");
    assert.ok(disclosure.includes("budget spent after 3 rounds"));
    assert.ok(disclosure.includes(CODE_NO_MATCH));
  });
});

test("a non-git root still answers: unranked mode over the memory-named file", async () => {
  const { home, root } = hermetic();
  writeRepoFile(root, "src/unit.ts", "export function parseThing(text: string) {\n  return text;\n}\n");
  seedMemory(home, [explainRecord("e1", root, "src/unit.ts", "export function parseThing(text: string) {")]);

  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "where is parseThing defined" });
    assert.equal(answer.status, 200);
    assert.equal(answer.payload.codeTrace?.mode, "unranked");
    assert.ok(String(answer.payload.codeAnswer?.disclosure ?? "").includes(CODE_UNRANKED));
    assert.equal(answer.payload.codeEvidence?.[0]?.path, "src/unit.ts");
  });
});

test("code: with no query behind it answers memory-only with CODE_PREFIX_EMPTY", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build")]);
  writeRepoFile(root, "src/a.ts", "export const a = 1;\n");
  gitInit(root);
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "code:" });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.payload.codeEvidence, []);
    assert.equal(answer.payload.codeAnswer?.status, "skipped");
    assert.ok(String(answer.payload.codeAnswer?.disclosure ?? "").includes("no query after the prefix"));
    assert.equal(answer.payload.codeTrace?.filesScanned, 0);
  });
});

test("memory: suppresses the scan on a message that looks like code", async () => {
  const { home, root } = hermetic();
  seedMemory(home, [failureRecord("f-1", "npm run build")]);
  writeRepoFile(root, "src/a.ts", "export const a = 1;\n");
  gitInit(root);
  await withGui(root, async (handle) => {
    const answer = await post(handle, { message: "memory: where is parsePatch defined" });
    assert.equal(answer.status, 200);
    assert.equal(answer.payload.codeEvidence, undefined);
    assert.equal(answer.payload.codeAnswer, undefined);
    assert.equal(answer.payload.codeTrace, undefined);
  });
});

test("the chat route still refuses an empty message and a missing token", async () => {
  const { root } = hermetic();
  await withGui(root, async (handle) => {
    assert.equal((await post(handle, { message: "   " })).status, 400);
    const noToken = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "where is a.ts defined" }),
    });
    assert.equal(noToken.status, 403);
  });
});
