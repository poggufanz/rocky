import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { SetupUsageError, parseSetupArgs } from "../setup/parser.js";
import { runHarnessWizard, selectionsToSetupOptions } from "../setup/harness-wizard.js";
import { MCP_HARNESS_IDS } from "../setup/harness-mcp-dispatch.js";
import { createPlatformServices } from "../setup/platform.js";
import type { ProcessRunner } from "../setup/process.js";
import type { PromptPort } from "../setup/prompt.js";
import { setup, type SetupDependencies } from "../commands/setup.js";

function usageError(argv: string[]): string {
  try {
    parseSetupArgs(argv);
  } catch (error) {
    assert.ok(error instanceof SetupUsageError);
    return error.message;
  }
  throw new Error("expected SetupUsageError");
}

test("bare --harness asks for the picker instead of failing", () => {
  const bare = parseSetupArgs(["--harness"]);
  assert.equal(bare.wizard, true);
  assert.deepEqual(bare.harnesses, []);
  assert.equal(bare.mcp, true);
  assert.equal(parseSetupArgs(["--harness", "--yes"]).wizard, true);
  assert.equal(parseSetupArgs(["--harness", "--yes"]).yes, true);
  assert.equal(parseSetupArgs(["--harness", "codex"]).wizard, undefined);
});

test("picker cannot mix with explicit selectors or other actions", () => {
  for (const argv of [
    ["--harness", "codex", "--harness"],
    ["--harness", "--harness", "codex"],
    ["--harness", "--listening"],
    ["--harness", "--mcp"],
    ["--harness", "--check"],
    ["--harness", "--remove"],
    ["--harness", "--agent-hooks"],
    ["--harness", "--voice-skill"],
    ["--harness", "--repo", "/r", "--allow-capture"],
  ]) {
    assert.match(usageError(argv), /picker/, argv.join(" "));
  }
});

test("selections become MCP-scoped options and drop listening-only hosts", () => {
  const base = parseSetupArgs(["--harness", "--yes"]);
  const next = selectionsToSetupOptions(base, [
    { id: "codex", mcp: true, listening: false },
    { id: "opencode", mcp: true, listening: true },
    { id: "claude-code", mcp: false, listening: true },
  ]);
  assert.deepEqual(next.harnesses, ["codex", "opencode"]);
  assert.deepEqual(next.harness, ["codex", "opencode"]);
  assert.equal(next.mcp, true);
  assert.equal(next.yes, true);
  assert.equal(next.wizard, false);
  assert.equal(base.wizard, true, "input options must stay untouched");
});

function throwingRunner(): ProcessRunner {
  return { async run() { throw new Error("no process in this test"); } };
}

function deps(overrides: Partial<SetupDependencies>): SetupDependencies {
  return {
    runner: throwingRunner(),
    platform: createPlatformServices({ platform: "linux", home: "/home/ada", env: { PATH: "/tools" }, isWsl: false }),
    adapters: [],
    confirmation: { async confirm() { throw new Error("no prompt in this test"); } },
    ...overrides,
  };
}

async function captureStderr(run: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("picker without an interactive terminal stops with usage code", async () => {
  const out = await captureStderr(() => setup(["--harness"], deps({ isTTY: false })));
  assert.equal(out.code, 2);
  assert.match(out.stderr, /interactive/);
  assert.match(out.stderr, /rocky setup --harness codex/);
});

test("cancelled picker changes nothing and exits 1", async () => {
  const out = await captureStderr(() => setup(["--harness"], deps({
    isTTY: true,
    pickHarnesses: async () => ({ cancelled: true, selections: [] }),
  })));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /nothing changed/);
});

test("listening-only pick stops without touching any host", async () => {
  const out = await captureStderr(() => setup(["--harness"], deps({
    isTTY: true,
    pickHarnesses: async () => ({ cancelled: false, selections: [{ id: "codex", mcp: false, listening: true }] }),
  })));
  assert.equal(out.code, 1);
  assert.match(out.stderr, /listening/);
  assert.match(out.stderr, /--allow-capture/);
});

function ttyInput(): PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode(mode: boolean): void };
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

const noPrompt: PromptPort = { ask: async () => undefined, confirm: async () => false };
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("menu redraws in place on a TTY output instead of stacking copies", async () => {
  const input = ttyInput();
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let text = "";
  output.on("data", (chunk: unknown) => { text += String(chunk); });
  const pending = runHarnessWizard(noPrompt, { input, output });
  await tick();
  input.emit("data", Buffer.from("\u001b[B")); // Down
  await tick();
  input.emit("data", Buffer.from("\u001b")); // Esc
  await pending;
  const titleCount = text.split("Select your Harness").length - 1;
  assert.equal(titleCount, 2, "one initial draw plus one redraw");
  // title + 11 harness rows + hint line = 13 lines to rewind before the redraw
  assert.ok(text.includes("\u001b[13A\u001b[J"), "redraw must rewind the whole menu");
});

test("picker lists only given ids and every pick is MCP with no feature phase", async () => {
  const input = ttyInput();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: unknown) => { text += String(chunk); });
  const pending = runHarnessWizard(noPrompt, { input, output }, MCP_HARNESS_IDS);
  await tick();
  input.emit("data", Buffer.from("\u001b[B")); // Down to codex
  await tick();
  input.emit("data", Buffer.from(" "));
  await tick();
  input.emit("data", Buffer.from("\r"));
  const result = await pending;
  assert.deepEqual(result, { cancelled: false, selections: [{ id: "codex", mcp: true, listening: false }] });
  assert.doesNotMatch(text, /antigravity|cursor|devin|omp|dsh|vscode/);
  assert.doesNotMatch(text, /Features for/);
});

test("MCP picker ids are exactly the hosts with MCP adapters", () => {
  assert.deepEqual([...MCP_HARNESS_IDS], ["claude-code", "codex", "opencode", "gemini-cli", "copilot-cli"]);
});

test("menu keeps plain append output when the stream is not a TTY", async () => {
  const input = ttyInput();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: unknown) => { text += String(chunk); });
  const pending = runHarnessWizard(noPrompt, { input, output });
  await tick();
  input.emit("data", Buffer.from("\u001b[B"));
  await tick();
  input.emit("data", Buffer.from("\u001b"));
  await pending;
  assert.ok(!text.includes("\u001b["), "no cursor codes on non-TTY output");
});
