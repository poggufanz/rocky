import { CellBuffer, type Rect } from "../core/buffer.js";
import { pulse } from "../core/motion.js";
import { Node, type NodeProps } from "../core/node.js";
import { codePointWidth, stringWidth } from "../core/text.js";
import { matchCommands } from "../surface/registry.js";
import { BoxNode } from "./box.js";

export class StatusBarNode extends Node {
  constructor(
    readonly segments: Array<[key: string, label: string]>,
    readonly right?: string,
    props: NodeProps = { height: 1 },
  ) {
    super(props);
  }

  protected override mainBasis(axis: "row" | "column", crossSize?: number): number {
    if (axis === "column" && this.props.height === undefined && this.props.basis === undefined) {
      return 1;
    }
    return super.mainBasis(axis, crossSize);
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    buf.fillRect(this.rect, " ", undefined, "panelHi");
    const clip: Rect = { x, y, w, h };
    let sx = x;

    if (w >= 76) {
      for (const [key, label] of this.segments) {
        if (sx >= x + w) break;
        sx += buf.blitText(sx, y, ` ${key}`, "accent", clip);
        sx += buf.blitText(sx, y, ` ${label} `, "muted", clip);
      }
    } else {
      for (const [key] of this.segments) {
        if (sx >= x + w) break;
        sx += buf.blitText(sx, y, ` ${key} `, "accent", clip);
      }
    }

    if (this.right && w >= 52) {
      const rw = stringWidth(this.right);
      const rx = x + w - rw - 1;
      if (rx > sx) {
        buf.blitText(rx, y, this.right, "muted", clip);
      }
    }
  }
}

export interface InputLineState {
  value: string;
  placeholder: string;
  cwdTail: string;
  frame: number;
  motionOn: boolean;
  ascii?: boolean;
}

export class InputLineNode extends Node {
  private box: BoxNode;

  constructor(readonly state: InputLineState, props: NodeProps = { height: 3 }) {
    super(props);
    const title = state.cwdTail ? `rocky · ${state.cwdTail}` : "rocky";
    this.box = new BoxNode({ title, focused: true, ascii: state.ascii ?? false });
  }

  protected override mainBasis(axis: "row" | "column", crossSize?: number): number {
    if (axis === "column" && this.props.height === undefined && this.props.basis === undefined) {
      return 3;
    }
    return super.mainBasis(axis, crossSize);
  }

  override layout(rect: Rect): void {
    this.rect = rect;
    this.box.layout(rect);
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    this.box.paint(buf);
    const lineY = y + 1;
    if (lineY >= y + h) return;

    const clip: Rect = { x: x + 1, y: lineY, w: Math.max(0, w - 2), h: 1 };
    buf.blitText(x + 2, lineY, "›", "accent", clip);

    const isCursorOn = pulse(this.state.frame, this.state.motionOn);

    if (this.state.value !== "") {
      buf.blitText(x + 4, lineY, this.state.value, "text", clip);
      if (isCursorOn) {
        const cursorX = x + 4 + stringWidth(this.state.value);
        if (cursorX < x + w - 1) {
          buf.set(cursorX, lineY, "▏", "accent");
        }
      }
    } else {
      if (this.state.placeholder) {
        buf.blitText(x + 5, lineY, this.state.placeholder, "muted", clip);
      }
      if (isCursorOn && x + 4 < x + w - 1) {
        buf.set(x + 4, lineY, "▏", "accent");
      }
    }
  }
}

export interface SlashMenuState {
  prefix: string;
  selected: number;
  ascii?: boolean;
}

export class SlashMenuNode extends Node {
  constructor(readonly state: SlashMenuState, props: NodeProps = {}) {
    super(props);
  }

  protected override mainBasis(axis: "row" | "column", crossSize?: number): number {
    if (axis === "column" && this.props.height === undefined && this.props.basis === undefined) {
      const cleanPrefix = this.state.prefix.startsWith("/") ? this.state.prefix.slice(1) : this.state.prefix;
      const matches = matchCommands(cleanPrefix);
      return matches.length + 2;
    }
    if (axis === "row" && this.props.width === undefined && this.props.basis === undefined) {
      return 56;
    }
    return super.mainBasis(axis, crossSize);
  }

  override paint(buf: CellBuffer): void {
    const { x, y, w, h } = this.rect;
    if (w <= 0 || h <= 0) return;

    const cleanPrefix = this.state.prefix.startsWith("/") ? this.state.prefix.slice(1) : this.state.prefix;
    const matches = matchCommands(cleanPrefix);
    const boxH = Math.min(h, matches.length + 2);
    if (boxH < 2) return;

    // Fill body — overlay sits on the panel layer
    buf.fillRect({ x, y, w, h: boxH }, " ", undefined, "panel");

    // Borders
    const ascii = this.state.ascii ?? false;
    const [tl, tr, bl, br, horiz, vert] = ascii
      ? ["+", "+", "+", "+", "-", "|"]
      : ["┌", "┐", "└", "┘", "─", "│"];
    buf.set(x, y, tl, "border");
    if (w > 1) buf.set(x + w - 1, y, tr, "border");
    if (boxH > 1) {
      buf.set(x, y + boxH - 1, bl, "border");
      if (w > 1) buf.set(x + w - 1, y + boxH - 1, br, "border");
    }
    for (let c = 1; c < w - 1; c++) {
      buf.set(x + c, y, horiz, "border");
      if (boxH > 1) buf.set(x + c, y + boxH - 1, horiz, "border");
    }
    for (let r = 1; r < boxH - 1; r++) {
      buf.set(x, y + r, vert, "border");
      if (w > 1) buf.set(x + w - 1, y + r, vert, "border");
    }

    // Title chip
    if (w >= 14) {
      const titleStr = " commands ";
      let cx = x + 2;
      for (const ch of titleStr) {
        buf.set(cx, y, ch, "text2", false, "panelHi");
        cx++;
      }
    }

    // Matches
    const maxRows = boxH - 2;
    for (let i = 0; i < maxRows && i < matches.length; i++) {
      const cmd = matches[i];
      const yy = y + 1 + i;
      const isSelected = i === this.state.selected;

      if (isSelected) {
        for (let dx = 1; dx < w - 1; dx++) {
          buf.set(x + dx, yy, " ", undefined, false, "accentDim");
        }
        buf.set(x + 1, yy, "▎", "accent", false, "accentDim");
      }

      // Column 2: /name
      const nameStr = "/" + cmd.name;
      let nx = x + 2;
      for (const ch of nameStr) {
        if (nx >= x + 18 || nx >= x + w - 1) break;
        buf.set(nx, yy, ch, isSelected ? "text" : "accent");
        nx++;
      }

      // usage (between name and column 19)
      if (cmd.usage && nx < x + 18) {
        let ux = nx + 1;
        for (const ch of cmd.usage) {
          if (ux >= x + 18 || ux >= x + w - 1) break;
          buf.set(ux, yy, ch, "muted");
          ux++;
        }
      }

      // Column 19: help
      let hx = x + 19;
      if (hx < x + w - 1) {
        for (const ch of cmd.help) {
          if (hx >= x + w - 1) break;
          buf.set(hx, yy, ch, isSelected ? "text2" : "muted");
          hx++;
        }
      }
    }
  }
}
