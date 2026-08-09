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

  const answer = port.confirm("send names, question", 1_000);
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
  assert.equal(await port.confirm("send names, question", 10), false);
  assert.equal(reads, 0);
});

test("TTY prompt falls back to process-style stdin when the controlling terminal cannot open", async () => {
  const input = ttyStream();
  const output = new PassThrough();
  const createWithFallback = createTtyPromptPort as unknown as (
    fallbackInput: typeof input,
    fallbackOutput: typeof output,
    controllingAsk: () => Promise<{ available: false }>,
  ) => PromptPort | undefined;
  const port = createWithFallback(input, output, async () => ({ available: false }));
  assert.ok(port);

  const answer = port.ask("answer, question ", 1_000);
  input.write("fallback works\n");

  assert.equal(await answer, "fallback works");
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
