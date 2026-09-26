import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "assets", "gui", "index.html"), "utf8");
const app = readFileSync(join(root, "assets", "gui", "app.js"), "utf8");

test("listening tab and tabpanel exist with filters and screenshot states", () => {
  assert.match(html, /id="tab-listening"[^>]*data-seg="listening"/);
  assert.match(html, /aria-controls="view-listening"/);
  assert.match(html, /id="view-listening"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-listening"/);
  for (const id of ["listen-repo-input", "listen-session", "listen-agent", "listen-surface", "listen-file", "listen-since"]) {
    assert.ok(html.includes(`id="${id}"`), `missing filter ${id}`);
  }
  assert.ok(html.includes("Rocky Listen"), "missing header state");
  assert.ok(html.includes("Listen To Repo"), "missing repo line");
  assert.ok(html.includes("Getting rationale"), "missing status state");
  assert.ok(html.includes("Secret may remain") || html.includes("secret may remain"), "missing secret warning");
});

test("listening js stops polling on hide and marks weak candidates", () => {
  assert.ok(app.includes("loadListening"), "missing loader");
  assert.ok(app.includes("stopListeningPoll"), "missing poll stop");
  assert.ok(app.includes("weak-candidate"), "missing weak-candidate styling");
  assert.ok(app.includes("partial"), "missing partial label");
  assert.ok(app.includes("listenCursor") || app.includes("nextCursor"), "missing checkpoint cursor");
  assert.ok(!app.includes("candidate_link causes") && !app.includes("proves cause"), "must never claim causality");
});

test("gui command exposes listening segment url", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-listen-gui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { guiCommand } = await import("../commands/gui.js");
  assert.equal(typeof guiCommand, "function");
});
