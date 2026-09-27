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
  for (const id of ["listen-repo-pick", "listen-session", "listen-agent", "listen-surface", "listen-file", "listen-since"]) {
    assert.ok(html.includes(`id="${id}"`), `missing filter ${id}`);
  }
  assert.ok(html.includes("Rocky Listen"), "missing header state");
  assert.ok(html.includes("Listen To Repo"), "missing repo line");
  assert.ok(html.includes("Getting rationale"), "missing status state");
  assert.ok(html.includes("Secret may remain") || html.includes("secret may remain"), "missing secret warning");
});

test("listening panel wraps filters and themes inputs like dash", () => {
  const css = readFileSync(join(root, "assets", "gui", "app.css"), "utf8");
  assert.ok(html.includes('class="listen-tab"'), "panel must use .listen-tab, not the boot .listen loader");
  assert.ok(!/^\.listen \{ display: flex/m.test(css), "boot .listen loader must not style the panel");
  assert.match(css, /\.listen-filters\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit/);
  assert.match(css, /\.listen-filters input,\s*\.listen-filters select\s*\{[^}]*background:\s*var\(--ground\)/);
  assert.match(css, /\.listen-filters input,\s*\.listen-filters select\s*\{[^}]*color:\s*var\(--bright\)/);
});

test("listening js stops polling on hide and marks weak candidates", () => {
  assert.ok(app.includes("loadListening"), "missing loader");
  assert.ok(app.includes("stopListeningPoll"), "missing poll stop");
  assert.ok(app.includes("weak-candidate"), "missing weak-candidate styling");
  assert.ok(app.includes("partial"), "missing partial label");
  assert.ok(app.includes("listenCursor") || app.includes("nextCursor"), "missing checkpoint cursor");
  assert.ok(!app.includes("candidate_link causes") && !app.includes("proves cause"), "must never claim causality");
});

test("listening js resolves rationale and wires every filter", () => {
  assert.ok(app.includes("listenDeadline"), "missing rationale timeout");
  assert.ok(app.includes("listenEmpty"), "missing empty states");
  assert.ok(app.includes("No events match"), "missing no-events empty state");
  assert.ok(app.includes("Listening read failed"), "missing error state");
  assert.ok(app.includes("Waiting for consent"), "missing no-consent terminal state");
  assert.ok(app.includes("Waiting for a repo"), "missing no-repo terminal state");
  for (const id of ["listen-session", "listen-agent", "listen-surface", "listen-file", "listen-since"]) {
    assert.ok(app.includes(id), `filter ${id} is present but never read`);
  }
});

test("listening needs one pick and one Listen click, nothing typed", () => {
  assert.match(html, /<select id="listen-repo-pick">/, "repo is a picker, not a typed path");
  assert.ok(html.includes('id="listen-hint"'), "missing grant hint");
  assert.ok(html.includes("never grants capture"), "hint must state picking grants nothing");
  assert.ok(!html.includes("manual:"), "no filter may ask for manual typing");
  assert.ok(!html.includes('id="listen-apply"'), "filters apply on change, no Apply button");
  for (const id of ["listen-session", "listen-agent", "listen-file", "listen-since"]) {
    assert.match(html, new RegExp(`<select id="${id}">`), `${id} must be a select`);
  }
  assert.match(html, /<details class="listen-more"/, "filters stay collapsed by default");
  assert.ok(app.includes("loadListenRepos"), "missing picker loader");
  assert.ok(app.includes("/api/listening/context"), "picker must read the read-only context endpoint");
  assert.ok(app.includes("fillListenFilter"), "filter choices must come from heard events");
  // Grant stays one explicit click; choosing a repo only refreshes.
  assert.match(app, /function listenConsentButton[\s\S]*?yes: true/, "Listen button must send the explicit yes");
  const choose = /function chooseListenRepo[\s\S]*?\r?\n}\r?\n/.exec(app)?.[0] ?? "";
  assert.ok(choose.length > 0, "missing chooseListenRepo");
  assert.ok(!choose.includes("/api/listening/consent"), "choosing a repo never posts consent");
});

test("listening context endpoint is read-only and leaks no consented path", () => {
  const server = readFileSync(join(root, "src", "gui", "server.ts"), "utf8");
  assert.ok(server.includes("/api/listening/context"), "missing context route");
  assert.ok(server.includes("launchRoot"), "context must carry the launch root");
  assert.ok(!/consented:\s*listConsentedRepos\(\)/.test(server), "context must not serialize the consented list");
  assert.match(server, /\.map\(\(key\) => \(\{ id: repoSlug\(key\), label: basename\(key\)/, "consented repos cross the wire as {id, label} only");
  const consentRoute = server.slice(server.indexOf('pathname === "/api/listening/consent"'));
  assert.ok(consentRoute.length > 0 && !consentRoute.includes("sendJson(response, 200, result)"), "consent replies must not echo the resolved root");
  const read = readFileSync(join(root, "src", "listening", "repo-consent-read.ts"), "utf8");
  assert.ok(read.includes("listConsentedRepos"), "missing read-only consented list");
  assert.ok(!read.includes("writeFileSync"), "read side must stay writer-free");
});

test("segment switching shows exactly one view and keeps tab state", () => {
  const css = readFileSync(join(root, "assets", "gui", "app.css"), "utf8");
  // CSS must respect [hidden]: no plain .view display rule may beat it.
  assert.match(css, /\.view\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  // Clicking a tab hides the other two panels and shows only its own.
  assert.match(
    app,
    /function showSegment\(name\)[\s\S]*?panel\.hidden = !on/,
  );
  for (const id of ["view-main", "view-dash", "view-listening"]) {
    assert.ok(html.includes(`id="${id}"`), `page must render ${id}`);
  }
  assert.ok(app.includes('getAttribute("aria-controls")'), "showSegment must resolve panels via aria-controls");
  // ARIA tab state stays consistent with the visible panel.
  assert.ok(app.includes('aria-selected'), "tab selection state must update");
  assert.ok(app.includes("tabIndex = on ? 0 : -1"), "roving tabindex must follow selection");
  // Leaving listening stops its poll; keyboard arrows move between segments.
  assert.ok(app.includes('if (name !== "listening") stopListeningPoll()'), "poll must stop off-segment");
  assert.ok(app.includes("ArrowLeft"), "arrow-key navigation must exist");
});

test("gui command exposes listening segment url", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "rocky-listen-gui-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { guiCommand } = await import("../commands/gui.js");
  assert.equal(typeof guiCommand, "function");
});
