const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], [0x20000, 0x3fffd],
];

const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], // C0/C1 controls, ESC included
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x2060, 0x2064], // zero-width + joiners
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
    if (cp < lo) return false;
  }
  return false;
}

export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += codePointWidth(ch.codePointAt(0) ?? 0);
  return width;
}

export function truncateToWidth(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = codePointWidth(ch.codePointAt(0) ?? 0);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

export function padToWidth(text: string, width: number): string {
  const gap = width - stringWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/**
 * Wrap to display cells. Breaks on spaces; a token wider than `max` is
 * hard-broken mid-token (wide-aware). Explicit newlines are respected.
 * The inverse of the shipped bug: content is never silently truncated.
 */
export function wrapToWidth(text: string, max: number): string[] {
  if (max <= 0) return [""];
  const out: string[] = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (let word of para.split(/[ \t]+/)) {
      while (stringWidth(word) > max) {
        if (line !== "") { out.push(line); line = ""; }
        let head = "";
        let w = 0;
        for (const ch of word) {
          const cw = codePointWidth(ch.codePointAt(0) ?? 0);
          if (w + cw > max) break;
          head += ch;
          w += cw;
        }
        out.push(head);
        word = word.slice(head.length);
      }
      if (line === "") { line = word; continue; }
      if (stringWidth(line) + 1 + stringWidth(word) <= max) { line += " " + word; continue; }
      out.push(line);
      line = word;
    }
    out.push(line);
  }
  return out;
}
