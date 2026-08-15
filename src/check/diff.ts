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

export interface UnifiedDiffParseResult {
  added: AddedLine[];
  /** False means non-empty output was not unambiguously a git diff. */
  complete: boolean;
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

/**
 * Parse a normal `git diff --unified=0` response and reject output that only
 * resembles an empty diff. An empty byte stream is a valid clean result; any
 * other response must contain a recognizable, complete per-file diff section.
 */
export function parseUnifiedZeroDiffChecked(diffText: string): UnifiedDiffParseResult {
  if (diffText.length === 0) return { added: [], complete: true };

  let section: {
    evidence: boolean;
    hasHunk: boolean;
    sawOldMarker: boolean;
    sawNewMarker: boolean;
    oldMode: boolean;
    newMode: boolean;
    newFileMode: boolean;
    deletedFileMode: boolean;
    index: boolean;
    similarity: boolean;
    dissimilarity: boolean;
    renameFrom: boolean;
    renameTo: boolean;
    copyFrom: boolean;
    copyTo: boolean;
    binaryFiles: boolean;
  } | undefined;
  let sawSection = false;
  let inHunk = false;
  let hunkHasLine = false;

  const completeSection = (): boolean => {
    if (section === undefined || !section.evidence || (inHunk && !hunkHasLine)) return false;
    if (section.sawOldMarker !== section.sawNewMarker) return false;
    if (section.oldMode !== section.newMode) return false;
    if (section.renameFrom !== section.renameTo || section.copyFrom !== section.copyTo) return false;
    if ((section.similarity || section.dissimilarity)
      && !(section.renameFrom || section.copyFrom)) return false;
    if ((section.renameFrom || section.renameTo)
      && !(section.similarity || section.dissimilarity)) return false;
    if ((section.copyFrom || section.copyTo)
      && !(section.similarity || section.dissimilarity)) return false;
    if (section.newFileMode && section.deletedFileMode) return false;
    if ((section.newFileMode || section.deletedFileMode) && !section.index) return false;

    const textHunk = section.hasHunk && hunkHasLine
      && section.sawOldMarker && section.sawNewMarker;
    const modeChange = section.oldMode && section.newMode;
    const emptyFile = (section.newFileMode || section.deletedFileMode) && section.index;
    const renameOrCopy = (section.renameFrom && section.renameTo)
      || (section.copyFrom && section.copyTo);
    return textHunk || modeChange || emptyFile || renameOrCopy || section.binaryFiles;
  };

  for (const raw of diffText.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      if (section !== undefined && !completeSection()) return { added: [], complete: false };
      if (raw.slice("diff --git ".length).trim().length === 0) {
        return { added: [], complete: false };
      }
      section = {
        evidence: false,
        hasHunk: false,
        sawOldMarker: false,
        sawNewMarker: false,
        oldMode: false,
        newMode: false,
        newFileMode: false,
        deletedFileMode: false,
        index: false,
        similarity: false,
        dissimilarity: false,
        renameFrom: false,
        renameTo: false,
        copyFrom: false,
        copyTo: false,
        binaryFiles: false,
      };
      sawSection = true;
      inHunk = false;
      hunkHasLine = false;
      continue;
    }

    // A trailing newline is normal. Other bytes before the first header, or
    // between headers, are ambiguous and must not become a false clean scan.
    if (raw.length === 0) continue;
    if (section === undefined) return { added: [], complete: false };

    if (raw.startsWith("@@")) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(raw)) {
        return { added: [], complete: false };
      }
      if (inHunk && !hunkHasLine) return { added: [], complete: false };
      inHunk = true;
      hunkHasLine = false;
      section.hasHunk = true;
      continue;
    }

    if (inHunk) {
      if (raw.startsWith("+") || raw.startsWith(" ") || raw.startsWith("-")) {
        hunkHasLine = true;
        section.evidence = true;
        continue;
      }
      if (raw === "\\ No newline at end of file") continue;
      // A new metadata or file marker ends a hunk only after at least one
      // actual hunk line has been seen.
      if (!hunkHasLine) return { added: [], complete: false };
      inHunk = false;
    }

    if (raw.startsWith("--- ")) {
      if (raw.length === 4) return { added: [], complete: false };
      if (section.hasHunk) return { added: [], complete: false };
      section.sawOldMarker = true;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (raw.length === 4) return { added: [], complete: false };
      if (section.hasHunk) return { added: [], complete: false };
      section.sawNewMarker = true;
      continue;
    }

    if (/^old mode \d+$/.test(raw)) {
      section.oldMode = true;
      section.evidence = true;
      continue;
    }
    if (/^new mode \d+$/.test(raw)) {
      section.newMode = true;
      section.evidence = true;
      continue;
    }
    if (/^new file mode \d+$/.test(raw)) {
      section.newFileMode = true;
      section.evidence = true;
      continue;
    }
    if (/^deleted file mode \d+$/.test(raw)) {
      section.deletedFileMode = true;
      section.evidence = true;
      continue;
    }
    if (/^similarity index \d+%$/.test(raw)) {
      section.similarity = true;
      section.evidence = true;
      continue;
    }
    if (/^dissimilarity index \d+%$/.test(raw)) {
      section.dissimilarity = true;
      section.evidence = true;
      continue;
    }
    if (/^rename from /.test(raw)) {
      section.renameFrom = true;
      section.evidence = true;
      continue;
    }
    if (/^rename to /.test(raw)) {
      section.renameTo = true;
      section.evidence = true;
      continue;
    }
    if (/^copy from /.test(raw)) {
      section.copyFrom = true;
      section.evidence = true;
      continue;
    }
    if (/^copy to /.test(raw)) {
      section.copyTo = true;
      section.evidence = true;
      continue;
    }
    if (/^index [0-9a-f]+(?:\.\.[0-9a-f]+)?(?: \d+)?$/.test(raw)) {
      section.index = true;
      section.evidence = true;
      continue;
    }
    if (/^Binary files .* differ$/.test(raw)) {
      section.binaryFiles = true;
      section.evidence = true;
      continue;
    }
    // Binary patch payloads are not requested by this bounded command. A
    // header or a partial literal/delta stream is therefore never proof of a
    // complete diff and must fail closed rather than become a clean result.
    if (/^(?:GIT binary patch|literal|delta)\b/.test(raw)) {
      return { added: [], complete: false };
    }

    // A line outside a hunk or recognized extended header is not enough to
    // prove that git returned a complete diff.
    return { added: [], complete: false };
  }

  if (!sawSection || section === undefined || !completeSection()) {
    return { added: [], complete: false };
  }
  return { added: parseUnifiedZeroDiff(diffText), complete: true };
}
