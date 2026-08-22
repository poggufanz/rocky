import { CellBuffer, type Rect } from "./buffer.js";
import { solveAxis, type AxisItem } from "./layout.js";
import { wrapToWidth, stringWidth } from "./text.js";
import type { ThemeToken } from "../theme.js";

export interface NodeProps extends AxisItem {
  direction?: "row" | "column";
  gap?: number;
  width?: number;
  height?: number;
}

export class Node {
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  readonly children: Node[] = [];
  constructor(readonly props: NodeProps = {}) {}

  add(child: Node): this {
    this.children.push(child);
    return this;
  }

  /** Main-axis basis when the parent solves this child. */
  protected mainBasis(axis: "row" | "column", _crossSize?: number): number {
    return axis === "row" ? this.props.width ?? this.props.basis ?? 0
                          : this.props.height ?? this.props.basis ?? 0;
  }

  layout(rect: Rect): void {
    this.rect = rect;
    if (this.children.length === 0) return;
    const axis = this.props.direction ?? "column";
    const inner = axis === "row" ? rect.w : rect.h;
    const cross = axis === "row" ? rect.h : rect.w;
    const items: AxisItem[] = this.children.map((c) => {
      const fixed = c.mainBasis(axis, cross);
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
    let cursor = axis === "row" ? rect.x : rect.y;
    this.children.forEach((c, i) => {
      const r: Rect = axis === "row"
        ? { x: cursor, y: rect.y, w: sizes[i], h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: sizes[i] };
      c.layout(r);
      cursor += sizes[i] + (this.props.gap ?? 0);
    });
  }

  paint(buf: CellBuffer): void {
    for (const c of this.children) c.paint(buf);
  }
}

export class TextNode extends Node {
  constructor(readonly text: string, readonly token?: ThemeToken, props: NodeProps = {}) {
    super(props);
  }

  protected override mainBasis(axis: "row" | "column", crossSize?: number): number {
    if (axis === "column" && this.props.height === undefined && this.props.basis === undefined) {
      const w = crossSize ?? this.props.width ?? 0;
      return w > 0 ? wrapToWidth(this.text, w).length : 1;
    }
    if (axis === "row" && this.props.width === undefined && this.props.basis === undefined) {
      return stringWidth(this.text);
    }
    return super.mainBasis(axis, crossSize);
  }

  override paint(buf: CellBuffer): void {
    const lines = wrapToWidth(this.text, Math.max(1, this.rect.w));
    for (let i = 0; i < lines.length && i < this.rect.h; i++) {
      buf.blitText(this.rect.x, this.rect.y + i, lines[i], this.token, this.rect);
    }
  }
}
