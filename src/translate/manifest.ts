import { join } from "node:path";
import type { Pair } from "./language.js";

export type FileRole = "glue" | "wasm" | "model" | "lex" | "vocab";

export interface PinnedFile {
  role: FileRole;
  name: string;
  size: number;
  sha256: string;
}

export interface TranslateManifest {
  engine: {
    tarball: string;
    integrity: string;
    maxBytes: number;
    members: (PinnedFile & { member: string })[];
  };
  models: Record<Pair, (PinnedFile & { url: string })[]>;
}

export const INSTALLED_FILE = "installed.json";

const MODEL_URL_BASE =
  "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/";

export const MANIFEST: TranslateManifest = {
  engine: {
    tarball:
      "https://registry.npmjs.org/@browsermt/bergamot-translator/-/bergamot-translator-0.4.9.tgz",
    integrity:
      "sha512-bNuuCwM/JnsIYQCKXcYKFT4Qc5vLMoB8Nbvz8ReIgs7xzebK8Sa+R8iEK8mLvNBe/WaZ6zrPaUQilLsRT/ea8Q==",
    maxBytes: 8 * 1024 * 1024,
    members: [
      {
        role: "glue",
        name: "bergamot-translator-worker.js",
        size: 80474,
        sha256: "748b2418418a2ffc6e70721aeb10098d8e6fb589ea156b91f4ae8bc3490d8f7a",
        member: "package/worker/bergamot-translator-worker.js",
      },
      {
        role: "wasm",
        name: "bergamot-translator-worker.wasm",
        size: 5174294,
        sha256: "95a2b58dd6773bf1b3f345d71f9149928b9f75f4ec9c9064c0b3e42c298671b2",
        member: "package/worker/bergamot-translator-worker.wasm",
      },
    ],
  },
  models: {
    "id-en": [
      {
        role: "model",
        name: "model.iden.intgemm.alphas.bin",
        size: 17141051,
        sha256: "eeed3d8c2c78ec7011b31b2419e1d2dfdf2a7cc0ee0dbb1fcd164c934cb5d328",
        url: `${MODEL_URL_BASE}models/id-en/spring-2024_Yl0wXq-iQE6G9PpA3AQfcg/exported/model.iden.intgemm.alphas.bin.gz`,
      },
      {
        role: "lex",
        name: "lex.50.50.iden.s2t.bin",
        size: 4050348,
        sha256: "7a543087d4e9c1fe2f6b6f735b5e31aeadab80235e734c0388278722042ee3a2",
        url: `${MODEL_URL_BASE}models/id-en/spring-2024_Yl0wXq-iQE6G9PpA3AQfcg/exported/lex.50.50.iden.s2t.bin.gz`,
      },
      {
        role: "vocab",
        name: "vocab.iden.spm",
        size: 772941,
        sha256: "a2dd1462abd17cccbbf3fefc562131f06b293f8ff6a5efad73ebb0176810d835",
        url: `${MODEL_URL_BASE}models/id-en/spring-2024_Yl0wXq-iQE6G9PpA3AQfcg/exported/vocab.iden.spm.gz`,
      },
    ],
    "en-id": [
      {
        role: "model",
        name: "model.enid.intgemm.alphas.bin",
        size: 17141051,
        sha256: "f81f13eef703a4e0650ffc3138a0f4bab7b6c8bfd173ef1b7bda68d16b8bc7e8",
        url: `${MODEL_URL_BASE}models/en-id/spring-2024_bbjDBFoDTNGSUo2if3ET_A/exported/model.enid.intgemm.alphas.bin.gz`,
      },
      {
        role: "lex",
        name: "lex.50.50.enid.s2t.bin",
        size: 3515428,
        sha256: "d37f72bcab6e7bc52fd223350f95521b5810bb2486a97275f86077988fced3f4",
        url: `${MODEL_URL_BASE}models/en-id/spring-2024_bbjDBFoDTNGSUo2if3ET_A/exported/lex.50.50.enid.s2t.bin.gz`,
      },
      {
        role: "vocab",
        name: "vocab.enid.spm",
        size: 773211,
        sha256: "61bc7db24d3b6de638a02a280580a273fe0c942ecbe8a8204b2f81978211db22",
        url: `${MODEL_URL_BASE}models/en-id/spring-2024_bbjDBFoDTNGSUo2if3ET_A/exported/vocab.enid.spm.gz`,
      },
    ],
  },
};

export function engineDir(home: string): string {
  return join(home, "translate", "engine");
}

export function modelDir(home: string, pair: Pair): string {
  return join(home, "translate", "models", pair);
}
