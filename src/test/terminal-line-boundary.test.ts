import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watch } from "../commands/watch.js";
import { quoteShellPath } from "../core/shell-quote.js";

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
    `process.stderr.write(Buffer.from('${encoded}','base64'));setTimeout(() => require('node:fs').writeFileSync(process.env.ROCKY_TASK12_MARKER, 'done'), 100);setTimeout(() => process.exit(0), ${durationMs})`,
  );
}

function runCli(args: readonly string[]): { status: number | null; stderr: Buffer } {
  const home = mkdtempSync(join(tmpdir(), "rocky-terminal-line-"));
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, ROCKY_HOME: home, NO_COLOR: "1" },
      encoding: null,
      timeout: 5_000,
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
  const markerRoot = mkdtempSync(join(tmpdir(), "rocky-terminal-line-running-"));
  const marker = join(markerRoot, "child-wrote-stderr");
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
  const previousMarker = process.env.ROCKY_TASK12_MARKER;
  process.env.ROCKY_TASK12_MARKER = marker;
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
    for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(marker), true);
    assert.ok(poll);
    poll!();
    assert.equal(await running, 0);
  } finally {
    process.stderr.write = originalWrite;
    if (previousMarker === undefined) delete process.env.ROCKY_TASK12_MARKER;
    else process.env.ROCKY_TASK12_MARKER = previousMarker;
    rmSync(markerRoot, { recursive: true, force: true });
  }

  assertRockyStartsAfter(stderr, childBytes, Buffer.from("[Rocky]"), true);
});
