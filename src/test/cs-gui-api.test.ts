import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGui } from "../gui/server.js";

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-cs-gui-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-cs-gui-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

test("cs-explain needs token, refuses outside repo, redacts secret", async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "loop.js"), "// loop iteration\nfor (let i = 0; i < 3; i += 1) {\n total += i;\n}\n", "utf8");
  const h = await startGui({ port: 0, root });
  try {
    const noToken = await fetch(`http://127.0.0.1:${h.port}/api/cs-explain?path=loop.js&start=1&end=2`);
    assert.equal(noToken.status, 403);
    const headers = { "X-Rocky-Token": h.token };
    const ok = await fetch(`http://127.0.0.1:${h.port}/api/cs-explain?path=loop.js&start=1&end=2`, { headers });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.ok(body && typeof body.definition === "string" && Array.isArray(body.trace));
    const escape = await fetch(
      `http://127.0.0.1:${h.port}/api/cs-explain?path=${encodeURIComponent("../../../../etc/passwd")}`,
      { headers },
    );
    assert.equal(escape.status, 403);

    writeFileSync(
      join(root, "secret.js"),
      "// loop iteration ghp_111111111122222222223333333333444444\nfor (let i = 0; i < 3; i += 1) {\n total += i;\n}\n",
      "utf8",
    );
    const secretRes = await fetch(`http://127.0.0.1:${h.port}/api/cs-explain?path=secret.js&start=1&end=2`, { headers });
    assert.equal(secretRes.status, 200);
    const secretBody = (await secretRes.json()) as any;
    assert.ok(secretBody && secretBody.trace.some((l: string) => l.includes("[redacted github token]")));
  } finally {
    await h.close();
  }
});
