import { CellBuffer, type Rect } from "../core/buffer.js";
import { solveAxis, type AxisItem } from "../core/layout.js";
import { Node, type NodeProps } from "../core/node.js";
import { codePointWidth } from "../core/text.js";
import type { ThemeToken } from "../theme.js";

export interface BoxProps extends NodeProps {
  title?: string;
  focused?: boolean;
  ascii?: boolean;
}

export class BoxNode extends Node {
  declare readonly props: BoxProps;
  constructor(props: BoxProps = {}) {
    super(props);
  }

  override layout(rect: Rect): void {
    this.rect = rect;
    if (this.children.length === 0) return;
    const innerRect: Rect = {
      x: rect.x + 2,
      y: rect.y + 1,
      w: Math.max(0, rect.w - 4),
      h: Math.max(0, rect.h - 2),
    };
    const axis = this.props.direction ?? "column";
    const inner = axis === "row" ? innerRect.w : innerRect.h;
    const cross = axis === "row" ? innerRect.h : innerRect.w;
    const items: AxisItem[] = this.children.map((c) => {
      const fixed = (c as any).mainBasis(axis, cross);
      const hasFixed = (axis === "row" ? c.props.width : c.props.height) !== undefined;
      return {
        basis: fixed,
        grow: hasFixed ? 0 : c.props.grow ?? 0,
        shrink: c.props.shrink ?? 0,
        min: c.props.min,
        max: hasFixed ? fixed : c.props.max,
      };
    });
    const sizes = solveAxis(inner, items, this.props.gap ?? 0);
    let cursor = axis === "row" ? innerRect.x : innerRect.y;
    this.children.forEach((c, i) => {
      // Overflowing children are clamped to the interior — a child slot must
      // never reach the border row, or content paints over the frame.
      const end = axis === "row" ? innerRect.x + innerRect.w : innerRect.y + innerRect.h;
      const size = Math.min(sizes[i], Math.max(0, end - cursor));
      const r: Rect = axis === "row"
        ? { x: cursor, y: innerRect.y, w: size, h: innerRect.h }
        : { x: innerRect.x, y: cursor, w: innerRect.w, h: size };
      c.layout(r);
      cursor += size + (this.props.gap ?? 0);
    });
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    // 1. Fill body
    buf.fillRect(this.rect, " ");

    // 2. Borders
    const ascii = this.props.ascii ?? false;
    const [tl, tr, bl, br, horiz, vert] = ascii
      ? ["+", "+", "+", "+", "-", "|"]
      : ["┌", "┐", "└", "┘", "─", "│"];

    // Corners
    buf.set(x, y, tl, "border");
    if (w > 1) {
      buf.set(x + w - 1, y, tr, "border");
    }
    if (h > 1) {
      buf.set(x, y + h - 1, bl, "border");
      if (w > 1) {
        buf.set(x + w - 1, y + h - 1, br, "border");
      }
    }

    // Top & bottom horizontal edges
    for (let c = 1; c < w - 1; c++) {
      buf.set(x + c, y, horiz, "border");
      if (h > 1) {
        buf.set(x + c, y + h - 1, horiz, "border");
      }
    }

    // Left & right vertical edges
    for (let r = 1; r < h - 1; r++) {
      buf.set(x, y + r, vert, "border");
      if (w > 1) {
        buf.set(x + w - 1, y + r, vert, "border");
      }
    }

    // 3. Title chip
    if (this.props.title && w >= 4) {
      const maxTitleW = Math.max(0, w - 4);
      const titleStr = ` ${this.props.title} `;
      let cx = x + 2;
      let usedW = 0;
      const isFocused = this.props.focused ?? false;
      const token: ThemeToken = isFocused ? "accent" : "text2";
      for (const ch of titleStr) {
        const cw = codePointWidth(ch.codePointAt(0) ?? 0);
        if (cw === 0) continue;
        if (usedW + cw > maxTitleW) break;
        buf.set(cx, y, ch, token, isFocused);
        if (cw === 2) {
          buf.set(cx + 1, y, "\u0000", token, isFocused);
        }
        cx += cw;
        usedW += cw;
      }
    }

    // 4. Children paint
    super.paint(buf);
  }
}
