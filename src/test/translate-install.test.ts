import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DOWNLOAD_TIMEOUT_MS,
  installTranslation,
  readInstalled,
  readTarMember,
  type InstallProgress,
} from "../translate/install.js";
import {
  MANIFEST,
  engineDir,
  modelDir,
  type TranslateManifest,
} from "../translate/manifest.js";

interface TarEntrySpec {
  name: string;
  prefix?: string;
  typeflag?: string;
  content?: Buffer;
}

function ustarOf(entries: TarEntrySpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const data = entry.content ?? Buffer.alloc(0);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156, "ascii");
    header.write(entry.typeflag ?? "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (entry.prefix) {
      header.write(entry.prefix, 345, 155, "utf8");
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
    blocks.push(header);
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sha512Integrity(buf: Buffer): string {
  return `sha512-${createHash("sha512").update(buf).digest("base64")}`;
}

function makeFakeFetch(
  routes: Map<string, Buffer | number | (() => Promise<Response>)>,
  calls: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const entry = routes.get(url);
    if (entry === undefined) {
      return new Response(null, { status: 404 });
    }
    if (typeof entry === "number") {
      return new Response(null, { status: entry });
    }
    if (typeof entry === "function") {
      return entry();
    }
    return new Response(new Uint8Array(entry), { status: 200 });
  }) as typeof fetch;
}

function findPartFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findPartFiles(full));
    } else if (entry.name.endsWith(".part")) {
      found.push(full);
    }
  }
  return found;
}

function buildFixture(): {
  manifest: TranslateManifest;
  routes: Map<string, Buffer | number | (() => Promise<Response>)>;
  glueBytes: Buffer;
  wasmBytes: Buffer;
  modelBytes: Buffer;
  lexBytes: Buffer;
  vocabBytes: Buffer;
} {
  const glueBytes = Buffer.from("console.log('bergamot glue');\n", "utf8");
  const wasmBytes = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 1, 2, 3]);
  const modelBytes = Buffer.from("fake-model-binary-payload", "utf8");
  const lexBytes = Buffer.from("fake-lex-binary-payload", "utf8");
  const vocabBytes = Buffer.from("fake-vocab-spm-payload", "utf8");

  const tar = ustarOf([
    { name: "package/worker/bergamot-translator-worker.js", content: glueBytes },
    { name: "package/worker/bergamot-translator-worker.wasm", content: wasmBytes },
  ]);
  const tgz = gzipSync(tar);

  const tarballUrl = "https://registry.npmjs.org/@browsermt/bergamot-translator/-/bergamot-translator-0.4.9.tgz";
  const modelUrl = "https://storage.googleapis.com/test/id-en/model.bin.gz";
  const lexUrl = "https://storage.googleapis.com/test/id-en/lex.bin.gz";
  const vocabUrl = "https://storage.googleapis.com/test/id-en/vocab.spm.gz";

  const enModelBytes = Buffer.from("fake-enid-model", "utf8");
  const enLexBytes = Buffer.from("fake-enid-lex", "utf8");
  const enVocabBytes = Buffer.from("fake-enid-vocab", "utf8");

  const manifest: TranslateManifest = {
    engine: {
      tarball: tarballUrl,
      integrity: sha512Integrity(tgz),
      maxBytes: 1024 * 1024,
      members: [
        {
          role: "glue",
          name: "bergamot-translator-worker.js",
          member: "package/worker/bergamot-translator-worker.js",
          size: glueBytes.length,
          sha256: sha256Hex(glueBytes),
        },
        {
          role: "wasm",
          name: "bergamot-translator-worker.wasm",
          member: "package/worker/bergamot-translator-worker.wasm",
          size: wasmBytes.length,
          sha256: sha256Hex(wasmBytes),
        },
      ],
    },
    models: {
      "id-en": [
        {
          role: "model",
          name: "model.iden.intgemm.alphas.bin",
          size: modelBytes.length,
          sha256: sha256Hex(modelBytes),
          url: modelUrl,
        },
        {
          role: "lex",
          name: "lex.50.50.iden.s2t.bin",
          size: lexBytes.length,
          sha256: sha256Hex(lexBytes),
          url: lexUrl,
        },
        {
          role: "vocab",
          name: "vocab.iden.spm",
          size: vocabBytes.length,
          sha256: sha256Hex(vocabBytes),
          url: vocabUrl,
        },
      ],
      "en-id": [
        {
          role: "model",
          name: "model.enid.intgemm.alphas.bin",
          size: enModelBytes.length,
          sha256: sha256Hex(enModelBytes),
          url: "https://storage.googleapis.com/test/en-id/model.bin.gz",
        },
        {
          role: "lex",
          name: "lex.50.50.enid.s2t.bin",
          size: enLexBytes.length,
          sha256: sha256Hex(enLexBytes),
          url: "https://storage.googleapis.com/test/en-id/lex.bin.gz",
        },
        {
          role: "vocab",
          name: "vocab.enid.spm",
          size: enVocabBytes.length,
          sha256: sha256Hex(enVocabBytes),
          url: "https://storage.googleapis.com/test/en-id/vocab.spm.gz",
        },
      ],
    },
  };

  const routes = new Map<string, Buffer | number | (() => Promise<Response>)>([
    [tarballUrl, tgz],
    [modelUrl, gzipSync(modelBytes)],
    [lexUrl, gzipSync(lexBytes)],
    [vocabUrl, gzipSync(vocabBytes)],
    ["https://storage.googleapis.com/test/en-id/model.bin.gz", gzipSync(enModelBytes)],
    ["https://storage.googleapis.com/test/en-id/lex.bin.gz", gzipSync(enLexBytes)],
    ["https://storage.googleapis.com/test/en-id/vocab.spm.gz", gzipSync(enVocabBytes)],
  ]);

  return { manifest, routes, glueBytes, wasmBytes, modelBytes, lexBytes, vocabBytes };
}

function withTempHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "rocky-translate-install-"));
  return Promise.resolve(fn(home)).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
}

test("installs engine then pair and writes each marker last", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes, glueBytes, wasmBytes, modelBytes, lexBytes, vocabBytes } = buildFixture();
    const calls: string[] = [];
    const progress: InstallProgress[] = [];

    assert.equal(DOWNLOAD_TIMEOUT_MS, 120_000);
    assert.equal(MANIFEST.engine.members.length, 2);

    const res = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes, calls),
      manifest,
      onProgress: (p) => progress.push(p),
    });

    assert.deepEqual(res, { ok: true });
    assert.equal(calls[0], manifest.engine.tarball);
    assert.equal(calls.length, 4);

    const eDir = engineDir(home);
    const mDir = modelDir(home, "id-en");

    assert.deepEqual(readFileSync(join(eDir, "bergamot-translator-worker.js")), glueBytes);
    assert.deepEqual(readFileSync(join(eDir, "bergamot-translator-worker.wasm")), wasmBytes);
    assert.deepEqual(readFileSync(join(mDir, "model.iden.intgemm.alphas.bin")), modelBytes);
    assert.deepEqual(readFileSync(join(mDir, "lex.50.50.iden.s2t.bin")), lexBytes);
    assert.deepEqual(readFileSync(join(mDir, "vocab.iden.spm")), vocabBytes);

    const engineMarker = readInstalled(eDir);
    assert.ok(engineMarker);
    assert.equal(engineMarker.v, 1);
    assert.equal(engineMarker.files.length, 2);

    const modelMarker = readInstalled(mDir);
    assert.ok(modelMarker);
    assert.equal(modelMarker.v, 1);
    assert.equal(modelMarker.pair, "id-en");
    assert.equal(modelMarker.model_sha256, sha256Hex(modelBytes));
    assert.equal(modelMarker.files.length, 3);

    const expectedTotal =
      glueBytes.length + wasmBytes.length + modelBytes.length + lexBytes.length + vocabBytes.length;
    assert.equal(progress.length, 5);
    assert.deepEqual(progress[progress.length - 1], {
      done_bytes: expectedTotal,
      total_bytes: expectedTotal,
    });
    assert.deepEqual(findPartFiles(join(home, "translate")), []);
  });
});

test("a second install fetches nothing", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    const firstCalls: string[] = [];
    const first = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes, firstCalls),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(first, { ok: true });
    assert.equal(firstCalls.length, 4);

    const secondCalls: string[] = [];
    const second = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes, secondCalls),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(second, { ok: true });
    assert.equal(secondCalls.length, 0);
  });
});

test("wrong file bytes are a checksum failure and leave nothing ready", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    const lexUrl = manifest.models["id-en"][1].url;
    routes.set(lexUrl, gzipSync(Buffer.from("corrupted-lex-bytes", "utf8")));

    const res = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });

    assert.deepEqual(res, { ok: false, reason: "checksum" });
    assert.equal(readInstalled(modelDir(home, "id-en")), undefined);
    assert.deepEqual(findPartFiles(join(home, "translate")), []);
  });
});

test("wrong tarball integrity is a checksum failure", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    manifest.engine.integrity = "sha512-" + Buffer.alloc(64, 0).toString("base64");

    const res = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });

    assert.deepEqual(res, { ok: false, reason: "checksum" });
    assert.equal(readInstalled(engineDir(home)), undefined);
    assert.deepEqual(findPartFiles(join(home, "translate")), []);
  });
});

test("HTTP 404, a throw, and a body over the cap are download failures", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    routes.set(manifest.engine.tarball, 404);
    const notFound = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(notFound, { ok: false, reason: "download" });
  });

  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    routes.set(manifest.engine.tarball, async () => {
      throw new Error("network down");
    });
    const threw = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(threw, { ok: false, reason: "download" });
  });

  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    routes.set(manifest.engine.tarball, Buffer.alloc(manifest.engine.maxBytes + 1, 0x61));
    const overTarballCap = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(overTarballCap, { ok: false, reason: "download" });
  });

  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    const modelFile = manifest.models["id-en"][0];
    routes.set(modelFile.url, Buffer.alloc(modelFile.size + 64 * 1024 + 1, 0x61));
    const overModelCap = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(overModelCap, { ok: false, reason: "download" });
    assert.equal(readInstalled(modelDir(home, "id-en")), undefined);
  });
});

test("an interrupted install is not ready, and a rerun completes", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    const thirdModelUrl = manifest.models["id-en"][2].url;
    const brokenRoutes = new Map(routes);
    brokenRoutes.set(thirdModelUrl, async () => {
      throw new Error("connection reset");
    });

    const first = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(brokenRoutes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(first, { ok: false, reason: "download" });
    assert.equal(readInstalled(modelDir(home, "id-en")), undefined);
    assert.deepEqual(findPartFiles(join(home, "translate")), []);

    const rerunCalls: string[] = [];
    const second = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes, rerunCalls),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(second, { ok: true });
    assert.ok(readInstalled(modelDir(home, "id-en")));
    assert.equal(rerunCalls.length, 3); // engine already installed; only the 3 model files fetched
  });
});

test("readTarMember reads ustar prefix+name and skips pax entries", () => {
  const payload = Buffer.from("wasm-bytes", "utf8");
  const paxPayload = Buffer.from("20 path=ignored\n", "utf8");
  const tar = ustarOf([
    { name: "PaxHeader/x.wasm", typeflag: "x", content: paxPayload },
    { name: "package/worker", typeflag: "5" },
    { name: "x.wasm", prefix: "package/worker", typeflag: "0", content: payload },
  ]);

  assert.deepEqual(readTarMember(tar, "package/worker/x.wasm"), payload);
  assert.equal(readTarMember(tar, "PaxHeader/x.wasm"), undefined);
  assert.equal(readTarMember(tar, "package/worker"), undefined);
  assert.equal(readTarMember(tar, "missing/file"), undefined);
});

test("readInstalled rejects a file whose size drifted", async () => {
  await withTempHome(async (home) => {
    const { manifest, routes } = buildFixture();
    const res = await installTranslation(home, "id-en", {
      fetch: makeFakeFetch(routes),
      manifest,
      onProgress: () => {},
    });
    assert.deepEqual(res, { ok: true });

    const mDir = modelDir(home, "id-en");
    const target = join(mDir, "vocab.iden.spm");
    const originalSize = statSync(target).size;
    appendFileSync(target, Buffer.from([0x20]));
    assert.equal(statSync(target).size, originalSize + 1);

    assert.equal(readInstalled(mDir), undefined);
  });
});
