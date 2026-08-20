import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolate ROCKY_HOME for one test, restoring the prior value (or absence) after. */
function withRockyHome(t: import("node:test").TestContext): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rocky-repl-")));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  });
}

test("repl dispatches known commands and refuses unknown, exits on quit", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["concepts\n", "nonsense-command\n", "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("repl exits 0 on exit as well as quit", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["exit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("repl exits 0 when input stream ends without quit (Ctrl-D)", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["concepts\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("repl help prints command list and keeps looping", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["help\n", "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("repl survives blank lines between commands", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["\n", "   \n", "concepts\n", "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("repl dispatches recall (async) and why (sync) without hanging", async (t) => {
  withRockyHome(t);
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(["recall some query\n", "why some/file.ts\n", "how naikin\n", "sessions\n", "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);
});

test("runReplCommand survives a thrown command instead of rejecting", async () => {
  const { runReplCommand } = await import("../commands/repl.js");
  const boom = {
    boom: () => {
      throw new Error("kaboom");
    },
  };
  const code = await runReplCommand("boom", [], false, boom);
  assert.equal(code, 1);
});

test("runReplCommand survives a thrown-async command instead of rejecting", async () => {
  const { runReplCommand } = await import("../commands/repl.js");
  const boom = {
    boom: async () => {
      throw new Error("kaboom-async");
    },
  };
  const code = await runReplCommand("boom", [], false, boom);
  assert.equal(code, 1);
});

test("runReplCommand refuses unknown command without throwing", async () => {
  const { runReplCommand } = await import("../commands/repl.js");
  const code = await runReplCommand("nonsense-command", [], false, {});
  assert.equal(code, 0);
});

test("runReplCommand help returns 0 without a dispatch table entry", async () => {
  const { runReplCommand } = await import("../commands/repl.js");
  const code = await runReplCommand("help", [], false, {});
  assert.equal(code, 0);
});

test("runReplCommand prepends --ai for recall and what, never for why, when useAi is true", async () => {
  const { runReplCommand } = await import("../commands/repl.js");
  const seen: Record<string, string[]> = {};
  const spy = (name: string) => (argv: string[]) => {
    seen[name] = argv;
    return 0;
  };
  const dispatch = { recall: spy("recall"), what: spy("what"), why: spy("why"), how: spy("how") };
  await runReplCommand("recall", ["build", "error"], true, dispatch);
  await runReplCommand("what", ["naikin"], true, dispatch);
  await runReplCommand("why", ["src/app.css"], true, dispatch);
  await runReplCommand("how", ["naikin"], true, dispatch);
  assert.deepEqual(seen.recall, ["--ai", "build", "error"]);
  assert.deepEqual(seen.what, ["--ai", "naikin"]);
  assert.deepEqual(seen.why, ["src/app.css"]); // never gets --ai: why has no such option
  assert.deepEqual(seen.how, ["naikin"]); // not AI-aware at all
});

test("repl concept alias with a quoted multi-word phrase writes the full phrase, not a truncated one", async (t) => {
  withRockyHome(t);
  const home = process.env.ROCKY_HOME as string;
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(['concept alias "flaky test" test-isolation\n', "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);

  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const lines = readFileSync(join(home, "memory.jsonl"), "utf8").split("\n").filter((l) => l.trim().length > 0);
  const records = lines.map((l) => JSON.parse(l));
  const alias = records.find((r) => r.kind === "alias");
  assert.ok(alias, "expected an alias record to be written");
  assert.equal(alias.alias, "flaky test");
  assert.equal(alias.concept, "test-isolation");
});

test("repl refuses an unterminated quote instead of writing a truncated alias, and still exits cleanly", async (t) => {
  withRockyHome(t);
  const home = process.env.ROCKY_HOME as string;
  const { replCommand } = await import("../commands/repl.js");
  const input = Readable.from(['concept alias "flaky test test-isolation\n', "quit\n"]);
  const code = await replCommand([], input);
  assert.equal(code, 0);

  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const memoryPath = join(home, "memory.jsonl");
  if (existsSync(memoryPath)) {
    const lines = readFileSync(memoryPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const records = lines.map((l) => JSON.parse(l));
    assert.equal(records.some((r) => r.kind === "alias"), false, "no alias record should have been written");
  }
});

test("repl exits cleanly instead of crashing when the input stream emits an error", async () => {
  const input = new Readable({ read() {} });
  const { replCommand } = await import("../commands/repl.js");
  const promise = replCommand([], input);
  setImmediate(() => input.emit("error", new Error("injected stream failure")));
  const code = await promise;
  assert.equal(code, 0);
});
