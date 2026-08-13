import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { annotateBatch, annotateCommand, defaultQueueLabel, degradedLabel, maybeQueueDigestHint } from "../agent/annotate.js";
import type { AnnotatePort } from "../ai/annotate.js";
import type { ConfigLoadResult } from "../core/config-read.js";
import { appendEvent, listOrphanClaims, readBatch } from "../agent/spool.js";
import type { AgentEvent } from "../agent/schema.js";
import { loadMemory, parseMemoryRecord, recordTriple, recordTripleOnce } from "../core/memory.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

const INVISIBLE_FORMAT_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ["U+061C", "\u061C"],
  ["U+200B", "\u200B"],
  ["U+200C", "\u200C"],
  ["U+200D", "\u200D"],
  ["U+200E", "\u200E"],
  ["U+200F", "\u200F"],
  ["U+202A", "\u202A"],
  ["U+202B", "\u202B"],
  ["U+202C", "\u202C"],
  ["U+202D", "\u202D"],
  ["U+202E", "\u202E"],
  ["U+2060", "\u2060"],
  ["U+2061", "\u2061"],
  ["U+2062", "\u2062"],
  ["U+2063", "\u2063"],
  ["U+2064", "\u2064"],
  ["U+2065", "\u2065"],
  ["U+2066", "\u2066"],
  ["U+2067", "\u2067"],
  ["U+2068", "\u2068"],
  ["U+2069", "\u2069"],
  ["U+206A", "\u206A"],
  ["U+206B", "\u206B"],
  ["U+206C", "\u206C"],
  ["U+206D", "\u206D"],
  ["U+206E", "\u206E"],
  ["U+206F", "\u206F"],
  ["U+FEFF", "\uFEFF"],
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function append(key: string, events: readonly AgentEvent[], paths: RockyPaths): void {
  for (const event of events) appendEvent(key, event, paths);
}

async function waitForMarker(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!existsSync(path)) throw new Error(`missing marker ${path}`);
}

function seedBatch(paths: RockyPaths, key: string, rationale = "margin adds spacing"): void {
  append(key, [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, cwd: paths.home, text: "naikin dikit" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.css", excerpt: "margin-top: 8px" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 3, source: "transcript", text: rationale },
  ], paths);
}

function seedDigestTriple(paths: RockyPaths, ts: number): void {
  recordTriple({
    ts,
    agent: "codex",
    cwd: "/w",
    intent: { text: "naikin" },
    mechanism: { files: [{ path: "a.css", plusMinus: [1, 0], props: ["margin"] }], truncatedFiles: 0 },
  }, paths);
}

function labelLines(paths: RockyPaths): string[] {
  return existsSync(paths.labels)
    ? readFileSync(paths.labels, "utf8").split("\n").filter(Boolean)
    : [];
}

test("degraded annotate writes one redacted triple to injected memory path and removes batch", async (t) => {
  const paths = freshPaths(t);
  append("redacted", [
    {
      v: 1,
      agent: "claude-code",
      kind: "intent",
      ts: 1,
      cwd: paths.home,
      text: "naikin dikit sk-ant-abcdefghijklmnopqrst123\n\u001b[31m\u202e",
    },
    {
      v: 1,
      agent: "claude-code",
      kind: "mechanism",
      ts: 2,
      tool: "Edit",
      path: "src/app.css",
      excerpt: "margin-top: 8px\n\u001b[31mAKIAABCDEFGHIJKLMNOP\u202e",
    },
    {
      v: 1,
      agent: "claude-code",
      kind: "rationale",
      ts: 3,
      source: "notify",
      text: "margin adds spacing\t\u202e",
    },
  ], paths);
  const labels: string[] = [];
  const gitCalls: Array<{ args: string[]; cwd: string }> = [];
  const triple = await annotateBatch("redacted", {
    paths,
    now: () => 99,
    git: (args, cwd) => {
      gitCalls.push({ args, cwd });
      return args[0] === "rev-parse" ? "abc123" : "3\t1\tsrc/app.css";
    },
    queueLabel: (line) => labels.push(line),
  });

  assert.ok(triple);
  assert.equal(triple.ts, 99);
  assert.equal(triple.agent, "claude-code");
  assert.equal(triple.mechanism.head, "abc123");
  assert.deepEqual(triple.mechanism.files[0], {
    path: "src/app.css",
    plusMinus: [3, 1],
    props: ["margin-top"],
    excerpt: "margin-top: 8px [redacted aws access key]",
  });
  assert.equal(triple.intent?.text, "naikin dikit [redacted anthropic key]");
  assert.equal(triple.rationale?.text, "margin adds spacing");
  assert.deepEqual(triple.rationale && { source: triple.rationale.source, tags: triple.rationale.tags }, {
    source: "notify",
    tags: [],
  });
  assert.equal(labels.length, 1);
  assert.ok(!JSON.stringify(triple).includes("sk-ant-"));
  assert.ok(!JSON.stringify(triple).includes("AKIAABCDEFGHIJKLMNOP"));
  assert.equal(/\u001b|\u0000|\u202e/.test(JSON.stringify(triple)), false);
  assert.equal(loadMemory(paths.memory).length, 1);
  assert.equal(loadMemory(paths.memory)[0]?.kind, "triple");
  assert.equal(existsSync(join(paths.spoolDir, "redacted.jsonl")), false);
  assert.ok(gitCalls.some(({ args }) => args[0] === "rev-parse" && args[1] === "HEAD"));
});

test("late appends stay in a fresh live spool while annotation awaits AI", async (t) => {
  const paths = freshPaths(t);
  append("late-append", [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, cwd: paths.home, text: "change spacing" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "before.css", excerpt: "margin-top: 8px" },
  ], paths);

  let begin: (() => void) | undefined;
  let release: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { begin = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const ai: AnnotatePort = {
    async run() {
      begin?.();
      await blocked;
      return { summary: "compact", tags: ["spacing"], label: "spacing, question" };
    },
  };

  const annotation = annotateBatch("late-append", { paths, ai, git: () => undefined, queueLabel: () => {} });
  await started;
  append("late-append", [
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 3, tool: "Edit", path: "after.ts", excerpt: "test: pass" },
  ], paths);
  release?.();
  const triple = await annotation;

  assert.ok(triple);
  assert.deepEqual(triple.mechanism.files.map((file) => file.path), ["before.css"]);
  assert.deepEqual(readBatch("late-append", paths).map((event) => event.kind === "mechanism" ? event.path : event.kind), ["after.ts"]);
});

test("orphan claim replay reuses one deterministic triple identity", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-replay-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const claimName = "replay.claim." + "a".repeat(32) + ".jsonl";
    const claimPath = join(paths.spoolDir, claimName);
    mkdirSync(paths.spoolDir, { recursive: true });
    const content = [
      { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "replay this" },
      { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "replay.ts", excerpt: "test: pass" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const old = new Date(Date.now() - 11 * 60 * 1000);
    writeFileSync(claimPath, content, { mode: 0o600 });
    utimesSync(claimPath, old, old);

    await annotateCommand("replay");
    const first = loadMemory(paths.memory).filter((record) => record.kind === "triple");
    assert.equal(first.length, 1);
    const firstId = first[0]?.id;
    assert.equal(readFileSync(paths.labels, "utf8").split("\n").filter(Boolean).length, 2);

    writeFileSync(claimPath, content, { mode: 0o600 });
    utimesSync(claimPath, old, old);
    await annotateCommand("replay");
    const records = loadMemory(paths.memory).filter((record) => record.kind === "triple");
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, firstId);
    assert.equal(readFileSync(paths.labels, "utf8").split("\n").filter(Boolean).length, 2);
    assert.equal(existsSync(claimPath), false);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
});

test("orphan claim recovery detaches a same-inode live path before annotation", async (t) => {
  const paths = freshPaths(t);
  const key = "orphan-hardlink";
  append(key, [
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: paths.home, text: "recover orphan" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "orphan.ts", excerpt: "test: pass" },
  ], paths);
  const live = join(paths.spoolDir, `${key}.jsonl`);
  const claimPath = join(paths.spoolDir, `${key}.claim.${"c".repeat(32)}.jsonl`);
  try {
    linkSync(live, claimPath);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(live, old, old);
  utimesSync(claimPath, old, old);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = paths.home;
  try {
    const claim = listOrphanClaims(Date.now(), paths)[0];
    assert.ok(claim);
    const triple = await annotateBatch(key, { paths, claim, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
  assert.equal(existsSync(live), false);
  assert.equal(existsSync(claimPath), false);
});

test("recordTriple round-trips without cmd through an explicitly injected memory path", (t) => {
  const paths = freshPaths(t);
  const record = recordTriple({
    ts: 7,
    cwd: "/w",
    agent: "codex",
    intent: { text: "make test pass" },
    mechanism: { files: [], truncatedFiles: 0 },
  }, paths);

  const loaded = loadMemory(paths.memory);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], record);
  assert.equal("cmd" in record, false);
});

test("recordTripleOnce recovers a stale zero-byte lock left before metadata", (t) => {
  const paths = freshPaths(t);
  const lock = `${paths.memory}.triple.lock`;
  writeFileSync(lock, "", { mode: 0o600 });
  const stale = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(lock, stale, stale);

  const result = recordTripleOnce({
    agent: "codex",
    cwd: paths.home,
    mechanism: { files: [{ path: "stale.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
  }, "stale-empty-lock", paths);

  assert.equal(result.appended, true);
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
  assert.equal(existsSync(lock), false);
});

test("recordTripleOnce keeps a fresh zero-byte lock busy", (t) => {
  const paths = freshPaths(t);
  const lock = `${paths.memory}.triple.lock`;
  writeFileSync(lock, "", { mode: 0o600 });
  const originalNow = Date.now;
  const base = originalNow();
  let first = true;
  Date.now = () => first ? (first = false, base) : base + 6_000;
  try {
    assert.throws(() => recordTripleOnce({
      agent: "codex",
      cwd: paths.home,
      mechanism: { files: [{ path: "fresh.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
    }, "fresh-empty-lock", paths), /triple lock is busy/u);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(existsSync(lock), true);
  assert.equal(existsSync(paths.memory), false);
});

test("recordTripleOnce keeps stale malformed triple lock fail-closed", (t) => {
  const paths = freshPaths(t);
  const lock = `${paths.memory}.triple.lock`;
  writeFileSync(lock, "not-owner-metadata", { mode: 0o600 });
  const stale = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(lock, stale, stale);
  const originalNow = Date.now;
  const base = originalNow();
  let first = true;
  Date.now = () => first ? (first = false, base) : base + 6_000;
  try {
    assert.throws(() => recordTripleOnce({
      agent: "codex",
      cwd: paths.home,
      mechanism: { files: [{ path: "malformed.ts", plusMinus: [1, 1], props: [] }], truncatedFiles: 0 },
    }, "malformed-triple-lock", paths), /triple lock is busy/u);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(readFileSync(lock, "utf8"), "not-owner-metadata");
  assert.equal(existsSync(paths.memory), false);
});

test("recordTripleOnce serializes check and append across processes", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-triple-once-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "memory.js");
  const gateDir = join(home, "gates");
  const start = join(home, "start");
  const release = join(home, "release");
  mkdirSync(gateDir);
  writeFileSync(join(home, "memory.jsonl"), "", { mode: 0o600 });
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "const [modulePath, home, gateDir, startPath, releasePath] = process.argv.slice(1);",
    "const originalOpen = fs.openSync.bind(fs);",
    "const originalRead = fs.readFileSync.bind(fs);",
    "let memoryFd;",
    "let gated = false;",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (String(path).endsWith('memory.jsonl')) memoryFd = fd; return fd; };",
    "fs.readFileSync = (path, ...args) => { const isMemory = typeof path === 'number' ? path === memoryFd : String(path).endsWith('memory.jsonl'); if (!gated && isMemory) { gated = true; fs.writeFileSync(`${gateDir}/${process.pid}.gate`, 'gate'); const signal = new Int32Array(new SharedArrayBuffer(4)); while (!fs.existsSync(releasePath)) Atomics.wait(signal, 0, 0, 10); } return originalRead(path, ...args); };",
    "syncBuiltinESMExports();",
    "const { recordTripleOnce } = await import(pathToFileURL(modulePath).href);",
    "fs.writeFileSync(`${gateDir}/${process.pid}.ready`, 'ready');",
    "while (!fs.existsSync(startPath)) Atomics.wait(signal, 0, 0, 10);",
    "recordTripleOnce({ agent: 'codex', cwd: home, mechanism: { files: [{ path: 'a.ts', plusMinus: [1, 1], props: [] }], truncatedFiles: 0 } }, 'shared-claim', { home, memory: `${home}/memory.jsonl` });",
  ].join("\n");
  const children = [0, 1].map(() => spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, modulePath, home, gateDir, start, release,
  ], { stdio: ["pipe", "pipe", "pipe"] }));
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  for (const child of children) await waitForMarker(join(gateDir, `${child.pid}.ready`));
  writeFileSync(start, "go");
  await Promise.race(children.map((child) => waitForMarker(join(gateDir, `${child.pid}.gate`))));
  const observationDeadline = Date.now() + 500;
  let gateCount = 0;
  while (Date.now() < observationDeadline) {
    gateCount = readdirSync(gateDir).filter((name) => name.endsWith(".gate")).length;
    if (gateCount > 1) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  gateCount = readdirSync(gateDir).filter((name) => name.endsWith(".gate")).length;
  assert.equal(existsSync(release), false);
  assert.equal(gateCount, 1, "second worker reached memory read before release");
  writeFileSync(release, "go");
  const results = await Promise.all(children.map((child) => new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  })));
  assert.deepEqual(results, [0, 0]);
  assert.equal(loadMemory(join(home, "memory.jsonl")).filter((record) => record.kind === "triple").length, 1);
});

test("crash after durable triple and label replays claim without duplicate record or label", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-crash-replay-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  append("crashed", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: home, text: "recover crash" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "replay.ts", excerpt: "test: pass" },
  ], paths);
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "annotate.js");
  const statePath = join(dirname(modulePath), "..", "core", "state-paths.js");
  const workerScript = [
    "import { writeFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "const [annotatePath, statePath, key, home] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const { annotateBatch } = await import(pathToFileURL(annotatePath).href);",
    "const { resolveRockyPaths } = await import(pathToFileURL(statePath).href);",
    "await annotateBatch(key, { paths: resolveRockyPaths(), git: () => undefined, queueLabel: (line) => { writeFileSync(`${home}/labels`, `${line}\\n`, { mode: 0o600 }); process.exit(0); } });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, modulePath, statePath, "crashed", home,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
  assert.equal(readdirSync(paths.spoolDir).filter((name) => name.startsWith("crashed.claim.")).length, 1);

  const firstId = loadMemory(paths.memory).find((record) => record.kind === "triple")?.id;
  const recoveryTime = new Date(Date.now() - 11 * 60 * 1000);
  for (const name of readdirSync(paths.spoolDir)) {
    if (name.startsWith("crashed.claim.") || name === "crashed.lock") {
      utimesSync(join(paths.spoolDir, name), recoveryTime, recoveryTime);
    }
  }
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    await annotateCommand("crashed");
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  const records = loadMemory(paths.memory).filter((record) => record.kind === "triple");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, firstId);
  assert.equal(readdirSync(paths.spoolDir).some((name) => name.startsWith("crashed.claim.")), false);
  assert.equal(readFileSync(paths.labels, "utf8").split("\n").filter(Boolean).length, 2);
});

test("intent-only and rationale-only batches clear without memory or labels", async (t) => {
  const paths = freshPaths(t);
  const labels: string[] = [];
  append("intent-only", [{ v: 1, agent: "codex", kind: "intent", ts: 1, text: "just thinking" }], paths);
  append("rationale-only", [{ v: 1, agent: "codex", kind: "rationale", ts: 2, source: "notify", text: "done" }], paths);

  assert.equal(await annotateBatch("intent-only", { paths, queueLabel: (line) => labels.push(line) }), undefined);
  assert.equal(await annotateBatch("rationale-only", { paths, queueLabel: (line) => labels.push(line) }), undefined);
  assert.equal(loadMemory(paths.memory).length, 0);
  assert.equal(labels.length, 0);
  assert.equal(readBatch("intent-only", paths).length, 0);
  assert.equal(readBatch("rationale-only", paths).length, 0);
});

test("mechanisms dedupe by path, retain latest event, cap files, and retain latest rationale", async (t) => {
  const paths = freshPaths(t);
  const events: AgentEvent[] = [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, text: "change styles" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "a.css", excerpt: "old: 1" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 3, tool: "Edit", path: "a.css", excerpt: "aa: 1 bb: 2 cc: 3 dd: 4 ee: 5 ff: 6 aa: 7" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 4, source: "transcript", text: "first rationale" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 5, source: "notify", text: "latest rationale" },
  ];
  for (let i = 0; i < 10; i += 1) {
    events.push({ v: 1, agent: "claude-code", kind: "mechanism", ts: 10 + i, tool: "Edit", path: `file-${i}.ts`, excerpt: `prop-${i}: value` });
  }
  append("many", events, paths);

  const triple = await annotateBatch("many", { paths, git: () => "invalid numstat", queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 8);
  assert.equal(triple.mechanism.truncatedFiles, 3);
  assert.deepEqual(triple.mechanism.files[0], {
    path: "a.css",
    plusMinus: [0, 0],
    props: ["aa", "bb", "cc", "dd", "ee"],
    excerpt: "aa: 1 bb: 2 cc: 3 dd: 4 ee: 5 ff: 6 aa: 7",
  });
  assert.equal(triple.mechanism.files[1]?.path, "file-0.ts");
  assert.equal(triple.rationale?.text, "latest rationale");
  assert.equal(triple.rationale?.source, "notify");
});

test("git failures omit head, fall back to zero numstat, and guard every path with --", async (t) => {
  const paths = freshPaths(t);
  seedBatch(paths, "git-fail");
  const calls: string[][] = [];
  const triple = await annotateBatch("git-fail", {
    paths,
    git: (args) => {
      calls.push(args);
      return undefined;
    },
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.head, undefined);
  assert.deepEqual(triple.mechanism.files[0]?.plusMinus, [0, 0]);
  assert.ok(calls.some((args) => args[0] === "diff" && args[1] === "--numstat" && args[2] === "--" && args[3] === "src/app.css"));
});

test("mechanism paths are redacted and control-stripped before durable write", async (t) => {
  const paths = freshPaths(t);
  const gitPaths: string[] = [];
  append("path-redact", [
    { v: 1, agent: "codex", kind: "mechanism", ts: 1, tool: "Edit", path: "src/sk-ant-abcdefghijklmnopqrst123\u001b[31m\u202e.ts", excerpt: "color: red" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/sk-ant-abcdefghijklmnopqrst456.ts", excerpt: "background: blue" },
  ], paths);
  const triple = await annotateBatch("path-redact", {
    paths,
    git: (args) => {
      if (args[0] === "diff") gitPaths.push(args[3] ?? "");
      return undefined;
    },
  });
  assert.ok(triple);
  assert.equal(triple.mechanism.files.length, 2);
  const pathsOnDisk = triple.mechanism.files.map((file) => file.path);
  assert.deepEqual(pathsOnDisk, ["src/[redacted anthropic key].ts", "src/[redacted anthropic key].ts"]);
  assert.equal(pathsOnDisk.every((path) => /[\r\n\u0000-\u001f\u007f\u001b\u202e]/u.test(path) === false), true);
  assert.deepEqual(gitPaths, [
    "src/sk-ant-abcdefghijklmnopqrst123.ts",
    "src/sk-ant-abcdefghijklmnopqrst456.ts",
  ]);
});

test("C0-obfuscated secrets are removed before durable redaction in every text field", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-\u0000ant-abcdefghijklmnopqrst123";
  append("control-secret", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, text: `plan\ntext ${token}` },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: `src/${token}.ts`, excerpt: `color: ${token}` },
    { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: `why ${token}` },
  ], paths);

  const triple = await annotateBatch("control-secret", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple.intent?.text, "plan text [redacted anthropic key]");
  assert.equal(triple.rationale?.text, "why [redacted anthropic key]");
  assert.equal(triple.mechanism.files[0]?.path, "src/[redacted anthropic key].ts");
  assert.equal(triple.mechanism.files[0]?.excerpt, "color: [redacted anthropic key]");
  const durable = JSON.stringify(triple);
  assert.doesNotMatch(durable, /sk-\s*ant-/u);
  assert.doesNotMatch(durable, /abcdefghijklmnopqrst123/u);
  assert.doesNotMatch(durable, /[\u0000-\u001f\u007f\u001b\u202e]/u);
});

test("every invisible format control is removed before durable redaction", async (t) => {
  const paths = freshPaths(t);
  for (const [name, control] of INVISIBLE_FORMAT_CONTROLS) {
    const key = `format-${name.slice(2)}`;
    const token = `sk-${control}ant-abcdefghijklmnopqrst123`;
    append(key, [
      { v: 1, agent: "codex", kind: "intent", ts: 1, text: `plan ${token}` },
      { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: `src/${token}.ts`, excerpt: `color: ${token}` },
      { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: `why ${token}` },
    ], paths);

    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple, name);
    assert.equal(triple?.intent?.text, "plan [redacted anthropic key]", name);
    assert.equal(triple?.rationale?.text, "why [redacted anthropic key]", name);
    assert.equal(triple?.mechanism.files[0]?.path, "src/[redacted anthropic key].ts", name);
    assert.equal(triple?.mechanism.files[0]?.excerpt, "color: [redacted anthropic key]", name);
    assert.doesNotMatch(JSON.stringify(triple), /sk-ant-|abcdefghijklmnopqrst123/u, name);
  }
});

test("durable annotation redacts a token after visible text and an invisible control", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  append("durable-prefix", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, text: `prefix\u061C${token}` },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.ts", excerpt: "value: 1" },
    { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: "why" },
  ], paths);

  const triple = await annotateBatch("durable-prefix", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple?.intent?.text, "prefix[redacted anthropic key]");
  assert.doesNotMatch(JSON.stringify(triple), /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("durable annotation scrubs a recognizable fragment exposed by the ingress cap", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  append("durable-cap", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, text: `${"\u061C".repeat(1980)}${token}` },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.ts", excerpt: "value: 1" },
    { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: "why" },
  ], paths);

  const triple = await annotateBatch("durable-cap", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.doesNotMatch(JSON.stringify(triple), /sk-ant-|abcdefghijklmnopqrst123/u);
});

test("durable annotation keeps C0 and ANSI boundary removals redacted", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  for (const [name, control] of [["c0", "\u0000"], ["ansi", "\u001b[31m"]] as const) {
    const key = `durable-boundary-${name}`;
    const candidate = `prefix${control}${token}`;
    append(key, [
      { v: 1, agent: "codex", kind: "intent", ts: 1, text: candidate },
      { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.ts", excerpt: "value: 1" },
      { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: "why" },
    ], paths);

    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple, name);
    assert.equal(triple?.intent?.text, "prefix[redacted anthropic key]", name);
    assert.doesNotMatch(JSON.stringify(triple), /sk-ant-|abcdefghijklmnopqrst123|\u001b|\u0000/u, name);
  }
});

test("durable annotation consumes ANSI payloads before redacting adjacent secrets", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["c1-csi", `prefix\u009b31m${token}`],
    ["c1-ss2", `prefix\u008em${token}`],
    ["c1-ss3", `prefix\u008fm${token}`],
    ["esc-ss2", `prefix\u001bNm${token}`],
    ["esc-ss3", `prefix\u001bOm${token}`],
    ["esc-dcs", `prefix\u001bP31m\u001b\\${token}`],
    ["esc-sos", `prefix\u001bX31m\u001b\\${token}`],
    ["esc-pm", `prefix\u001b^31m\u001b\\${token}`],
    ["esc-apc", `prefix\u001b_31m\u001b\\${token}`],
    ["c1-osc", `prefix\u009d31m\u009c${token}`],
    ["c1-dcs", `prefix\u009031m\u009c${token}`],
    ["c1-sos", `prefix\u009831m\u009c${token}`],
    ["c1-pm", `prefix\u009e31m\u009c${token}`],
    ["c1-apc", `prefix\u009f31m\u009c${token}`],
  ];

  for (const [name, candidate] of cases) {
    const key = `durable-ansi-payload-${name}`;
    append(key, [
      { v: 1, agent: "codex", kind: "intent", ts: 1, text: candidate },
      { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.ts", excerpt: "value: 1" },
      { v: 1, agent: "codex", kind: "rationale", ts: 3, source: "notify", text: "why" },
    ], paths);

    const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
    assert.ok(triple, name);
    assert.equal(triple?.intent?.text, "prefix[redacted anthropic key]", name);
    assert.doesNotMatch(JSON.stringify(triple), /sk-ant-|abcdefghijklmnopqrst123|31m|\u001b|[\u008e\u008f\u009b]/u, name);
  }
});

test("durable annotation consumes DCS payload through BEL until ST", async (t) => {
  const paths = freshPaths(t);
  const token = "sk-ant-abcdefghijklmnopqrst123";
  const key = "durable-dcs-bel";
  append(key, [
    { v: 1, agent: "codex", kind: "intent", ts: 1, text: `prefix\u009031m\u0007${token}\u009c` },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.ts", excerpt: "value: 1" },
  ], paths);

  const triple = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple?.intent?.text, "prefix");
  assert.doesNotMatch(JSON.stringify(triple), /31m|sk-ant-|abcdefghijklmnopqrst123|\u0090|\u009c/u);
});

test("mixed-agent batches use the first valid agent and ignore mismatched evidence", async (t) => {
  const paths = freshPaths(t);
  append("mixed-agent", [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, text: "claude intent" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "codex.ts", excerpt: "codex: x" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 3, tool: "Edit", path: "claude.ts", excerpt: "claude: x" },
    { v: 1, agent: "codex", kind: "rationale", ts: 4, source: "notify", text: "codex rationale" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 5, source: "transcript", text: "claude rationale" },
  ], paths);

  const triple = await annotateBatch("mixed-agent", { paths, git: () => undefined, queueLabel: () => {} });
  assert.ok(triple);
  assert.equal(triple.agent, "claude-code");
  assert.deepEqual(triple.mechanism.files.map((file) => file.path), ["claude.ts"]);
  assert.equal(triple.rationale?.text, "claude rationale");
});

test("whitespace/control-only operational cwd falls back to process.cwd", async (t) => {
  const paths = freshPaths(t);
  const seenCwds: string[] = [];
  append("cwd-fallback", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: "\u0000\n\t\u202e", text: "keep intent" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "a.ts", excerpt: "test: pass" },
  ], paths);

  const triple = await annotateBatch("cwd-fallback", {
    paths,
    git: (_args, cwd) => {
      seenCwds.push(cwd);
      return undefined;
    },
    queueLabel: () => {},
  });
  assert.ok(triple);
  assert.equal(triple.cwd, process.cwd());
  assert.ok(seenCwds.length > 0);
  assert.equal(seenCwds.every((cwd) => cwd === process.cwd()), true);
});

test("a throwing label queue cannot prevent cleanup after durable append", async (t) => {
  const paths = freshPaths(t);
  seedBatch(paths, "queue-throw");
  const triple = await annotateBatch("queue-throw", {
    paths,
    git: () => undefined,
    queueLabel: () => { throw new Error("label unavailable"); },
  });
  assert.ok(triple);
  assert.equal(loadMemory(paths.memory).length, 1);
  assert.equal(readBatch("queue-throw", paths).length, 0);
});

test("memory failure leaves evidence recoverable and does not remove batch", async (t) => {
  const paths = freshPaths(t);
  seedBatch(paths, "memory-fail");
  mkdirSync(paths.memory, { recursive: true });
  await assert.rejects(
    annotateBatch("memory-fail", { paths, git: () => undefined }),
  );
  assert.equal(readBatch("memory-fail", paths).length, 3);
});

test("short claim read leaves durable evidence and writes no triple", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-short-read-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const key = "short-read";
  seedBatch(paths, key);
  const originalBytes = readFileSync(join(paths.spoolDir, `${key}.jsonl`));
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "annotate.js");
  const statePath = join(dirname(modulePath), "..", "core", "state-paths.js");
  const resultPath = join(home, "result.json");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "const [annotatePath, statePath, key, home, resultPath] = process.argv.slice(1);",
    "process.env.ROCKY_HOME = home;",
    "const { annotateBatch } = await import(pathToFileURL(annotatePath).href);",
    "const { resolveRockyPaths } = await import(pathToFileURL(statePath).href);",
    "const originalRead = fs.readSync.bind(fs);",
    "const originalFstat = fs.fstatSync.bind(fs);",
    "let shortRead = false;",
    "fs.readSync = (fd, ...args) => { if (!shortRead && originalFstat(fd).size > 192) { shortRead = true; return 0; } return originalRead(fd, ...args); };",
    "syncBuiltinESMExports();",
    "const paths = resolveRockyPaths();",
    "const result = await annotateBatch(key, { paths, git: () => undefined, queueLabel: () => {} });",
    "fs.writeFileSync(resultPath, JSON.stringify({ result: result === undefined ? 'undefined' : 'record', shortRead, files: fs.readdirSync(paths.spoolDir) }), { mode: 0o600 });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, modulePath, statePath, key, home, resultPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const completion = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.equal(completion.code, 0, completion.stderr);
  const workerResult = JSON.parse(readFileSync(resultPath, "utf8")) as { result: string; shortRead: boolean; files: string[] };
  assert.equal(workerResult.result, "undefined");
  assert.equal(workerResult.shortRead, true);
  assert.equal(workerResult.files.filter((name) => name.startsWith(`${key}.claim.`)).length, 1);
  assert.equal(workerResult.files.includes(`${key}.jsonl`), false);
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 0);
  const claimName = readdirSync(paths.spoolDir).find((name) => name.startsWith(`${key}.claim.`));
  assert.ok(claimName);
  assert.deepEqual(readFileSync(join(paths.spoolDir, claimName)), originalBytes);
});

test("degradedLabel uses exact rocky voice and strips terminal injection", () => {
  assert.equal(
    degradedLabel("naikin dikit", [{ path: "src/app.css", plusMinus: [3, 1], props: ["margin-top"] }]),
    'you say "naikin dikit". it is margin-top. I think. check, question',
  );
  const unsafe = degradedLabel("bad\n\u001b[31mthing\u202e", [{ path: "src/app.css", plusMinus: [0, 0], props: [] }]);
  assert.ok(unsafe);
  assert.equal(/[\r\n\u001b\u202e]/u.test(unsafe), false);
  assert.equal(degradedLabel(undefined, []), undefined);
});

test("default label queue rejects symlink and non-regular destinations", (t) => {
  const paths = freshPaths(t);
  mkdirSync(paths.home, { recursive: true });
  const target = join(paths.home, "target-labels");
  writeFileSync(target, "keep\n", "utf8");
  try {
    symlinkSync(target, paths.labels);
  } catch {
    // Symlinks may be unavailable on a restricted Windows runner.
  }
  if (existsSync(paths.labels) && lstatSync(paths.labels).isSymbolicLink()) {
    defaultQueueLabel("unsafe\nline", paths);
    assert.equal(readFileSync(target, "utf8"), "keep\n");
    rmSync(paths.labels, { force: true });
  }
  mkdirSync(paths.labels, { recursive: true });
  defaultQueueLabel("must not write directory", paths);
  assert.equal(lstatSync(paths.labels).isDirectory(), true);
});

test("default label queue keeps exactly the last ten safe one-line labels", (t) => {
  const paths = freshPaths(t);
  for (let i = 0; i < 12; i += 1) defaultQueueLabel(`safe-${i}`, paths);
  defaultQueueLabel("hostile\n\u001b[31mline\u202e", paths);

  const lines = readFileSync(paths.labels, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 10);
  assert.equal(lines[0], "safe-3");
  assert.equal(lines.at(-1), "hostile line");
  assert.equal(/[\r\n\u001b\u202e]/u.test(lines.join("")), false);
  assert.equal(lstatSync(paths.labels).isFile(), true);
});

test("triple parser validates complete subfields and skips unknown lines between known records", () => {
  const valid = {
    kind: "triple",
    id: "t1",
    ts: 1,
    cwd: "/w",
    schemaV: 1,
    agent: "claude-code",
    origin: "agent-hook",
    mechanism: { files: [{ path: "a.ts", plusMinus: [1, 2], props: ["x"], excerpt: "x: y" }], truncatedFiles: 0 },
  };
  assert.ok(parseMemoryRecord(valid));
  assert.equal(parseMemoryRecord({ ...valid, schemaV: 2 }), undefined);
  assert.equal(parseMemoryRecord({ ...valid, origin: "run" }), undefined);
  assert.equal(parseMemoryRecord({ ...valid, agent: "other" }), undefined);
  assert.equal(parseMemoryRecord({ ...valid, mechanism: { files: [{ path: "a.ts", plusMinus: [1, Infinity], props: ["x"] }], truncatedFiles: 0 } }), undefined);
  assert.equal(parseMemoryRecord({ ...valid, mechanism: { files: [{ path: "a.ts", plusMinus: [1, 2], props: [3] }], truncatedFiles: 0 } }), undefined);
  assert.equal(parseMemoryRecord({ ...valid, rationale: { text: "why", tags: [], source: "unknown" } }), undefined);
  assert.equal(parseMemoryRecord({ kind: "hologram", id: "h", ts: 1, cwd: "/w" }), undefined);
});

test("annotateCommand locks duplicate requests, sweeps stale orphans, and returns zero", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-command-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  append("requested", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, text: "make tests pass" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "a.ts", excerpt: "test: pass" },
  ], paths);
  append("orphan", [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, text: "clean orphan" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "b.ts", excerpt: "clean: pass" },
  ], paths);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(join(paths.spoolDir, "orphan.jsonl"), old, old);
  const original = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    const results = await Promise.all([
      annotateCommand("requested"),
      annotateCommand("requested"),
    ]);
    assert.deepEqual(results, [0, 0]);
  } finally {
    if (original === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = original;
  }
  const records = loadMemory(paths.memory);
  assert.equal(records.filter((record) => record.kind === "triple").length, 2);
  assert.equal(readBatch("requested", paths).length, 0);
  assert.equal(readBatch("orphan", paths).length, 0);
});

test("maybeQueueDigestHint queues once per week when recent intent exists", (t) => {
  const paths = freshPaths(t);
  const now = Date.now();
  seedDigestTriple(paths, now);

  maybeQueueDigestHint(paths, now);
  maybeQueueDigestHint(paths, now + 1_000);
  const first = readFileSync(paths.labels, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(first.length, 1);
  assert.ok(first[0]?.includes("rocky digest, question"));
  assert.equal(readFileSync(paths.digestHint, "utf8"), String(now));

  const next = now + 8 * 24 * 60 * 60 * 1_000;
  seedDigestTriple(paths, next);
  maybeQueueDigestHint(paths, next);
  assert.equal(readFileSync(paths.labels, "utf8").trim().split("\n").filter(Boolean).length, 2);
});

test("digest hint hardlink remains byte-identical and queues nothing", (t) => {
  const paths = freshPaths(t);
  const target = join(paths.home, "digest-target");
  writeFileSync(target, "keep-target", { mode: 0o600 });
  try {
    linkSync(target, paths.digestHint);
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  seedDigestTriple(paths, Date.now());
  maybeQueueDigestHint(paths, Date.now());
  assert.equal(readFileSync(target, "utf8"), "keep-target");
  assert.deepEqual(labelLines(paths), []);
});

test("digest hint rejects a marker hardlink replacement before open", { timeout: 15_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("atomic hardlink replacement is POSIX-only");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "rocky-digest-marker-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const now = Date.now();
  const stale = new Date(now - WEEK_MS);
  const sentinelPath = join(home, "sentinel");
  const replacementPath = join(home, "digest-hint.replacement");
  const resultPath = join(home, "child-result.json");
  writeFileSync(paths.digestHint, "stale marker", { mode: 0o600 });
  writeFileSync(sentinelPath, "sentinel bytes", { mode: 0o600 });
  utimesSync(paths.digestHint, stale, stale);
  utimesSync(sentinelPath, stale, stale);
  try {
    linkSync(sentinelPath, replacementPath);
    rmSync(replacementPath, { force: true });
  } catch {
    t.skip("hard links are unavailable");
    return;
  }
  seedDigestTriple(paths, now);

  const annotatePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "annotate.js");
  const statePath = join(dirname(annotatePath), "..", "core", "state-paths.js");
  const workerScript = [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "const [annotatePath, statePath, home, markerPath, sentinelPath, replacementPath, resultPath, now] = process.argv.slice(1);",
    "const originalLstat = fs.lstatSync.bind(fs);",
    "const originalLink = fs.linkSync.bind(fs);",
    "const originalRename = fs.renameSync.bind(fs);",
    "const safeMarkerStats = originalLstat(markerPath);",
    "let replaced = false;",
    "fs.lstatSync = (path, ...args) => {",
    "  const result = originalLstat(path, ...args);",
    "  if (String(path) !== markerPath) return result;",
    "  if (!replaced) {",
    "    replaced = true;",
    "    originalLink(sentinelPath, replacementPath);",
    "    originalRename(replacementPath, markerPath);",
    "  }",
    "  return safeMarkerStats;",
    "};",
    "syncBuiltinESMExports();",
    "const { maybeQueueDigestHint } = await import(pathToFileURL(annotatePath).href);",
    "const { resolveRockyPaths } = await import(pathToFileURL(statePath).href);",
    "maybeQueueDigestHint(resolveRockyPaths({ ROCKY_HOME: home }), Number(now));",
    "const labels = fs.existsSync(`${home}/labels`) ? fs.readFileSync(`${home}/labels`, 'utf8') : '';",
    "const target = fs.readFileSync(sentinelPath, 'utf8');",
    "fs.writeFileSync(resultPath, JSON.stringify({ replaced, labels, target }), { mode: 0o600 });",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval", workerScript, annotatePath, statePath, home,
    paths.digestHint, sentinelPath, replacementPath, resultPath, String(now),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const completion = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  assert.equal(completion.code, 0, completion.stderr);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as { replaced: boolean; labels: string; target: string };
  assert.equal(result.replaced, true);
  assert.equal(result.target, "sentinel bytes", JSON.stringify(result));
  assert.equal(result.labels, "", JSON.stringify(result));
});

test("digest hint symlink target remains byte-identical and queues nothing", (t) => {
  const paths = freshPaths(t);
  const target = join(paths.home, "digest-target");
  writeFileSync(target, "keep-target", { mode: 0o600 });
  try {
    symlinkSync(target, paths.digestHint);
  } catch {
    t.skip("symlinks are unavailable");
    return;
  }
  seedDigestTriple(paths, Date.now());
  maybeQueueDigestHint(paths, Date.now());
  assert.equal(readFileSync(target, "utf8"), "keep-target");
  assert.deepEqual(labelLines(paths), []);
});

test("digest hint FIFO returns bounded and queues nothing on POSIX", { timeout: 5_000 }, (t) => {
  if (process.platform === "win32") {
    t.skip("FIFO is POSIX-only");
    return;
  }
  const paths = freshPaths(t);
  const made = spawnSync("mkfifo", [paths.digestHint], { encoding: "utf8", windowsHide: true });
  if (made.error || made.status !== 0) {
    t.skip("mkfifo is unavailable");
    return;
  }
  seedDigestTriple(paths, Date.now());
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "annotate.js");
  const statePath = join(dirname(modulePath), "..", "core", "state-paths.js");
  const worker = [
    "import { pathToFileURL } from 'node:url';",
    "const [annotatePath, statePath, home, now] = process.argv.slice(1);",
    "const { maybeQueueDigestHint } = await import(pathToFileURL(annotatePath).href);",
    "const { resolveRockyPaths } = await import(pathToFileURL(statePath).href);",
    "maybeQueueDigestHint(resolveRockyPaths({ ROCKY_HOME: home }), Number(now));",
  ].join("\n");
  const result = spawnSync(process.execPath, [
    "--input-type=module", "--eval", worker, modulePath, statePath, paths.home, String(Date.now()),
  ], { encoding: "utf8", timeout: 1_000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(labelLines(paths), []);
});

test("digest hint marker commit failure queues nothing", (t) => {
  const paths = freshPaths(t);
  seedDigestTriple(paths, Date.now());
  const broken = { ...paths, digestHint: join(paths.home, "missing-parent", "digest-hint") };
  maybeQueueDigestHint(broken, Date.now());
  assert.deepEqual(labelLines(paths), []);
});

test("digest hint exact seven-day boundary is eligible once", (t) => {
  const paths = freshPaths(t);
  const now = Date.now();
  seedDigestTriple(paths, now);
  writeFileSync(paths.digestHint, "old", { mode: 0o600 });
  const old = new Date(now - WEEK_MS);
  utimesSync(paths.digestHint, old, old);
  maybeQueueDigestHint(paths, now);
  maybeQueueDigestHint(paths, now);
  assert.deepEqual(labelLines(paths), ["week of work in memory. rocky digest, question"]);
  assert.equal(readFileSync(paths.digestHint, "utf8"), String(now));
});

test("digest hint lease allows exactly one label across racing processes", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-digest-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  const now = Date.now();
  seedDigestTriple(paths, now);
  const start = join(home, "start");
  const readyDir = join(home, "ready");
  mkdirSync(readyDir);
  const modulePath = join(dirname(fileURLToPath(import.meta.url)), "..", "agent", "annotate.js");
  const statePath = join(dirname(modulePath), "..", "core", "state-paths.js");
  const worker = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { pathToFileURL } from 'node:url';",
    "const [annotatePath, statePath, home, start, ready, now] = process.argv.slice(1);",
    "const { maybeQueueDigestHint } = await import(pathToFileURL(annotatePath).href);",
    "const { resolveRockyPaths } = await import(pathToFileURL(statePath).href);",
    "writeFileSync(ready, 'ready');",
    "const signal = new Int32Array(new SharedArrayBuffer(4));",
    "while (!existsSync(start)) Atomics.wait(signal, 0, 0, 10);",
    "maybeQueueDigestHint(resolveRockyPaths({ ROCKY_HOME: home }), Number(now));",
  ].join("\n");
  const children = [0, 1].map((index) => spawn(process.execPath, [
    "--input-type=module", "--eval", worker, modulePath, statePath, home, start,
    join(readyDir, `${index}`), String(now),
  ], { stdio: ["ignore", "pipe", "pipe"] }));
  t.after(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  for (const index of [0, 1]) await waitForMarker(join(readyDir, `${index}`));
  writeFileSync(start, "go");
  const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr: Buffer.concat(stderr).toString("utf8") }));
  })));
  assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join("\n"));
  assert.deepEqual(labelLines(paths), ["week of work in memory. rocky digest, question"]);
  assert.equal(readFileSync(paths.digestHint, "utf8"), String(now));
});

test("hidden _annotate dispatch is silent and uses scratch home", (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const paths = resolveRockyPaths({ ROCKY_HOME: home });
  append("cli-key", [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, text: "run tests" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "src/test.ts", excerpt: "test: pass" },
  ], paths);
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entry = join(packageRoot, "dist", "index.js");
  const result = spawnSync(process.execPath, [entry, "_annotate", "cli-key"], {
    cwd: packageRoot,
    env: { ...process.env, ROCKY_HOME: home },
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(loadMemory(paths.memory).filter((record) => record.kind === "triple").length, 1);
});

function deterministicFields(record: NonNullable<Awaited<ReturnType<typeof annotateBatch>>>): unknown {
  const { id: _id, ts: _ts, rationale: _rationale, ...rest } = record;
  return rest;
}

function aiSeed(paths: RockyPaths, key: string): void {
  append(key, [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, cwd: "/workspace", text: "change spacing" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.css", excerpt: "margin-top: 8px" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 3, source: "transcript", text: "agent rationale" },
  ], paths);
}

test("AI success changes only compacted rationale, tags, and valid queued label", async (t) => {
  const degradedPaths = freshPaths(t);
  const aiPaths = freshPaths(t);
  aiSeed(degradedPaths, "degraded");
  aiSeed(aiPaths, "ai");
  const degradedLabels: string[] = [];
  const aiLabels: string[] = [];
  const fake: AnnotatePort = {
    async run(input, signal) {
      assert.equal(input.intent, "change spacing");
      assert.equal(input.rationaleRaw, "agent rationale");
      assert.deepEqual(input.files, [{ path: "src/app.css", excerpt: "margin-top: 8px" }]);
      assert.equal(signal.aborted, false);
      return { summary: "compact rationale", tags: ["spacing"], label: "spacing, question" };
    },
  };
  const degraded = await annotateBatch("degraded", {
    paths: degradedPaths,
    now: () => 7,
    git: () => undefined,
    queueLabel: (line) => degradedLabels.push(line),
  });
  const ai = await annotateBatch("ai", {
    paths: aiPaths,
    now: () => 7,
    git: () => undefined,
    ai: fake,
    queueLabel: (line) => aiLabels.push(line),
  });
  assert.ok(degraded);
  assert.ok(ai);
  assert.deepEqual(deterministicFields(ai), deterministicFields(degraded));
  assert.deepEqual(ai.rationale, { text: "compact rationale", tags: ["spacing"], source: "transcript" });
  assert.deepEqual(aiLabels, ["spacing, question"]);
  assert.equal(degradedLabels.length, 1);
});

test("throwing and undefined AI ports produce exact degraded rationale, tags, and label", async (t) => {
  const throwingPaths = freshPaths(t);
  const undefinedPaths = freshPaths(t);
  aiSeed(throwingPaths, "throwing");
  aiSeed(undefinedPaths, "undefined");
  const expectedLabels: string[] = [];
  const throwing: AnnotatePort = { async run() { throw new Error("offline"); } };
  const absent: AnnotatePort = { async run() { return undefined; } };
  const throwingResult = await annotateBatch("throwing", {
    paths: throwingPaths,
    now: () => 7,
    git: () => undefined,
    ai: throwing,
    queueLabel: (line) => expectedLabels.push(line),
  });
  const undefinedResult = await annotateBatch("undefined", {
    paths: undefinedPaths,
    now: () => 7,
    git: () => undefined,
    ai: absent,
    queueLabel: (line) => expectedLabels.push(line),
  });
  assert.ok(throwingResult);
  assert.ok(undefinedResult);
  assert.equal(throwingResult.rationale?.text, "agent rationale");
  assert.deepEqual(throwingResult.rationale?.tags, []);
  assert.equal(undefinedResult.rationale?.text, "agent rationale");
  assert.deepEqual(undefinedResult.rationale?.tags, []);
  assert.equal(expectedLabels.length, 2);
  assert.match(expectedLabels[0] ?? "", /you say/);
  assert.equal(expectedLabels[0], expectedLabels[1]);
});

test("invalid or voice-breaking AI label falls back while valid summary and tags remain usable", async (t) => {
  const paths = freshPaths(t);
  aiSeed(paths, "invalid-label");
  const labels: string[] = [];
  const fake: AnnotatePort = {
    async run() { return { summary: "compact", tags: ["spacing"], label: "the thing?" }; },
  };
  const result = await annotateBatch("invalid-label", {
    paths,
    ai: fake,
    git: () => undefined,
    queueLabel: (line) => labels.push(line),
  });
  assert.ok(result);
  assert.equal(result.rationale?.text, "compact");
  assert.deepEqual(result.rationale?.tags, ["spacing"]);
  assert.equal(labels.length, 1);
  assert.match(labels[0] ?? "", /^you say /);
  assert.doesNotMatch(labels[0] ?? "", /the thing\?/u);
});

test("AI may queue a valid label but never invent a rationale event", async (t) => {
  const paths = freshPaths(t);
  append("no-rationale-ai", [
    { v: 1, agent: "codex", kind: "intent", ts: 1, cwd: "/workspace", text: "change spacing" },
    { v: 1, agent: "codex", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.css", excerpt: "margin-top: 8px" },
  ], paths);
  const labels: string[] = [];
  const fake: AnnotatePort = {
    async run(input) {
      assert.equal(input.rationaleRaw, undefined);
      return { summary: "invented summary must not store", tags: ["spacing"], label: "spacing, question" };
    },
  };
  const result = await annotateBatch("no-rationale-ai", { paths, ai: fake, git: () => undefined, queueLabel: (line) => labels.push(line) });
  assert.ok(result);
  assert.equal(result.rationale, undefined);
  assert.deepEqual(labels, ["spacing, question"]);
});

test("default AI config lookup uses injected paths.config and never an unrelated home", async (t) => {
  const paths = freshPaths(t);
  aiSeed(paths, "config-path");
  const seen: string[] = [];
  const configLoader = (path: string): ConfigLoadResult => {
    seen.push(path);
    return { status: "missing", path, config: { version: 1, ai: { enabled: false } } };
  };
  const labels: string[] = [];
  const result = await annotateBatch("config-path", {
    paths,
    loadConfig: configLoader,
    git: () => undefined,
    queueLabel: (line) => labels.push(line),
  });
  assert.ok(result);
  assert.deepEqual(seen, [paths.config]);
  assert.equal(labels.length, 1);
});
