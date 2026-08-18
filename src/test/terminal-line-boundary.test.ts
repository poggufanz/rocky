import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "../commands/watch.js";
import { runProcess } from "../core/exec.js";
import { quoteShellPath } from "../core/shell-quote.js";
import { say } from "../ui/rocky.js";

const packageRoot = process.cwd();
const cli = join(packageRoot, "dist", "index.js");

function nodeCommand(source: string): string {
  return `${quoteShellPath(process.execPath, process.platform)} -e ${quoteShellPath(source, process.platform)}`;
}

function stderrCommand(bytes: Buffer, code: number): string {
  const encoded = bytes.toString("base64");
  return nodeCommand(`process.stderr.write(Buffer.from('${encoded}','base64'));process.exit(${code})`);
}

function runningStderrCommand(bytes: Buffer, durationMs: number): string {
  const encoded = bytes.toString("base64");
  return nodeCommand(
    `process.stderr.write(Buffer.from('${encoded}','base64'));setTimeout(() => process.exit(0), ${durationMs})`,
  );
}

function twoChunkStderrCommand(first: string, second: string, gapMs: number, durationMs: number): string {
  const firstEncoded = Buffer.from(first, "utf8").toString("base64");
  const secondEncoded = Buffer.from(second, "utf8").toString("base64");
  return nodeCommand(
    `process.stderr.write(Buffer.from('${firstEncoded}','base64'));setTimeout(() => { process.stderr.write(Buffer.from('${secondEncoded}','base64')); setTimeout(() => process.exit(0), ${durationMs}); }, ${gapMs})`,
  );
}

function tailStderrCommand(first: string, tail: string, tailDelayMs: number, exitDelayMs: number): string {
  const firstEncoded = Buffer.from(first, "utf8").toString("base64");
  const tailEncoded = Buffer.from(tail, "utf8").toString("base64");
  return nodeCommand(
    `process.stderr.write(Buffer.from('${firstEncoded}','base64'));setTimeout(() => { process.stderr.write(Buffer.from('${tailEncoded}','base64')); setTimeout(() => process.exit(0), ${exitDelayMs}); }, ${tailDelayMs})`,
  );
}

function runCli(args: readonly string[]): { status: number | null; stderr: Buffer } {
  const home = mkdtempSync(join(tmpdir(), "rocky-terminal-line-"));
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" },
      encoding: null,
      // Hang guard only, not an assertion; generous for a loaded CI runner
      // (see cli-grammar.test.ts's CLI_HANG_GUARD_MS for the same reasoning).
      timeout: 30_000,
      windowsHide: true,
    });
    return { status: result.status, stderr: result.stderr ?? Buffer.alloc(0) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertRockyStartsAfter(
  stderr: Buffer,
  childBytes: Buffer,
  marker: Buffer,
  separator: boolean,
): void {
  assert.deepEqual(stderr.subarray(0, childBytes.length), childBytes);
  const markerOffset = stderr.indexOf(marker, childBytes.length);
  assert.ok(markerOffset >= childBytes.length, `missing marker ${marker.toString()}: ${stderr.toString("hex")}`);
  const between = stderr.subarray(childBytes.length, markerOffset);
  assert.deepEqual(between, separator ? Buffer.from("\n") : Buffer.alloc(0));
}

test("run keeps binary stderr prefix exact and separates unterminated child output", () => {
  const childBytes = Buffer.from([0x45, 0x72, 0x72, 0x6f, 0x72, 0x3a, 0x20, 0x6e, 0x6f, 0x00, 0x07, 0x08, 0x1b, 0x5b, 0x32, 0x4a]);
  const result = runCli(["run", stderrCommand(childBytes, 67)]);

  assert.equal(result.status, 67);
  assertRockyStartsAfter(result.stderr, childBytes, Buffer.from("[Rocky]"), true);
});

test("run does not add a separator after LF or CRLF child output", () => {
  for (const ending of ["\n", "\r\n"]) {
    const childBytes = Buffer.from(`Error: complete${ending}`, "utf8");
    const result = runCli(["run", stderrCommand(childBytes, 67)]);

    assert.equal(result.status, 67);
    assertRockyStartsAfter(result.stderr, childBytes, Buffer.from("[Rocky]"), false);
  }
});

test("run success with unterminated stderr and no commentary adds no byte", () => {
  const childBytes = Buffer.from("success without final newline", "utf8");
  const result = runCli(["run", stderrCommand(childBytes, 0)]);

  assert.equal(result.status, 0);
  assert.deepEqual(result.stderr, childBytes);
});

test("run cancellation with unterminated stderr adds no byte", () => {
  const childBytes = Buffer.from("cancelled without final newline", "utf8");
  const result = runCli(["run", stderrCommand(childBytes, 130)]);

  assert.equal(result.status, 130);
  assert.deepEqual(result.stderr, childBytes);
});

test("watch separates normal commentary after unterminated child output", () => {
  const childBytes = Buffer.from("watch failure without final newline", "utf8");
  const result = runCli(["watch", stderrCommand(childBytes, 1)]);

  assert.equal(result.status, 1);
  assertRockyStartsAfter(result.stderr, childBytes, Buffer.from("[Rocky]"), true);
});

test("quiet watch separates direct facts after unterminated child output", () => {
  const childBytes = Buffer.from("quiet failure without final newline", "utf8");
  const result = runCli(["watch", "--quiet", stderrCommand(childBytes, 1)]);

  assert.equal(result.status, 1);
  assertRockyStartsAfter(result.stderr, childBytes, Buffer.from("duration:"), true);
});

test("watch cancellation with unterminated stderr adds no byte", () => {
  const childBytes = Buffer.from("watch cancelled without final newline", "utf8");
  const result = runCli(["watch", stderrCommand(childBytes, 130)]);

  assert.equal(result.status, 130);
  assert.deepEqual(result.stderr, childBytes);
});

test("watch separates a label spoken while child stderr is still running", async () => {
  const childBytes = Buffer.from("running child without final newline", "utf8");
  let poll: (() => void) | undefined;
  let reads = 0;
  const timer = { unref: () => {} };
  const originalWrite = process.stderr.write;
  let stderr = Buffer.alloc(0);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    stderr = Buffer.concat([stderr, bytes]);
    return true;
  }) as typeof process.stderr.write;
  try {
    const running = watch([runningStderrCommand(childBytes, 500)], {
      notify: () => {},
      readLabels: () => (reads++ === 0 ? "" : "running label\n"),
      setInterval: (callback) => {
        poll = callback;
        return timer as unknown as NodeJS.Timeout;
      },
      clearInterval: () => {},
    });
    for (let attempt = 0; attempt < 100 && !stderr.subarray(0, childBytes.length).equals(childBytes); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(stderr.subarray(0, childBytes.length), childBytes);
    assert.ok(poll);
    poll!();
    assert.equal(await running, 0);
  } finally {
    process.stderr.write = originalWrite;
  }

  assertRockyStartsAfter(stderr, childBytes, Buffer.from("[Rocky]"), true);
});

test("active stderr re-arms the boundary after idle commentary", async () => {
  const childBytes = Buffer.from("firstsecond", "utf8");
  let stderr = Buffer.alloc(0);
  let spokeFirst = false;
  let spokeSecond = false;
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr = Buffer.concat([stderr, typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)]);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await runProcess(twoChunkStderrCommand("first", "second", 150, 150), {
      idleMs: 30,
      onIdle: () => {
        if (!spokeFirst && stderr.includes("first")) {
          spokeFirst = true;
          say("idle first");
        } else if (spokeFirst && !spokeSecond && stderr.includes("second")) {
          spokeSecond = true;
          say("idle second");
        }
      },
    });
    assert.equal(result.code, 0);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(spokeFirst, true);
  assert.equal(spokeSecond, true);
  const firstMarker = stderr.indexOf(Buffer.from("[Rocky] idle first"));
  const secondMarker = stderr.indexOf(Buffer.from("[Rocky] idle second"));
  assert.deepEqual(stderr.subarray(0, firstMarker), Buffer.from("first\n"));
  assert.deepEqual(stderr.subarray(firstMarker + "[Rocky] idle first\n".length, secondMarker), Buffer.from("second\n"));
});

test("delayed first commentary keeps pending separator after child exit", async () => {
  const childBytes = Buffer.from("delayed", "utf8");
  let stderr = Buffer.alloc(0);
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr = Buffer.concat([stderr, typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)]);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await runProcess(stderrCommand(childBytes, 0));
    assert.equal(result.code, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    say("delayed commentary");
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.deepEqual(stderr.subarray(0, childBytes.length), childBytes);
  assert.deepEqual(stderr.subarray(childBytes.length, childBytes.length + 1), Buffer.from("\n"));
});

test("concurrent runProcess calls keep one shared physical boundary", async () => {
  let stderr = Buffer.alloc(0);
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr = Buffer.concat([stderr, typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)]);
    return true;
  }) as typeof process.stderr.write;
  try {
    const a = runProcess(tailStderrCommand("A", "TAIL", 1_000, 200)).then(() => say("A done"));
    const b = runProcess(runningStderrCommand(Buffer.from("B", "utf8"), 600)).then(() => say("B done"));
    await Promise.all([a, b]);
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.match(stderr.toString("utf8"), /TAIL\n\[Rocky\] A done\n/u);
});

test("quiet log fact sanitizes control-bearing ROCKY_HOME path", () => {
  const root = mkdtempSync(join(tmpdir(), "rocky-terminal-line-\u202e-"));
  const home = join(root, "home");
  mkdirSync(home);
  try {
    const result = spawnSync(process.execPath, [cli, "watch", "--quiet", stderrCommand(Buffer.from("quiet log"), 1)], {
      env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /\u202e/u);
    assert.match(result.stderr, /log:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
