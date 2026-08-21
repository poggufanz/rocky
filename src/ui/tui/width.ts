const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff], [0x20000, 0x3fffd],
];

const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f],            // C0/C1 controls, ESC included
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x2060, 0x2064],            // zero-width + joiners
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
