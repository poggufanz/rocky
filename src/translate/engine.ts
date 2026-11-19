import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { readInstalled } from "./install.js";
import type { Pair } from "./language.js";
import { engineDir, modelDir, type FileRole } from "./manifest.js";
import type { Translator, TranslatorLoad } from "./quote.js";

export const MARIAN_CONFIG = [
  "beam-size: 1",
  "normalize: 1.0",
  "word-penalty: 0",
  "cpu-threads: 0",
  "gemm-precision: int8shiftAlphaAll",
  "skip-cost: true",
  "alignment: soft",
  "quiet: true",
  "quiet-translation: true",
  "max-length-break: 128",
  "mini-batch-words: 1024",
  "workspace: 32",
  "max-length-factor: 2.0",
].join("\n");

export interface LoadedEngine {
  translator(pair: Pair): TranslatorLoad;
}

export type EngineLoadResult =
  | { ok: true; engine: LoadedEngine }
  | { ok: false; reason: "engine-missing" | "load-failed" };

interface EmscriptenVector<T> {
  push_back(value: T): void;
  size(): number;
  get(index: number): T;
  delete(): void;
}

interface AlignedMemoryInstance {
  getByteArrayView(): Uint8Array;
  delete(): void;
}

interface AlignedMemoryListInstance {
  push_back(mem: AlignedMemoryInstance): void;
  delete(): void;
}

interface TranslationModelInstance {
  delete(): void;
}

interface TranslationResponse {
  getTranslatedText(): string;
  delete(): void;
}

interface ResponseOptions {
  alignment: boolean;
  html: boolean;
  qualityScores: boolean;
}

interface BlockingServiceInstance {
  translate(
    model: TranslationModelInstance,
    input: EmscriptenVector<string>,
    options: EmscriptenVector<ResponseOptions>,
  ): EmscriptenVector<TranslationResponse>;
  delete(): void;
}

type WasmGemmFn = (...args: unknown[]) => unknown;

interface BergamotModuleInit {
  asm?: Record<string, WasmGemmFn>;
  instantiateWasm(
    info: Record<string, unknown>,
    accept: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ): Record<string, never>;
  onRuntimeInitialized: () => void;
  onAbort: (what: unknown) => void;
  print: () => void;
  printErr: () => void;
}

interface BergamotModule extends BergamotModuleInit {
  AlignedMemory: new (size: number, alignment: number) => AlignedMemoryInstance;
  AlignedMemoryList: new () => AlignedMemoryListInstance;
  TranslationModel: new (
    config: string,
    model: AlignedMemoryInstance,
    lex: AlignedMemoryInstance,
    vocabs: AlignedMemoryListInstance,
    qualityModel: null,
  ) => TranslationModelInstance;
  BlockingService: new (options: { cacheSize: number }) => BlockingServiceInstance;
  VectorString: new () => EmscriptenVector<string>;
  VectorResponseOptions: new () => EmscriptenVector<ResponseOptions>;
}

const WASM_GEMM_EXPORTS = [
  "int8_prepare_a",
  "int8_prepare_b",
  "int8_prepare_b_from_transposed",
  "int8_prepare_b_from_quantized_transposed",
  "int8_prepare_bias",
  "int8_multiply_and_add_bias",
  "int8_select_columns_of_b",
] as const;

type RuntimeState =
  | { ok: true; module: BergamotModule; service: BlockingServiceInstance }
  | { ok: false; reason: "load-failed" };

// Process-wide runtime promise: Emscripten glue binds globalThis.Module and
// Embind types once per Node process, so initialization runs at most once.
let runtimePromise: Promise<RuntimeState> | undefined;
const enginesByHome = new Map<string, LoadedEngine>();

function toFallbackExportName(snakeName: string): string {
  return snakeName.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) + "Fallback";
}

function buildWasmGemmImports(mod: BergamotModuleInit): Record<string, WasmGemmFn> {
  const imports: Record<string, WasmGemmFn> = {};
  for (const name of WASM_GEMM_EXPORTS) {
    const fallbackName = toFallbackExportName(name);
    imports[name] = (...args: unknown[]) => {
      const fn = mod.asm?.[fallbackName];
      if (!fn) {
        throw new Error(`Missing wasm_gemm fallback export: ${fallbackName}`);
      }
      return fn(...args);
    };
  }
  return imports;
}

function findRoleFile(
  files: readonly { role: FileRole; name: string; size: number }[],
  role: FileRole,
): string | undefined {
  return files.find((entry) => entry.role === role)?.name;
}

function createAlignedMemory(
  mod: BergamotModule,
  bytes: Buffer,
  alignment: number,
): AlignedMemoryInstance {
  const mem = new mod.AlignedMemory(bytes.byteLength, alignment);
  mem.getByteArrayView().set(bytes);
  return mem;
}

function createPairTranslator(
  home: string,
  pair: Pair,
  mod: BergamotModule,
  service: BlockingServiceInstance,
): TranslatorLoad {
  const mDir = modelDir(home, pair);
  const marker = readInstalled(mDir);
  if (!marker || marker.pair !== pair) {
    return { ok: false, reason: "model-missing" };
  }

  const modelName = findRoleFile(marker.files, "model");
  const lexName = findRoleFile(marker.files, "lex");
  const vocabName = findRoleFile(marker.files, "vocab");
  if (!modelName || !lexName || !vocabName) {
    return { ok: false, reason: "model-missing" };
  }

  let modelBytes: Buffer;
  let lexBytes: Buffer;
  let vocabBytes: Buffer;
  try {
    modelBytes = readFileSync(join(mDir, modelName));
    lexBytes = readFileSync(join(mDir, lexName));
    vocabBytes = readFileSync(join(mDir, vocabName));
  } catch {
    return { ok: false, reason: "load-failed" };
  }

  let modelMem: AlignedMemoryInstance | undefined;
  let lexMem: AlignedMemoryInstance | undefined;
  let vocabMem: AlignedMemoryInstance | undefined;
  let vocabs: AlignedMemoryListInstance | undefined;
  let model: TranslationModelInstance | undefined;

  try {
    modelMem = createAlignedMemory(mod, modelBytes, 256);
    lexMem = createAlignedMemory(mod, lexBytes, 64);
    vocabMem = createAlignedMemory(mod, vocabBytes, 64);
    vocabs = new mod.AlignedMemoryList();
    vocabs.push_back(vocabMem);
    model = new mod.TranslationModel(MARIAN_CONFIG, modelMem, lexMem, vocabs, null);
  } catch {
    model?.delete();
    vocabs?.delete();
    vocabMem?.delete();
    lexMem?.delete();
    modelMem?.delete();
    return { ok: false, reason: "load-failed" };
  }

  const loadedModel = model;
  const translator: Translator = {
    translate(htmlLines: string[]): string[] {
      let input: EmscriptenVector<string> | undefined;
      let options: EmscriptenVector<ResponseOptions> | undefined;
      let responses: EmscriptenVector<TranslationResponse> | undefined;
      try {
        input = new mod.VectorString();
        options = new mod.VectorResponseOptions();
        for (const line of htmlLines) {
          input.push_back(line);
          options.push_back({ alignment: false, html: true, qualityScores: false });
        }
        responses = service.translate(loadedModel, input, options);
        const count = responses.size();
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          const response = responses.get(i);
          try {
            out.push(response.getTranslatedText());
          } finally {
            response.delete();
          }
        }
        return out;
      } finally {
        responses?.delete();
        options?.delete();
        input?.delete();
      }
    },
  };

  return { ok: true, translator };
}

function makeLoadedEngine(
  home: string,
  mod: BergamotModule,
  service: BlockingServiceInstance,
): LoadedEngine {
  const cache = new Map<Pair, TranslatorLoad>();
  return {
    translator(pair: Pair): TranslatorLoad {
      const cached = cache.get(pair);
      if (cached) return cached;
      const loaded = createPairTranslator(home, pair, mod, service);
      cache.set(pair, loaded);
      return loaded;
    },
  };
}

async function initRuntime(gluePath: string, wasmPath: string): Promise<RuntimeState> {
  let glueBytes: Buffer;
  let wasmBytes: Buffer;
  try {
    glueBytes = readFileSync(gluePath);
    wasmBytes = readFileSync(wasmPath);
  } catch {
    return { ok: false, reason: "load-failed" };
  }

  let settled = false;
  let settle!: { resolve: () => void; reject: (err: unknown) => void };
  const ready = new Promise<void>((resolve, reject) => {
    settle = {
      resolve() {
        if (!settled) {
          settled = true;
          resolve();
        }
      },
      reject(err: unknown) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      },
    };
  });
  // Attach a no-op handler so synchronous init throws cannot trigger an unhandled rejection.
  ready.catch(() => {});

  try {
    const glueSource = glueBytes.toString("utf8");
    const wasmCopy = new Uint8Array(wasmBytes.byteLength);
    wasmCopy.set(wasmBytes);

    const modInit: BergamotModuleInit = {
      instantiateWasm(info, accept) {
        try {
          const wasm_gemm = buildWasmGemmImports(modInit);
          WebAssembly.instantiate(wasmCopy, {
            ...(info as WebAssembly.Imports),
            wasm_gemm,
          })
            .then((result) => accept(result.instance, result.module))
            .catch((err) => {
              settle.reject(err);
            });
        } catch (err) {
          settle.reject(err);
        }
        return {};
      },
      onRuntimeInitialized() {
        settle.resolve();
      },
      onAbort(what) {
        settle.reject(new Error(String(what)));
      },
      print() {},
      printErr() {},
    };

    // ponytail: Module and require stay global; this process exists only to translate.
    Object.assign(globalThis, {
      Module: modInit,
      require: createRequire(import.meta.url),
    });

    runInThisContext(glueSource, { filename: gluePath });
    await ready;

    const mod = modInit as BergamotModule;
    const service = new mod.BlockingService({ cacheSize: 0 });
    return { ok: true, module: mod, service };
  } catch {
    return { ok: false, reason: "load-failed" };
  }
}

/**
 * Loads the Bergamot WASM engine onto Node's main thread and exposes a per-pair
 * translator loader backed by local files under `home`.
 */
export async function loadEngine(home: string): Promise<EngineLoadResult> {
  const eDir = engineDir(home);
  const marker = readInstalled(eDir);
  if (!marker) {
    return { ok: false, reason: "engine-missing" };
  }

  const glueName = findRoleFile(marker.files, "glue");
  const wasmName = findRoleFile(marker.files, "wasm");
  if (!glueName || !wasmName) {
    return { ok: false, reason: "load-failed" };
  }

  const gluePath = join(eDir, glueName);
  const wasmPath = join(eDir, wasmName);

  if (!runtimePromise) {
    runtimePromise = Promise.resolve().then(() => initRuntime(gluePath, wasmPath));
  }
  const runtime = await runtimePromise;
  if (!runtime.ok) {
    return runtime;
  }

  const resolvedHome = resolve(home);
  let engine = enginesByHome.get(resolvedHome);
  if (!engine) {
    engine = makeLoadedEngine(resolvedHome, runtime.module, runtime.service);
    enginesByHome.set(resolvedHome, engine);
  }

  return { ok: true, engine };
}
