import { Buffer } from "node:buffer";
import type { Writable } from "node:stream";
import type { JsonRpcResponse } from "./protocol.js";

export const MAX_INPUT_LINE_BYTES = 1_048_576;

export type DecodedLine =
  | { kind: "message"; value: unknown }
  | { kind: "parse_error" }
  | { kind: "too_large" };

export class JsonLineDecoder {
  private buffer = Buffer.alloc(0);
  private discarding = false;

  constructor(private readonly maxLineBytes = MAX_INPUT_LINE_BYTES) {}

  push(chunk: Buffer | string): readonly DecodedLine[] {
    const input = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const decoded: DecodedLine[] = [];
    let start = 0;

    while (start < input.length) {
      const newline = input.indexOf(0x0a, start);
      if (newline === -1) {
        this.consume(input.subarray(start), false, decoded);
        break;
      }
      this.consume(input.subarray(start, newline), true, decoded);
      start = newline + 1;
    }

    return decoded;
  }

  end(): readonly DecodedLine[] {
    if (this.discarding) {
      this.discarding = false;
      return [{ kind: "too_large" }];
    }
    if (this.buffer.length === 0) return [];

    const line = this.buffer;
    this.buffer = Buffer.alloc(0);
    return [this.decode(line)];
  }

  private consume(segment: Buffer, terminated: boolean, decoded: DecodedLine[]): void {
    if (this.discarding) {
      if (terminated) {
        this.discarding = false;
        decoded.push({ kind: "too_large" });
      }
      return;
    }

    const lineLength = this.buffer.length + segment.length;
    const lastByte = segment.length > 0 ? segment.at(-1) : this.buffer.at(-1);
    const trailingCarriageReturn = lastByte === 0x0d;
    const framingCarriageReturn = terminated && trailingCarriageReturn;
    const pendingCarriageReturn = !terminated && trailingCarriageReturn && lineLength === this.maxLineBytes + 1;
    const contentLength = lineLength - (framingCarriageReturn ? 1 : 0);

    if (contentLength > this.maxLineBytes && !pendingCarriageReturn) {
      this.buffer = Buffer.alloc(0);
      if (terminated) decoded.push({ kind: "too_large" });
      else this.discarding = true;
      return;
    }

    if (!terminated) {
      this.buffer = Buffer.concat([this.buffer, segment]);
      return;
    }

    const line = this.buffer.length === 0 ? segment : Buffer.concat([this.buffer, segment]);
    this.buffer = Buffer.alloc(0);
    decoded.push(this.decode(line));
  }

  private decode(line: Buffer): DecodedLine {
    const content = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
    try {
      return { kind: "message", value: JSON.parse(content.toString("utf8")) as unknown };
    } catch {
      return { kind: "parse_error" };
    }
  }
}

export class SerializedJsonWriter {
  private pending: Promise<void> = Promise.resolve();
  private closeOutcome: "drained" | "timed_out" | undefined;
  private closing: Promise<"drained" | "timed_out"> | undefined;

  constructor(private readonly output: Writable) {}

  write(message: JsonRpcResponse): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    this.pending = this.pending.then(() => new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.output.off("error", onError);
        this.output.off("drain", onDrain);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onDrain = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      this.output.once("error", onError);
      try {
        if (this.output.write(line)) onDrain();
        else if (!settled) this.output.once("drain", onDrain);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }));
    return this.pending;
  }

  close(deadlineAt?: number): Promise<"drained" | "timed_out"> {
    if (this.closeOutcome !== undefined) return Promise.resolve(this.closeOutcome);
    if (this.closing !== undefined) return this.closing;

    this.closing = this.waitForPending(deadlineAt);
    void this.closing.then(
      (outcome) => {
        this.closeOutcome = outcome;
      },
      () => {
        this.closing = undefined;
      },
    );
    return this.closing;
  }

  private async waitForPending(deadlineAt?: number): Promise<"drained" | "timed_out"> {
    if (deadlineAt === undefined) {
      await this.pending;
      return "drained";
    }

    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return "timed_out";

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.pending.then(() => "drained" as const),
        new Promise<"timed_out">((resolve) => {
          timeout = setTimeout(() => resolve("timed_out"), remaining);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
