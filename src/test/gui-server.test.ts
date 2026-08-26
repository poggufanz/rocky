import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGui, type GuiHandle } from "../gui/server.js";
import { publicSettings, readSettings, writeSettings } from "../gui/settings.js";

/**
 * Every test gets its own ROCKY_HOME and its own repo root, so nothing here
 * reads or writes the developer's real memory.
 */
function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-gui-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-gui-root-"));
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Raw client, because fetch() silently drops a hand-set Host header. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((done) => {
    const call = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    call.end();
  });
}

async function withGui(root: string, run: (h: GuiHandle) => Promise<void>): Promise<void> {
  const handle = await startGui({ port: 0, root });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

const json = async (h: GuiHandle, path: string, init: RequestInit = {}): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    ...init,
    headers: { "X-Rocky-Token": h.token, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("api refuses a request with no token and with the wrong token", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    const none = await rawGet(h.port, "/api/home", { Host: `127.0.0.1:${h.port}` });
    assert.equal(none.status, 403);
    const wrong = await rawGet(h.port, "/api/home", {
      Host: `127.0.0.1:${h.port}`,
      "X-Rocky-Token": "0".repeat(32),
    });
    assert.equal(wrong.status, 403);
  });
});

test("api refuses a foreign Host, which is how dns rebinding arrives", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    const rebind = await rawGet(h.port, "/api/home", {
      Host: "evil.test",
      "X-Rocky-Token": h.token,
    });
    assert.equal(rebind.status, 403);

    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`]) {
      const good = await rawGet(h.port, "/api/home", { Host: host, "X-Rocky-Token": h.token });
      assert.equal(good.status, 200);
    }
  });
});

test("a path outside the launch repo is refused, not read", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    const escape = await json(h, `/api/file?path=${encodeURIComponent("../../../../etc/passwd")}`);
    assert.equal(escape.status, 403);
  });
});

test("a file memory names outside the launch repo still reads", async () => {
  const { home, root } = hermetic();
  // memory hears files from every cwd, so a file can live outside the tree
  // rocky was launched in; the dash lists it either way and must read it too
  const outside = mkdtempSync(join(tmpdir(), "rocky-gui-outside-"));
  const target = join(outside, "heard.ts");
  writeFileSync(target, "const heard = true;\n");
  const named = target.replace(/\\/g, "/");
  seedMemory(home, [{
    kind: "explain",
    id: "e1",
    v: 1,
    ts: Date.now(),
    cwd: outside,
    path: named,
    source: "agent:test",
    code: "const heard = true;",
    business: "a heard file reads wherever it lives",
    snippet: "const heard = true;",
  }]);

  await withGui(root, async (h) => {
    const heard = await json(h, `/api/file?path=${encodeURIComponent(named)}`);
    assert.equal(heard.status, 200);
    // the trailing newline splits into a final empty line, as on disk
    assert.deepEqual(heard.body.lines, ["const heard = true;", ""]);
  });
});

test("file reads stop at the line cap and disclose that they were cut", async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "long.ts"), Array.from({ length: 2500 }, (_, i) => `const l${i} = ${i};`).join("\n"));
  writeFileSync(join(root, "short.ts"), "const a = 1;\nconst b = 2;\n");

  await withGui(root, async (h) => {
    const long = await json(h, "/api/file?path=long.ts");
    assert.equal(long.body.lines.length, 2000);
    assert.equal(long.body.truncated, true);

    const short = await json(h, "/api/file?path=short.ts");
    assert.equal(short.body.truncated, false);

    const gone = await json(h, "/api/file?path=nothing-here.ts");
    assert.equal(gone.body.missing, true);
  });
});

test("a windows path in the wrong case still reaches its file", { skip: process.platform !== "win32" }, async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "cased.ts"), "const a = 1;\n");
  await withGui(root, async (h) => {
    // memory canonicalises paths to lower case; the file must still be found
    const lowered = join(root, "cased.ts").toLowerCase();
    const answer = await json(h, `/api/file?path=${encodeURIComponent(lowered)}`);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.missing, undefined, "a lower-cased repo path must not read as missing");
    assert.deepEqual(answer.body.lines, ["const a = 1;", ""]);
  });
});

test("teach answers with the witness card when rocky heard a why", async () => {
  const { home, root } = hermetic();
  // the recorded code line and the selected snippet must share enough tokens
  // to clear the teach similarity threshold, the same as in real use
  const snippet = "const cap = readCap(path, bytes);";
  writeFileSync(join(root, "save.ts"), `${snippet}\nreturn cap;\n`);
  seedMemory(home, [{
    kind: "explain",
    id: "e1",
    v: 1,
    ts: Date.now() - 3_600_000,
    cwd: root,
    path: "save.ts",
    source: "agent:claude-code",
    code: snippet,
    business: "a partial read must never be reported as complete",
    snippet,
  }]);

  await withGui(root, async (h) => {
    const card = await json(h, "/api/teach", {
      method: "POST",
      body: JSON.stringify({ path: "save.ts", start: 1, end: 2 }),
    });
    assert.equal(card.status, 200);
    assert.ok(
      String(card.body?.header ?? "").startsWith("rocky heard this"),
      `expected a witness header, got ${JSON.stringify(card.body)}`,
    );
  });
});

test("teach never claims a witness it does not have", async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "plain.ts"), "const a = 1;\n");
  await withGui(root, async (h) => {
    const card = await json(h, "/api/teach", {
      method: "POST",
      body: JSON.stringify({ path: "plain.ts", start: 1, end: 1 }),
    });
    assert.equal(card.status, 200);
    const header = String(card.body?.header ?? "");
    assert.ok(header === "" || !header.startsWith("rocky heard this"));
  });
});

test("the shell and its assets are served, and unknown routes are not", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    for (const path of ["/", "/?v=dash", "/assets/app.css", "/assets/app.js"]) {
      const res = await rawGet(h.port, path, { Host: `127.0.0.1:${h.port}` });
      assert.equal(res.status, 200, `${path} should serve without a token`);
    }
    const missing = await rawGet(h.port, "/dash", { Host: `127.0.0.1:${h.port}` });
    assert.equal(missing.status, 404, "there is one route, so /dash does not exist");
  });
});

test("the served page reaches no host outside this machine", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    for (const path of ["/", "/assets/app.css", "/assets/app.js"]) {
      const res = await rawGet(h.port, path, { Host: `127.0.0.1:${h.port}` });
      const external = res.body.match(/https?:\/\/(?!127\.0\.0\.1|localhost)[^\s"'`)]+/g) ?? [];
      const fetched = external.filter((url) =>
        // an xml namespace is an identifier, never a request
        !url.startsWith("http://www.w3.org/") &&
        // provider defaults are strings the user edits, never something fetched
        !url.includes("api.openai.com") && !url.includes("api.anthropic.com"));
      assert.deepEqual(fetched, [], `${path} references ${fetched.join(", ")}`);
    }
  });
});

test("settings hand back everything except the key", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    const before = await json(h, "/api/settings");
    assert.equal(before.body.hasKey, false);

    await json(h, "/api/settings", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", endpoint: "http://127.0.0.1:1/v1/chat/completions", model: "m", key: "sk-secret" }),
    });

    const after = await json(h, "/api/settings");
    assert.equal(after.body.hasKey, true);
    assert.ok(!JSON.stringify(after.body).includes("sk-secret"), "the key must never travel to the page");
  });
});

test("saving one field leaves the stored key alone", () => {
  const { home } = hermetic();
  writeSettings({ provider: "openai", endpoint: "e", model: "m", key: "sk-keep" });
  writeSettings({ model: "other" });
  assert.equal(readSettings().key, "sk-keep");
  assert.equal(readSettings().model, "other");
  assert.equal(publicSettings(readSettings()).hasKey, true);
  assert.ok(!readFileSync(join(home, "gui.json"), "utf8").includes('"hasKey"'));
});

test("an empty key is an explicit erase", () => {
  hermetic();
  writeSettings({ endpoint: "e", model: "m", key: "sk-gone" });
  writeSettings({ key: "" });
  assert.equal(readSettings().key, "");
  assert.equal(publicSettings(readSettings()).hasKey, false);
});

test("ask refuses before a key is stored", async () => {
  const { root } = hermetic();
  await withGui(root, async (h) => {
    const answer = await json(h, "/api/ask", { method: "POST", body: JSON.stringify({ prompt: "why" }) });
    assert.equal(answer.status, 400);
  });
});

test("the ask rides the english spec when the settings say en", async () => {
  const { root } = hermetic();
  let seen = "";
  const provider: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw).messages[0].content;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    await withGui(root, async (h) => {
      await json(h, "/api/settings", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
          model: "m",
          key: "sk-test",
          lang: "en",
        }),
      });

      const answer = await json(h, "/api/ask", { method: "POST", body: JSON.stringify({ prompt: "why" }) });
      assert.equal(answer.status, 200);
      assert.ok(seen.includes("Output language: English."), "the english spec did not ride the ask");
      assert.ok(!seen.includes("Output language: Indonesian."), "the wrong spec rode the ask");
    });
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});

test("the ask digs the file and its imports before forwarding", async () => {
  const { root } = hermetic();
  writeFileSync(join(root, "b.ts"), 'export const MARKER_B = "found-in-b";\nconst token = "ghp_DDDDDDDDEEEEEEEEFFFFFFFFGGGGGGGG1111";\n');
  writeFileSync(join(root, "a.ts"), 'import { MARKER_B } from "./b.js";\nconsole.log(MARKER_B);\n');

  let seen = "";
  const provider: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw).messages[0].content;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    await withGui(root, async (h) => {
      await json(h, "/api/settings", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
          model: "m",
          key: "sk-test",
        }),
      });

      const answer = await json(h, "/api/ask", {
        method: "POST",
        body: JSON.stringify({ prompt: "why", path: "a.ts", start: 1, end: 2 }),
      });
      assert.equal(answer.status, 200);
      assert.ok(seen.includes("=== file a.ts (whole) ==="), "the file itself did not ride the ask");
      assert.ok(seen.includes("found-in-b"), "the imported neighbour did not ride the ask");
      assert.ok(!seen.includes("ghp_DDDDDDDDEEEEEEEEFFFFFFFFGGGGGGGG1111"), "a neighbour's secret reached the provider");
    });
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});

test("the prompt is redacted before it leaves the machine", async () => {
  const { root } = hermetic();
  let seen = "";
  const provider: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw).messages[0].content;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((up) => provider.listen(0, "127.0.0.1", () => up()));
  const providerPort = (provider.address() as { port: number }).port;

  try {
    await withGui(root, async (h) => {
      await json(h, "/api/settings", {
        method: "POST",
        body: JSON.stringify({
          provider: "openai",
          endpoint: `http://127.0.0.1:${providerPort}/v1/chat/completions`,
          model: "deepseek-v4-flash",
          key: "sk-test",
        }),
      });

      const answer = await json(h, "/api/ask", {
        method: "POST",
        body: JSON.stringify({ prompt: 'const token = "ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234";' }),
      });
      assert.equal(answer.status, 200);
      assert.ok(!seen.includes("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH1234"), "the secret reached the provider");
      // the whole spec rides with every ask, so editing the file edits the investigator
      assert.ok(seen.includes("Teach investigator"), "the teach spec did not reach the provider");
      assert.ok(seen.includes("HARD STOP"), "the teach spec did not reach the provider whole");
    });
  } finally {
    await new Promise<void>((down) => provider.close(() => down()));
  }
});
