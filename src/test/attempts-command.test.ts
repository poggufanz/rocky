import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  attempts,
  formatAttemptChanges,
  formatAttemptOutcome,
  parseAttemptsArgs,
  renderProblemsText,
  sanitizeProblemEntry,
} from "../commands/attempts.js";
import { buildProblems, type Attempt, type AttemptOutcome, type ProblemEntry, type ProblemSet } from "../core/attempts.js";
import { commandIdentity } from "../core/fingerprint.js";
import { createMemoryQueries, loadDurableMemorySnapshot, type MemoryQueries } from "../core/memory-query.js";
import { canonicalPath, MEMORY_FORMAT_VERSION, type MemoryCoverage } from "../core/memory-read.js";
import { cardsFilePath } from "../listening/cards-path.js";
import { validateOutputLine } from "../ui/phrases.js";
import { causalWordViolations } from "./causal-words.js";
import { withRecordCap } from "./memory-cap-fixture.js";

const CWD = "/work/app";
const OTHER_CWD = "/work/other";
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0); // 2026-11-16 12:00 UTC

function sha16(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function freshHome(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "rocky-attempts-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const prev = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prev;
  });
  return home;
}

async function captureOutput(
  run: () => Promise<number>,
): Promise<{ code: number; stderr: string; stdout: string }> {
  const origStderr = process.stderr.write;
  const origStdout = process.stdout.write;
  let stderr = "";
  let stdout = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: await run(), stderr, stdout };
  } finally {
    process.stderr.write = origStderr;
    process.stdout.write = origStdout;
  }
}

function failureRecord(opts: {
  id: string;
  ts: number;
  cwd?: string;
  cmd?: string;
  fingerprint?: string;
  signature?: string[];
  resolvedBy?: string;
}): Record<string, unknown> {
  const cmd = opts.cmd ?? "npm test";
  const identity = commandIdentity(cmd, { platform: "linux" });
  return {
    kind: "failure",
    id: opts.id,
    ts: opts.ts,
    cwd: opts.cwd ?? CWD,
    cmd,
    exitCode: 1,
    fingerprint: opts.fingerprint ?? "3f2a9c1e44d0b7a1",
    fingerprintV: 2,
    signature: opts.signature ?? ["TypeError: token undefined"],
    excerpt: opts.signature?.[0] ?? "TypeError: token undefined",
    origin: "run",
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform: "linux",
    ...(opts.resolvedBy === undefined ? {} : { resolvedBy: opts.resolvedBy }),
  };
}

function fixRecord(opts: {
  id: string;
  ts: number;
  cwd?: string;
  cmd?: string;
  failureIds: string[];
}): Record<string, unknown> {
  const cmd = opts.cmd ?? "npm test";
  const identity = commandIdentity(cmd, { platform: "linux" });
  return {
    kind: "fix",
    id: opts.id,
    ts: opts.ts,
    cwd: opts.cwd ?? CWD,
    cmd,
    failureIds: opts.failureIds,
    commandIdentity: identity.value,
    identityV: 1,
    identityReliable: identity.reliable,
    platform: "linux",
  };
}

function rationaleRecord(opts: {
  id: string;
  ts: number;
  failureId: string;
  files: string[];
}): Record<string, unknown> {
  return {
    kind: "rationale",
    id: opts.id,
    ts: opts.ts,
    cwd: CWD,
    v: 1,
    agent: "claude-code",
    source: "notify",
    rationale_fidelity: "summary",
    excerpt: "check token guard",
    links: { failureId: opts.failureId },
    files: opts.files,
    platform: "linux",
  };
}

function seedDefaultListingMemory(home: string): string {
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 55);
  const t3 = Date.UTC(2026, 10, 12, 14, 3);
  const t4 = Date.UTC(2026, 10, 15, 9, 10);
  const lines = [
    failureRecord({ id: "f1", ts: t1, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1" }),
    rationaleRecord({ id: "r1", ts: t1 + 1000, failureId: "f1", files: ["src/auth.ts"] }),
    failureRecord({
      id: "f2",
      ts: t2,
      cmd: "npm test",
      fingerprint: "aaaa1111bbbb2222",
      signature: ["ReferenceError: session missing"],
    }),
    rationaleRecord({ id: "r2", ts: t2 + 1000, failureId: "f2", files: ["src/token.ts"] }),
    failureRecord({ id: "f3", ts: t3, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1", resolvedBy: "x1" }),
    rationaleRecord({ id: "r3", ts: t3 + 1000, failureId: "f3", files: ["src/session.ts"] }),
    fixRecord({ id: "x1", ts: t3 + 30_000, cmd: "npm test", failureIds: ["f3"] }),
    failureRecord({ id: "f4", ts: t4, cmd: "npm test -- auth", fingerprint: "3f2a9c1e44d0b7a1" }),
  ];
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
  return sha16(`output:3f2a9c1e44d0b7a1:${CWD}`);
}

test("snapshot: default listing", async (t) => {
  const home = freshHome(t);
  const problemId = seedDefaultListingMemory(home);
  assert.equal(problemId, "9a509759c962b731");

  const out = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );

  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(
    out.stderr,
    [
      "rocky: 1 repeated error in /work/app",
      "9a509759c962b731  TypeError: token undefined",
      "  2026-11-12 13:20  npm test          other error         said: edited src/auth.ts",
      "  2026-11-12 14:03  npm test          passed              said: edited src/session.ts",
      "  2026-11-15 09:10  npm test -- auth  no later run        changes unknown",
      "rocky: Rocky records order, not cause.",
      "",
    ].join("\n"),
  );
});

test("snapshot: tail header names newest window", async (t) => {
  withRecordCap(t, 4);
  const home = freshHome(t);
  const tOld = Date.UTC(2026, 9, 2, 8, 0);
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 55);
  const t3 = Date.UTC(2026, 10, 12, 14, 3);
  const lines = [
    failureRecord({ id: "old1", ts: tOld, fingerprint: "9999000011112222", signature: ["old error"] }),
    failureRecord({ id: "old2", ts: tOld + 1000, fingerprint: "9999000011112222", signature: ["old error"] }),
    failureRecord({ id: "f1", ts: t1, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1" }),
    failureRecord({ id: "f2", ts: t2, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1" }),
    failureRecord({ id: "f3", ts: t3, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1", resolvedBy: "x1" }),
    fixRecord({ id: "x1", ts: t3 + 30_000, cmd: "npm test", failureIds: ["f3"] }),
  ];
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

  const out = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );

  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(
    out.stderr,
    [
      "rocky: 1 repeated error in /work/app (newest 4 records, from 2026-11-12)",
      "9a509759c962b731  TypeError: token undefined",
      "  2026-11-12 13:20  npm test  failed same way     changes unknown",
      "  2026-11-12 13:55  npm test  failed same way     changes unknown",
      "  2026-11-12 14:03  npm test  passed              changes unknown",
      "rocky: Rocky records order, not cause.",
      "",
    ].join("\n"),
  );
});

test("snapshot: tail coverage with skipped lines discloses coverage", async (t) => {
  withRecordCap(t, 4);
  const home = freshHome(t);
  const tOld = Date.UTC(2026, 9, 2, 8, 0);
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 55);
  const lines = [
    JSON.stringify(failureRecord({ id: "old1", ts: tOld, fingerprint: "9999000011112222", signature: ["old error"] })),
    JSON.stringify(failureRecord({ id: "old2", ts: tOld + 1000, fingerprint: "9999000011112222", signature: ["old error"] })),
    JSON.stringify(failureRecord({ id: "old3", ts: tOld + 2000, fingerprint: "9999000011112222", signature: ["old error"] })),
    JSON.stringify(failureRecord({ id: "old4", ts: tOld + 3000, fingerprint: "9999000011112222", signature: ["old error"] })),
    JSON.stringify(failureRecord({ id: "f1", ts: t1, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1" })),
    "{bad json 1",
    JSON.stringify(failureRecord({ id: "f2", ts: t2, cmd: "npm test", fingerprint: "3f2a9c1e44d0b7a1" })),
    "{bad json 2",
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const out = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );

  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(
    out.stderr,
    [
      "rocky: 1 repeated error in /work/app (newest 2 records, from 2026-11-12)",
      "memory coverage incomplete: 2 lines could not be used. Only the newest 2 records were read; earlier lines were not read.",
      "9a509759c962b731  TypeError: token undefined",
      "  2026-11-12 13:20  npm test  failed same way     changes unknown",
      "  2026-11-12 13:55  npm test  unknown             changes unknown",
      "rocky: Rocky records order, not cause.",
      "",
    ].join("\n"),
  );
});

test("json is valid and versioned", async (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  const out = await captureOutput(() =>
    attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );

  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
  const payload = JSON.parse(out.stdout) as {
    v: number;
    coverage: MemoryCoverage;
    ungroupedLegacy: number;
    entries: ProblemEntry[];
  };
  assert.equal(payload.v, 1);
  assert.equal(typeof payload.ungroupedLegacy, "number");
  assert.equal(payload.entries.length, 1);
  assert.deepEqual(
    payload.entries[0]!.attempts.map((a) => a.outcome),
    ["different_failure", "passed", "no_later_run"],
  );
});

test("exit 2 on bad args", async (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  for (const bad of [
    ["--limit", "0"],
    ["--limit", "51"],
    ["--limit"],
    ["--nope"],
    ["--json", "--json"],
    ["--card", "x"],
  ]) {
    assert.throws(() => parseAttemptsArgs(bad), Error, bad.join(" "));
    const out = await captureOutput(() =>
      attempts(bad, { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
    );
    assert.equal(out.code, 2, bad.join(" "));
    assert.equal(out.stdout, "", bad.join(" "));
    assert.match(out.stderr, /^rocky: Invalid option for attempts\./, bad.join(" "));
  }
});

test("exit 1 when memory cannot be read", async (t) => {
  const home = freshHome(t);
  // A directory at memory.jsonl is a portable unreadable memory fixture that
  // exercises the real durable reader (read-race) via createMemoryQueries().
  mkdirSync(join(home, "memory.jsonl"), { recursive: true });

  const textOut = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(textOut.code, 1);
  assert.equal(textOut.stdout, "");
  assert.equal(textOut.stderr, "rocky: Memory cannot be read.\n");

  const jsonOut = await captureOutput(() =>
    attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(jsonOut.code, 1);
  assert.equal(jsonOut.stdout, "");
  assert.equal(jsonOut.stderr, "rocky: Memory cannot be read.\n");

  const nonDurable = {
    recall() { throw new Error("boom"); },
    recentFailures() { throw new Error("boom"); },
    stats() { throw new Error("boom"); },
    searchKnowledge() { throw new Error("boom"); },
    fetchRecord() { throw new Error("boom"); },
    whyFile() { throw new Error("boom"); },
    coverage() { throw new Error("boom"); },
  } as unknown as MemoryQueries;

  const fallbackOut = await captureOutput(() =>
    attempts([], { memory: nonDurable, now: NOW, cwd: CWD }),
  );
  assert.equal(fallbackOut.code, 1);
  assert.equal(fallbackOut.stdout, "");
  assert.equal(fallbackOut.stderr, "rocky: Memory cannot be read.\n");
});

test("exit 0 on empty memory", async (t) => {
  freshHome(t);

  const out = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );

  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
  assert.equal(
    out.stderr,
    "rocky: No repeated errors in /work/app.\nrocky: Rocky records order, not cause.\n",
  );
});

test("fingerprint query and text query both find the entry", async (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  const byFp = await captureOutput(() =>
    attempts(["3f2a9c1e44d0b7a1"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(byFp.code, 0);
  assert.match(byFp.stderr, /^rocky: 1 matching error in \/work\/app/m);
  assert.match(byFp.stderr, /TypeError: token undefined/);
  assert.match(byFp.stderr, /^rocky: Rocky records order, not cause\.$/m);

  const byText = await captureOutput(() =>
    attempts(["token", "undefined"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(byText.code, 0);
  assert.match(byText.stderr, /^rocky: 1 matching error in \/work\/app/m);
  assert.match(byText.stderr, /TypeError: token undefined/);
  assert.match(byText.stderr, /^rocky: Rocky records order, not cause\.$/m);
});

test("--all-dirs adds elsewhere entries", async (t) => {
  const home = freshHome(t);
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 25);
  const lines = [
    failureRecord({ id: "h1", ts: t1, cwd: CWD, fingerprint: "3f2a9c1e44d0b7a1" }),
    failureRecord({ id: "h2", ts: t2, cwd: CWD, fingerprint: "3f2a9c1e44d0b7a1" }),
    failureRecord({
      id: "e1",
      ts: t1,
      cwd: OTHER_CWD,
      fingerprint: "bbbb1111cccc2222",
      signature: ["SyntaxError: elsewhere"],
    }),
    failureRecord({
      id: "e2",
      ts: t2 + 1000,
      cwd: OTHER_CWD,
      fingerprint: "bbbb1111cccc2222",
      signature: ["SyntaxError: elsewhere"],
    }),
  ];
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

  const hereOnly = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(hereOnly.code, 0);
  assert.match(hereOnly.stderr, /^rocky: 1 repeated error in \/work\/app/m);
  assert.doesNotMatch(hereOnly.stderr, /elsewhere/);

  const allDirs = await captureOutput(() =>
    attempts(["--all-dirs"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(allDirs.code, 0);
  assert.match(allDirs.stderr, /^rocky: 2 repeated errors in all directories/m);
  assert.match(allDirs.stderr, /SyntaxError: elsewhere {2}\(in \/work\/other\)/);
});

test("hostile cmd, signature, and changes render safe in both stderr and JSON without mutating buildProblems", async (t) => {
  const home = freshHome(t);
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 25);
  const cmdSecret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const sigSecret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  const fileSecret = "ghp_zyxwvutsrqponmlkjihgfedcba0987654321";
  const hostileCmd = `npm\u001b[31m \u200btest \u202eevil ${cmdSecret}`;
  const hostileSig = `Error:\u001b[31m \u200bbad \u202esig ${sigSecret}`;
  const hostileFile = `src/\u001b[31m\u200b\u202e${fileSecret}.ts`;
  const lines = [
    failureRecord({ id: "h1", ts: t1, cmd: hostileCmd, signature: [hostileSig], fingerprint: "3f2a9c1e44d0b7a1" }),
    rationaleRecord({ id: "r1", ts: t1 + 1000, failureId: "h1", files: [hostileFile] }),
    failureRecord({ id: "h2", ts: t2, cmd: hostileCmd, signature: [hostileSig], fingerprint: "3f2a9c1e44d0b7a1" }),
  ];
  writeFileSync(join(home, "memory.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");

  const memory = createMemoryQueries();
  const snapshot = loadDurableMemorySnapshot(memory, NOW);
  assert.ok(snapshot !== undefined);
  const built = buildProblems(snapshot.records, snapshot.coverage, { now: NOW, cwd: CWD });
  const originalEntry = built.entries[0]!;
  const sanitizedCopy = sanitizeProblemEntry(originalEntry);
  assert.notEqual(sanitizedCopy, originalEntry);
  assert.equal(originalEntry.attempts[0]!.cmd, hostileCmd);
  assert.equal(originalEntry.signature[0], hostileSig);
  assert.equal(
    originalEntry.attempts[0]!.changes.state === "testimony"
      ? originalEntry.attempts[0]!.changes.files[0]
      : undefined,
    hostileFile,
  );

  // Also check observed changes sanitization without mutating input.
  const observedEntry: ProblemEntry = {
    ...originalEntry,
    attempts: [
      {
        ...originalEntry.attempts[0]!,
        changes: { state: "observed", files: [hostileFile], more: 0, cardId: "c1", partial: false },
      },
    ],
  };
  const sanitizedObserved = sanitizeProblemEntry(observedEntry);
  assert.equal(
    observedEntry.attempts[0]!.changes.state === "observed" ? observedEntry.attempts[0]!.changes.files[0] : undefined,
    hostileFile,
  );
  assert.equal(
    sanitizedObserved.attempts[0]!.changes.state === "observed" ? sanitizedObserved.attempts[0]!.changes.files[0] : undefined,
    "src/[redacted github token].ts",
  );

  const textOut = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(textOut.code, 0);
  for (const forbidden of ["\u001b", "\u202e", "\u200b", "ghp_", cmdSecret, sigSecret, fileSecret]) {
    assert.equal(textOut.stderr.includes(forbidden), false, `stderr leaked ${JSON.stringify(forbidden)}`);
  }
  assert.match(textOut.stderr, /Error: bad sig \[redacted github token\]/);
  assert.match(textOut.stderr, /npm test evil/);
  assert.match(textOut.stderr, /said: edited src\/\[redacted github token\]\.ts/);

  const jsonOut = await captureOutput(() =>
    attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
  );
  assert.equal(jsonOut.code, 0);
  assert.equal(jsonOut.stderr, "");
  for (const forbidden of ["\u001b", "\u202e", "\u200b", "ghp_", cmdSecret, sigSecret, fileSecret]) {
    assert.equal(jsonOut.stdout.includes(forbidden), false, `json stdout leaked ${JSON.stringify(forbidden)}`);
  }
  const parsed = JSON.parse(jsonOut.stdout) as { entries: ProblemEntry[] };
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]!.signature[0], "Error: bad sig [redacted github token]");
  assert.equal(parsed.entries[0]!.attempts[0]!.cmd, "npm test evil [redacted github token]");
  assert.deepEqual(
    parsed.entries[0]!.attempts[0]!.changes.state === "testimony"
      ? parsed.entries[0]!.attempts[0]!.changes.files
      : [],
    ["src/[redacted github token].ts"],
  );
});

test("--json keeps a single persistent stdout error listener and handles EPIPE/EIO in any order", async (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  const origDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const origStderrWrite = process.stderr.write;
  const origExitCode = process.exitCode;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);

  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  const waitTicks = (ms = 25): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  type WritableMode =
    | "ok"
    | "callback-then-error"
    | "callback-then-delayed-error"
    | "sync-callback-then-error"
    | "error-then-callback"
    | "error-then-delayed-callback"
    | "destroy-then-callback"
    | "sync-destroy-after-success"
    | "delayed-destroy";

  const installWritableStdout = (errorCode: string, mode: WritableMode): Writable => {
    let stream!: Writable;
    stream = new Writable({
      write(_chunk, _encoding, callback) {
        if (mode === "ok") {
          callback();
          return;
        }
        const err = Object.assign(new Error(`write ${errorCode}`), { code: errorCode });
        if (mode === "sync-callback-then-error") {
          callback(err);
          return;
        }
        if (mode === "sync-destroy-after-success" || mode === "delayed-destroy") {
          callback();
          stream.destroy(err);
          return;
        }
        if (mode === "error-then-delayed-callback") {
          stream.destroy(err);
          setTimeout(() => callback(err), 15);
          return;
        }
        setImmediate(() => {
          if (mode === "callback-then-error") {
            callback(err);
          } else if (mode === "error-then-callback") {
            stream.emit("error", err);
            callback(err);
          } else {
            stream.destroy(err);
            callback(err);
          }
        });
      },
      destroy(error, callback) {
        if (mode === "delayed-destroy") {
          setTimeout(() => callback(error), 15);
          return;
        }
        callback(error);
      },
    });
    if (mode === "callback-then-delayed-error") {
      stream.write = ((_chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
        const callback = (typeof encodingOrCb === "function" ? encodingOrCb : cb) as
          | ((error?: Error | null) => void)
          | undefined;
        const err = Object.assign(new Error(`write ${errorCode}`), { code: errorCode });
        setImmediate(() => callback?.(err));
        setTimeout(() => stream.emit("error", err), 15);
        return false;
      }) as typeof stream.write;
    }
    Object.defineProperty(process, "stdout", { value: stream, configurable: true, enumerable: true });
    return stream;
  };

  try {
    // Callback-first EIO (write callback rejects first, then stream emits 'error',
    // immediately or 15ms later): promise rejects, listener ignores every later error
    // (caller already reported) and never calls exit.
    // EPIPE in the same orderings is silent and never calls exit.
    for (const mode of [
      "callback-then-error",
      "callback-then-delayed-error",
      "sync-callback-then-error",
      "destroy-then-callback",
    ] as const) {
      stderr = "";
      process.exitCode = undefined;
      const epipeExitCalls: number[] = [];
      const epipeOut = installWritableStdout("EPIPE", mode);
      const epipeCode = await attempts(["--json"], {
        memory: createMemoryQueries(),
        now: NOW,
        cwd: CWD,
        exit: (code) => epipeExitCalls.push(code),
      });
      await waitTicks(40);
      assert.equal(epipeCode, 0, mode);
      assert.equal(process.exitCode, undefined, `${mode} EPIPE exitCode`);
      assert.equal(stderr, "", `${mode} EPIPE stderr`);
      assert.deepEqual(epipeExitCalls, [], `${mode} EPIPE exitCalls`);
      assert.equal(epipeOut.listenerCount("error"), 1, `${mode} EPIPE error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EPIPE uncaught`);

      stderr = "";
      process.exitCode = undefined;
      const eioExitCalls: number[] = [];
      const eioOut = installWritableStdout("EIO", mode);
      await assert.rejects(
        () =>
          attempts(["--json"], {
            memory: createMemoryQueries(),
            now: NOW,
            cwd: CWD,
            exit: (code) => eioExitCalls.push(code),
          }),
        (error: NodeJS.ErrnoException) => error.code === "EIO",
        mode,
      );
      await waitTicks(40);
      assert.equal(stderr, "", `${mode} EIO stderr`);
      assert.deepEqual(eioExitCalls, [], `${mode} EIO exitCalls`);
      assert.equal(eioOut.listenerCount("error"), 1, `${mode} EIO error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EIO uncaught`);
    }

    // Error-first EIO ('error' arrives before write promise settles):
    // promise rejects, listener prints zero lines and does not call exit.
    // EPIPE in the same orderings resolves 0 silently without calling exit.
    for (const mode of ["error-then-callback", "error-then-delayed-callback"] as const) {
      stderr = "";
      process.exitCode = undefined;
      const epipeExitCalls: number[] = [];
      const epipeOut = installWritableStdout("EPIPE", mode);
      const epipeCode = await attempts(["--json"], {
        memory: createMemoryQueries(),
        now: NOW,
        cwd: CWD,
        exit: (code) => epipeExitCalls.push(code),
      });
      await waitTicks(40);
      assert.equal(epipeCode, 0, mode);
      assert.equal(process.exitCode, undefined, `${mode} EPIPE exitCode`);
      assert.equal(stderr, "", `${mode} EPIPE stderr`);
      assert.deepEqual(epipeExitCalls, [], `${mode} EPIPE exitCalls`);
      assert.equal(epipeOut.listenerCount("error"), 1, `${mode} EPIPE error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EPIPE uncaught`);

      stderr = "";
      process.exitCode = undefined;
      const eioExitCalls: number[] = [];
      const eioOut = installWritableStdout("EIO", mode);
      await assert.rejects(
        () =>
          attempts(["--json"], {
            memory: createMemoryQueries(),
            now: NOW,
            cwd: CWD,
            exit: (code) => eioExitCalls.push(code),
          }),
        (error: NodeJS.ErrnoException) => error.code === "EIO",
        mode,
      );
      await waitTicks(40);
      assert.equal(stderr, "", `${mode} EIO stderr`);
      assert.deepEqual(eioExitCalls, [], `${mode} EIO exitCalls`);
      assert.equal(eioOut.listenerCount("error"), 1, `${mode} EIO error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EIO uncaught`);
    }

    // Post-success destroy (both immediate nextTick destroy and delayed 15ms destroy):
    // EPIPE is silent with exit 0 and no exit() call; EIO prints one line and calls exit(1).
    for (const mode of ["sync-destroy-after-success", "delayed-destroy"] as const) {
      stderr = "";
      process.exitCode = undefined;
      const epipeExitCalls: number[] = [];
      const delayedEpipeOut = installWritableStdout("EPIPE", mode);
      const delayedEpipeCode = await attempts(["--json"], {
        memory: createMemoryQueries(),
        now: NOW,
        cwd: CWD,
        exit: (code) => epipeExitCalls.push(code),
      });
      assert.equal(delayedEpipeCode, 0, mode);
      await waitTicks(40);
      assert.equal(process.exitCode, undefined, `${mode} EPIPE exitCode`);
      assert.equal(stderr, "", `${mode} EPIPE stderr`);
      assert.deepEqual(epipeExitCalls, [], `${mode} EPIPE exitCalls`);
      assert.equal(delayedEpipeOut.listenerCount("error"), 1, `${mode} EPIPE listeners`);
      assert.deepEqual(uncaught, [], `${mode} EPIPE uncaught`);

      stderr = "";
      process.exitCode = undefined;
      const eioExitCalls: number[] = [];
      const delayedEioOut = installWritableStdout("EIO", mode);
      const delayedEioCode = await attempts(["--json"], {
        memory: createMemoryQueries(),
        now: NOW,
        cwd: CWD,
        exit: (code) => eioExitCalls.push(code),
      });
      assert.equal(delayedEioCode, 0, mode);
      await waitTicks(40);
      assert.equal(stderr, "rocky: Cannot write attempts output.\n", `${mode} EIO stderr`);
      assert.deepEqual(eioExitCalls, [1], `${mode} EIO exitCalls`);
      assert.equal(delayedEioOut.listenerCount("error"), 1, `${mode} EIO listeners`);
      assert.deepEqual(uncaught, [], `${mode} EIO uncaught`);
    }

    // Buffered/slow stderr Writable: callback succeeds, EIO arrives later -> diagnostic
    // line is fully written to stderr BEFORE exit(1) is called.
    const origStderrDescriptor = Object.getOwnPropertyDescriptor(process, "stderr");
    try {
      for (const mode of ["sync-destroy-after-success", "delayed-destroy"] as const) {
        let slowStderrOut = "";
        const exitObservations: Array<{ code: number; stderrAtExit: string }> = [];
        const slowStderr = new Writable({
          write(chunk, _encoding, callback) {
            setTimeout(() => {
              slowStderrOut += String(chunk);
              callback();
            }, 20);
          },
        });
        Object.defineProperty(process, "stderr", {
          value: slowStderr,
          configurable: true,
          enumerable: true,
        });
        process.exitCode = undefined;
        installWritableStdout("EIO", mode);
        let resolveExit!: () => void;
        let rejectExit!: (error: unknown) => void;
        const exitCalled = new Promise<void>((resolve, reject) => {
          resolveExit = resolve;
          rejectExit = reject;
        });
        const exitTimeout = setTimeout(() => {
          rejectExit(new Error(`${mode} slowStderr exit timed out after 5000ms`));
        }, 5000);
        try {
          const code = await attempts(["--json"], {
            memory: createMemoryQueries(),
            now: NOW,
            cwd: CWD,
            exit: (exitCode) => {
              exitObservations.push({ code: exitCode, stderrAtExit: slowStderrOut });
              resolveExit();
            },
          });
          assert.equal(code, 0, `${mode} slowStderr return`);
          await exitCalled;
        } finally {
          clearTimeout(exitTimeout);
        }
        assert.deepEqual(
          exitObservations,
          [{ code: 1, stderrAtExit: "rocky: Cannot write attempts output.\n" }],
          `${mode} slowStderr exitObservations`,
        );
        assert.deepEqual(uncaught, [], `${mode} slowStderr uncaught`);
      }
    } finally {
      if (origStderrDescriptor) Object.defineProperty(process, "stderr", origStderrDescriptor);
    }

    // Repeated calls on the same stream do not add a second error listener
    stderr = "";
    process.exitCode = undefined;
    const reusableExitCalls: number[] = [];
    const reusableOut = installWritableStdout("EIO", "ok");
    const firstCode = await attempts(["--json"], {
      memory: createMemoryQueries(),
      now: NOW,
      cwd: CWD,
      exit: (code) => reusableExitCalls.push(code),
    });
    assert.equal(firstCode, 0);
    assert.equal(reusableOut.listenerCount("error"), 1);
    const secondCode = await attempts(["--json"], {
      memory: createMemoryQueries(),
      now: NOW,
      cwd: CWD,
      exit: (code) => reusableExitCalls.push(code),
    });
    assert.equal(secondCode, 0);
    assert.equal(reusableOut.listenerCount("error"), 1);
    assert.equal(process.exitCode, undefined);
    assert.equal(stderr, "");
    assert.deepEqual(reusableExitCalls, []);
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
    if (origDescriptor) Object.defineProperty(process, "stdout", origDescriptor);
  }
});

test("--json through real CLI dispatcher exits 1 with one stderr line on EIO and 0 silently on EPIPE", (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entry = join(packageRoot, "dist", "index.js");
  const entryUrl = pathToFileURL(entry).href;

  const runnerScript = `
    import { Writable } from "node:stream";
    const entryUrl = process.argv[1];
    const entryPath = process.argv[2];
    const mode = process.argv[3];
    const errorCode = process.argv[4];
    const stderrMode = process.argv[5] ?? "default";
    if (stderrMode === "slow") {
      const realStderrWrite = process.stderr.write.bind(process.stderr);
      const slowStderr = new Writable({
        write(chunk, encoding, callback) {
          setTimeout(() => {
            realStderrWrite(chunk, encoding, callback);
          }, 20);
        },
      });
      Object.defineProperty(process, "stderr", { value: slowStderr, configurable: true, enumerable: true });
    }
    let stream;
    stream = new Writable({
      write(_chunk, _encoding, callback) {
        const err = Object.assign(new Error("write " + errorCode), { code: errorCode });
        if (mode === "sync-destroy-after-success" || mode === "delayed-destroy") {
          callback();
          stream.destroy(err);
          return;
        }
        setImmediate(() => {
          if (mode === "callback-then-error") {
            callback(err);
          } else {
            stream.emit("error", err);
            callback(err);
          }
        });
      },
      destroy(error, callback) {
        if (mode === "delayed-destroy") {
          setTimeout(() => callback(error), 15);
          return;
        }
        callback(error);
      },
    });
    if (mode === "callback-then-delayed-error") {
      stream.write = (_chunk, encodingOrCb, cb) => {
        const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
        const err = Object.assign(new Error("write " + errorCode), { code: errorCode });
        setImmediate(() => callback?.(err));
        setTimeout(() => stream.emit("error", err), 15);
        return false;
      };
    }
    Object.defineProperty(process, "stdout", { value: stream, configurable: true, enumerable: true });
    process.argv = [process.execPath, entryPath, "attempts", "--json"];
    await import(entryUrl);
  `;

  const runDispatch = (mode: string, errorCode: string, stderrMode = "default") => {
    const env: NodeJS.ProcessEnv = { ...process.env, ROCKY_HOME: home };
    delete env.NODE_OPTIONS;
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(
      process.execPath,
      ["--input-type=module", "-e", runnerScript, entryUrl, entry, mode, errorCode, stderrMode],
      {
        cwd: packageRoot,
        env,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
  };

  // Post-success EIO (both before and after index.ts assigns return code, including with
  // a buffered/slow stderr Writable) exits 1 with one stderr line after stderr drains.
  for (const mode of ["sync-destroy-after-success", "delayed-destroy"]) {
    const eio = runDispatch(mode, "EIO");
    assert.equal(eio.status, 1, `${mode} EIO stderr=${eio.stderr}`);
    assert.equal(eio.stderr, "rocky: Cannot write attempts output.\n", mode);

    const slowEio = runDispatch(mode, "EIO", "slow");
    assert.equal(slowEio.status, 1, `${mode} slow EIO stderr=${slowEio.stderr}`);
    assert.equal(slowEio.stderr, "rocky: Cannot write attempts output.\n", `${mode} slow`);

    const epipe = runDispatch(mode, "EPIPE");
    assert.equal(epipe.status, 0, `${mode} EPIPE stderr=${epipe.stderr}`);
    assert.equal(epipe.stderr, "", mode);
  }

  // Callback-first EIO (including a 15ms-delayed 'error' event) exits 1 with exactly one
  // stderr line from index.ts:634 (listener ignores post-rejection errors).
  for (const mode of ["callback-then-error", "callback-then-delayed-error"]) {
    const cbFirst = runDispatch(mode, "EIO");
    assert.equal(cbFirst.status, 1, `${mode} stderr=${cbFirst.stderr}`);
    assert.equal(cbFirst.stderr, "rocky: Unexpected internal error: Error: write EIO\n", mode);
  }

  // Error-first EIO rejects cleanly; only index.ts:634 prints one line.
  const errFirst = runDispatch("error-then-callback", "EIO");
  assert.equal(errFirst.status, 1, `error-then-callback stderr=${errFirst.stderr}`);
  assert.equal(errFirst.stderr, "rocky: Unexpected internal error: Error: write EIO\n");
});

test("no causal words in any rendered string", () => {
  const outcomes: readonly AttemptOutcome[] = [
    "passed",
    "possible_pass",
    "same_failure",
    "different_failure",
    "no_later_run",
    "unknown",
  ];
  const changeVariants: readonly Attempt["changes"][] = [
    { state: "observed", files: ["src/a.ts", "src/b.ts"], more: 0, cardId: "c1", partial: false },
    { state: "observed", files: ["src/a.ts", "src/b.ts"], more: 2, cardId: "c2", partial: true },
    { state: "testimony", files: ["src/a.ts", "src/b.ts"], rationaleId: "r1" },
    { state: "unknown" },
  ];

  const allLines: string[] = [];
  for (const outcome of outcomes) {
    allLines.push(formatAttemptOutcome(outcome));
    for (const changes of changeVariants) {
      allLines.push(formatAttemptChanges(changes));
      const syntheticAttempts: Attempt[] = [
        {
          failureId: "f1",
          ts: NOW - 60_000,
          cmd: "npm test",
          outcome,
          sessionScoped: false,
          changes,
        },
      ];
      const entry: ProblemEntry = {
        problemId: "0123456789abcdef",
        key: "output:0123456789abcdef:/work/app",
        fingerprint: "0123456789abcdef",
        family: ["0123456789abcdef"],
        keyStrength: "output",
        cwd: CWD,
        cwdScope: "here",
        firstSeenTs: NOW - 60_000,
        lastSeenTs: NOW - 60_000,
        signature: ["TypeError: token undefined"],
        counts: {
          attempts: 1,
          passed: outcome === "passed" ? 1 : 0,
          possible_pass: outcome === "possible_pass" ? 1 : 0,
          same_failure: outcome === "same_failure" ? 1 : 0,
          different_failure: outcome === "different_failure" ? 1 : 0,
          no_later_run: outcome === "no_later_run" ? 1 : 0,
          unknown: outcome === "unknown" ? 1 : 0,
        },
        latestOutcome: outcome,
        attempts: syntheticAttempts,
        historyMayStartEarlier: false,
      };
      const set: ProblemSet = {
        entries: [entry],
        coverage: {
          version: MEMORY_FORMAT_VERSION,
          scanned: 1,
          skipped: 0,
          truncated: 0,
          bytesScanned: 100,
          bytesTotal: 100,
          complete: true,
        },
        ungroupedLegacy: 0,
      };
      const rendered = renderProblemsText(set, {
        now: NOW,
        cwd: CWD,
        allDirs: false,
        totalRecords: 1,
      });
      allLines.push(rendered.header);
      if (rendered.coverageLine !== undefined) allLines.push(rendered.coverageLine);
      allLines.push(...rendered.detailLines);
      allLines.push(rendered.footer);
      assert.deepEqual(validateOutputLine(rendered.header), [], rendered.header);
      assert.deepEqual(validateOutputLine(rendered.footer), [], rendered.footer);
    }
  }

  assert.deepEqual(causalWordViolations(allLines), []);
});

function makeTempWorkspace(t: TestContext): { root: string; home: string } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rocky-attempts-card-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const prev = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prev;
  });
  return { root, home };
}

function makeTempGitRepo(baseDir: string, name: string): { repoRoot: string; subDir: string } {
  const repoRoot = join(baseDir, name);
  const subDir = join(repoRoot, "packages", "app");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(subDir, { recursive: true });
  return { repoRoot, subDir };
}

function writeCardsLog(repoRoot: string, home: string, cards: readonly Record<string, unknown>[]): void {
  const logPath = cardsFilePath(canonicalPath(repoRoot), home);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${cards.map((c) => JSON.stringify(c)).join("\n")}\n`, "utf8");
}

function makeJoinedCard(opts: {
  cardId: string;
  root: string;
  startedMs: number;
  endedMs: number;
  flow: Record<string, unknown>[];
  blocks: Record<string, unknown>[];
  sessionId?: string;
}): Record<string, unknown> {
  return {
    v: 1,
    card_id: opts.cardId,
    rev: 1,
    repo_id: "repo-1",
    root: opts.root,
    main_root: null,
    branch: "main",
    session_id: opts.sessionId ?? "sess-1",
    agent_id: "",
    agent_type: "",
    parent_card_id: null,
    started_ms: opts.startedMs,
    ended_ms: opts.endedMs,
    status: "done",
    prompt: "Fix failing test",
    prompt_truncated: false,
    importance: "medium",
    blocks: opts.blocks,
    more_count: 0,
    flow: opts.flow,
    flow_more: 0,
    outside_count: 0,
    coverage: { state: "complete", reasons: [] },
  };
}

function seedJoinedRepoFixture(t: TestContext): {
  home: string;
  repoRoot: string;
  cardId: string;
} {
  const { root, home } = makeTempWorkspace(t);
  const { repoRoot } = makeTempGitRepo(root, "app");
  const canonicalRoot = canonicalPath(repoRoot);
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 25);
  const cardId = "4e5e1a6d22cea72d7a8b3985c9c27fcf";

  const cmd = "npm test";
  const identity = commandIdentity(cmd, { platform: process.platform });
  const records = [
    {
      ...failureRecord({ id: "f1", ts: t1, cwd: repoRoot, cmd, resolvedBy: "x1" }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    {
      ...fixRecord({ id: "x1", ts: t1 + 60_000, cwd: repoRoot, cmd, failureIds: ["f1"] }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    {
      ...failureRecord({ id: "f2", ts: t2, cwd: repoRoot, cmd }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
  ];
  writeFileSync(join(home, "memory.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

  writeCardsLog(repoRoot, home, [
    makeJoinedCard({
      cardId,
      root: canonicalRoot,
      startedMs: t1 - 5_000,
      endedMs: t1 + 90_000,
      blocks: [
        {
          seq: 1,
          path: "src/a.ts",
          symbol: null,
          labels: [{ id: "body_changed", args: {} }],
          importance: "medium",
          via: "edit",
          tool_use_ids: ["tu-edit-1"],
          bash: null,
          before: null,
          after: null,
          recorded: true,
          line: 10,
          added: 2,
          removed: 1,
          quote: { text: "guard empty token", shared: false },
        },
      ],
      flow: [
        {
          kind: "cmd",
          text: cmd,
          ok: false,
          dur_ms: 1_000,
          seqs: [],
          exit_code: 1,
          start_ms: t1 - 1_000,
          end_ms: t1,
          cwd: repoRoot,
          tool_use_id: "tu-fail-1",
        },
        {
          kind: "edit",
          text: "edit",
          ok: true,
          dur_ms: 1_000,
          seqs: [1],
          start_ms: t1 + 10_000,
          end_ms: t1 + 11_000,
        },
        {
          kind: "cmd",
          text: cmd,
          ok: true,
          dur_ms: 800,
          seqs: [],
          exit_code: 0,
          start_ms: t1 + 59_500,
          end_ms: t1 + 60_300,
          cwd: repoRoot,
          tool_use_id: "tu-pass-1",
          desc: "Re-run tests after guard",
        },
      ],
    }),
  ]);

  return { home, repoRoot, cardId };
}

test("default listing prints observed card edits and --json carries changes.state observed", async (t) => {
  const { repoRoot, cardId } = seedJoinedRepoFixture(t);

  const textOut = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: repoRoot }),
  );
  assert.equal(textOut.code, 0);
  assert.equal(textOut.stdout, "");
  assert.match(textOut.stderr, /edited src\/a\.ts/);
  assert.doesNotMatch(textOut.stderr, /said: edited src\/a\.ts/);

  const jsonOut = await captureOutput(() =>
    attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: repoRoot }),
  );
  assert.equal(jsonOut.code, 0);
  assert.equal(jsonOut.stderr, "");
  const payload = JSON.parse(jsonOut.stdout) as { v: number; entries: ProblemEntry[] };
  assert.equal(payload.v, 1);
  assert.equal(payload.entries.length, 1);
  const firstAttempt = payload.entries[0]!.attempts[0]!;
  assert.deepEqual(firstAttempt.changes, {
    state: "observed",
    files: ["src/a.ts"],
    more: 0,
    cardId,
    partial: false,
  });
  assert.deepEqual(firstAttempt.stated, {
    text: "Re-run tests after guard",
    source: "bash-description",
    recordId: `${cardId}#tu-pass-1`,
  });
});

test("desk/tool-text-off hides bash-description and card-quote in --json while keeping observed files", async (t) => {
  const { home, repoRoot, cardId } = seedJoinedRepoFixture(t);
  mkdirSync(join(home, "desk"), { recursive: true });
  writeFileSync(join(home, "desk", "tool-text-off"), "", "utf8");

  const jsonOut = await captureOutput(() =>
    attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: repoRoot }),
  );
  assert.equal(jsonOut.code, 0);
  assert.equal(jsonOut.stderr, "");
  const payload = JSON.parse(jsonOut.stdout) as { entries: ProblemEntry[] };
  assert.equal(payload.entries.length, 1);
  const firstAttempt = payload.entries[0]!.attempts[0]!;
  assert.deepEqual(firstAttempt.changes, {
    state: "observed",
    files: ["src/a.ts"],
    more: 0,
    cardId,
    partial: false,
  });
  assert.equal(firstAttempt.stated, undefined);
});

test("--card <id> --json returns only entries joined to that card across all ages and respects --limit", async (t) => {
  const { root, home } = makeTempWorkspace(t);
  const { repoRoot, subDir } = makeTempGitRepo(root, "repo-a");
  const { repoRoot: otherRepo } = makeTempGitRepo(root, "repo-b");
  const canonicalA = canonicalPath(repoRoot);
  const canonicalB = canonicalPath(otherRepo);

  const targetCardId = "4e5e1a6d22cea72d7a8b3985c9c27fcf";
  const otherCardId = "97394ac43381e6ac7a3b66cb264cd2b9";
  const oldTs = NOW - 45 * 86_400_000; // older than 30 days
  const midTs = NOW - 40 * 86_400_000;
  const recentTs = NOW - 60_000;
  const cmd = "npm test";
  const identity = commandIdentity(cmd, { platform: process.platform });

  const records = [
    // Entry A: old (>30d), single attempt, inside subDir of repo-a, joined to targetCardId.
    {
      ...failureRecord({
        id: "f-old",
        ts: oldTs,
        cwd: subDir,
        cmd,
        fingerprint: "1111111111111111",
        signature: ["TypeError: old failure"],
        resolvedBy: "x-old",
      }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    {
      ...fixRecord({ id: "x-old", ts: oldTs + 30_000, cwd: subDir, cmd, failureIds: ["f-old"] }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    // Entry D: newer than Entry A (still >30d), in repoRoot, no later run, also joined to targetCardId.
    {
      ...failureRecord({
        id: "f-mid",
        ts: midTs,
        cwd: repoRoot,
        cmd,
        fingerprint: "2222222222222222",
        signature: ["TypeError: mid failure"],
      }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    // Entry B: recent in repo-a, joined to a DIFFERENT card.
    {
      ...failureRecord({
        id: "f-other-card",
        ts: recentTs,
        cwd: repoRoot,
        cmd,
        fingerprint: "3333333333333333",
        signature: ["TypeError: other card failure"],
      }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
    // Entry C: recent in repo-b (outside card.root).
    {
      ...failureRecord({
        id: "f-other-repo",
        ts: recentTs,
        cwd: otherRepo,
        cmd,
        fingerprint: "4444444444444444",
        signature: ["TypeError: other repo failure"],
      }),
      commandIdentity: identity.value,
      identityReliable: identity.reliable,
      platform: process.platform,
    },
  ];
  writeFileSync(join(home, "memory.jsonl"), `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");

  writeCardsLog(repoRoot, home, [
    makeJoinedCard({
      cardId: targetCardId,
      root: canonicalA,
      startedMs: oldTs - 5_000,
      endedMs: midTs + 10_000,
      blocks: [
        {
          seq: 1,
          path: "src/old.ts",
          symbol: null,
          labels: [{ id: "body_changed", args: {} }],
          importance: "medium",
          via: "edit",
          tool_use_ids: ["tu-e1"],
          bash: null,
          before: null,
          after: null,
          recorded: true,
          line: 1,
          added: 1,
          removed: 0,
        },
      ],
      flow: [
        {
          kind: "cmd",
          text: cmd,
          ok: false,
          dur_ms: 500,
          seqs: [],
          exit_code: 1,
          start_ms: oldTs - 500,
          end_ms: oldTs,
          cwd: subDir,
        },
        {
          kind: "edit",
          text: "edit",
          ok: true,
          dur_ms: 500,
          seqs: [1],
          start_ms: oldTs + 5_000,
          end_ms: oldTs + 5_500,
        },
        {
          kind: "cmd",
          text: cmd,
          ok: false,
          dur_ms: 500,
          seqs: [],
          exit_code: 1,
          start_ms: midTs - 500,
          end_ms: midTs,
          cwd: repoRoot,
        },
      ],
    }),
    makeJoinedCard({
      cardId: otherCardId,
      root: canonicalA,
      startedMs: recentTs - 5_000,
      endedMs: recentTs + 5_000,
      blocks: [],
      flow: [
        {
          kind: "cmd",
          text: cmd,
          ok: false,
          dur_ms: 500,
          seqs: [],
          exit_code: 1,
          start_ms: recentTs - 500,
          end_ms: recentTs,
          cwd: repoRoot,
        },
      ],
    }),
  ]);
  writeCardsLog(otherRepo, home, [
    makeJoinedCard({
      cardId: "085fd43e5e4c84caf8d98e99af9d6ff2",
      root: canonicalB,
      startedMs: recentTs - 5_000,
      endedMs: recentTs + 5_000,
      blocks: [],
      flow: [
        {
          kind: "cmd",
          text: cmd,
          ok: false,
          dur_ms: 500,
          seqs: [],
          exit_code: 1,
          start_ms: recentTs - 500,
          end_ms: recentTs,
          cwd: otherRepo,
        },
      ],
    }),
  ]);

  // Run from otherRepo to prove --card ignores caller cwd and filters by card.root.
  const out = await captureOutput(() =>
    attempts(["--card", targetCardId, "--json"], { memory: createMemoryQueries(), now: NOW, cwd: otherRepo }),
  );
  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
  const payload = JSON.parse(out.stdout) as {
    v: number;
    coverage: MemoryCoverage;
    ungroupedLegacy: number;
    entries: ProblemEntry[];
  };
  assert.equal(payload.v, 1);
  assert.equal(typeof payload.ungroupedLegacy, "number");
  assert.equal(payload.coverage.complete, true);
  assert.deepEqual(
    payload.entries.map((e) => e.fingerprint),
    ["2222222222222222", "1111111111111111"],
  );
  assert.deepEqual(payload.entries[1]!.attempts[0]!.changes, {
    state: "observed",
    files: ["src/old.ts"],
    more: 0,
    cardId: targetCardId,
    partial: false,
  });

  const limited = await captureOutput(() =>
    attempts(["--card", targetCardId, "--json", "--limit", "1"], {
      memory: createMemoryQueries(),
      now: NOW,
      cwd: otherRepo,
    }),
  );
  assert.equal(limited.code, 0);
  const limitedPayload = JSON.parse(limited.stdout) as { entries: ProblemEntry[] };
  assert.deepEqual(
    limitedPayload.entries.map((e) => e.fingerprint),
    ["2222222222222222"],
  );
});

test("--card with unknown id exits 0 with empty entries", async (t) => {
  const { repoRoot } = seedJoinedRepoFixture(t);

  const out = await captureOutput(() =>
    attempts(["--card", "deadbeef00000000deadbeef00000000", "--json"], {
      memory: createMemoryQueries(),
      now: NOW,
      cwd: repoRoot,
    }),
  );
  assert.equal(out.code, 0);
  assert.equal(out.stderr, "");
  const payload = JSON.parse(out.stdout) as {
    v: number;
    coverage: MemoryCoverage;
    ungroupedLegacy: number;
    entries: ProblemEntry[];
  };
  assert.equal(payload.v, 1);
  assert.equal(payload.coverage.complete, true);
  assert.equal(typeof payload.ungroupedLegacy, "number");
  assert.deepEqual(payload.entries, []);
});

test("exit 2 on invalid --card flag combinations and malformed ids", async (t) => {
  const home = freshHome(t);
  seedDefaultListingMemory(home);

  // Valid boundary ids parse cleanly when paired with --json.
  assert.deepEqual(parseAttemptsArgs(["--card", "A_z.0:9-x", "--json"]), {
    card: "A_z.0:9-x",
    allDirs: false,
    limit: 10,
    json: true,
  });
  assert.deepEqual(parseAttemptsArgs(["--card", "a".repeat(128), "--json", "--limit", "5"]), {
    card: "a".repeat(128),
    allDirs: false,
    limit: 5,
    json: true,
  });

  const invalidCases: readonly (readonly string[])[] = [
    ["--card", "card-1", "--json", "token"],
    ["token", "--card", "card-1", "--json"],
    ["--card", "card-1", "--all-dirs", "--json"],
    ["--card", "card-1"],
    ["--card"],
    ["--json", "--card"],
    ["--card", "--json"],
    ["--card", "--all-dirs", "--json"],
    ["--json", "--card", "--all-dirs"],
    ["--card", "card-1", "--card", "card-2", "--json"],
    ["--card", "", "--json"],
    ["--card", "../escape", "--json"],
    ["--card", "bad id", "--json"],
    ["--card", "id$1", "--json"],
    ["--card", "a".repeat(129), "--json"],
  ];

  for (const bad of invalidCases) {
    assert.throws(() => parseAttemptsArgs(bad), Error, bad.join(" "));
    const out = await captureOutput(() =>
      attempts(bad, { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
    );
    assert.equal(out.code, 2, bad.join(" "));
    assert.equal(out.stdout, "", bad.join(" "));
    assert.match(out.stderr, /^rocky: Invalid option for attempts\./, bad.join(" "));
  }
});

test("unreadable card log does not fail attempts or --card lookup", async (t) => {
  const { root, home } = makeTempWorkspace(t);
  const { repoRoot } = makeTempGitRepo(root, "broken-cards");
  const t1 = Date.UTC(2026, 10, 12, 13, 20);
  const t2 = Date.UTC(2026, 10, 12, 13, 25);
  const lines = [
    failureRecord({ id: "f1", ts: t1, cwd: repoRoot, cmd: "npm test" }),
    failureRecord({ id: "f2", ts: t2, cwd: repoRoot, cmd: "npm test" }),
  ];
  writeFileSync(join(home, "memory.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, "utf8");
  // Place a directory where the card log file would live so card reading hits non-regular.
  mkdirSync(cardsFilePath(canonicalPath(repoRoot), home), { recursive: true });

  const textOut = await captureOutput(() =>
    attempts([], { memory: createMemoryQueries(), now: NOW, cwd: repoRoot }),
  );
  assert.equal(textOut.code, 0);
  assert.match(textOut.stderr, /changes unknown/);

  const cardOut = await captureOutput(() =>
    attempts(["--card", "4e5e1a6d22cea72d7a8b3985c9c27fcf", "--json"], {
      memory: createMemoryQueries(),
      now: NOW,
      cwd: repoRoot,
    }),
  );
  assert.equal(cardOut.code, 0);
  const payload = JSON.parse(cardOut.stdout) as { entries: ProblemEntry[] };
  assert.deepEqual(payload.entries, []);
});
