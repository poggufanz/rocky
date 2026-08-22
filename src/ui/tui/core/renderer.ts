import { CellBuffer } from "./buffer.js";
import { Node } from "./node.js";
import type { ColorDepth } from "../theme.js";

/**
 * Pure render: tree in, exactly `rows` lines of exactly `cols` cells out.
 * The surfaces plan wires this to screen.ts; tests and `block` density call
 * it directly. No IO, no globals, no clock.
 */
export function renderToLines(root: Node, cols: number, rows: number, depth: ColorDepth): string[] {
  const buf = new CellBuffer(cols, rows);
  root.layout({ x: 0, y: 0, w: cols, h: rows });
  root.paint(buf);
  return buf.toLines(depth);
}
