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
