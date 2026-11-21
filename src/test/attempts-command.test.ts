import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { type TestContext } from "node:test";
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
import { MEMORY_FORMAT_VERSION, type MemoryCoverage } from "../core/memory-read.js";
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

  const installWritableStdout = (
    errorCode: string,
    mode:
      | "ok"
      | "callback-then-error"
      | "sync-callback-then-error"
      | "error-then-callback"
      | "destroy-then-callback"
      | "delayed-destroy",
  ): Writable => {
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
        if (mode === "delayed-destroy") {
          callback();
          stream.destroy(err);
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
    Object.defineProperty(process, "stdout", { value: stream, configurable: true, enumerable: true });
    return stream;
  };

  try {
    // (a) callback-then-error EIO & (b) error-then-callback EIO & (c) EPIPE across all orderings
    for (const mode of [
      "callback-then-error",
      "sync-callback-then-error",
      "error-then-callback",
      "destroy-then-callback",
    ] as const) {
      stderr = "";
      process.exitCode = undefined;
      const epipeOut = installWritableStdout("EPIPE", mode);
      const epipeCode = await attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD });
      await waitTicks();
      assert.equal(epipeCode, 0, mode);
      assert.equal(process.exitCode, undefined, `${mode} EPIPE exitCode`);
      assert.equal(stderr, "", `${mode} EPIPE stderr`);
      assert.equal(epipeOut.listenerCount("error"), 1, `${mode} EPIPE error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EPIPE uncaught`);

      stderr = "";
      process.exitCode = undefined;
      const eioOut = installWritableStdout("EIO", mode);
      await assert.rejects(
        () => attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD }),
        (error: NodeJS.ErrnoException) => error.code === "EIO",
        mode,
      );
      await waitTicks();
      assert.equal(process.exitCode, 1, `${mode} EIO exitCode`);
      assert.equal(stderr, "rocky: Cannot write attempts output.\n", `${mode} EIO stderr`);
      assert.equal(eioOut.listenerCount("error"), 1, `${mode} EIO error listeners`);
      assert.deepEqual(uncaught, [], `${mode} EIO uncaught`);
    }

    // (d) delayed destroy (error emitted asynchronously after write callback) for both EPIPE and EIO
    stderr = "";
    process.exitCode = undefined;
    const delayedEpipeOut = installWritableStdout("EPIPE", "delayed-destroy");
    const delayedEpipeCode = await attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD });
    assert.equal(delayedEpipeCode, 0);
    await waitTicks(40);
    assert.equal(process.exitCode, undefined);
    assert.equal(stderr, "");
    assert.equal(delayedEpipeOut.listenerCount("error"), 1);
    assert.deepEqual(uncaught, []);

    stderr = "";
    process.exitCode = undefined;
    const delayedEioOut = installWritableStdout("EIO", "delayed-destroy");
    const delayedEioCode = await attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD });
    assert.equal(delayedEioCode, 0);
    await waitTicks(40);
    assert.equal(process.exitCode, 1);
    assert.equal(stderr, "rocky: Cannot write attempts output.\n");
    assert.equal(delayedEioOut.listenerCount("error"), 1);
    assert.deepEqual(uncaught, []);

    // Repeated calls on the same stream do not add a second error listener
    stderr = "";
    process.exitCode = undefined;
    const reusableOut = installWritableStdout("EIO", "ok");
    const firstCode = await attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD });
    assert.equal(firstCode, 0);
    assert.equal(reusableOut.listenerCount("error"), 1);
    const secondCode = await attempts(["--json"], { memory: createMemoryQueries(), now: NOW, cwd: CWD });
    assert.equal(secondCode, 0);
    assert.equal(reusableOut.listenerCount("error"), 1);
    assert.equal(process.exitCode, undefined);
    assert.equal(stderr, "");
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
    if (origDescriptor) Object.defineProperty(process, "stdout", origDescriptor);
  }
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
