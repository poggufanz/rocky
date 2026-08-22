export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export interface MouseEvent {
  kind: "press" | "release" | "wheel-up" | "wheel-down";
  x: number;
  y: number;
  button: number;
}

export function parseSgrMouse(params: string, final: "M" | "m"): MouseEvent | undefined {
  const m = params.match(/^(\d+);(\d+);(\d+)$/);
  if (!m) return undefined;
  const button = Number(m[1]);
  const x = Number(m[2]) - 1;
  const y = Number(m[3]) - 1;
  if (x < 0 || y < 0) return undefined;
  if (button === 64) return { kind: "wheel-up", x, y, button };
  if (button === 65) return { kind: "wheel-down", x, y, button };
  if (button & 32) return undefined; // drag/motion: dropped
  return { kind: final === "M" ? "press" : "release", x, y, button };
}
