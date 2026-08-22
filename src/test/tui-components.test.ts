import { test } from "node:test";
import assert from "node:assert/strict";
import { BoxNode } from "../ui/tui/components/box.js";
import { StatusBarNode, InputLineNode, SlashMenuNode } from "../ui/tui/components/chrome.js";
import { TextNode } from "../ui/tui/core/node.js";
import { renderToLines } from "../ui/tui/core/renderer.js";
import { stringWidth } from "../ui/tui/core/text.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const frame = (n: any, cols = 40, rows = 8, depth: 1 | 4 | 8 | 24 = 1) => renderToLines(n, cols, rows, depth).map(strip);

test("box paints square corners and holds its width", () => {
  const b = new BoxNode({ title: "records" });
  b.add(new TextNode("hello"));
  const f = frame(b);
  assert.ok(f[0].startsWith("┌") && f[0].endsWith("┐"));
  assert.ok(f[f.length - 1].startsWith("└") && f[f.length - 1].endsWith("┘"));
  assert.ok(f[0].includes("records"));
  assert.ok(!f.join("").includes("╭"), "no rounded corners anywhere");
  for (const l of f) assert.equal(stringWidth(l), 40);
});

test("ascii fallback uses +-| only", () => {
  const f = frame(new BoxNode({ title: "t", ascii: true }));
  assert.match(f[0], /^\+[-+]/);
  assert.ok(!/[┌┐└┘─│]/.test(f.join("")));
});

test("input line ascii fallback uses +-| borders only", () => {
  const input = new InputLineNode({
    value: "",
    placeholder: "",
    cwdTail: "",
    frame: 0,
    motionOn: false,
    ascii: true,
  });
  const f = frame(input, 50, 3);
  assert.ok(f[0].startsWith("+"));
  assert.ok(!/[┌┐└┘─│]/.test(f.join("")));
});

test("slash menu ascii fallback uses +-| borders only", () => {
  const f = frame(new SlashMenuNode({ prefix: "", selected: 0, ascii: true }), 56, 14);
  assert.ok(f[0].startsWith("+"));
  assert.ok(!/[┌┐└┘─│]/.test(f.join("")));
});

test("content wraps inside the interior, never over the border", () => {
  const b = new BoxNode({});
  b.add(new TextNode("append-only reader bounded never rewrite evidence at all"));
  const f = frame(b, 24, 6);
  for (const l of f.slice(1, -1)) {
    assert.equal(l[0], "│");
    assert.equal(l[l.length - 1], "│");
  }
});

test("statusbar adapts to width", () => {
  const segs: Array<[string, string]> = [["tab", "panes"], ["enter", "run"], ["esc", "back"]];
  const wide = frame(new StatusBarNode(segs, "local only · no egress"), 100, 1)[0];
  assert.ok(wide.includes("local only"));
  assert.ok(wide.includes("panes"));

  const compact = frame(new StatusBarNode(segs, "local only · no egress"), 60, 1)[0];
  assert.ok(compact.includes("local only"), "right text present at 60 cols");
  assert.ok(!compact.includes("panes"), "labels dropped below 76 cols");
  assert.ok(compact.includes("tab"), "keys kept below 76 cols");

  const narrow = frame(new StatusBarNode(segs, "local only · no egress"), 40, 1)[0];
  assert.ok(!narrow.includes("local only"), "right text dropped below 52 cols");
  assert.ok(!narrow.includes("panes"), "labels dropped below 52 cols");
  assert.ok(narrow.includes("tab"), "keys kept below 52 cols");
});

test("input line paints prompt, cwd chip, and cursor", () => {
  const input = new InputLineNode({
    value: "npm test",
    placeholder: "type a command",
    cwdTail: "rocky/src",
    frame: 0,
    motionOn: true,
  });
  const f = frame(input, 50, 3);
  assert.ok(f[0].includes("rocky · rocky/src"));
  assert.ok(f[1].includes("›"));
  assert.ok(f[1].includes("npm test"));
  assert.ok(f[1].includes("▏"));
});

test("input line placeholder displayed when value empty", () => {
  const input = new InputLineNode({
    value: "",
    placeholder: "type a command",
    cwdTail: "rocky",
    frame: 0,
    motionOn: true,
  });
  const f = frame(input, 50, 3);
  assert.ok(f[1].includes("type a command"));
});

test("slash menu lists matches and marks the selection", () => {
  const f = frame(new SlashMenuNode({ prefix: "", selected: 1 }), 56, 14);
  assert.ok(f.some((l) => l.includes("/run")));
  assert.ok(f.some((l) => l.includes("/recall")));
  const selRow = f.find((l) => l.includes("▎"));
  assert.ok(selRow && selRow.includes("/recall"), "second entry carries the cursor");
});

test("slash menu filters by prefix", () => {
  const f = frame(new SlashMenuNode({ prefix: "rec", selected: 0 }), 56, 14);
  assert.ok(f.some((l) => l.includes("/recall")));
  assert.ok(!f.some((l) => l.includes("/brief")));
});
