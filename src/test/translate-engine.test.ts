import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARIAN_CONFIG, loadEngine } from "../translate/engine.js";
import { INSTALLED_FILE, engineDir, modelDir } from "../translate/manifest.js";

const gatedHome = process.env.ROCKY_TEST_BERGAMOT_HOME;
const skipReason = gatedHome ? false : "ROCKY_TEST_BERGAMOT_HOME unset";
const engineModuleUrl = new URL("../translate/engine.js", import.meta.url).href;
const MINIMAL_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

function writeFakeEngine(home: string, glueSource: string, wasmBytes = MINIMAL_WASM): void {
  const eDir = engineDir(home);
  mkdirSync(eDir, { recursive: true });
  const glueBuf = Buffer.from(glueSource, "utf8");
  writeFileSync(join(eDir, "glue.js"), glueBuf);
  writeFileSync(join(eDir, "engine.wasm"), wasmBytes);
  writeFileSync(
    join(eDir, INSTALLED_FILE),
    JSON.stringify({
      v: 1,
      files: [
        { role: "glue", name: "glue.js", size: glueBuf.byteLength },
        { role: "wasm", name: "engine.wasm", size: wasmBytes.byteLength },
      ],
    }),
  );
}

function writeFakeIdEnModel(home: string): void {
  const mDir = modelDir(home, "id-en");
  mkdirSync(mDir, { recursive: true });
  const dummy = Buffer.from("x");
  writeFileSync(join(mDir, "model.bin"), dummy);
  writeFileSync(join(mDir, "lex.bin"), dummy);
  writeFileSync(join(mDir, "vocab.spm"), dummy);
  writeFileSync(
    join(mDir, INSTALLED_FILE),
    JSON.stringify({
      v: 1,
      pair: "id-en",
      files: [
        { role: "model", name: "model.bin", size: dummy.byteLength },
        { role: "lex", name: "lex.bin", size: dummy.byteLength },
        { role: "vocab", name: "vocab.spm", size: dummy.byteLength },
      ],
    }),
  );
}

function runFreshNode(script: string, args: string[]): void {
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    encoding: "utf8",
  });
  assert.ifError(res.error);
  assert.equal(res.status, 0, `child exited with ${res.status}\nstderr:\n${res.stderr}`);
}

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

test("glue throwing during init returns load-failed and stays failed for the process", () => {
  const badHome = mkdtempSync(join(tmpdir(), "rocky-translate-engine-badglue-"));
  const emptyHome = mkdtempSync(join(tmpdir(), "rocky-translate-engine-empty2-"));
  try {
    writeFakeEngine(
      badHome,
      'Module.onAbort("init abort"); throw new Error("glue init exploded");',
    );
    runFreshNode(
      `
        import assert from "node:assert/strict";
        const { loadEngine } = await import(process.argv[1]);
        const first = await loadEngine(process.argv[2]);
        assert.deepEqual(first, { ok: false, reason: "load-failed" });
        const second = await loadEngine(process.argv[2]);
        assert.deepEqual(second, { ok: false, reason: "load-failed" });
        const missing = await loadEngine(process.argv[3]);
        assert.deepEqual(missing, { ok: false, reason: "engine-missing" });
      `,
      [engineModuleUrl, badHome, emptyHome],
    );
  } finally {
    rmSync(badHome, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("acceptance callback throwing in instantiateWasm returns load-failed without crashing", () => {
  const badHome = mkdtempSync(join(tmpdir(), "rocky-translate-engine-acceptfail-"));
  try {
    writeFakeEngine(
      badHome,
      'Module.instantiateWasm({}, () => { throw new Error("receiveInstance failed"); });',
    );
    runFreshNode(
      `
        import assert from "node:assert/strict";
        const { loadEngine } = await import(process.argv[1]);
        const res = await loadEngine(process.argv[2]);
        assert.deepEqual(res, { ok: false, reason: "load-failed" });
      `,
      [engineModuleUrl, badHome],
    );
  } finally {
    rmSync(badHome, { recursive: true, force: true });
  }
});

test("translate frees native response handles and cleans up input vector if options allocation throws", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "rocky-translate-engine-cleanup-"));
  try {
    const fakeGlue = `
      globalThis.__counts = {
        inputDelete: 0,
        optionsDelete: 0,
        responsesDelete: 0,
        responseDelete: 0,
        throwOptions: false,
      };
      class FakeAlignedMemory {
        constructor(size) { this.buf = new Uint8Array(size); }
        getByteArrayView() { return this.buf; }
        delete() {}
      }
      class FakeAlignedMemoryList {
        push_back() {}
        delete() {}
      }
      class FakeTranslationModel {
        delete() {}
      }
      class FakeVectorString {
        constructor() { this.items = []; }
        push_back(v) { this.items.push(v); }
        delete() { globalThis.__counts.inputDelete++; }
      }
      class FakeVectorResponseOptions {
        constructor() {
          if (globalThis.__counts.throwOptions) throw new Error("options boom");
          this.items = [];
        }
        push_back(v) { this.items.push(v); }
        delete() { globalThis.__counts.optionsDelete++; }
      }
      class FakeResponse {
        constructor(text) { this.text = text; }
        getTranslatedText() { return this.text; }
        delete() { globalThis.__counts.responseDelete++; }
      }
      class FakeResponseVector {
        constructor(items) { this.items = items; }
        size() { return this.items.length; }
        get(i) { return new FakeResponse("tr:" + this.items[i]); }
        delete() { globalThis.__counts.responsesDelete++; }
      }
      class FakeBlockingService {
        translate(_model, input) { return new FakeResponseVector(input.items); }
        delete() {}
      }
      Module.AlignedMemory = FakeAlignedMemory;
      Module.AlignedMemoryList = FakeAlignedMemoryList;
      Module.TranslationModel = FakeTranslationModel;
      Module.VectorString = FakeVectorString;
      Module.VectorResponseOptions = FakeVectorResponseOptions;
      Module.BlockingService = FakeBlockingService;
      Module.onRuntimeInitialized();
    `;
    writeFakeEngine(fakeHome, fakeGlue);
    writeFakeIdEnModel(fakeHome);

    runFreshNode(
      `
        import assert from "node:assert/strict";
        const { loadEngine } = await import(process.argv[1]);
        const loaded = await loadEngine(process.argv[2]);
        assert.equal(loaded.ok, true);
        if (!loaded.ok) throw new Error("expected ok");
        const pairRes = loaded.engine.translator("id-en");
        assert.equal(pairRes.ok, true);
        if (!pairRes.ok) throw new Error("expected translator ok");

        const out = pairRes.translator.translate(["one", "two"]);
        assert.deepEqual(out, ["tr:one", "tr:two"]);
        assert.deepEqual(globalThis.__counts, {
          inputDelete: 1,
          optionsDelete: 1,
          responsesDelete: 1,
          responseDelete: 2,
          throwOptions: false,
        });

        globalThis.__counts.throwOptions = true;
        assert.throws(() => pairRes.translator.translate(["three"]), /options boom/);
        assert.equal(globalThis.__counts.inputDelete, 2);
        assert.equal(globalThis.__counts.optionsDelete, 1);
      `,
      [engineModuleUrl, fakeHome],
    );
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("concurrent cold loadEngine calls both succeed and translate", { skip: skipReason }, () => {
  assert.ok(gatedHome);
  runFreshNode(
    `
      import assert from "node:assert/strict";
      const { loadEngine } = await import(process.argv[1]);
      const [a, b] = await Promise.all([loadEngine(process.argv[2]), loadEngine(process.argv[2])]);
      assert.equal(a.ok, true);
      assert.equal(b.ok, true);
      if (!a.ok || !b.ok) throw new Error("expected both ok");

      const ta = a.engine.translator("id-en");
      const tb = b.engine.translator("id-en");
      assert.equal(ta.ok, true);
      assert.equal(tb.ok, true);
      if (!ta.ok || !tb.ok) throw new Error("expected both translators ok");

      const sample = 'Saya sengaja mengubah <x id="0"></x> supaya <x id="1"></x> lulus.';
      for (const translator of [ta.translator, tb.translator]) {
        const out = translator.translate([sample]);
        assert.equal(out.length, 1);
        assert.equal(out[0].split('<x id="0"></x>').length - 1, 1);
        assert.equal(out[0].split('<x id="1"></x>').length - 1, 1);
        assert.match(out[0], /deliberately|intentionally/i);
      }
    `,
    [engineModuleUrl, gatedHome],
  );
});
