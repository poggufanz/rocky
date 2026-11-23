import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_MEMORY_LINE_BYTES = 2 * 1024 * 1024;

function isMissingFileError(error) {
  const code = error && typeof error === "object" ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

function stripWin32ExtendedPrefix(p) {
  return p.replace(/^\\\\\?\\(?=[A-Za-z]:[\\/])/, "");
}

function stripTrailingSep(target, pathApi) {
  const root = pathApi.parse(target).root;
  let current = target;
  const isSep = pathApi === win32
    ? (ch) => ch === "/" || ch === "\\"
    : (ch) => ch === "/";
  while (current.length > root.length && isSep(current[current.length - 1])) {
    current = current.slice(0, -1);
  }
  return current;
}

function normalizeForCompare(target, pathApi, caseInsensitive) {
  let normalized = pathApi === win32 ? stripWin32ExtendedPrefix(target) : target;
  normalized = pathApi.normalize(normalized);
  normalized = stripTrailingSep(normalized, pathApi);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function resolveCanonical(target, pathApi, realpath) {
  if (typeof realpath !== "function") return null;
  const cleaned = pathApi === win32 ? stripWin32ExtendedPrefix(target) : target;
  let cursor = stripTrailingSep(pathApi.normalize(cleaned), pathApi);
  /** @type {string[]} */
  const suffix = [];

  while (true) {
    try {
      const resolved = realpath(cursor);
      if (typeof resolved !== "string" || resolved.length === 0) return null;
      const cleanResolved = stripTrailingSep(
        pathApi.normalize(pathApi === win32 ? stripWin32ExtendedPrefix(resolved) : resolved),
        pathApi,
      );
      return suffix.length > 0
        ? pathApi.join(cleanResolved, ...suffix.slice().reverse())
        : cleanResolved;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      if (code !== undefined && code !== "ENOENT" && code !== "ENOTDIR" && code !== "EINVAL") {
        return null;
      }
      const parent = pathApi.dirname(cursor);
      if (parent === cursor) return null;
      suffix.push(pathApi.basename(cursor));
      cursor = stripTrailingSep(parent, pathApi);
    }
  }
}

function isPathUnderNormalized(normCandidate, normRoot, pathApi) {
  if (!pathApi.isAbsolute(normRoot) || !pathApi.isAbsolute(normCandidate)) {
    return false;
  }
  const rel = pathApi.relative(normRoot, normCandidate);
  if (rel === "") return true;
  if (pathApi.isAbsolute(rel)) return false;
  const firstSegment = rel.split(pathApi.sep)[0];
  return firstSegment !== "..";
}

function snapshotSettingsFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: filePath, sha256: null, mtimeMs: null };
    }
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { path: filePath, sha256: null, mtimeMs: null };
    }
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pos = 0;
    while (true) {
      const bytesRead = readSync(fd, buf, 0, READ_CHUNK_BYTES, pos);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return {
      path: filePath,
      sha256: hash.digest("hex"),
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}

function readMemorySize(memoryPath) {
  try {
    const stat = statSync(memoryPath);
    return stat.isFile() ? stat.size : 0;
  } catch (error) {
    if (isMissingFileError(error)) return 0;
    throw error;
  }
}

/**
 * Snapshot the owner's Rocky memory byte offset and Claude settings metadata
 * (paths, byte size, sha256, mtime — never file contents).
 * @param {{
 *   ownerHome: string,
 *   ownerConfigDir?: string | null,
 *   ownerRockyHome?: string | null,
 *   platform?: NodeJS.Platform,
 * }} options
 * @returns {{
 *   memoryPath: string,
 *   memoryBytes: number,
 *   settings: Array<{ path: string, sha256: string | null, mtimeMs: number | null }>,
 * }}
 */
export function ownerBaseline({
  ownerHome,
  ownerConfigDir,
  ownerRockyHome,
  platform = process.platform,
}) {
  if (typeof ownerHome !== "string" || ownerHome.trim().length === 0) {
    throw new TypeError("ownerBaseline requires a non-empty ownerHome path");
  }

  const resolvedHome = resolve(ownerHome);
  const memoryDir = typeof ownerRockyHome === "string" && ownerRockyHome.trim().length > 0
    ? resolve(ownerRockyHome)
    : join(resolvedHome, ".rocky");
  const memoryPath = join(memoryDir, "memory.jsonl");
  const memoryBytes = readMemorySize(memoryPath);

  /** @type {string[]} */
  const candidateSettings = [join(resolvedHome, ".claude", "settings.json")];
  if (typeof ownerConfigDir === "string" && ownerConfigDir.trim().length > 0) {
    candidateSettings.push(join(resolve(ownerConfigDir), "settings.json"));
  }

  const caseInsensitive = platform === "win32";
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<{ path: string, sha256: string | null, mtimeMs: number | null }>} */
  const settings = [];
  for (const settingsPath of candidateSettings) {
    const key = caseInsensitive ? settingsPath.toLowerCase() : settingsPath;
    if (seen.has(key)) continue;
    seen.add(key);
    settings.push(snapshotSettingsFile(settingsPath));
  }

  return {
    memoryPath,
    memoryBytes,
    settings,
  };
}

/**
 * Check whether the owner's Rocky memory or Claude settings leaked eval activity
 * since `baseline` was captured.
 * Reads only bytes appended after `baseline.memoryBytes` in bounded chunks;
 * if the file shrank (rotation/truncation), reads from offset 0 and reports
 * `memoryTruncated: true`. Any trailing partial line without a newline is ignored.
 * @param {{
 *   memoryPath: string,
 *   memoryBytes: number,
 *   settings?: readonly { path: string, sha256: string | null, mtimeMs: number | null }[],
 * }} baseline
 * @param {{
 *   evalRoot: string,
 *   platform?: NodeJS.Platform,
 *   realpath?: (candidate: string) => string,
 * }} options
 * @returns {{
 *   appendedTotal: number,
 *   appendedUnderEvalRoot: number,
 *   memoryTruncated: boolean,
 *   settingsChanged: string[],
 *   settingsTouched: string[],
 *   leak: boolean,
 * }}
 */
export function ownerCheck(
  baseline,
  { evalRoot, platform = process.platform, realpath = realpathSync.native },
) {
  if (!baseline || typeof baseline !== "object") {
    throw new TypeError("ownerCheck requires a baseline object");
  }
  if (typeof evalRoot !== "string" || evalRoot.trim().length === 0) {
    throw new TypeError("ownerCheck requires a non-empty evalRoot path");
  }

  const pathApi = platform === "win32" ? win32 : posix;
  const caseInsensitive = platform === "win32";

  /** @type {Set<string>} */
  const rootCandidateSet = new Set();
  rootCandidateSet.add(normalizeForCompare(evalRoot, pathApi, caseInsensitive));
  const canonicalRoot = resolveCanonical(evalRoot, pathApi, realpath);
  if (canonicalRoot) {
    rootCandidateSet.add(normalizeForCompare(canonicalRoot, pathApi, caseInsensitive));
  }
  const rootCandidates = Array.from(rootCandidateSet);

  function isCwdUnderEvalRoot(cwd) {
    if (typeof cwd !== "string" || cwd.trim().length === 0) return false;
    const rawNorm = normalizeForCompare(cwd, pathApi, caseInsensitive);
    for (const rootNorm of rootCandidates) {
      if (isPathUnderNormalized(rawNorm, rootNorm, pathApi)) {
        return true;
      }
    }
    const canonicalCwd = resolveCanonical(cwd, pathApi, realpath);
    if (canonicalCwd) {
      const canonicalNorm = normalizeForCompare(canonicalCwd, pathApi, caseInsensitive);
      for (const rootNorm of rootCandidates) {
        if (isPathUnderNormalized(canonicalNorm, rootNorm, pathApi)) {
          return true;
        }
      }
    }
    return false;
  }

  const baselineBytes = Number.isInteger(baseline.memoryBytes) && baseline.memoryBytes >= 0
    ? baseline.memoryBytes
    : 0;
  let appendedTotal = 0;
  let appendedUnderEvalRoot = 0;
  let memoryTruncated = false;

  if (typeof baseline.memoryPath === "string" && baseline.memoryPath.length > 0) {
    let fd = null;
    try {
      fd = openSync(baseline.memoryPath, "r");
    } catch (error) {
      if (isMissingFileError(error)) {
        memoryTruncated = baselineBytes > 0;
      } else {
        throw error;
      }
    }

    if (fd !== null) {
      try {
        const stat = fstatSync(fd);
        const currentSize = stat.isFile() ? stat.size : 0;
        let startOffset = baselineBytes;
        if (currentSize < baselineBytes) {
          memoryTruncated = true;
          startOffset = 0;
        }

        if (currentSize > startOffset) {
          const chunkBuf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
          const decoder = new StringDecoder("utf8");
          let lineBuf = "";
          let lineBytes = 0;
          let lineOverflowed = false;

          const processCompleteLine = (rawLine) => {
            const trimmed = rawLine.trim();
            if (trimmed.length === 0) return;
            let parsed;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              return;
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return;
            }
            appendedTotal += 1;
            if (typeof parsed.cwd === "string" && isCwdUnderEvalRoot(parsed.cwd)) {
              appendedUnderEvalRoot += 1;
            }
          };

          const appendSegment = (segment) => {
            if (lineOverflowed || segment.length === 0) return;
            const segBytes = Buffer.byteLength(segment, "utf8");
            if (lineBytes + segBytes > MAX_MEMORY_LINE_BYTES) {
              lineOverflowed = true;
              lineBuf = "";
              lineBytes = 0;
              return;
            }
            lineBuf += segment;
            lineBytes += segBytes;
          };

          const feedText = (text) => {
            let start = 0;
            while (start < text.length) {
              const nl = text.indexOf("\n", start);
              if (nl === -1) {
                appendSegment(text.slice(start));
                break;
              }
              appendSegment(text.slice(start, nl));
              if (!lineOverflowed) {
                processCompleteLine(lineBuf);
              }
              lineOverflowed = false;
              lineBuf = "";
              lineBytes = 0;
              start = nl + 1;
            }
          };

          let pos = startOffset;
          while (pos < currentSize) {
            const toRead = Math.min(READ_CHUNK_BYTES, currentSize - pos);
            const bytesRead = readSync(fd, chunkBuf, 0, toRead, pos);
            if (bytesRead === 0) break;
            pos += bytesRead;
            feedText(decoder.write(chunkBuf.subarray(0, bytesRead)));
          }
          // Any remaining text in decoder/lineBuf has no trailing newline (partial write); ignore it.
          decoder.end();
        }
      } finally {
        closeSync(fd);
      }
    }
  }

  /** @type {string[]} */
  const settingsChanged = [];
  /** @type {string[]} */
  const settingsTouched = [];
  for (const entry of baseline.settings ?? []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const current = snapshotSettingsFile(entry.path);
    if (current.sha256 !== entry.sha256) {
      settingsChanged.push(entry.path);
    } else if (current.mtimeMs !== entry.mtimeMs) {
      settingsTouched.push(entry.path);
    }
  }

  const leak = appendedUnderEvalRoot > 0 || settingsChanged.length > 0;
  return {
    appendedTotal,
    appendedUnderEvalRoot,
    memoryTruncated,
    settingsChanged,
    settingsTouched,
    leak,
  };
}
