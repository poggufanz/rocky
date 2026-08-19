import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("concept alias add writes alias record; concepts lists it", async () => {
  process.env.ROCKY_HOME = realpathSync(mkdtempSync(join(tmpdir(), "rocky-cc-")));
  const { conceptsCommand } = await import("../commands/concepts.js");
  assert.equal(conceptsCommand(["alias", "jangan jalan dua kali", "idempotency"]), 0);
  assert.equal(conceptsCommand([]), 0);          // list — smoke, output on stderr
  assert.equal(conceptsCommand(["idempotency"]), 0); // reverse lookup — smoke
  assert.equal(conceptsCommand(["alias", "x", "not-a-concept"]), 1); // unknown concept refused
});
