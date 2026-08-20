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
