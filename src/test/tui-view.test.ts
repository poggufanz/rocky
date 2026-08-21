import test from "node:test";
import assert from "node:assert/strict";
import { initialState, update, type DashRow } from "../ui/tui/state.js";
import { render } from "../ui/tui/view.js";
import { stringWidth } from "../ui/tui/width.js";

const VP = { cols: 100, rows: 28 };
const mk = (id: string, label: string, kind = "failure", extra: Record<string, unknown> = {}): DashRow =>
  ({
    id,
    badge: "fail",
    label,
    ts: 1_700_000_000_000,
    kind,
    json: JSON.stringify({ id, kind, cmd: label, cwd: "/project", ...extra }, null, 2),
  });

function loaded(rows: DashRow[] = [mk("a", "npm test"), mk("b", "vite build")]) {
  return update(initialState(VP.cols, VP.rows), { type: "data", rows, coverageLine: "coverage full" });
}

function frame(state = loaded()) {
  return render(state, VP, 1, false);
}

test("frame is exactly rows x cols with no escapes at depth 1", () => {
  const lines = frame();
  assert.equal(lines.length, VP.rows);
  for (const line of lines) {
    assert.equal(stringWidth(line), VP.cols);
    assert.ok(!line.includes("\x1b"), "depth 1 emits no escape codes");
  }
});

test("header carries coverage line and hint bar lists context keys", () => {
  const lines = frame();
  assert.ok(lines[0].includes("coverage full"));
  const hints = lines[VP.rows - 1];
  for (const hint of ["[Tab]", "[j/k]", "[/]", "[?]", "[q]"]) {
    assert.ok(hints.includes(hint), hint);
  }
});

test("empty memory renders teaching empty state in rocky voice", () => {
  const s = update(initialState(VP.cols, VP.rows), { type: "data", rows: [], coverageLine: "coverage full" });
  const lines = render(s, VP, 1, false);
  const text = lines.join("\n");
  assert.ok(text.includes("nothing remembered yet"));
  const body = lines.slice(1, -1).join("\n");
  assert.ok(!body.includes("?"), "no bare question marks in voice lines");
});

test("zero-hit search renders filter-empty message, not blank pane", () => {
  let s = loaded();
  s = update(s, { type: "key", key: { name: "char", ch: "/" } });
  for (const c of "zzz") s = update(s, { type: "key", key: { name: "char", ch: c } });
  const text = render(s, VP, 1, false).join("\n");
  assert.ok(text.includes('no match for "zzz"'));
});

test("help overlay replaces panes and lists esc precedence", () => {
  const s = update(loaded(), { type: "key", key: { name: "char", ch: "?" } });
  const text = render(s, VP, 1, false).join("\n");
  assert.ok(text.includes("[/]") && text.includes("[f]") && text.includes("Esc"));
});

test("json tab shows redacted record json and diff tab shows loading state", () => {
  let s = loaded();
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // rationale
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // diff
  s = update(s, { type: "diff-loading", rowId: "a" });
  assert.ok(render(s, VP, 1, false).join("\n").includes("loading"));
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // json
  assert.ok(render(s, VP, 1, false).join("\n").includes('"id": "a"'));
});

test("stacked viewport renders single pane", () => {
  let s = loaded();
  s = update(s, { type: "resize", cols: 60, rows: 18 });
  const lines = render(s, { cols: 60, rows: 18 }, 1, false);
  assert.equal(lines.length, 18);
  for (const line of lines) assert.equal(stringWidth(line), 60);

  // Focus inspector in stacked layout opens full inspector pane
  s = update(s, { type: "key", key: { name: "enter" } });
  const insLines = render(s, { cols: 60, rows: 18 }, 1, false);
  assert.equal(insLines.length, 18);
  for (const line of insLines) assert.equal(stringWidth(line), 60);
  assert.ok(insLines.join("\n").includes("inspector"));
});

test("no emoji anywhere in any frame", () => {
  for (const line of frame()) {
    assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line));
  }
});

test("ascii mode uses ascii borders and selection markers", () => {
  const lines = render(loaded(), VP, 1, true);
  assert.equal(lines.length, VP.rows);
  for (const line of lines) {
    assert.equal(stringWidth(line), VP.cols);
  }
  const text = lines.join("\n");
  assert.ok(text.includes("+"));
  assert.ok(text.includes("|"));
  assert.ok(!text.includes("╭"));
  assert.ok(!text.includes("╰"));
});

test("depth > 1 wraps colored segments with ANSI SGR escape codes", () => {
  const lines = render(loaded(), VP, 24, false);
  assert.equal(lines.length, VP.rows);
  const text = lines.join("\n");
  assert.ok(text.includes("\x1b[38;2;"), "truecolor depth 24 includes 24-bit ANSI codes");
});

test("info and rationale tabs render structured record content", () => {
  const rows = [
    mk("f1", "npm test", "failure", {
      intent: "run tests",
      note: "auth token missing",
      rationale: "token expired during run",
      failureId: "f0",
      file: "src/auth.ts",
      fingerprint: "fp123",
    }),
  ];
  let s = loaded(rows);
  const infoText = render(s, VP, 1, false).join("\n");
  assert.ok(infoText.includes("src/auth.ts"));
  assert.ok(infoText.includes("/project"));

  // Switch to rationale tab
  s = update(s, { type: "key", key: { name: "char", ch: "]" } });
  const rationaleText = render(s, VP, 1, false).join("\n");
  assert.ok(rationaleText.includes("token expired during run"));
});

test("diff tab renders diff lines and diff coloring at depth 24", () => {
  let s = loaded();
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // rationale
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // diff
  s = update(s, { type: "diff-ready", rowId: "a", lines: ["@@ -1,3 +1,3 @@", "+const auth = 1;", "-const auth = 0;"] });
  const plainText = render(s, VP, 1, false).join("\n");
  assert.ok(plainText.includes("+const auth = 1;"));
  assert.ok(plainText.includes("-const auth = 0;"));

  const coloredText = render(s, VP, 24, false).join("\n");
  assert.ok(coloredText.includes("\x1b[38;2;"), "diff lines painted in color");
});

test("viewport edge cases: height 0, 1, 2", () => {
  const s = loaded();
  assert.deepEqual(render(s, { cols: 80, rows: 0 }, 1, false), []);
  const h1 = render(s, { cols: 80, rows: 1 }, 1, false);
  assert.equal(h1.length, 1);
  assert.equal(stringWidth(h1[0]), 80);
  const h2 = render(s, { cols: 80, rows: 2 }, 1, false);
  assert.equal(h2.length, 2);
  assert.equal(stringWidth(h2[0]), 80);
  assert.equal(stringWidth(h2[1]), 80);
});

test("search modal active and fullDiff mode hint lines", () => {
  let s = loaded();
  s = update(s, { type: "key", key: { name: "char", ch: "/" } });
  const searchHints = render(s, VP, 1, false)[VP.rows - 1];
  assert.ok(searchHints.includes("keep filter") || searchHints.includes("cancel"));

  s = update(s, { type: "key", key: { name: "esc" } });
  s = update(s, { type: "key", key: { name: "char", ch: "d" } });
  const fullDiffText = render(s, VP, 1, false).join("\n");
  assert.ok(fullDiffText.includes("inspector"));
});

test("rationale tab shows a rationale record's excerpt string", () => {
  const row = mk("r-not", "rationale", "rationale", {
    excerpt: "pin release truth to v0.7.4 now that tag exists",
    rationale_fidelity: "summary",
    source: "notify",
  });
  delete (JSON.parse(row.json) as Record<string, unknown>).cmd; // sanity only
  const noCmd = { ...row, json: JSON.stringify({ id: row.id, kind: "rationale", excerpt: "pin release truth to v0.7.4 now that tag exists" }, null, 2) };
  let s = loaded([noCmd]);
  s = update(s, { type: "key", key: { name: "char", ch: "]" } }); // rationale tab
  const text = render(s, VP, 1, false).join("\n");
  assert.ok(text.includes("pin release truth"), "excerpt string must render in rationale tab");
  assert.ok(!text.includes("(no additional rationale recorded)"));
});

test("rationale tab shows a triple's nested intent.text and rationale.text", () => {
  const row = { ...mk("t-not", "triple", "triple"), json: JSON.stringify({
    id: "t-not", kind: "triple",
    intent: { text: "add dashboard filter cycle" },
    rationale: { text: "user asked for quick kind filtering" },
  }, null, 2) };
  let s = loaded([row]);
  s = update(s, { type: "key", key: { name: "char", ch: "]" } });
  const text = render(s, VP, 1, false).join("\n");
  assert.ok(text.includes("add dashboard filter cycle"), "intent.text must render");
  assert.ok(text.includes("user asked for quick kind filtering"), "rationale.text must render");
});
