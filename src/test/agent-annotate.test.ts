import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { annotateBatch, annotateCommand, defaultQueueLabel, degradedLabel } from "../agent/annotate.js";
import { appendEvent, readBatch } from "../agent/spool.js";
import type { AgentEvent } from "../agent/schema.js";
import { loadMemory, parseMemoryRecord, recordTriple } from "../core/memory.js";
import { resolveRockyPaths, type RockyPaths } from "../core/state-paths.js";

function freshPaths(t: TestContext): RockyPaths {
  const home = mkdtempSync(join(tmpdir(), "rocky-annotate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return resolveRockyPaths({ ROCKY_HOME: home });
}

function append(key: string, events: readonly AgentEvent[], paths: RockyPaths): void {
  for (const event of events) appendEvent(key, event, paths);
}

function seedBatch(paths: RockyPaths, key: string, rationale = "margin adds spacing"): void {
  append(key, [
    { v: 1, agent: "claude-code", kind: "intent", ts: 1, cwd: paths.home, text: "naikin dikit" },
    { v: 1, agent: "claude-code", kind: "mechanism", ts: 2, tool: "Edit", path: "src/app.css", excerpt: "margin-top: 8px" },
    { v: 1, agent: "claude-code", kind: "rationale", ts: 3, source: "transcript", text: rationale },
  ], paths);
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
