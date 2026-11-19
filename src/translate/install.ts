import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Pair } from "./language.js";
import {
  INSTALLED_FILE,
  engineDir,
  modelDir,
  type FileRole,
  type PinnedFile,
  type TranslateManifest,
} from "./manifest.js";

export const DOWNLOAD_TIMEOUT_MS = 120_000;

const GZIP_DOWNLOAD_SLACK_BYTES = 64 * 1024;
const MODEL_UNZIP_SLACK_BYTES = 1024;
const TARBALL_MAX_UNZIP_BYTES = 32 * 1024 * 1024;
const VALID_ROLES = new Set<FileRole>(["glue", "wasm", "model", "lex", "vocab"]);

export interface InstalledMarker {
  v: 1;
  pair?: Pair;
  model_sha256?: string;
  files: { role: FileRole; name: string; size: number }[];
}

export interface InstallProgress {
  done_bytes: number;
  total_bytes: number;
}

export type InstallResult =
  | { ok: true }
  | { ok: false; reason: "download" | "checksum" | "write" };

export interface InstallDeps {
  fetch: typeof fetch;
  manifest: TranslateManifest;
  onProgress(p: InstallProgress): void;
}

function isSafeFilename(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".."
  );
}

function isValidMarker(value: unknown): value is InstalledMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.v !== 1) return false;
  if (obj.pair !== undefined && obj.pair !== "id-en" && obj.pair !== "en-id") {
    return false;
  }
  if (obj.model_sha256 !== undefined && typeof obj.model_sha256 !== "string") {
    return false;
  }
  if (!Array.isArray(obj.files) || obj.files.length === 0) return false;
  for (const entry of obj.files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.role !== "string" || !VALID_ROLES.has(item.role as FileRole)) {
      return false;
    }
    if (!isSafeFilename(item.name)) return false;
    if (
      typeof item.size !== "number" ||
      !Number.isInteger(item.size) ||
      item.size < 0
    ) {
      return false;
    }
  }
  return true;
}

export function readInstalled(dir: string): InstalledMarker | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, INSTALLED_FILE), "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isValidMarker(parsed)) return undefined;
  for (const file of parsed.files) {
    try {
      const st = statSync(join(dir, file.name));
      if (!st.isFile() || st.size !== file.size) return undefined;
    } catch {
      return undefined;
    }
  }
  return parsed;
}

function readNullTerminated(slice: Buffer): string {
  const zero = slice.indexOf(0);
  const end = zero === -1 ? slice.length : zero;
  return slice.subarray(0, end).toString("utf8");
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

export function readTarMember(tar: Buffer, path: string): Buffer | undefined {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const name = readNullTerminated(header.subarray(0, 100));
    const sizeText = readNullTerminated(header.subarray(124, 136)).trim();
    if (sizeText !== "" && !/^[0-7]+$/.test(sizeText)) {
      return undefined;
    }
    const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      return undefined;
    }

    const typeflag = header[156];
    const prefix = readNullTerminated(header.subarray(345, 500));
    const fullPath = prefix.length > 0 ? `${prefix}/${name}` : name;

    const dataStart = offset + 512;
    const blocksSize = Math.ceil(size / 512) * 512;
    if (dataStart + size > tar.length) {
      return undefined;
    }

    if ((typeflag === 0 || typeflag === 0x30) && fullPath === path) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }

    offset = dataStart + blocksSize;
  }
  return undefined;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function verifyIntegritySha512(buf: Buffer, expected: string): boolean {
  if (!expected.startsWith("sha512-")) return false;
  const actual = `sha512-${createHash("sha512").update(buf).digest("base64")}`;
  return actual === expected;
}

function markerMatchesFiles(
  marker: InstalledMarker | undefined,
  expected: readonly PinnedFile[],
  expectedPair?: Pair,
): boolean {
  if (!marker) return false;
  if (expectedPair !== undefined) {
    if (marker.pair !== expectedPair) return false;
    const modelFile = expected.find((f) => f.role === "model");
    if (modelFile && marker.model_sha256 !== modelFile.sha256) return false;
  }
  return expected.every((pinned) =>
    marker.files.some(
      (f) => f.role === pinned.role && f.name === pinned.name && f.size === pinned.size,
    ),
  );
}

async function fetchWithinCap(
  fetchFn: typeof fetch,
  url: string,
  maxBytes: number,
): Promise<{ ok: true; data: Buffer } | { ok: false; reason: "download" }> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "download" };
  }

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // ignore cancel errors
    }
    return { ok: false, reason: "download" };
  }

  if (!response.body) {
    return { ok: true, data: Buffer.alloc(0) };
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: "download" };
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: "download" };
  }

  return { ok: true, data: Buffer.concat(chunks, total) };
}

function writeFileAtomic(dir: string, name: string, data: Buffer | string): boolean {
  const partPath = join(dir, `${name}.part`);
  const finalPath = join(dir, name);
  try {
    writeFileSync(partPath, data);
    renameSync(partPath, finalPath);
    return true;
  } catch {
    try {
      rmSync(partPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    return false;
  }
}

function prepareDirAndClearMarker(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, INSTALLED_FILE), { force: true });
    return true;
  } catch {
    return false;
  }
}

function markerPayload(
  files: readonly PinnedFile[],
  pair?: Pair,
): InstalledMarker {
  const modelEntry = pair ? files.find((f) => f.role === "model") : undefined;
  return {
    v: 1,
    ...(pair ? { pair } : {}),
    ...(modelEntry ? { model_sha256: modelEntry.sha256 } : {}),
    files: files.map((f) => ({
      role: f.role,
      name: f.name,
      size: f.size,
    })),
  };
}

export async function installTranslation(
  home: string,
  pair: Pair,
  deps: InstallDeps,
): Promise<InstallResult> {
  const eDir = engineDir(home);
  const mDir = modelDir(home, pair);
  const engineMembers = deps.manifest.engine.members;
  const modelFiles = deps.manifest.models[pair];

  const needEngine = !markerMatchesFiles(readInstalled(eDir), engineMembers);
  const needModel = !markerMatchesFiles(readInstalled(mDir), modelFiles, pair);

  if (!needEngine && !needModel) {
    return { ok: true };
  }

  const totalBytes =
    (needEngine ? engineMembers.reduce((sum, m) => sum + m.size, 0) : 0) +
    (needModel ? modelFiles.reduce((sum, f) => sum + f.size, 0) : 0);
  let doneBytes = 0;

  if (needEngine) {
    const dl = await fetchWithinCap(
      deps.fetch,
      deps.manifest.engine.tarball,
      deps.manifest.engine.maxBytes,
    );
    if (!dl.ok) return dl;

    if (!verifyIntegritySha512(dl.data, deps.manifest.engine.integrity)) {
      return { ok: false, reason: "checksum" };
    }

    let tar: Buffer;
    try {
      tar = gunzipSync(dl.data, { maxOutputLength: TARBALL_MAX_UNZIP_BYTES });
    } catch {
      return { ok: false, reason: "checksum" };
    }

    const extracted: { member: (typeof engineMembers)[number]; data: Buffer }[] = [];
    for (const member of engineMembers) {
      const data = readTarMember(tar, member.member);
      if (!data || data.length !== member.size || sha256Hex(data) !== member.sha256) {
        return { ok: false, reason: "checksum" };
      }
      extracted.push({ member, data });
    }

    if (!prepareDirAndClearMarker(eDir)) {
      return { ok: false, reason: "write" };
    }

    for (const { member, data } of extracted) {
      if (!writeFileAtomic(eDir, member.name, data)) {
        return { ok: false, reason: "write" };
      }
      doneBytes += member.size;
      deps.onProgress({ done_bytes: doneBytes, total_bytes: totalBytes });
    }

    const markerJson = JSON.stringify(markerPayload(engineMembers), null, 2) + "\n";
    if (!writeFileAtomic(eDir, INSTALLED_FILE, markerJson)) {
      return { ok: false, reason: "write" };
    }
  }

  if (needModel) {
    if (!prepareDirAndClearMarker(mDir)) {
      return { ok: false, reason: "write" };
    }

    for (const file of modelFiles) {
      const dl = await fetchWithinCap(
        deps.fetch,
        file.url,
        file.size + GZIP_DOWNLOAD_SLACK_BYTES,
      );
      if (!dl.ok) return dl;

      let data: Buffer;
      try {
        data = gunzipSync(dl.data, {
          maxOutputLength: file.size + MODEL_UNZIP_SLACK_BYTES,
        });
      } catch {
        return { ok: false, reason: "checksum" };
      }

      if (data.length !== file.size || sha256Hex(data) !== file.sha256) {
        return { ok: false, reason: "checksum" };
      }

      if (!writeFileAtomic(mDir, file.name, data)) {
        return { ok: false, reason: "write" };
      }
      doneBytes += file.size;
      deps.onProgress({ done_bytes: doneBytes, total_bytes: totalBytes });
    }

    const markerJson = JSON.stringify(markerPayload(modelFiles, pair), null, 2) + "\n";
    if (!writeFileAtomic(mDir, INSTALLED_FILE, markerJson)) {
      return { ok: false, reason: "write" };
    }
  }

  return { ok: true };
}
