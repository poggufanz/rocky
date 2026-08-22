import { codePointWidth } from "./text.js";
import { paint, type ColorDepth, type ThemeToken } from "../theme.js";

export interface Rect { x: number; y: number; w: number; h: number }

const CONT = "\u0000"; // second cell of a wide glyph; skipped on emit

interface Cell { ch: string; token: ThemeToken | undefined; inverse: boolean }

export class CellBuffer {
  private cells: Cell[];
  constructor(readonly w: number, readonly h: number) {
    this.cells = Array.from({ length: w * h }, () => ({ ch: " ", token: undefined, inverse: false }));
  }

  set(x: number, y: number, ch: string, token?: ThemeToken, inverse = false): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.cells[y * this.w + x] = { ch, token, inverse };
  }

  fillRect(r: Rect, ch = " ", token?: ThemeToken): void {
    for (let dy = 0; dy < r.h; dy++) for (let dx = 0; dx < r.w; dx++) this.set(r.x + dx, r.y + dy, ch, token);
  }

  blitText(x: number, y: number, text: string, token?: ThemeToken, clip?: Rect): number {
    const c = clip ?? { x: 0, y: 0, w: this.w, h: this.h };
    if (y < c.y || y >= c.y + c.h || y < 0 || y >= this.h) return 0;
    let cx = x;
    let written = 0;
    for (const ch of text) {
      const cw = codePointWidth(ch.codePointAt(0) ?? 0);
      if (cw === 0) continue;                        // combining marks: dropped
      if (cx + cw > c.x + c.w || cx + cw > this.w) break;
      if (cx < c.x || cx < 0) { cx += cw; continue; } // left clip consumes width, writes nothing
      this.set(cx, y, ch, token);
      if (cw === 2) this.set(cx + 1, y, CONT, token);
      cx += cw;
      written += cw;
    }
    return written;
  }

  toLines(depth: ColorDepth): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let line = "";
      let run = "";
      let runToken: ThemeToken | undefined;
      let runInverse = false;
      const flush = () => {
        if (run === "") return;
        let piece = depth === 1 || runToken === undefined ? run : paint(runToken, run, depth);
        if (runInverse && depth !== 1) piece = `\x1b[7m${piece}\x1b[27m`;
        line += piece;
        run = "";
      };
      for (let x = 0; x < this.w; x++) {
        const cell = this.cells[y * this.w + x];
        if (cell.ch === CONT) continue;
        if (cell.token !== runToken || cell.inverse !== runInverse) { flush(); runToken = cell.token; runInverse = cell.inverse; }
        run += cell.ch;
      }
      flush();
      out.push(line);
    }
    return out;
  }
}
