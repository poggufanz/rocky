import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { runHarnessWizard } from "../setup/harness-wizard.js";
import type { PromptPort } from "../setup/prompt.js";

function ttyInput(): PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

function scriptedPrompt(answers: Array<string | undefined>): PromptPort {
  let cursor = 0;
  return {
    ask: async () => answers[cursor++] as string | undefined,
    confirm: async () => false,
  };
}

function collectOutput(): { stream: PassThrough; text(): string } {
  const stream = new PassThrough();
  let data = "";
  stream.on("data", (chunk: unknown) => { data += String(chunk); });
  return { stream, text: () => data };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("wizard title is exactly Select your Harness and output is ASCII-only", async () => {
  const input = ttyInput();
  const out = collectOutput();
  const pending = runHarnessWizard(scriptedPrompt([]), { input, output: out.stream });
  await tick();
  input.emit("data", Buffer.from("")); // Esc cancels
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.selections, []);
  assert.match(out.text(), /Select your Harness/);
  assert.ok(!/[^\x00-\x7F]/.test(out.text()), "wizard output must be ASCII-only");
});

test("space toggles and enter accepts a harness", async () => {
  const input = ttyInput();
  const out = collectOutput();
  // Phase 2 uses the same raw toggle UI, so keys (not scripted answers) drive it.
  const pending = runHarnessWizard(scriptedPrompt([]), { input, output: out.stream });
  await tick();
  input.emit("data", Buffer.from(" "));   // toggle first row (claude-code = registry order)
  await tick();
  input.emit("data", Buffer.from("\r"));  // accept phase 1
  await tick();
  await tick();
  input.emit("data", Buffer.from(" "));   // toggle MCP for claude-code
  await tick();
  input.emit("data", Buffer.from("\r"));  // accept phase 2
  const result = await pending;
  assert.equal(result.cancelled, false);
  assert.equal(result.selections.length, 1);
  assert.equal(result.selections[0]?.id, "claude-code");
  assert.equal(result.selections[0]?.mcp, true);
  assert.equal(result.selections[0]?.listening, false);
});

test("ctrl-c cancels and restores the terminal", async () => {
  const input = ttyInput();
  const rawCalls: boolean[] = [];
  input.setRawMode = (mode: boolean) => { rawCalls.push(mode); };
  const out = collectOutput();
  const pending = runHarnessWizard(scriptedPrompt([]), { input, output: out.stream });
  await tick();
  input.emit("data", Buffer.from(""));
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.ok(rawCalls.includes(false), "raw mode must be restored on cancel");
});

test("numbered fallback cancels on 0", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true; // TTY but no setRawMode => fallback path
  const out = collectOutput();
  const result = await runHarnessWizard(scriptedPrompt(["0"]), { input, output: out.stream });
  assert.equal(result.cancelled, true);
  assert.match(out.text(), /Select your Harness/);
});
