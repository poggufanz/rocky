import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { registryConsent } from "../commands/check.js";
import { createPromptPort, createTtyPromptPort, type PromptPort } from "../setup/prompt.js";

function ttyStream(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}

function pipedStream(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = false;
  return stream;
}

/** The controlling-terminal seam is not part of the exported signature. */
const createWithControllingAsk = createTtyPromptPort as unknown as (
  fallbackInput: PassThrough & { isTTY: boolean },
  fallbackOutput: PassThrough,
  controllingAsk: () => Promise<{ available: boolean; answer?: string }>,
) => PromptPort | undefined;

/** Stub one property for the rest of the test; the returned function restores it exactly. */
function stubProperty(target: object, key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true });
  return () => {
    if (original === undefined) delete (target as Record<string, unknown>)[key];
    else Object.defineProperty(target, key, original);
  };
}

test("prompt port returns a free-text answer", async () => {
  const input = ttyStream();
  const output = new PassThrough();
  const port = createPromptPort(input, output);

  const answer = port.ask("explain: ", 1_000);
  input.write("because it validates input\n");

  assert.equal(await answer, "because it validates input");
});

test("prompt port supports boolean consent", async () => {
  const input = ttyStream();
  const output = new PassThrough();
  const port = createPromptPort(input, output);

  const answer = port.confirm("Send package names?", 1_000);
  input.write("yes\n");

  assert.equal(await answer, true);
});

test("prompt port times out to undefined without keeping the process open", async () => {
  const input = ttyStream();
  const output = new PassThrough();
  const port = createPromptPort(input, output);

  assert.equal(await port.ask("answer: ", 10), undefined);
});

test("prompt port silently declines non-TTY input without reading", async () => {
  let reads = 0;
  const input = {
    isTTY: false,
    read() { reads += 1; throw new Error("must not read"); },
  };
  const port = createPromptPort(input, new PassThrough());

  assert.equal(await port.ask("answer: ", 10), undefined);
  assert.equal(await port.confirm("Send package names?", 10), false);
  assert.equal(reads, 0);
});

test("TTY prompt falls back to process-style stdin when the controlling terminal cannot open", async () => {
  const input = ttyStream();
  const output = new PassThrough();
  const port = createWithControllingAsk(input, output, async () => ({ available: false }));
  assert.ok(port);

  const answer = port.ask("Your answer? ", 1_000);
  input.write("fallback works\n");

  assert.equal(await answer, "fallback works");
});

test("on win32 a terminal stderr alone cannot answer, so the TTY prompt declines", (t) => {
  // /dev/tty does not exist on Windows: a TTY stderr there promised an answer
  // nothing could give, and the question header printed with no way to reply.
  t.after(stubProperty(process, "platform", "win32"));
  t.after(stubProperty(process.stderr, "isTTY", true));

  const port = createWithControllingAsk(pipedStream(), new PassThrough(), async () => ({ available: false }));

  assert.equal(port, undefined);
});

test("on win32 a terminal stdin still prompts through the fallback", async (t) => {
  t.after(stubProperty(process, "platform", "win32"));
  for (const stderrIsTTY of [true, false]) {
    const restore = stubProperty(process.stderr, "isTTY", stderrIsTTY);
    try {
      const input = ttyStream();
      const port = createWithControllingAsk(input, new PassThrough(), async () => ({ available: false }));
      assert.ok(port, `stderr TTY ${stderrIsTTY}: stdin is the terminal, so the prompt stays available`);

      const answer = port.ask("Your answer? ", 1_000);
      input.write("typed on win32\n");

      assert.equal(await answer, "typed on win32");
    } finally {
      restore();
    }
  }
});

test("off win32 a terminal stderr keeps the controlling-terminal prompt while stdin is piped", async (t) => {
  t.after(stubProperty(process, "platform", "linux"));
  t.after(stubProperty(process.stderr, "isTTY", true));

  const port = createWithControllingAsk(pipedStream(), new PassThrough(), async () => ({
    available: true,
    answer: "from the controlling terminal",
  }));

  assert.ok(port, "POSIX behavior is unchanged: a TTY stderr is enough to reach /dev/tty");
  assert.equal(await port.ask("Your answer? ", 1_000), "from the controlling terminal");
});

test("off win32 without any terminal the TTY prompt still declines", (t) => {
  t.after(stubProperty(process, "platform", "linux"));
  t.after(stubProperty(process.stderr, "isTTY", false));

  assert.equal(createWithControllingAsk(pipedStream(), new PassThrough(), async () => ({ available: false })), undefined);
});

test("quiet skips first consent during scans but not during hook installation", async (t) => {
  const previous = process.env.ROCKY_HOME;
  const rockyHome = mkdtempSync(join(tmpdir(), "rocky-prompt-consent-"));
  process.env.ROCKY_HOME = rockyHome;
  t.after(() => {
    rmSync(rockyHome, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
  let asked = 0;
  const prompt: PromptPort = {
    async ask() { asked += 1; return "yes"; },
    async confirm() { throw new Error("registry consent uses free-text ask"); },
  };

  const skipped = await registryConsent(true, false, () => prompt);
  assert.equal(skipped, false);
  assert.equal(asked, 0);

  const enabled = await registryConsent(true, true, () => prompt);

  assert.equal(enabled, true);
  assert.equal(asked, 1);
});
