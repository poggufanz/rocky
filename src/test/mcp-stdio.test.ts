import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import test from "node:test";
import {
  JsonLineDecoder,
  MAX_INPUT_LINE_BYTES,
  SerializedJsonWriter,
} from "../mcp/stdio.js";

class BackpressureWritable extends Writable {
  readonly chunks: string[] = [];
  private blocked = true;

  override write(chunk: string | Uint8Array): boolean {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    if (!this.blocked) return true;
    return false;
  }

  releaseDrain(): void {
    this.blocked = false;
    this.emit("drain");
  }

  fail(error: Error): void {
    this.emit("error", error);
  }

  lines(): string[] {
    return this.chunks.join("").trimEnd().split("\n");
  }
}

test("decoder retains split UTF-8 bytes until a complete line arrives", () => {
  const decoder = new JsonLineDecoder();
  const input = Buffer.from('{"currency":"€"}\n');
  const splitAt = input.indexOf(Buffer.from("€")) + 1;

  assert.deepEqual(decoder.push(input.subarray(0, splitAt)), []);
  assert.deepEqual(decoder.push(input.subarray(splitAt)), [
    { kind: "message", value: { currency: "€" } },
  ]);
});

test("decoder emits multiple newline-delimited messages from one chunk", () => {
  const decoder = new JsonLineDecoder();

  assert.deepEqual(decoder.push('{"id":1}\n{"id":2}\n'), [
    { kind: "message", value: { id: 1 } },
    { kind: "message", value: { id: 2 } },
  ]);
});

test("decoder strips CR before newline framing", () => {
  const decoder = new JsonLineDecoder();

  assert.deepEqual(decoder.push('{"ok":true}\r\n'), [
    { kind: "message", value: { ok: true } },
  ]);
});

test("decoder parses a final unterminated line on end", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"final":true}'), []);

  assert.deepEqual(decoder.end(), [
    { kind: "message", value: { final: true } },
  ]);
});

test("decoder marks invalid JSON as a parse error", () => {
  const decoder = new JsonLineDecoder();

  assert.deepEqual(decoder.push('{not json}\n'), [{ kind: "parse_error" }]);
});

test("decoder accepts a JSON line of exactly one MiB", () => {
  const decoder = new JsonLineDecoder();
  const line = `"${"a".repeat(MAX_INPUT_LINE_BYTES - 2)}"`;

  const decoded = decoder.push(`${line}\n`);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]?.kind, "message");
  if (decoded[0]?.kind !== "message") return;
  assert.equal(typeof decoded[0].value, "string");
  assert.equal((decoded[0].value as string).length, MAX_INPUT_LINE_BYTES - 2);
});

test("decoder rejects a JSON line larger than one MiB", () => {
  const decoder = new JsonLineDecoder();
  const line = `"${"a".repeat(MAX_INPUT_LINE_BYTES - 1)}"`;

  assert.deepEqual(decoder.push(`${line}\n`), [{ kind: "too_large" }]);
});

test("oversized input discards until newline and then recovers", () => {
  const decoder = new JsonLineDecoder(8);

  assert.deepEqual(decoder.push("123456789"), []);
  assert.deepEqual(decoder.push('ignored\n{"x":1}\n'), [
    { kind: "too_large" },
    { kind: "message", value: { x: 1 } },
  ]);
});

test("serialized writer waits for drain and never interleaves lines", async () => {
  const output = new BackpressureWritable();
  const writer = new SerializedJsonWriter(output);
  const first = writer.write({ jsonrpc: "2.0", id: 1, result: { value: "a" } });
  const second = writer.write({ jsonrpc: "2.0", id: 2, result: { value: "b" } });

  await Promise.resolve();
  assert.deepEqual(output.lines(), ['{"jsonrpc":"2.0","id":1,"result":{"value":"a"}}']);
  output.releaseDrain();
  await Promise.all([first, second]);
  assert.deepEqual(output.lines(), [
    '{"jsonrpc":"2.0","id":1,"result":{"value":"a"}}',
    '{"jsonrpc":"2.0","id":2,"result":{"value":"b"}}',
  ]);
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(output.listenerCount("error"), 0);
});

test("serialized writer rejects write errors and removes listeners", async () => {
  const output = new BackpressureWritable();
  const writer = new SerializedJsonWriter(output);
  const pending = writer.write({ jsonrpc: "2.0", id: 1, result: {} });
  const failure = new Error("write failed");

  await Promise.resolve();
  output.fail(failure);
  await assert.rejects(pending, failure);
  assert.equal(output.listenerCount("drain"), 0);
  assert.equal(output.listenerCount("error"), 0);
});

test("writer close returns timed_out at an absolute deadline without ending stdout", async () => {
  const output = new BackpressureWritable();
  let endCalls = 0;
  output.end = (() => {
    endCalls += 1;
    return output;
  }) as typeof output.end;
  const writer = new SerializedJsonWriter(output);
  const pending = writer.write({ jsonrpc: "2.0", id: 1, result: {} });

  assert.equal(await writer.close(Date.now() + 20), "timed_out");
  assert.equal(endCalls, 0);
  output.fail(new Error("cleanup"));
  await assert.rejects(pending, /cleanup/);
});

test("writer close drains completed work without ending stdout", async () => {
  const output = new BackpressureWritable();
  let endCalls = 0;
  output.end = (() => {
    endCalls += 1;
    return output;
  }) as typeof output.end;
  const writer = new SerializedJsonWriter(output);
  const pending = writer.write({ jsonrpc: "2.0", id: 1, result: {} });

  await Promise.resolve();
  output.releaseDrain();
  await pending;
  assert.equal(await writer.close(Date.now() + 1_000), "drained");
  assert.equal(endCalls, 0);
});
