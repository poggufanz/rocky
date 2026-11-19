import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARIAN_CONFIG, loadEngine } from "../translate/engine.js";
import { engineDir } from "../translate/manifest.js";

const gatedHome = process.env.ROCKY_TEST_BERGAMOT_HOME;
const skipReason = gatedHome ? false : "ROCKY_TEST_BERGAMOT_HOME unset";

test("an empty home is engine-missing", async () => {
  assert.equal(MARIAN_CONFIG.split("\n").length, 13);
  const home = mkdtempSync(join(tmpdir(), "rocky-translate-engine-empty-"));
  try {
    const res = await loadEngine(home);
    assert.deepEqual(res, { ok: false, reason: "engine-missing" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("translates id to en and keeps placeholders", { skip: skipReason }, async () => {
  assert.ok(gatedHome);
  const loaded = await loadEngine(gatedHome);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;

  const pairRes = loaded.engine.translator("id-en");
  assert.equal(pairRes.ok, true);
  if (!pairRes.ok) return;

  const cachedRes = loaded.engine.translator("id-en");
  assert.equal(cachedRes.ok, true);
  if (!cachedRes.ok) return;
  assert.equal(cachedRes.translator, pairRes.translator);

  const out = pairRes.translator.translate([
    'Saya sengaja mengubah <x id="0"></x> supaya <x id="1"></x> lulus.',
  ]);
  assert.equal(out.length, 1);
  const line = out[0];
  assert.equal(line.split('<x id="0"></x>').length - 1, 1);
  assert.equal(line.split('<x id="1"></x>').length - 1, 1);
  assert.match(line, /deliberately|intentionally/i);
});

test("a pair without files is model-missing", { skip: skipReason }, async () => {
  assert.ok(gatedHome);
  const tempHome = mkdtempSync(join(tmpdir(), "rocky-translate-engine-nomodel-"));
  try {
    cpSync(engineDir(gatedHome), engineDir(tempHome), { recursive: true });
    const loaded = await loadEngine(tempHome);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const pairRes = loaded.engine.translator("en-id");
    assert.deepEqual(pairRes, { ok: false, reason: "model-missing" });
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
