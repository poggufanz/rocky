import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request, type Server } from "node:http";

import { repoForPath } from "../core/repo-groups.js";
import { startGui, type GuiHandle } from "../gui/server.js";

/** A temp root per test, so nothing here touches the developer's real repos. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "rocky-repo-groups-"));
}

const named = (p: string): string => p.replace(/\\/g, "/");

test("a file under a .git directory belongs to that repo", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-a", "src"), { recursive: true });
  assert.equal(await repoForPath(named(join(root, "repo-a", "src", "a.ts"))), "repo-a");
});

test("a file with no .git ancestor is non-repo", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "plain"), { recursive: true });
  assert.equal(await repoForPath(named(join(root, "plain", "b.txt"))), null);
});

test("a worktree .git file still marks the repo", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "wt"), { recursive: true });
  writeFileSync(join(root, "wt", ".git"), "gitdir: elsewhere\n");
  assert.equal(await repoForPath(named(join(root, "wt", "x.ts"))), "wt");
});

test("the nearest repo wins over an outer one", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "outer", ".git"), { recursive: true });
  mkdirSync(join(root, "outer", "inner", ".git"), { recursive: true });
  assert.equal(await repoForPath(named(join(root, "outer", "inner", "i.ts"))), "inner");
});

test("the cache turns a second walk into the same answer", async () => {
  const root = tempRoot();
  mkdirSync(join(root, "repo-b", ".git"), { recursive: true });
  mkdirSync(join(root, "repo-b", "src"), { recursive: true });
  const cache = new Map<string, string | null>();
  const first = await repoForPath(named(join(root, "repo-b", "src", "a.ts")), cache);
  const second = await repoForPath(named(join(root, "repo-b", "src", "b.ts")), cache);
  assert.equal(first, "repo-b");
  assert.equal(second, first);
});

/* ---- the dash surface --------------------------------------------------- */

function hermetic(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), "rocky-repo-home-"));
  const root = tempRoot();
  process.env.ROCKY_HOME = home;
  return { home, root };
}

function seedMemory(home: string, records: unknown[]): void {
  writeFileSync(join(home, "memory.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function withGui(root: string, run: (h: GuiHandle) => Promise<void>): Promise<void> {
  const handle = await startGui({ port: 0, root });
  try {
    await run(handle);
  } finally {
    await handle.close();
  }
}

const json = async (h: GuiHandle, path: string): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, {
    headers: { "X-Rocky-Token": h.token },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test("api/files names the repo each heard file lives in", async () => {
  const { home, root } = hermetic();
  mkdirSync(join(root, "repo-a", ".git"), { recursive: true });
  mkdirSync(join(root, "plain"), { recursive: true });
  const inRepo = named(join(root, "repo-a", "a.ts"));
  const stray = named(join(root, "plain", "b.txt"));
  const explain = (id: string, path: string): unknown => ({
    kind: "explain", id, v: 1, ts: Date.now(), cwd: root, path, source: "agent:test",
    code: "const heard = true;", business: "a heard file joins the dash list",
  });
  seedMemory(home, [explain("e1", inRepo), explain("e2", stray)]);

  await withGui(root, async (h) => {
    const res = await json(h, "/api/files");
    assert.equal(res.status, 200);
    const byPath = new Map<string, { path: string; repo: string | null }>(
      res.body.map((f: { path: string; repo: string | null }) => [f.path, f]),
    );
    assert.equal(byPath.get(inRepo)?.repo, "repo-a");
    assert.equal(byPath.get(stray)?.repo, null);
  });
});
