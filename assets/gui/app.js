/*
 * rocky gui -- one page, one route, two segments.
 *
 * The server hands the token in the URL fragment; every fetch carries it back
 * as X-Rocky-Token. Nothing here mutates evidence: the whole surface is reads.
 * Teach has no view of its own -- it is what selecting lines does.
 */

const TOKEN = location.hash.slice(1);

/** Repeated or unknown ?v= falls back to main rather than throwing. */
function initialSegment() {
  const all = new URLSearchParams(location.search).getAll("v");
  const value = all.length === 1 ? all[0] : "";
  return value === "dash" ? "dash" : "main";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "X-Rocky-Token": TOKEN, ...(options.headers ?? {}) },
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fill(host, ...children) {
  host.replaceChildren(...children);
}

/** el() takes text; box() takes children. */
function box(className, ...children) {
  const node = el("div", className);
  node.append(...children);
  return node;
}

/** Waiting, drawn the way rocky finds anything out: sound out, sound back. */
function skeleton() {
  return box(
    "listen",
    box("rings", el("div", "ring"), el("div", "ring"), el("div", "ring"), el("div", "core")),
  );
}

function empty(...lines) {
  const wrap = el("div", "empty");
  for (const line of lines) wrap.append(el("p", null, line));
  return wrap;
}

/** An error that promises a retry has to offer one. */
function failed(retry) {
  const wrap = box("fail", el("p", null, "rocky not hear answer."));
  if (retry) {
    const again = el("button", "fail-retry", "listen again");
    again.type = "button";
    again.addEventListener("click", retry);
    wrap.append(again);
  }
  return wrap;
}

/** A list has a known shape, so its wait keeps that shape. */
function listSkeleton(rows) {
  const wrap = el("div", "skel-list");
  for (let i = 0; i < rows; i += 1) {
    const bar = el("div", "skel-row");
    bar.style.width = `${76 - (i % 4) * 11}%`;
    wrap.append(bar);
  }
  return wrap;
}

/* ---- syntax ------------------------------------------------------------ */

const KEYWORD = new Set(
  ("const let var function return if else for while do try catch finally throw new class extends " +
   "import export from as async await typeof instanceof in of this super switch case break continue " +
   "default delete void yield static get set interface type enum implements readonly public private " +
   "protected abstract declare namespace satisfies keyof infer is null undefined true false").split(" "),
);

// ponytail: a tokeniser, not a parser. It knows comments, strings, numbers,
// keywords and call sites, which is every distinction a reader needs here.
const CODE_TOKEN = /(\/\/.*$|\/\*.*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;

/**
 * Paints one line into `host`. `openComment` carries block-comment state
 * across lines, so a block comment spanning ten lines is dim for all ten.
 * Returns the state for the next line.
 */
function paintCode(host, text, openComment) {
  if (openComment) {
    const end = text.indexOf("*/");
    if (end === -1) {
      host.append(el("span", "tk-c", text));
      return true;
    }
    host.append(el("span", "tk-c", text.slice(0, end + 2)));
    return paintCode(host, text.slice(end + 2), false);
  }

  const opens = text.indexOf("/*");
  if (opens !== -1 && text.indexOf("*/", opens) === -1) {
    paintCode(host, text.slice(0, opens), false);
    host.append(el("span", "tk-c", text.slice(opens)));
    return true;
  }

  let last = 0;
  CODE_TOKEN.lastIndex = 0;
  for (let m = CODE_TOKEN.exec(text); m !== null; m = CODE_TOKEN.exec(text)) {
    if (m.index > last) host.append(document.createTextNode(text.slice(last, m.index)));
    const [whole, comment, string, number, word] = m;
    if (comment !== undefined) host.append(el("span", "tk-c", whole));
    else if (string !== undefined) host.append(el("span", "tk-s", whole));
    else if (number !== undefined) host.append(el("span", "tk-n", whole));
    else if (KEYWORD.has(word)) host.append(el("span", "tk-k", whole));
    else if (text[m.index + whole.length] === "(") host.append(el("span", "tk-f", whole));
    else host.append(document.createTextNode(whole));
    last = m.index + whole.length;
  }
  if (last < text.length) host.append(document.createTextNode(text.slice(last)));
  return false;
}

/** A code cell, coloured. Returns the block-comment state for the next line. */
function codeCell(text, openComment) {
  const cell = el("span", "lt");
  const next = paintCode(cell, text, openComment);
  return { cell, openComment: next };
}

/* ---- segments --------------------------------------------------------- */

const state = {
  segment: initialSegment(),
  mode: "lines",
  file: null,
  filter: "",
  total: null,
  fileCount: null,
  mainLoaded: false,
  recent: [],
  // record modes: the TUI's showDiff, strict picker, and the two chosen moments
  showDiff: true,
  strict: false,
  A: null,
  B: null,
};

/** The TUI header reads "N remembered · N files". Each half appears once known. */
function setTally() {
  const parts = [];
  if (state.total !== null) parts.push(`${state.total} Remembered`);
  if (state.segment === "dash" && state.fileCount !== null) {
    parts.push(`${state.fileCount} Files`);
  }
  $("#tally").textContent = parts.join(" | ");
}

// data-seg, not .seg-btn: the provider control reuses that class and has no panel
const tabs = [...document.querySelectorAll("[data-seg]")];

function showSegment(name) {
  state.segment = name;
  for (const tab of tabs) {
    const on = tab.dataset.seg === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#${tab.getAttribute("aria-controls")}`).hidden = !on;
  }
  setTally();
  if (name === "main") loadMain();
  else loadFiles();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showSegment(tab.dataset.seg));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    next.focus();
    showSegment(next.dataset.seg);
  });
}

/* ---- main ------------------------------------------------------------- */

/** Kinds that are rocky explaining himself. These carry the voice colour. */
const WHY_KINDS = new Set(["rationale", "explain", "triple"]);

/** House style: title case, and a bar where the core sends a middle dot. */
function houseStyle(text) {
  return text
    .split(" · ")
    .map((part) => part.replace(/\b[a-z]/g, (letter) => letter.toUpperCase()))
    .join(" | ");
}

function countRow(label, count, tone) {
  const row = el("div", "row");
  row.append(el("span", "row-label", label));
  const number = el("span", "row-num", String(count));
  if (count > 0 && tone) number.classList.add(tone);
  row.append(number);
  return row;
}

async function loadMain() {
  if (state.mainLoaded) return;
  state.mainLoaded = true;
  fill($("#holds"), skeleton(3));
  fill($("#day"), skeleton(4));

  let data;
  try {
    data = await api("/api/home");
  } catch {
    state.mainLoaded = false;
    fill($("#holds"), failed(loadMain));
    fill($("#day"));
    return;
  }

  state.total = data.total;
  setTally();

  const holds = data.byKind.length === 0
    ? [empty("no records yet")]
    : data.byKind.map((entry) => countRow(entry.kind, entry.count, "live"));
  // Coverage is rocky admitting what he did not read, so it is never hidden.
  if (data.coverageLine) holds.push(el("div", "row-note", houseStyle(data.coverageLine)));
  fill($("#holds"), ...holds);

  fill(
    $("#day"),
    countRow("heard", data.day.heard, "live"),
    countRow("failures", data.day.failures, "live"),
    countRow("fixes", data.day.fixes, "live"),
    countRow("why recorded", data.day.whys, "why"),
  );

  fill(
    $("#topfiles"),
    ...(data.topFiles.length === 0
      ? [empty("(none heard yet)")]
      : data.topFiles.map((file) => {
          const row = el("div", "row");
          // rtl truncation keeps the filename, the mark keeps the path readable
          row.append(el("span", "row-path", `‪${file.name}`), el("span", "row-num", String(file.count)));
          return row;
        })),
  );

  fill(
    $("#recent"),
    ...(data.recent.length === 0
      ? [empty("no records yet")]
      : data.recent.map((hit) => {
          const row = el("div", "recent-row");
          const kind = el("span", "recent-kind", hit.kind);
          if (WHY_KINDS.has(hit.kind)) kind.classList.add("why");
          row.append(kind, el("span", "recent-label", hit.label), el("span", "recent-ago", hit.agoText));
          return row;
        })),
  );
}

/* ---- dash: picker ----------------------------------------------------- */

/** The total lives in the home payload, so Dash asks for it once. */
async function ensureTotal() {
  if (state.total !== null) return;
  try {
    const home = await api("/api/home");
    state.total = home.total;
    state.recent = home.recent ?? [];
    setTally();
    // the pane is still empty at this point, so it gets something real
    if (state.file === null) paneWelcome();
  } catch {
    // a missing tally is not worth an error state
  }
}

/**
 * What the pane says before a file is picked. An empty screen is an
 * invitation to act, so it answers "what has been going on" and points at
 * the one control that does anything.
 */
function paneWelcome() {
  const parts = [el("p", "welcome-head", "Lately Heard")];

  if ((state.recent ?? []).length === 0) {
    parts.push(el("p", "welcome-note", "nothing heard yet. run something through rocky, question"));
  } else {
    for (const hit of state.recent) {
      const row = el("div", "welcome-row");
      const kind = el("span", "welcome-kind", hit.kind);
      if (WHY_KINDS.has(hit.kind)) kind.classList.add("why");
      row.append(kind, el("span", "welcome-label", hit.label), el("span", "welcome-ago", hit.agoText));
      parts.push(row);
    }
  }

  parts.push(el("p", "welcome-note", "pick file on left to hear why its lines are the way they are."));
  fill($("#pane-body"), box("welcome", ...parts));
}

async function loadFiles() {
  ensureTotal();
  fill($("#files"), listSkeleton(7));
  let files;
  try {
    files = await api(`/api/files?q=${encodeURIComponent(state.filter)}`);
  } catch {
    fill($("#files"), failed(loadFiles));
    return;
  }
  state.fileCount = files.length;
  setTally();
  $("#files-head").textContent = `Files: ${files.length}`;

  if (files.length === 0) {
    fill($("#files"), empty("no explain records heard yet."));
    return;
  }

  fill(
    $("#files"),
    ...files.map((file) => {
      const button = el("button", "file");
      button.type = "button";
      button.title = file.path;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(file.path === state.file));
      // count first, then the basename -- the same row shape the TUI paints
      button.append(
        el("span", "file-count", String(file.count)),
        el("span", "file-name", file.path.split("/").pop()),
      );
      button.addEventListener("click", () => openFile(file.path));
      return button;
    }),
  );
}

let filterTimer = 0;
$("#filter").addEventListener("input", (event) => {
  state.filter = event.target.value.trim();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(loadFiles, 120);
});

/* ---- dash: pane ------------------------------------------------------- */

const modes = [...document.querySelectorAll(".mode-btn")];

function setMode(mode) {
  state.mode = mode;
  for (const button of modes) {
    const on = button.dataset.mode === mode;
    button.setAttribute("aria-selected", String(on));
    button.tabIndex = on ? 0 : -1;
  }
  // the diff toggle is the TUI's `d` key, and only the record modes have diffs
  $("#pane-sub").hidden = mode === "lines";
  $("#sel").textContent = "";
  closeMoments();
  closePop();
  if (state.file) renderPane();
}

for (const button of modes) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

$("#show-diff").addEventListener("change", (event) => {
  state.showDiff = event.target.checked;
  if (state.file) renderPane();
});

function openFile(path) {
  state.file = path;
  // moments belong to a file, so a new file drops the pair
  state.A = null;
  state.B = null;
  $("#pane-path").textContent = path;
  $("#sel").textContent = "";
  closeMoments();
  for (const button of $("#files").querySelectorAll(".file")) {
    button.setAttribute("aria-selected", String(button.title === path));
  }
  closePop();
  renderPane();
}

async function renderPane() {
  const body = $("#pane-body");
  fill(body, skeleton(8));
  try {
    if (state.mode === "lines") await renderLines(body);
    else if (state.mode === "history") await renderHistory(body);
    else await renderCompare(body);
  } catch {
    fill(body, failed(renderPane));
  }
}

async function renderLines(body) {
  const data = await api(`/api/file?path=${encodeURIComponent(state.file)}`);
  if (data.missing) {
    fill(body, empty("file not on disk. rocky cannot read it, question"));
    return;
  }
  let open = false;
  const rows = data.lines.map((text, index) => {
    const row = el("div", "cl");
    row.dataset.line = String(index + 1);
    const painted = codeCell(text, open);
    open = painted.openComment;
    row.append(el("span", "ln", String(index + 1)), painted.cell);
    return row;
  });
  if (data.truncated) rows.push(el("div", "trunc", "… file long, lines cut"));
  fill(body, ...rows);
}

const KIND_CLASS = { "@": "dl-at", h: "dl-h", "+": "dl-p", "-": "dl-m" };

/** One diff, the shape `diffFor` returns. */
function diffBlock(diff) {
  const wrap = el("div", "diff");
  if (diff.commit) {
    wrap.append(
      el("div", "diff-head", `${diff.prior ? "last change before · " : ""}commit ${diff.commit}`),
    );
  }
  let open = false;
  for (const row of diff.rows ?? []) {
    const line = el("div", `dl ${KIND_CLASS[row.k] ?? ""}`);
    // hunk headers are not code, so they are never tokenised
    if (row.k === "@") {
      line.append(el("span", "ln", ""), el("span", "lt", row.t));
    } else {
      const painted = codeCell(row.t, open);
      open = painted.openComment;
      line.append(el("span", "ln", row.n ? String(row.n) : ""), painted.cell);
    }
    wrap.append(line);
  }
  return wrap;
}

const bodyText = (record) => record.reason ?? record.summary ?? record.excerpt ?? "";
const labelText = (record) => `${record.kind} ${record.source} ${record.ago}`;

/** Kind, source and age are three facts, so they get three columns rather
 *  than a chain of separator dots to squint through. */
function headRow(record) {
  const row = el("div", "rec-top");
  const kind = el("span", "rec-kind", record.kind);
  if (WHY_KINDS.has(record.kind)) kind.classList.add("why");
  row.append(kind, el("span", "rec-src", record.source), el("span", "rec-ago", record.ago));
  return row;
}

/** A record row. Clicking it sends the full intent to the why column. */
function recordRow(record, extra) {
  const item = el("div", `rec${extra ?? ""}`);
  item.tabIndex = 0;
  item.append(headRow(record), el("div", "rec-body", bodyText(record)));
  if (state.showDiff && record.diff) item.append(diffBlock(record.diff));
  const choose = () => {
    for (const other of document.querySelectorAll(".rec.on")) other.classList.remove("on");
    item.classList.add("on");
    showIntent(record, item.getBoundingClientRect());
  };
  item.addEventListener("click", (event) => {
    // otherwise the click reaches the document listener and shuts the answer
    event.stopPropagation();
    choose();
  });
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose();
    }
  });
  return item;
}

/* mode: all history */

async function renderHistory(pane) {
  const data = await api(`/api/compare?path=${encodeURIComponent(state.file)}`);
  state.moments = data.records ?? [];
  $("#sub-note").textContent = `${state.moments.length} moments`;
  if (state.moments.length === 0) {
    fill(pane, empty("nothing heard for this file yet."));
    return;
  }
  fill(pane, ...state.moments.map((record) => recordRow(record)));
}

/* mode: two moments */

async function renderCompare(pane) {
  $("#sub-note").textContent = state.strict ? "Strict · Same Lines" : "Loose | Whole File";

  // Each side draws from the moment it holds, on its own. Requiring both
  // meant picking A showed nothing until B was picked too, which read as
  // the pick having failed.
  let moments = [];
  try {
    moments = await api(`/api/moments?path=${encodeURIComponent(state.file)}`);
  } catch {
    // an unreadable list leaves both sides on their pick prompt
  }

  const sideFor = (side, id) => {
    const record = id === null ? null : moments.find((m) => m.id === id) ?? null;
    return sideColumn(side, record, record?.diff ?? null);
  };

  fill(pane, box("two", sideFor("A", state.A), sideFor("B", state.B)));
}

function sideColumn(side, record, diff) {
  const column = el("div", "side");

  const head = el("button", "side-head");
  head.type = "button";
  head.append(
    el("span", "side-tag", side),
    el("span", "side-label", record ? labelText(record) : "Pick Moment"),
  );
  head.addEventListener("click", (event) => {
    event.stopPropagation();
    openMoments(side, head);
  });
  column.append(head);

  if (record === null) {
    column.append(empty("compare what he knew then against now"));
    return column;
  }

  const detail = el("div", "side-body");
  detail.append(el("div", "rec-body", bodyText(record)));
  if (state.showDiff && diff) detail.append(diffBlock(diff));
  detail.addEventListener("click", (event) => {
    event.stopPropagation();
    showIntent(record, detail.getBoundingClientRect());
  });
  column.append(detail);
  return column;
}

/* the TUI's timeline modal, inlined under the side it changes */

function closeMoments() {
  for (const open of document.querySelectorAll(".moments")) open.remove();
}

async function openMoments(side, anchor) {
  closeMoments();
  const panel = el("div", "moments");

  const search = el("input", "moments-search");
  search.type = "search";
  search.placeholder = "search intent…";
  search.autocomplete = "off";

  const scope = el("button", "moments-scope", state.strict ? "Strict · Same Lines" : "Loose | Whole File");
  scope.type = "button";
  scope.addEventListener("click", () => {
    state.strict = !state.strict;
    openMoments(side, anchor);
  });

  const list = el("div", "moments-list");
  panel.append(box("moments-bar", search, scope), list);
  panel.addEventListener("click", (event) => event.stopPropagation());
  anchor.after(panel);
  search.focus();

  const near = side === "A" ? state.B : state.A;
  let moments;
  try {
    const query = [
      `path=${encodeURIComponent(state.file)}`,
      state.strict ? "strict=1" : "",
      near ? `near=${encodeURIComponent(near)}` : "",
    ].filter(Boolean).join("&");
    moments = await api(`/api/moments?${query}`);
  } catch {
    fill(list, failed(() => openMoments(side, anchor)));
    return;
  }

  const paint = () => {
    const needle = search.value.trim().toLowerCase();
    const shown = needle
      ? moments.filter((record) => `${labelText(record)} ${bodyText(record)}`.toLowerCase().includes(needle))
      : moments;
    if (shown.length === 0) {
      fill(list, empty("no moment touches those same lines"));
      return;
    }
    fill(
      list,
      ...shown.map((record) => {
        const option = el("button", "moment");
        option.type = "button";
        option.append(headRow(record), el("span", "moment-body", bodyText(record)));
        option.addEventListener("click", () => {
          state[side] = record.id;
          closeMoments();
          renderPane();
        });
        return option;
      }),
    );
  };

  search.addEventListener("input", paint);
  paint();
}

document.addEventListener("click", closeMoments);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMoments();
});

/* a record's full intent, opened beside the record it belongs to */

function showIntent(record, anchor) {
  const parts = [el("p", "card-head assembled", record.machine ? "intent · agent raw" : "intent")];

  if (record.machine) {
    parts.push(el("p", "card-line", "machine note, not human words"));
    const raw = el("button", "card-more", "show raw");
    raw.type = "button";
    const rawText = el("p", "rung", record.intent ?? bodyText(record));
    raw.addEventListener("click", () => {
      const open = raw.textContent === "hide raw";
      raw.textContent = open ? "show raw" : "hide raw";
      if (open) rawText.remove();
      else pop.append(rawText);
    });
    parts.push(raw);
  } else {
    parts.push(el("p", "card-line", record.intent ?? bodyText(record)));
  }

  parts.push(el("div", "card-ev", `source: ${record.source} · ${record.ago}`));
  openPop(anchor, ...parts);
}

/* ---- dash: selection drives teach -------------------------------------- */

const ask = $("#ask");
let pending = null;

function clearPicked() {
  for (const row of document.querySelectorAll(".cl.picked")) row.classList.remove("picked");
}

function readSelection() {
  if (state.mode !== "lines") return null;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const rows = [...$("#pane-body").querySelectorAll(".cl")].filter((row) =>
    range.intersectsNode(row),
  );
  if (rows.length === 0) return null;

  const rect = range.getBoundingClientRect();
  return {
    rows,
    start: Number(rows[0].dataset.line),
    end: Number(rows[rows.length - 1].dataset.line),
    rect,
  };
}

document.addEventListener("selectionchange", () => {
  // clicking inside the answer collapses the selection; the range it answers
  // stays marked until the popover closes
  if (!pop.hidden) return;
  const picked = readSelection();
  clearPicked();
  if (picked === null) {
    ask.hidden = true;
    pending = null;
    return;
  }
  for (const row of picked.rows) row.classList.add("picked");
  pending = picked;
  $("#sel").textContent = `sel ${picked.start}–${picked.end}`;
  ask.hidden = false;
  ask.style.left = `${Math.max(8, picked.rect.left)}px`;
  ask.style.top = `${Math.max(8, picked.rect.top - 38)}px`;
});

ask.addEventListener("click", (event) => {
  // the document listener closes the popover, so this click must not reach it
  event.stopPropagation();
  if (pending !== null) askWhy(pending.start, pending.end, ask.getBoundingClientRect());
});

/* ---- the why popover ---------------------------------------------------- */

const pop = $("#pop");

/** Opens beside `rect`, flipping above or below to stay on screen. */
function openPop(rect, ...nodes) {
  fill(pop, ...nodes);
  pop.hidden = false;
  const size = pop.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - size.width - 12));
  const above = rect.top - size.height - 10;
  const below = rect.bottom + 10;
  const top = above >= 12 ? above : Math.min(below, window.innerHeight - size.height - 12);
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(12, top)}px`;
}

function closePop() {
  pop.hidden = true;
  fill(pop);
  clearPicked();
}

pop.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  if (!pop.hidden) closePop();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !pop.hidden) closePop();
});

/**
 * `deepseek-v4-flash` reads as `Deepseek V4 Flash`. A version token keeps all
 * its letters capitalised, because `V4` is not a word being title-cased.
 */
const ACRONYMS = new Set(["gpt", "glm", "ai", "api", "llm", "mimo", "hy"]);

function prettyModel(id) {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => {
      // a version token and an acronym both keep every letter
      if (/^v\d/i.test(word) || ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** The provider is whoever the endpoint points at, not whichever tab is lit. */
function providerOf(endpoint) {
  try {
    const host = new URL(endpoint).hostname;
    if (host.endsWith("anthropic.com")) return "anthropic";
    if (host.endsWith("openai.com")) return "openai";
  } catch {
    // an unparseable endpoint is simply not a known provider
  }
  return "other";
}

/** Simple marks, drawn here because the page may fetch nothing from outside. */
function providerMark(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "chip-mark");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  if (kind === "anthropic") {
    // the converging apex of the anthropic mark
    path.setAttribute("d", "M6.1 2h3.8l4.1 12h-3l-.8-2.6H5.8L5 14H2L6.1 2Zm.5 6.9h2.8L8 4.6 6.6 8.9Z");
  } else if (kind === "openai") {
    // a hexagonal knot, the shape of the openai mark in outline
    path.setAttribute("d", "M8 1.2 13.9 4.6v6.8L8 14.8 2.1 11.4V4.6L8 1.2Zm0 2.1L4 5.6v4.8l4 2.3 4-2.3V5.6L8 3.3Zm0 2.4a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z");
  } else {
    // an unknown host gets a neutral mark rather than a borrowed one
    path.setAttribute("d", "M8 1.6a6.4 6.4 0 1 0 0 12.8A6.4 6.4 0 0 0 8 1.6Zm0 2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8Zm0 2.6a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z");
  }
  svg.append(path);
  return svg;
}

/** What the catalogue said about the endpoint currently typed in Settings. */
let provider = null;

/** Rebuilds a catalogue mark from geometry alone; no foreign markup enters. */
function markFromMeta(mark) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", mark.viewBox);
  svg.setAttribute("class", "chip-mark");
  svg.setAttribute("aria-hidden", "true");
  for (const d of mark.paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
  }
  return svg;
}

/** Asks the catalogue who serves an endpoint. Null means it does not know. */
async function loadProvider(endpoint) {
  if (!endpoint) return null;
  try {
    return await api(`/api/provider?endpoint=${encodeURIComponent(endpoint)}`);
  } catch {
    return null;
  }
}

/**
 * The model field only ever offers models the endpoint actually serves. An
 * endpoint the catalogue does not recognise offers none: a wrong list is
 * worse than no list, because it would be picked and then fail at request time.
 */
function paintModels() {
  const select = $("#set-model");
  const note = $("#model-note");
  const chosen = settings.model;

  if (provider === null) {
    fill(select);
    select.disabled = true;
    note.textContent = "Endpoint not known, no models to pick.";
    return;
  }

  select.disabled = false;
  note.textContent = `${provider.name} · ${provider.models.length} models`;
  fill(
    select,
    ...provider.models.map((model) => {
      const option = el("option", null, model.name);
      option.value = model.id;
      if (model.id === chosen) option.selected = true;
      return option;
    }),
  );
  // a stored model the provider no longer lists is still shown, not silently swapped
  if (chosen && !provider.models.some((m) => m.id === chosen)) {
    const stale = el("option", null, `${chosen} (not listed)`);
    stale.value = chosen;
    stale.selected = true;
    select.prepend(stale);
  }
}

/**
 * The provider control is a filtered list, not a `<select>`: the catalogue
 * carries 177 of them, and a native dropdown can be neither capped nor
 * searched. Ten rows show at a time and the rest scroll.
 */
let providerChoices = [];
let chosen = { endpoint: "", custom: true };

/** The endpoint in force: the picked provider, or whatever Custom holds. */
function currentEndpoint() {
  return chosen.custom ? $("#set-endpoint").value.trim() : chosen.endpoint;
}

function closeProviders() {
  $("#provider-list").hidden = true;
  $("#provider-search").setAttribute("aria-expanded", "false");
}

/** Draws the rows matching what has been typed, Custom always last. */
function paintProviderList(needle = "") {
  const list = $("#provider-list");
  const query = needle.trim().toLowerCase();
  const shown = query
    ? providerChoices.filter((p) => p.name.toLowerCase().includes(query) || p.id.includes(query))
    : providerChoices;

  const rows = shown.map((p) => {
    const row = el("button", "combo-row", p.name);
    row.type = "button";
    if (!chosen.custom && p.endpoint === chosen.endpoint) row.classList.add("on");
    row.addEventListener("click", (event) => {
      event.stopPropagation();
      chosen = { endpoint: p.endpoint, custom: false };
      $("#provider-search").value = p.name;
      // a different provider serves different models, so the old pick cannot stand
      settings.model = "";
      closeProviders();
      void refreshModels();
    });
    return row;
  });

  const custom = el("button", "combo-row", "Custom…");
  custom.type = "button";
  if (chosen.custom) custom.classList.add("on");
  custom.addEventListener("click", (event) => {
    event.stopPropagation();
    chosen = { endpoint: "", custom: true };
    $("#provider-search").value = "Custom…";
    settings.model = "";
    closeProviders();
    void refreshModels();
    $("#set-endpoint").focus();
  });

  fill(list, ...rows, custom);
  list.hidden = false;
  $("#provider-search").setAttribute("aria-expanded", "true");
}

async function paintProviders() {
  if (providerChoices.length === 0) {
    try {
      providerChoices = await api("/api/providers");
    } catch {
      providerChoices = [];
    }
  }
  const match = providerChoices.find((p) => p.endpoint === settings.endpoint);
  chosen = match ? { endpoint: match.endpoint, custom: false } : { endpoint: "", custom: true };
  $("#provider-search").value = match ? match.name : "Custom…";
  if (chosen.custom) $("#set-endpoint").value = settings.endpoint;
  closeProviders();
}

$("#provider-search").addEventListener("focus", () => {
  $("#provider-search").select();
  paintProviderList("");
});
$("#provider-search").addEventListener("input", (event) => paintProviderList(event.target.value));
$("#provider-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeProviders();
});
$("#provider-list").addEventListener("click", (event) => event.stopPropagation());

/** The typed endpoint is only ever visible while Custom is the choice. */
function syncEndpointField() {
  $("#endpoint-field").hidden = !chosen.custom;
}

/** Re-asks the catalogue for whatever endpoint is in force right now. */
async function refreshModels() {
  $("#model-note").textContent = "asking models.dev…";
  provider = await loadProvider(currentEndpoint());
  paintModels();
  // every path that changes the endpoint lands here, so visibility settles here
  syncEndpointField();
}

let modelTimer = 0;
$("#set-endpoint").addEventListener("input", () => {
  clearTimeout(modelTimer);
  // a URL is typed a character at a time; only the pause is worth a lookup
  modelTimer = setTimeout(refreshModels, 450);
});

/** The bar says which model would answer, so nobody has to open Settings to find out. */
async function paintModelChip() {
  const chip = $("#model-chip");
  if (!settings.hasKey || !settings.model) {
    chip.hidden = true;
    fill(chip);
    return;
  }

  const known = provider ?? (await loadProvider(settings.endpoint));
  const named = known?.models.find((m) => m.id === settings.model);
  fill(
    chip,
    known?.mark ? markFromMeta(known.mark) : providerMark(providerOf(settings.endpoint)),
    el("span", null, named?.name ?? prettyModel(settings.model)),
  );
  chip.hidden = false;
}

/** True once the user has filled in all three BYOK fields. */
function byokReady() {
  return Boolean(settings.hasKey && settings.endpoint && settings.model);
}

/**
 * A model answer is a guess over evidence rocky already holds, so it is grey
 * and says so. Clay is reserved for what rocky actually heard, and a guess
 * that borrowed that colour would be the one lie this whole surface avoids.
 */
async function askModel(anchor, prompt, keep) {
  openPop(anchor, ...keep, box("guess", el("p", "guess-head", "Model Guess (Beta)"), skeleton()));

  let answer;
  try {
    answer = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // only the prompt travels: endpoint, model and key are read server side
      body: JSON.stringify({ prompt }),
    });
  } catch {
    openPop(anchor, ...keep, box("guess", el("p", "guess-head", "Model Guess (Beta)"),
      el("p", "guess-body", "model not answer. check endpoint, key, model, question")));
    return;
  }

  const guess = box(
    "guess",
    el("p", "guess-head", "Model Guess (Beta)"),
    el("p", "guess-body", answer.text || answer.error || "model said nothing."),
    el("div", "card-ev", `guessed by ${settings.model}. not evidence. cross check`),
  );
  openPop(anchor, ...keep, guess);
}

/** Adds the ask control, but only once BYOK is actually configured. */
function withAsk(anchor, parts, prompt, held) {
  if (!byokReady()) return parts;
  // the same action, but the label admits whether rocky already answered
  const label = held
    ? "Re-explain this with Agent (May use your AI API)"
    : "Use Agent to explain this (May use your AI API)";
  const button = el("button", "card-more ask-agent", label);
  button.type = "button";
  button.addEventListener("click", () => askModel(anchor, prompt, parts));
  return [...parts, button];
}

/** The snippet the question is about, read straight off the painted lines. */
function snippetFor(start, end) {
  return [...$("#pane-body").querySelectorAll(".cl")]
    .filter((row) => Number(row.dataset.line) >= start && Number(row.dataset.line) <= end)
    .map((row) => row.querySelector(".lt").textContent)
    .join("\n");
}

async function askWhy(start, end, at) {
  const anchor = at ?? ask.getBoundingClientRect();
  const snippet = snippetFor(start, end);
  ask.hidden = true;
  openPop(anchor, skeleton());

  let data;
  try {
    data = await api("/api/teach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.file, start, end }),
    });
  } catch {
    openPop(anchor, failed(() => askWhy(start, end, anchor)));
    return;
  }

  // the TUI's wording, not the `rocky why` CLI wording -- this surface
  // replaces the TUI, so it says what the TUI says
  const askedAbout = `${state.file} lines ${start}-${end}\n\n${snippet}`;

  if (data === null || data.header === undefined) {
    const bare = [empty("no witness, no ladder.", "", "ask agent to explain, question")];
    openPop(anchor, ...withAsk(
      anchor,
      bare,
      `Why is this code written this way? Rocky has no recorded reason for it.\n\n${askedAbout}\n\nAnswer in two or three sentences. Say plainly if you cannot tell from the code alone.`,
    ));
    return;
  }

  // Witness keeps the voice colour; assembly stays grey. The header text
  // itself already says which one it is -- the colour just agrees with it.
  const assembled = data.header.startsWith("rocky not hear");
  const head = el("p", `card-head${assembled ? " assembled" : ""}`, data.header);
  const parts = [head, ...data.lines.map((line) => el("p", "card-line", line))];
  parts.push(el("div", "card-ev", data.evidence));

  if (data.expandable && (data.rungs ?? []).length > 0) {
    const more = el("button", "card-more", "show rungs");
    more.type = "button";
    const rungs = data.rungs.map((rung) => el("p", "rung", rung));
    more.addEventListener("click", () => {
      const open = more.textContent === "hide rungs";
      more.textContent = open ? "show rungs" : "hide rungs";
      if (open) for (const rung of rungs) rung.remove();
      else pop.append(...rungs);
    });
    parts.push(more);
  }

  // the model is given what rocky holds, so it interprets rather than invents
  const held = [data.header, ...data.lines, data.evidence].join("\n");
  openPop(anchor, ...withAsk(
    anchor,
    parts,
    `Rocky recorded this about the code below:\n\n${held}\n\n${askedAbout}\n\n` +
      "Explain what that recorded reason means for this code, in two or three sentences. " +
      "Do not invent history rocky did not record.",
    true,
  ));
}

/* ---- settings ----------------------------------------------------------
 *
 * BYOK is beta and off until filled in. It is the one place this page talks
 * to a host other than 127.0.0.1, so the key lives in this browser only and
 * never reaches rocky: the evidence stays local whatever the model answers.
 */

// The key lives in rocky home, never here. `hasKey` is all the page is told.
const settings = { provider: "openai", endpoint: "", model: "", hasKey: false };

async function pullSettings() {
  try {
    Object.assign(settings, await api("/api/settings"));
    paintModelChip();
  } catch {
    // an unreachable config is an unset one: the ask control simply stays away
  }
}

async function pushSettings(patch) {
  try {
    Object.assign(settings, await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }));
    paintModelChip();
  } catch {
    // nothing stored, nothing to undo
  }
}

function paintSettings() {
  $("#set-key").value = "";
  $("#set-key").placeholder = settings.hasKey ? "key saved. type to replace" : "";
}

async function openSettings() {
  await pullSettings();
  paintSettings();
  await paintProviders();
  await refreshModels();
  $("#scrim").hidden = false;
  $("#settings").hidden = false;
  $("#set-endpoint").focus();
}

function closeSettings() {
  closeProviders();
  $("#settings").hidden = true;
  $("#scrim").hidden = true;
  $("#settings-btn").focus();
}

$("#settings-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  openSettings();
});
$("#settings-close").addEventListener("click", closeSettings);
$("#scrim").addEventListener("click", closeSettings);
$("#settings").addEventListener("click", (event) => event.stopPropagation());

$("#settings-save").addEventListener("click", () => {
  const typed = $("#set-key").value;
  void pushSettings({
    provider: settings.provider,
    endpoint: currentEndpoint(),
    model: $("#set-model").value,
    // an untouched field leaves the stored key alone rather than erasing it
    ...(typed ? { key: typed } : {}),
  });
  closeSettings();
});

$("#settings-clear").addEventListener("click", () => {
  $("#set-key").value = "";
  void pushSettings({ key: "" }).then(paintSettings);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#settings").hidden) closeSettings();
});

/* ---- boot -------------------------------------------------------------- */

closePop();
void pullSettings();
showSegment(state.segment);

// A read surface goes stale while the tab is away, so it refetches on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  state.mainLoaded = false;
  if (state.segment === "main") loadMain();
  else loadFiles();
});
