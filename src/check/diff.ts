import { runGit } from "../core/exec.js";

/** One ref line from git's pre-push stdin, per githooks(5). */
export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** The commit range introduced by a pre-push ref update. */
export type PushRange =
  | { kind: "endpoints"; base: string; head: string }
  | { kind: "new-ref"; head: string }
  | null;

/** One added line from a unified-0 diff. Deleted lines are never inspected. */
export interface AddedLine {
  file: string;
  line: number;
  text: string;
}
interface GitPathToken {
  value: string;
  next: number;
}

function decodeGitQuoted(raw: string): string | null {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return null;
  const pieces: Buffer[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain.length > 0) {
      pieces.push(Buffer.from(plain, "utf8"));
      plain = "";
    }
  };
  for (let index = 1; index < raw.length - 1; index++) {
    const character = raw[index]!;
    if (character !== "\\") {
      plain += character;
      continue;
    }
    flush();
    const escaped = raw[++index];
    if (escaped === undefined) return null;
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      "\\": 0x5c,
      '"': 0x22,
    };
    const simpleValue = simple[escaped];
    if (simpleValue !== undefined) {
      pieces.push(Buffer.from([simpleValue]));
      continue;
    }
    if (!/[0-7]/.test(escaped)) return null;
    let octal = escaped;
    while (octal.length < 3 && index + 1 < raw.length - 1 && /[0-7]/.test(raw[index + 1]!)) {
      octal += raw[++index];
    }
    pieces.push(Buffer.from([Number.parseInt(octal, 8)]));
  }
  flush();
  return Buffer.concat(pieces).toString("utf8");
}

function parseGitPathToken(text: string, start: number): GitPathToken | null {
  if (text[start] === '"') {
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) {
      const character = text[index]!;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const raw = text.slice(start, index + 1);
        const value = decodeGitQuoted(raw);
        return value === null ? null : { value, next: index + 1 };
      }
    }
    return null;
  }
  let index = start;
  while (index < text.length && !/\s/.test(text[index]!)) index++;
  if (index === start) return null;
  return { value: text.slice(start, index), next: index };
}

function parseGitPathText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith('"')) return trimmed;
  const token = parseGitPathToken(trimmed, 0);
  if (token === null || token.next !== trimmed.length) return null;
  return token.value;
}

function targetPath(raw: string): string | null {
  const path = parseGitPathText(raw.slice(4));
  if (path === null || path === "/dev/null" || !path.startsWith("b/") || path.length === 2) return null;
  return path.slice(2);
}

function parseDiffHeader(raw: string): boolean {
  const prefix = "diff --git ";
  if (!raw.startsWith(prefix)) return false;
  const operands = raw.slice(prefix.length);
  if (operands.length === 0) return false;
  if (operands.startsWith('"')) {
    const first = parseGitPathToken(operands, 0);
    if (first === null) return false;
    let secondStart = first.next;
    while (secondStart < operands.length && /\s/.test(operands[secondStart]!)) secondStart++;
    const second = parseGitPathToken(operands, secondStart);
    if (second === null || operands.slice(second.next).trim().length > 0) return false;
    return first.value.startsWith("a/") && first.value.length > 2
      && second.value.startsWith("b/") && second.value.length > 2;
  }
  if (!operands.startsWith("a/")) return false;
  // Git leaves ordinary spaces and Unicode unquoted. The second operand is
  // identified by its ` b/` boundary; quoted paths use the branch above.
  return [...operands.matchAll(/\s+b\//g)].some((match) => {
    const boundary = match.index ?? -1;
    if (boundary <= 2) return false;
    const first = operands.slice(0, boundary).trimEnd();
    const second = operands.slice(boundary).trimStart();
    return first.startsWith("a/") && first.length > 2 && second.length > 2;
  });
}

function extractAddedLines(diffText: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file: string | null = null;
  let lineNo = 0;
  let inHunk = false;

  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      file = targetPath(raw);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      lineNo = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (file === null || !inHunk) continue;
    if (raw.startsWith("+")) {
      added.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith(" ")) {
      lineNo++;
    }
  }
  return added;
}

function parseNumstatAdded(output: string): number | null {
  if (output.length === 0) return 0;
  if (!output.endsWith("\0")) return null;
  const frames = output.slice(0, -1).split("\0");
  if (frames.some((frame) => frame.length === 0)) return null;
  let total = 0;
  for (const frame of frames) {
    const record = /^(\d+|-)\t(\d+|-)\t/.exec(frame);
    if (record === null) return null;
    const additions = record[1]!;
    const deletions = record[2]!;
    if ((additions === "-") !== (deletions === "-")) return null;
    if (additions !== "-") {
      const count = Number(additions);
      if (!Number.isSafeInteger(count)) return null;
      total += count;
      if (!Number.isSafeInteger(total)) return null;
    }
    if (frame.slice(record[0].length).length === 0) return null;
  }
  return total;
}

const PATCH_PARSE_TIMEOUT_MS = 5_000;
const MAX_PATCH_PARSE_BYTES = 1024 * 1024;

function hasSafePatchOrder(diffText: string): boolean {
  let inHunk = false;
  let hasSection = false;
  let metadataPhase: "metadata" | "markers" | "hunk" | "binary" = "metadata";
  let metadataRank = 0;
  let oldSeen = false;
  let newSeen = false;
  let oldDevNull = false;
  let newDevNull = false;
  let newFileMode = false;
  let deletedFileMode = false;
  let oldMode = false;
  let newMode = false;
  let renameFrom = false;
  let renameTo = false;
  let copyFrom = false;
  let copyTo = false;
  let hasHunk = false;
  let hasIndex = false;
  let hasBinary = false;
  let hasSimilarity = false;
  let similarityKind: "similarity" | "dissimilarity" | undefined;
  const finishSection = (): boolean => {
    const hasText = hasHunk && oldSeen && newSeen;
    const hasMode = oldMode && newMode;
    const hasEmptyFile = (newFileMode || deletedFileMode) && hasIndex;
    const hasRenameOrCopy = (renameFrom && renameTo || copyFrom && copyTo) && hasSimilarity;
    const recognized = hasText || hasMode || hasEmptyFile || hasRenameOrCopy || hasBinary;
    return oldSeen === newSeen
      && (!oldSeen || oldDevNull === newFileMode)
      && (!newSeen || newDevNull === deletedFileMode)
      && !(newFileMode && deletedFileMode)
      && !(oldMode && (newFileMode || deletedFileMode))
      && !(newMode && (newFileMode || deletedFileMode))
      && !(renameFrom || renameTo ? copyFrom || copyTo : false)
      && renameFrom === renameTo
      && copyFrom === copyTo
      && recognized
      && !(hasBinary && (hasHunk || oldSeen || newSeen));
  };
  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      if (hasSection && !finishSection()) return false;
      if (!parseDiffHeader(raw)) return false;
      hasSection = true;
      inHunk = false;
      metadataPhase = "metadata";
      metadataRank = 0;
      oldSeen = false;
      newSeen = false;
      oldDevNull = false;
      newDevNull = false;
      newFileMode = false;
      deletedFileMode = false;
      oldMode = false;
      newMode = false;
      renameFrom = false;
      renameTo = false;
      copyFrom = false;
      copyTo = false;
      hasHunk = false;
      hasIndex = false;
      hasBinary = false;
      hasSimilarity = false;
      similarityKind = undefined;
      continue;
    }
    if (!hasSection) return false;
    if (raw.startsWith("@@")) {
      if (metadataPhase === "metadata"
        || !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(raw)) return false;
      inHunk = true;
      hasHunk = true;
      metadataPhase = "hunk";
      continue;
    }
    if (inHunk) continue;
    if (raw.startsWith("--- ")) {
      if (metadataPhase !== "metadata" || oldSeen || newSeen) return false;
      const path = parseGitPathText(raw.slice(4));
      if (path === null || path.length === 0) return false;
      oldSeen = true;
      oldDevNull = path === "/dev/null";
      metadataPhase = "markers";
    } else if (raw.startsWith("+++ ")) {
      if (metadataPhase !== "markers" || !oldSeen || newSeen) return false;
      const path = parseGitPathText(raw.slice(4));
      if (path === null || path.length === 0) return false;
      newSeen = true;
      newDevNull = path === "/dev/null";
    } else if (raw.startsWith("old mode ")) {
      if (!/^old mode [0-7]{6}$/.test(raw)
        || metadataPhase !== "metadata" || metadataRank > 1 || oldMode) return false;
      oldMode = true;
      metadataRank = 1;
    } else if (raw.startsWith("new mode ")) {
      if (!/^new mode [0-7]{6}$/.test(raw)
        || metadataPhase !== "metadata" || metadataRank > 1 || !oldMode || newMode) return false;
      newMode = true;
      metadataRank = 1;
    } else if (raw.startsWith("similarity index ") || raw.startsWith("dissimilarity index ")) {
      const similarity = /^(similarity|dissimilarity) index (100|[0-9]{1,2})%$/.exec(raw);
      if (similarity === null || metadataPhase !== "metadata" || metadataRank > 2
        || similarityKind !== undefined) return false;
      metadataRank = 2;
      hasSimilarity = true;
      similarityKind = similarity[1] as "similarity" | "dissimilarity";
    } else if (raw.startsWith("new file mode ")) {
      if (!/^new file mode [0-7]{6}$/.test(raw)
        || metadataPhase !== "metadata" || metadataRank > 1 || newFileMode) return false;
      newFileMode = true;
      metadataRank = 1;
    } else if (raw.startsWith("deleted file mode ")) {
      if (!/^deleted file mode [0-7]{6}$/.test(raw)
        || metadataPhase !== "metadata" || metadataRank > 1 || deletedFileMode) return false;
      deletedFileMode = true;
      metadataRank = 1;
    } else if (raw.startsWith("rename from ")) {
      if (metadataPhase !== "metadata" || metadataRank > 3 || renameFrom
        || parseGitPathText(raw.slice("rename from ".length)) === null) return false;
      renameFrom = true;
      metadataRank = 3;
    } else if (raw.startsWith("rename to ")) {
      if (metadataPhase !== "metadata" || metadataRank > 3 || !renameFrom || renameTo
        || parseGitPathText(raw.slice("rename to ".length)) === null) return false;
      renameTo = true;
      metadataRank = 3;
    } else if (raw.startsWith("copy from ")) {
      if (metadataPhase !== "metadata" || metadataRank > 3 || copyFrom
        || parseGitPathText(raw.slice("copy from ".length)) === null) return false;
      copyFrom = true;
      metadataRank = 3;
    } else if (raw.startsWith("copy to ")) {
      if (metadataPhase !== "metadata" || metadataRank > 3 || !copyFrom || copyTo
        || parseGitPathText(raw.slice("copy to ".length)) === null) return false;
      copyTo = true;
      metadataRank = 3;
    } else if (/^index /.test(raw)) {
      if (!/^index [0-9a-fA-F]{4,64}\.\.[0-9a-fA-F]{4,64}(?: [0-7]{6})?$/.test(raw)
        || metadataPhase !== "metadata" || metadataRank > 4 || hasIndex) return false;
      metadataRank = 4;
      hasIndex = true;
    } else if (raw.startsWith("Binary files ")) {
      if (!/^Binary files .+ and .+ differ$/.test(raw)
        || metadataPhase !== "metadata" || hasBinary || oldSeen || newSeen) return false;
      hasBinary = true;
      metadataPhase = "binary";
    } else {
      return false;
    }
  }
  return hasSection && finishSection();
}

/** Parse Git's bounded unified-0 response with the check path's async runner. */
export async function parseUnifiedZeroDiffChecked(diffText: string): Promise<UnifiedDiffParseResult> {
  if (diffText.length === 0) return { added: [], complete: true };
  if (Buffer.byteLength(diffText, "utf8") > MAX_PATCH_PARSE_BYTES) return { added: [], complete: false };
  const lines = diffText.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.some((line) => line.length === 0) || !hasSafePatchOrder(diffText)) {
    return { added: [], complete: false };
  }
  const result = await runGit(
    ["apply", "--numstat", "-z"],
    diffText.endsWith("\n") ? diffText : `${diffText}\n`,
    { timeoutMs: PATCH_PARSE_TIMEOUT_MS, maxOutputBytes: MAX_PATCH_PARSE_BYTES },
  );
  if (result.code !== 0 || result.timedOut || result.outputLimitExceeded) {
    return { added: [], complete: false };
  }
  const expectedAdded = parseNumstatAdded(result.stdout);
  if (expectedAdded === null) return { added: [], complete: false };
  const added = extractAddedLines(diffText);
  if (added.length !== expectedAdded) return { added: [], complete: false };
  return { added, complete: true };
}

export interface UnifiedDiffParseResult {
  added: AddedLine[];
  /** False means non-empty output was not unambiguously a git diff. */
  complete: boolean;
}

/** Parse git's `--name-only -z` framing without treating malformed bytes as no paths. */
export function parseNameOnlyZero(output: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("git name-only output was missing NUL terminator");
  const frames = output.slice(0, -1).split("\0");
  if (frames.some((frame) => frame.length === 0)) {
    throw new Error("git name-only output contained an empty NUL frame");
  }
  return frames;
}

const ZERO_SHA = /^0+$/;

export function parsePrePushStdin(text: string): PushRef[] {
  const refs: PushRef[] = [];

  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    refs.push({
      localRef: parts[0]!,
      localSha: parts[1]!,
      remoteRef: parts[2]!,
      remoteSha: parts[3]!,
    });
  }

  return refs;
}

/** Returns null for a branch deletion. New refs are resolved by Task 12. */
export function rangeForPush(ref: PushRef): PushRange {
  if (ZERO_SHA.test(ref.localSha)) return null;
  if (ZERO_SHA.test(ref.remoteSha)) return { kind: "new-ref", head: ref.localSha };
  return { kind: "endpoints", base: ref.remoteSha, head: ref.localSha };
}

export function parseUnifiedZeroDiff(diffText: string): AddedLine[] {
  const added: AddedLine[] = [];
  let file: string | null = null;
  let lineNo = 0;
  let inHunk = false;

  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }

    if (!inHunk && raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      inHunk = false;
      continue;
    }

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      lineNo = Number(hunk[1]);
      inHunk = true;
      continue;
    }

    if (file === null || !inHunk) continue;
    if (raw.startsWith("+")) {
      added.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith(" ")) {
      lineNo++;
    }
  }

  return added;
}
