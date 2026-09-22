import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_RENDER_ORDER,
  RAW_CHAT_TEMPLATE,
  renderChatText,
  safeRenderChatText,
  validateRenderedClaims,
} from "../ai/chat-render.js";
import { startGui } from "../gui/server.js";

test("template render carries only code-owned facts", () => {
  const text = renderChatText({
    topRef: "failure-aaa",
    topKind: "failure",
    topScore: 0.9,
    engine: "jev",
    status: "used",
    evidenceCount: 2,
    latencyMs: 12,
  });
  assert.ok(text.includes("top: failure-aaa (failure)"));
  assert.ok(text.includes("decision: jev used, top score 0.90"));
  assert.ok(text.includes("renderer: template (no model text)."));
  const check = validateRenderedClaims(text, ["failure-aaa", "fix-bbb"]);
  assert.equal(check.dropped, 0);
  assert.equal(check.stripped, text);
});

test("claim without a cited ref is stripped and counted", () => {
  const text = renderChatText({
    engine: "heuristic",
    status: "used",
    evidenceCount: 1,
    latencyMs: 3,
  });
  const tainted = `${text}\nThe cache bug is definitely caused by stale DNS.`;
  const check = validateRenderedClaims(tainted, ["failure-aaa"]);
  assert.ok(check.dropped > 0);
  assert.ok(!check.stripped.includes("stale DNS"));
  assert.ok(check.stripped.includes("rocky heard 1 thing"));
});

test("cited answer id survives the claims gate", () => {
  const text = "q_failure-aaa ranks first with noul 0.9.";
  const check = validateRenderedClaims(text, ["failure-aaa"]);
  assert.equal(check.dropped, 0);
  assert.ok(check.stripped.includes("q_failure-aaa"));
});

test("chat payload carries the evidence-first renderOrder", async () => {
  const home = mkdtempSync(join(tmpdir(), "rocky-render-home-"));
  const root = mkdtempSync(join(tmpdir(), "rocky-render-root-"));
  const previous = process.env.ROCKY_HOME;
  process.env.ROCKY_HOME = home;
  try {
    writeFileSync(
      join(home, "memory.jsonl"),
      `${JSON.stringify({ kind: "failure", id: "failure-aaa", ts: Date.now() - 1000, cwd: "/private/one", cmd: "npm run build", exitCode: 1, fingerprint: "a1b2c3d4e5f60718", signature: ["npm run build"], excerpt: "plain excerpt" })}\n`,
    );
    const handle = await startGui({ port: 0, root });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/chat`, {
        method: "POST",
        headers: { "X-Rocky-Token": handle.token, "Content-Type": "application/json" },
        body: JSON.stringify({ message: "npm run build" }),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as Record<string, unknown>;
      assert.deepEqual(payload.renderOrder, ["evidenceCards", "text", "decisionTrace"]);
      assert.ok(Array.isArray(payload.evidenceCards));
      assert.equal(typeof payload.text, "string");
    } finally {
      await handle.close();
    }
  } finally {
    if (previous === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = previous;
  }
});

test("renderer failure degrades to the raw template", () => {
  const text = safeRenderChatText({
    topRef: "a",
    engine: "hev" as never,
    status: "used",
    evidenceCount: Number.NaN,
    latencyMs: 1,
  });
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.ok(text === RAW_CHAT_TEMPLATE || text.includes("decision:"));
});

test("evidence-first render order is documented and stable", () => {
  assert.deepEqual([...CHAT_RENDER_ORDER], ["evidenceCards", "text", "decisionTrace"]);
});

test("natural human language explanation with markdown and citations passes claims gate", () => {
  const naturalResponse = [
    "Berdasarkan rekaman memori Rocky dan evaluasi Jev:",
    "1. Perintah `npm run build` sempat mengalami kegagalan pada target [failure-aaa].",
    "2. Penyebab error adalah kegagalan build pada step 3.",
    "3. Masalah berhasil diselesaikan dengan perbaikan [fix-bbb].",
    "",
    "### Catatan Tambahan",
    "- Perbaikan dilakukan di directory yang sama.",
    "- Status evaluasi: Jev used.",
  ].join("\n");

  const check = validateRenderedClaims(naturalResponse, ["failure-aaa", "fix-bbb"]);
  assert.equal(check.dropped, 0);
  assert.equal(check.stripped, naturalResponse);
});

test("English human explanation with bullet points and citations survives intact", () => {
  const englishResponse = [
    "According to Rocky's memory and Jev's decision:",
    "- An error occurred when executing `npm run build` as seen in [failure-aaa].",
    "- The issue was resolved by [fix-bbb].",
    "",
    "Summary: Rocky successfully remembered the error and the confirmed fix.",
  ].join("\n");

  const check = validateRenderedClaims(englishResponse, ["failure-aaa", "fix-bbb"]);
  assert.equal(check.dropped, 0);
  assert.equal(check.stripped, englishResponse);
});

test("practical interpretation and notes section survives claims gate without being dropped", () => {
  const response = [
    "Interpretasi Praktis",
    "",
    "Dari pola catatan di atas, bisa disimpulkan beberapa hal:",
    '1. Cross region didukung, tapi punya alur kode yang terpisah dari transfer biasa — itulah kenapa ada pertanyaan khusus soal "cross region only".',
    "2. Proses generate-nya lewat command `app:generate-inventory-transfer-req`, yang bisa diuji dulu dengan `--dry-run` sebelum benar-benar dieksekusi.",
    "3. Ada kompleksitas pada staging, terutama ketika transfer melibatkan DC atau lintas region. Jumlah baris staging yang muncul bisa jadi sumber kebingungan dan perlu diverifikasi ulang.",
    "",
    "Catatan",
    "Data di atas berasal dari eksekusi yang pernah tercatat di memori Rocky.",
    "Pastikan selalu melakukan uji coba sebelum deploy ke production.",
  ].join("\n");

  const check = validateRenderedClaims(response, ["failure-aaa", "fix-bbb"]);
  assert.equal(check.dropped, 0);
  assert.equal(check.stripped, response);
});
