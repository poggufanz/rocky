/**
 * Strict byte-level parser for Rocky's managed `.bashrc` hook block.
 *
 * The managed block is exactly these bytes (markers at line starts, exact hook
 * line, trailing newline):
 *
 * ```
 * # >>> rocky hook >>>
 * [ -f "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash" ] && . "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash"
 * # <<< rocky hook <<<
 * ```
 *
 * Everything is classified and transformed on `Buffer` so unrelated content —
 * CRLF endings, non-UTF-8 bytes, odd trailing newlines — survives untouched.
 * Anything marker-like that is not exactly the managed block is `corrupt`:
 * orphaned or reversed markers, duplicate or nested blocks, a modified
 * interior, or marker bytes outside the block. Corrupt bytes are never
 * rewritten; the caller reports manual-repair guidance instead.
 */

export type HookBlockClassification = "absent" | "managed" | "corrupt";

const HOOK_BEGIN = "# >>> rocky hook >>>";
const HOOK_END = "# <<< rocky hook <<<";
const HOOK_LINE =
  '[ -f "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash" ] && . "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash"';

const BEGIN_BYTES = Buffer.from(HOOK_BEGIN, "utf8");
const END_BYTES = Buffer.from(HOOK_END, "utf8");
const BLOCK_BYTES = Buffer.from(`${HOOK_BEGIN}\n${HOOK_LINE}\n${HOOK_END}\n`, "utf8");
const SEPARATOR_BYTES = Buffer.from("\n", "utf8");
const LINE_FEED = 0x0a;

function countOccurrences(content: Buffer, marker: Buffer): number {
  let count = 0;
  let offset = content.indexOf(marker);
  while (offset !== -1) {
    count += 1;
    offset = content.indexOf(marker, offset + marker.length);
  }
  return count;
}

/** Classify hook-marker bytes: absent, exactly one managed block, or corrupt. */
export function classifyHookBlock(content: Buffer): HookBlockClassification {
  const begins = countOccurrences(content, BEGIN_BYTES);
  const ends = countOccurrences(content, END_BYTES);
  if (begins === 0 && ends === 0) return "absent";
  if (begins !== 1 || ends !== 1) return "corrupt";
  const start = content.indexOf(BEGIN_BYTES);
  if (start !== 0 && content[start - 1] !== LINE_FEED) return "corrupt";
  return content.subarray(start, start + BLOCK_BYTES.length).equals(BLOCK_BYTES)
    ? "managed"
    : "corrupt";
}

/**
 * Append the managed block. Every existing byte is preserved; the block is
 * preceded by one blank separator line (plus a line feed when the content
 * does not already end at a line boundary). Non-absent input is returned
 * unchanged — corrupt content is never rewritten.
 */
export function addHookBlockBytes(content: Buffer): Buffer {
  if (classifyHookBlock(content) !== "absent") return content;
  const needsLineFeed = content.length > 0 && content[content.length - 1] !== LINE_FEED;
  return Buffer.concat([
    content,
    ...(needsLineFeed ? [SEPARATOR_BYTES] : []),
    SEPARATOR_BYTES,
    BLOCK_BYTES,
  ]);
}

/**
 * Remove exactly the managed block bytes. Every byte outside the block —
 * including the blank separator line an earlier add placed before it — is
 * preserved. Absent or corrupt input is returned unchanged.
 */
export function removeHookBlockBytes(content: Buffer): Buffer {
  if (classifyHookBlock(content) !== "managed") return content;
  const start = content.indexOf(BEGIN_BYTES);
  return Buffer.concat([
    content.subarray(0, start),
    content.subarray(start + BLOCK_BYTES.length),
  ]);
}
