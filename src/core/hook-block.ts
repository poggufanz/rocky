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

const BEGIN_BYTES = Buffer.from(HOOK_BEGIN, "utf8");
const END_BYTES = Buffer.from(HOOK_END, "utf8");
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

export interface HookBlockCodec {
  /** Classify hook-marker bytes: absent, exactly one managed block, or corrupt. */
  classify(content: Buffer): HookBlockClassification;
  /**
   * Append the managed block. Every existing byte is preserved; the block is
   * preceded by one blank separator line (plus a line feed when the content
   * does not already end at a line boundary). Non-absent input is returned
   * unchanged — corrupt content is never rewritten. When the content already
   * ends in a blank line — typically the separator a previous `remove` left
   * behind — that existing line is reused as the separator instead of adding
   * another, so repeated add/remove cycles do not grow an extra blank line
   * each time.
   */
  add(content: Buffer): Buffer;
  /**
   * Remove exactly the managed block bytes. Every byte outside the block —
   * including the blank separator line an earlier add placed before it — is
   * preserved. Absent or corrupt input is returned unchanged.
   */
  remove(content: Buffer): Buffer;
  /** The exact managed-block bytes this codec's `add` writes and `remove` strips. */
  readonly blockBytes: Buffer;
}

/**
 * Build a codec for one shell's managed block. The begin/end marker text
 * (`# >>> rocky hook >>>` / `# <<< rocky hook <<<`) is a valid comment in
 * every shell language Rocky's hook targets (Bash, PowerShell), so only the
 * interior hook line varies between callers — everything else (classify/
 * add/remove's byte-exact-block logic) is shell-agnostic and lives here once,
 * audited once, shared by every caller instead of forked per shell.
 */
export function createHookBlockCodec(hookLine: string): HookBlockCodec {
  const blockBytes = Buffer.from(`${HOOK_BEGIN}\n${hookLine}\n${HOOK_END}\n`, "utf8");

  function classify(content: Buffer): HookBlockClassification {
    const begins = countOccurrences(content, BEGIN_BYTES);
    const ends = countOccurrences(content, END_BYTES);
    if (begins === 0 && ends === 0) return "absent";
    if (begins !== 1 || ends !== 1) return "corrupt";
    const start = content.indexOf(BEGIN_BYTES);
    if (start !== 0 && content[start - 1] !== LINE_FEED) return "corrupt";
    return content.subarray(start, start + blockBytes.length).equals(blockBytes)
      ? "managed"
      : "corrupt";
  }

  function add(content: Buffer): Buffer {
    if (classify(content) !== "absent") return content;
    const endsWithBlankLine = content.length >= 2
      && content[content.length - 1] === LINE_FEED
      && content[content.length - 2] === LINE_FEED;
    const needsLineFeed = content.length > 0 && content[content.length - 1] !== LINE_FEED;
    return Buffer.concat([
      content,
      ...(needsLineFeed ? [SEPARATOR_BYTES] : []),
      ...(endsWithBlankLine ? [] : [SEPARATOR_BYTES]),
      blockBytes,
    ]);
  }

  function remove(content: Buffer): Buffer {
    if (classify(content) !== "managed") return content;
    const start = content.indexOf(BEGIN_BYTES);
    return Buffer.concat([
      content.subarray(0, start),
      content.subarray(start + blockBytes.length),
    ]);
  }

  return { classify, add, remove, blockBytes };
}

const BASH_HOOK_LINE =
  '[ -f "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash" ] && . "${ROCKY_HOME:-$HOME/.rocky}/rocky-hook.bash"';

/**
 * Exported (not just used internally by the free functions below) so
 * `commands/hook.ts` can pass it to shared, target-agnostic install/
 * uninstall/status machinery alongside `powershellHookBlockCodec`, instead of
 * forking that machinery per shell.
 */
export const bashHookBlockCodec = createHookBlockCodec(BASH_HOOK_LINE);

/** Classify hook-marker bytes: absent, exactly one managed block, or corrupt. */
export function classifyHookBlock(content: Buffer): HookBlockClassification {
  return bashHookBlockCodec.classify(content);
}

/**
 * Append the managed block. Every existing byte is preserved; the block is
 * preceded by one blank separator line (plus a line feed when the content
 * does not already end at a line boundary). Non-absent input is returned
 * unchanged — corrupt content is never rewritten. When the content already
 * ends in a blank line — typically the separator a previous `remove` left
 * behind — that existing line is reused as the separator instead of adding
 * another, so repeated add/remove cycles do not grow an extra blank line
 * each time.
 */
export function addHookBlockBytes(content: Buffer): Buffer {
  return bashHookBlockCodec.add(content);
}

/**
 * Remove exactly the managed block bytes. Every byte outside the block —
 * including the blank separator line an earlier add placed before it — is
 * preserved. Absent or corrupt input is returned unchanged.
 */
export function removeHookBlockBytes(content: Buffer): Buffer {
  return bashHookBlockCodec.remove(content);
}

/**
 * The PowerShell hook line, one physical line so the byte-parser story above
 * stays as simple as the Bash one. Same default-with-override for
 * `ROCKY_HOME`, same "only source if the file exists" safety as the Bash
 * line — verified against a scratch PowerShell profile file in the Task 3
 * spike (`docs/superpowers/validation/2026-08-17-powershell-hook-spike.md`
 * §3/§7.8).
 */
export const POWERSHELL_HOOK_LINE =
  "$__rockyHome = $(if ($env:ROCKY_HOME) { $env:ROCKY_HOME } else { Join-Path $HOME '.rocky' }); "
  + "if (Test-Path (Join-Path $__rockyHome 'rocky-hook.ps1')) { . (Join-Path $__rockyHome 'rocky-hook.ps1') }";

export const powershellHookBlockCodec = createHookBlockCodec(POWERSHELL_HOOK_LINE);
