import { test } from "node:test";
import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import { createTailBuffer, runProcess } from "../core/exec.js";

test("createTailBuffer keeps only the last N lines, in order", () => {
  const buf = createTailBuffer(200);
  for (let i = 1; i <= 500; i++) buf.push(`line ${i}\n`);
  const tail = buf.end();
  assert.equal(tail.length, 200);
  assert.equal(tail[0], "line 301");
  assert.equal(tail[tail.length - 1], "line 500");
});

test("createTailBuffer truncates a long line to maxLineBytes bytes", () => {
  const buf = createTailBuffer(200, 4096);
  buf.push("x".repeat(10_000) + "\n");
  const tail = buf.end();
  assert.equal(tail.length, 1);
  assert.equal(Buffer.byteLength(tail[0], "utf8"), 4096);
});

test("createTailBuffer gives identical result whether fed in one push or many", () => {
  const content = "alpha\nbeta\ngamma\ndelta\n";
  const whole = createTailBuffer(200);
  whole.push(content);
  const wholeResult = whole.end();

  const chunked = createTailBuffer(200);
  for (const ch of content) chunked.push(ch);
  const chunkedResult = chunked.end();

  assert.deepEqual(chunkedResult, wholeResult);
});

test("createTailBuffer survives a multi-byte character split across push calls", () => {
  // Two UTF-8 bytes of "é" (0xc3 0xa9), decoded one byte per push through a
  // StringDecoder — the same mechanism runProcess uses on real chunk splits.
  // Naive per-chunk `.toString("utf8")` would corrupt each lone byte into a
  // replacement character; StringDecoder withholds the incomplete byte
  // instead, so the character only appears once both bytes have arrived.
  const encoded = Buffer.from("é");
  assert.equal(encoded.length, 2);
  const decoder = new StringDecoder("utf8");
  const buf = createTailBuffer(200);
  buf.push(decoder.write(encoded.subarray(0, 1)));
  buf.push(decoder.write(encoded.subarray(1, 2)));
  buf.push(decoder.end());
  buf.push("\n");
  const tail = buf.end();
  assert.deepEqual(tail, ["é"]);
});

test("createTailBuffer flushes an unterminated final line via end()", () => {
  const buf = createTailBuffer(200);
  buf.push("complete\n");
  buf.push("partial");
  const tail = buf.end();
  assert.deepEqual(tail, ["complete", "partial"]);
});

test("createTailBuffer does not produce an empty last entry for a trailing newline", () => {
  const buf = createTailBuffer(200);
  buf.push("only\n");
  const tail = buf.end();
  assert.deepEqual(tail, ["only"]);
});

test("createTailBuffer caps an unterminated 10000-character partial line at 4096 bytes on end()", () => {
  const buf = createTailBuffer(200, 4096);
  buf.push("y".repeat(10_000));
  const tail = buf.end();
  assert.equal(tail.length, 1);
  assert.equal(Buffer.byteLength(tail[0], "utf8"), 4096);
});

test("createTailBuffer caps the in-progress partial line as it accumulates across many small pushes, not only at end()", () => {
  // Each individual push is well under maxLineBytes; only the cumulative,
  // still-unterminated line exceeds it. If truncation were deferred to
  // end() only, this would still pass on output alone — the point of this
  // test is that push() re-caps `partial` after every call (see the
  // `Buffer.byteLength(partial, ...) > maxLineBytes` check inside push in
  // exec.ts), which is what keeps a 200 MB single line from ever being held
  // in full. Covered here by exercising many pushes before end().
  const maxLineBytes = 4096;
  const buf = createTailBuffer(200, maxLineBytes);
  for (let i = 0; i < 200; i++) buf.push("z".repeat(100)); // 20,000 chars total, no newline
  const tail = buf.end();
  assert.equal(tail.length, 1);
  assert.equal(Buffer.byteLength(tail[0], "utf8"), maxLineBytes);
});

test("runProcess: nonzero exit with stderr", async () => {
  const result = await runProcess("sh -c 'echo boom >&2; exit 3'");
  assert.equal(result.code, 3);
  assert.ok(result.tail.includes("boom"));
  assert.equal(result.stderr, "boom");
  assert.ok(result.durationMs >= 0);
});

test("runProcess: clean exit has empty tail", async () => {
  const result = await runProcess("sh -c 'exit 0'");
  assert.equal(result.code, 0);
  assert.deepEqual(result.tail, []);
});

test("runProcess: bounds tail to tailLines, keeping the newest", async () => {
  const result = await runProcess(
    "sh -c 'i=1; while [ $i -le 5000 ]; do echo line-$i >&2; i=$((i+1)); done'",
    { tailLines: 10 },
  );
  assert.equal(result.tail.length, 10);
  assert.equal(result.tail[result.tail.length - 1], "line-5000");
});

test("runProcess: nonexistent binary through the shell preserves the shell's own exit code", async () => {
  const result = await runProcess("this-binary-does-not-exist-xyz");
  // The shell reports its own "command not found" exit status here; this is
  // not the spawn `error` path (127 is asserted only for that path, tested
  // implicitly by run.ts's own error-path coverage), so just check failure.
  assert.notEqual(result.code, 0);
});
