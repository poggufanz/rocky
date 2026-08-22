export type ColorDepth = 1 | 4 | 8 | 24;
export type ThemeToken =
  | "border" | "accent" | "text" | "text2" | "muted"
  | "ok" | "err" | "why" | "guard" | "diffAdd" | "diffDel" | "diffHunk"
  // background-capable layer tokens — the approved prototypes' visual language
  | "page" | "panel" | "panelHi" | "accentDim" | "shadow" | "black"
  | "diffAddBg" | "diffDelBg" | "gutter";

// [r, g, b, ansi256, ansi16] per token — spec §4 palette.
const PALETTE: Record<ThemeToken, readonly [number, number, number, number, number]> = {
  border:  [0x3f, 0x3f, 0x46, 240, 90],
  accent:  [0x14, 0xb8, 0xa6,  37, 96],
  text:    [0xf4, 0xf4, 0xf5, 255, 97],
  text2:   [0xa1, 0xa1, 0xaa, 248, 37],
  muted:   [0x71, 0x71, 0x7a, 243, 90],
  ok:      [0x10, 0xb9, 0x81,  36, 92],
  err:     [0xf4, 0x3f, 0x5e, 204, 91],
  why:     [0xa7, 0x8b, 0xfa, 141, 95],
  guard:   [0xf5, 0x9e, 0x0b, 214, 93],
  diffAdd: [0x22, 0xc5, 0x5e,  41, 92],
  diffDel: [0xf8, 0x71, 0x71, 210, 91],
  diffHunk:[0x38, 0xbd, 0xf8,  81, 94],
  page:     [0x08, 0x08, 0x0a, 232, 30],
  panel:    [0x1c, 0x1c, 0x23, 234, 30],
  panelHi:  [0x27, 0x27, 0x30, 236, 30],
  accentDim:[0x12, 0x3f, 0x3a,  23, 36],
  shadow:   [0x05, 0x05, 0x07, 232, 30],
  black:    [0x0b, 0x0b, 0x0e, 232, 30],
  diffAddBg:[0x0c, 0x24, 0x19,  22, 32],
  diffDelBg:[0x2a, 0x12, 0x18,  52, 31],
  gutter:   [0x16, 0x16, 0x1c, 233, 30],
};

/**
 * Background SGR prefix for a token. Truecolor only — spec §9: below
 * truecolor, fills are dropped rather than approximated. Pair with BG_RESET.
 */
export function bgSgr(token: ThemeToken, depth: ColorDepth): string {
  if (depth !== 24) return "";
  const [r, g, b] = PALETTE[token];
  return `\x1b[48;2;${r};${g};${b}m`;
}

export const BG_RESET = "\x1b[49m";

export function detectColorDepth(env: NodeJS.ProcessEnv, streamDepth: () => number): ColorDepth {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "") {
    if (force === "0") return 1;
    if (force === "1") return 4;
    if (force === "2") return 8;
    return 24;
  }
  if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined) return 1;
  try {
    const depth = streamDepth();
    if (depth >= 24) return 24;
    if (depth >= 8) return 8;
    if (depth >= 4) return 4;
    if (depth >= 1) return 1;
  } catch { /* no tty stream — fall through to env heuristics */ }
  const colorterm = env.COLORTERM ?? "";
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if ((env.TERM ?? "").includes("256color")) return 8;
  return 4;
}

export function paint(token: ThemeToken, text: string, depth: ColorDepth): string {
  if (depth === 1) return text;
  const [r, g, b, c256, c16] = PALETTE[token];
  if (depth === 24) return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  if (depth === 8) return `\x1b[38;5;${c256}m${text}\x1b[39m`;
  return `\x1b[${c16}m${text}\x1b[39m`;
}
