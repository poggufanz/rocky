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

/**
 * Rocky himself, converted from assets/rocky-pixel.webp by masking the warm
 * lit stone off the cold room and mapping what survived onto a density ramp.
 * Drawn by hand it would only have been a guess at his shape.
 */
const FACE = [
  "                                :-:",
  "        %%%%#**+*#**+-         =- .-:",
  "   *%%****+**+++*+=-..:==:     -=  --",
  "=*#@%@#***+***+*+=-::.=+*+=:    ==.-:",
  " :=*+==+++**++++:.:... :=--==: -*:.",
  "   :=--===+++*+:.::...    -=#*+*++:.",
  "    ..:==+==+-:.=  .       :==-==:",
  " =#*- .:-----. -  .      :",
  "++=-:  .: -:-  :.       =+*-",
  "=.        ... -+:        -:-+:",
  "-            ++--         .+*+:",
  "             +**:          .==:.",
  "            :+**:            :-:",
  "             -::             - ::",
  "            .*:-*",
  ".  ::.      .-  +",
];

/** Waiting: rocky arrives a line at a time, from the top down. */
function skeleton() {
  const art = el("pre", "rocky-load");
  art.setAttribute("aria-label", "rocky listening");
  FACE.forEach((line, index) => {
    const row = el("span", "rl-line", line);
    row.style.setProperty("--i", String(index));
    art.append(row);
  });
  return box("listen", art);
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
  view: "individual",
  file: null,
  filter: "",
  total: null,
  fileCount: null,
  bundleCount: null,
  files: [],
  bundles: [],
  selectedBundle: null,
  bundleDiff: null,
  // group keys (repo names, "" for non-repo) the user hid in Filter Repo
  repoHidden: new Set(),
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
  if (state.segment === "dash") {
    if (state.view === "bundle" && state.bundleCount !== null) {
      parts.push(`${state.bundleCount} Bundles`);
    } else if (state.fileCount !== null) {
      parts.push(`${state.fileCount} Files`);
    }
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
  else if (state.view === "bundle") loadBundles();
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
  fill($("#holds"), skeleton());
  fill($("#day"), skeleton());

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

  // The newest record is the anchor: remembering is what this surface is for,
  // so the last thing rocky heard is read first and everything else follows it.
  const [newest, ...rest] = data.recent;
  if (newest === undefined) {
    fill($("#latest"));
    fill($("#recent"), empty("no records yet"));
    return;
  }

  const meta = el("div", "latest-meta");
  const kind = el("span", "latest-kind", newest.kind);
  if (WHY_KINDS.has(newest.kind)) kind.classList.add("why");
  meta.append(kind, el("span", "latest-ago", newest.agoText));

  // Rocky stands beside what he last heard: the face makes the anchor his,
  // and the whole hero rises in one short stagger so the eye lands in order.
  const face = el("pre", "latest-face", FACE.join("\n"));
  face.setAttribute("aria-hidden", "true");
  const body = box(
    "latest-body",
    el("div", "latest-eyebrow", "Last Heard"),
    el("p", "latest-line", newest.label),
    meta,
  );
  [face, body].forEach((node, index) => node.style.setProperty("--i", String(index)));
  fill($("#latest"), face, body);

  // The same line arriving twice is a repeat, not two things to read. It is
  // stacked rather than hidden: the count says how many rocky actually heard.
  const stacked = [];
  for (const hit of [newest, ...rest]) {
    const last = stacked[stacked.length - 1];
    if (last && last.hit.label === hit.label && last.hit.kind === hit.kind) last.count += 1;
    else stacked.push({ hit, count: 1 });
  }

  fill(
    $("#recent"),
    ...stacked.slice(1).map(({ hit, count }, index) => {
      const row = el("div", "recent-row");
      row.style.setProperty("--i", String(index + 2));
      const rowKind = el("span", "recent-kind", hit.kind);
      if (WHY_KINDS.has(hit.kind)) rowKind.classList.add("why");
      const label = el("span", "recent-label", hit.label);
      row.append(rowKind, label, el("span", "recent-ago", hit.agoText));
      if (count > 1) label.append(el("span", "recent-count", ` ×${count}`));
      return row;
    }),
  );

  const twin = stacked[0].count;
  if (twin > 1) meta.append(el("span", "latest-count", `heard ×${twin}`));
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
  if (!state.files || state.files.length === 0) {
    fill($("#files"), listSkeleton(7));
  }
  try {
    state.files = await api(`/api/files?q=${encodeURIComponent(state.filter)}`);
  } catch {
    if (!state.files) fill($("#files"), failed(loadFiles));
    return;
  }
  renderFiles();
}

/** A file's group key is its repo name; "" is the non-repo group. */
function fileGroup(file) {
  return file.repo ?? "";
}

function renderFiles() {
  const files = state.files;
  const shown = files.filter((file) => !state.repoHidden.has(fileGroup(file)));
  state.fileCount = shown.length;
  setTally();
  $("#files-head").textContent = `Files: ${shown.length}`;
  $("#repo-filter-btn").classList.toggle("on", state.repoHidden.size > 0);

  if (shown.length === 0) {
    fill($("#files"), files.length === 0
      ? empty("no explain records heard yet.")
      : empty("every group is hidden. filter repo opens them again."));
    return;
  }

  fill(
    $("#files"),
    ...shown.map((file) => {
      const button = el("button", "file");
      button.type = "button";
      button.title = file.path;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(file.path === state.file));
      // count badge, then two-line text: basename first, directory second
      const parts = file.path.split("/");
      const base = parts.pop() ?? file.path;
      const dir = parts.join("/");
      const text = el("span", "file-text");
      text.append(el("span", "file-name", base));
      if (dir) text.append(el("span", "file-dir", dir));
      button.append(
        el("span", "file-count", String(file.count)),
        text,
      );
      button.addEventListener("click", () => openFile(file.path));
      return button;
    }),
  );
}

/* ---- dash: repo filter -------------------------------------------------- */

/** One card per heard group, busiest first; non-repo comes last. Each card
 *  carries the group's newest intent and when it was heard, so the picker
 *  reads as a list of live places rather than bare names. */
function paintRepoFilter() {
  const groups = new Map();
  for (const file of state.files) {
    const key = fileGroup(file);
    const entry = groups.get(key) ?? { label: key === "" ? "non-repo" : key, count: 0, last: null };
    entry.count += 1;
    if (file.last && (!entry.last || file.last.ts > entry.last.ts)) entry.last = file.last;
    groups.set(key, entry);
  }
  const needle = ($("#repo-filter-search")?.value ?? "").trim().toLowerCase();
  const rows = [...groups.entries()]
    .filter(([, group]) => !needle || group.label.toLowerCase().includes(needle))
    .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
    .map(([key, group]) => {
      const shown = !state.repoHidden.has(key);
      const row = el("label", "repo-row repo-card");
      if (!shown) row.classList.add("off");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = shown;
      check.setAttribute("aria-label", `show ${group.label}`);
      check.addEventListener("change", () => {
        if (check.checked) state.repoHidden.delete(key);
        else state.repoHidden.add(key);
        if (state.view === "bundle") renderBundles();
        else renderFiles();
      });
      const text = el("span", "repo-card-text");
      const top = el("span", "repo-card-top");
      top.append(el("span", "repo-name", group.label), el("span", "repo-count", `${group.count} files`));
      text.append(top);
      text.append(el("span", "repo-intent", group.last?.label || "nothing heard yet"));
      text.append(el("span", "repo-updated", group.last ? `Updated ${group.last.agoText}` : ""));
      row.append(check, text);
      return row;
    });
  fill($("#repo-filter-list"), ...(rows.length > 0 ? rows : [empty("no repo matches that search.")]));
}

function openRepoFilter() {
  const search = $("#repo-filter-search");
  if (search) search.value = "";
  paintRepoFilter();
  $("#scrim").hidden = false;
  $("#repo-filter").hidden = false;
  $("#repo-filter-close").focus();
}

function closeRepoFilter() {
  if ($("#repo-filter").hidden) return;
  $("#repo-filter").hidden = true;
  // the scrim is shared with settings; it stays while any modal does
  if ($("#settings").hidden) $("#scrim").hidden = true;
  $("#repo-filter-btn").focus();
}

$("#repo-filter-btn").addEventListener("click", (event) => {
  event.stopPropagation();
  openRepoFilter();
});
$("#repo-filter-search").addEventListener("input", () => paintRepoFilter());
$("#repo-filter-close").addEventListener("click", closeRepoFilter);
$("#repo-filter-done").addEventListener("click", closeRepoFilter);
$("#repo-filter-reset").addEventListener("click", () => {
  state.repoHidden.clear();
  paintRepoFilter();
  if (state.view === "bundle") renderBundles();
  else renderFiles();
});

let filterTimer = 0;
$("#filter").addEventListener("input", (event) => {
  state.filter = event.target.value.trim();
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (state.view === "bundle") loadBundles();
    else loadFiles();
  }, 250);
});

async function loadBundles() {
  ensureTotal();
  if (state.bundles && state.bundles.length > 0) {
    renderBundles();
  } else {
    fill($("#files"), listSkeleton(7));
  }
  try {
    const data = await api(`/api/bundles?q=${encodeURIComponent(state.filter)}`);
    state.bundles = data.bundles ?? [];
  } catch {
    if (!state.bundles) fill($("#files"), failed(loadBundles));
    return;
  }
  renderBundles();
}

/** Plain-English bundle labels. The list names what happened, not the storage
 *  words (prior/after/witness) the core uses -- one mapping shared by the
 *  bundle list and the history headers so both read the same. */
function epistemicLabel(epistemic) {
  if (epistemic === "uncommitted") return "Not committed yet";
  if (epistemic === "recorded") return "Saved snapshot";
  if (epistemic === "after") return "First change after heard";
  if (epistemic === "prior") return "Last change before heard";
  return "Committed change";
}

function noteWord(n) {
  return n === 1 ? "1 note" : `${n} notes`;
}

function renderBundles() {
  const bundles = state.bundles ?? [];
  const shown = bundles.filter((b) => !state.repoHidden.has(b.repo ?? ""));
  state.bundleCount = shown.length;
  setTally();
  $("#files-head").textContent = `Bundles: ${shown.length}`;
  $("#repo-filter-btn").classList.toggle("on", state.repoHidden.size > 0);

  if (shown.length === 0) {
    fill($("#files"), bundles.length === 0
      ? empty("no bundles heard yet.")
      : empty("every group is hidden. filter repo opens them again."));
    return;
  }

  fill(
    $("#files"),
    ...shown.map((bundle) => {
      const card = el("button", "bundle-card");
      card.type = "button";
      card.dataset.key = bundle.key;
      card.setAttribute("role", "option");
      const isPicked = state.selectedBundle?.key === bundle.key;
      card.setAttribute("aria-selected", String(isPicked));
      if (isPicked) card.classList.add("picked");

      const shaBit = bundle.commit && bundle.commit !== "uncommitted"
        ? ` · ${bundle.commit.slice(0, 7)}`
        : "";
      const fileCount = bundle.files?.length ?? 0;
      const fileWord = fileCount === 1 ? "1 file changed" : `${fileCount} files changed`;
      const witCount = bundle.witnessCount ?? 0;

      const top = el("div", "moment-top");
      top.textContent = `${epistemicLabel(bundle.epistemic)}${shaBit} · ${noteWord(witCount)}`;

      const fileNames = (bundle.files ?? []).map((f) => f.path.split("/").pop()).join(", ");
      const body = el("div", "moment-body");
      body.textContent = `${fileWord}: ${fileNames}`;

      card.append(top, body);
      card.addEventListener("click", () => selectBundle(bundle));
      return card;
    }),
  );
}

async function selectBundle(bundle) {
  state.selectedBundle = bundle;
  for (const card of $("#files").querySelectorAll(".bundle-card")) {
    const isThis = card.dataset.key === bundle.key;
    card.setAttribute("aria-selected", String(isThis));
    card.classList.toggle("picked", isThis);
  }

  state.bundleDiff = null;
  if (bundle.commit && /^[0-9a-fA-F]{4,128}$/.test(bundle.commit)) {
    try {
      state.bundleDiff = await api(`/api/bundle?commit=${encodeURIComponent(bundle.commit)}`);
    } catch {
      state.bundleDiff = null;
    }
  }

  const inBundle = bundle.files?.some((f) => f.path === state.file);
  if (!inBundle && bundle.files?.length > 0) {
    state.file = bundle.files[0].path;
  }
  if (state.file) {
    $("#pane-path").textContent = state.file;
  } else {
    $("#pane-path").textContent = bundle.commit ? `commit ${bundle.commit.slice(0, 7)}` : "bundle";
  }

  $("#sel").textContent = "";
  closeMoments();
  closePop();
  renderPane();
}

const viewToggleBtn = el("button", "repo-filter-btn", "Individual");
viewToggleBtn.id = "view-toggle-btn";
viewToggleBtn.type = "button";
viewToggleBtn.title = "Toggle view (individual / bundle)";
viewToggleBtn.setAttribute("data-view", "individual");
viewToggleBtn.style.marginLeft = "auto";

function updateViewToggle() {
  const isBundle = state.view === "bundle";
  viewToggleBtn.textContent = isBundle ? "Bundle" : "Individual";
  viewToggleBtn.classList.toggle("on", isBundle);
  viewToggleBtn.setAttribute("aria-pressed", String(isBundle));
  viewToggleBtn.setAttribute("data-view", state.view);
  setTally();
}

viewToggleBtn.addEventListener("click", () => {
  state.view = state.view === "bundle" ? "individual" : "bundle";
  updateViewToggle();
  if (state.view === "bundle") {
    loadBundles();
  } else {
    state.selectedBundle = null;
    state.bundleDiff = null;
    loadFiles();
    if (state.file) renderPane();
  }
});

const repoFilterBtn = $("#repo-filter-btn");
if (repoFilterBtn) {
  repoFilterBtn.before(viewToggleBtn);
}

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
  fill(body, skeleton());
  try {
    if (state.mode === "lines") await renderLines(body);
    else if (state.mode === "history") await renderHistory(body);
    else await renderCompare(body);
  } catch {
    fill(body, failed(renderPane));
  }
}

async function renderLines(body) {
  if (!state.file) {
    paneWelcome();
    return;
  }
  const nodes = [];

  if (state.view === "bundle" && state.bundleDiff?.files?.length > 0) {
    const bundleFilesWrap = el("div", "bundle-files");
    for (const f of state.bundleDiff.files) {
      const section = el("div", "change");
      const head = el("div", "change-head");
      head.style.cursor = "pointer";
      head.textContent = f.path;
      if (f.path === state.file) {
        head.style.color = "var(--voice)";
        head.textContent += " · viewing lines below";
      } else {
        head.title = "Click to view file lines below";
      }
      head.addEventListener("click", () => {
        state.file = f.path;
        $("#pane-path").textContent = f.path;
        renderPane();
      });
      section.append(head, diffBlock({ commit: state.bundleDiff.commit, rows: f.rows }, true));
      bundleFilesWrap.append(section);
    }
    if (state.bundleDiff.truncated) {
      bundleFilesWrap.append(el("div", "trunc", `… diff truncated (${state.bundleDiff.files.length} of ${state.bundleDiff.total} files)`));
    }
    nodes.push(bundleFilesWrap);
  }

  const data = await api(`/api/file?path=${encodeURIComponent(state.file)}`);
  if (data.missing) {
    nodes.push(empty("file not on disk. rocky cannot read it, question"));
    fill(body, ...nodes);
    return;
  }

  const bundleFile = state.view === "bundle"
    ? state.selectedBundle?.files?.find((f) => f.path === state.file)
    : null;
  const spans = bundleFile?.spans ?? [];
  const inSpan = (line) => spans.some(([s, e]) => line >= s && line <= e);

  let open = false;
  const rows = data.lines.map((text, index) => {
    const lineNum = index + 1;
    const row = el("div", "cl");
    row.dataset.line = String(lineNum);
    if (state.view === "bundle" && inSpan(lineNum)) {
      row.classList.add("picked", "hl");
    }
    const painted = codeCell(text, open);
    open = painted.openComment;
    const ln = el("span", "ln", String(lineNum));
    ln.style.cursor = "pointer";
    ln.addEventListener("click", (event) => {
      event.stopPropagation();
      clearPicked();
      row.classList.add("picked");
      pending = { rows: [row], start: lineNum, end: lineNum, rect: row.getBoundingClientRect() };
      askWhy(lineNum, lineNum, row.getBoundingClientRect());
    });
    row.addEventListener("click", (event) => {
      if (event.target === ln) return;
      const sel = document.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
      event.stopPropagation();
      clearPicked();
      row.classList.add("picked");
      pending = { rows: [row], start: lineNum, end: lineNum, rect: row.getBoundingClientRect() };
      askWhy(lineNum, lineNum, row.getBoundingClientRect());
    });
    row.append(ln, painted.cell);
    return row;
  });
  if (data.truncated) rows.push(el("div", "trunc", "… file long, lines cut"));
  nodes.push(...rows);
  fill(body, ...nodes);
}

const KIND_CLASS = { "@": "dl-at", h: "dl-h", "+": "dl-p", "-": "dl-m" };

/** One diff, the shape `diffFor` returns. Inside a change card the card's
 *  own header already names the commit, so the head line stays off there. */
function diffBlock(diff, hideHead) {
  const wrap = el("div", "diff");
  if (diff.commit && !hideHead) {
    const label = diff.commit === "uncommitted"
      ? "working tree · sementara, hilang setelah commit"
      : `${diff.stored ? "recorded at event · " : ""}${diff.after ? "first change after · " : ""}${diff.prior ? "last change before · " : ""}commit ${diff.commit}`;
    const head = el("div", "diff-head", label);
    if (diff.commit === "uncommitted" || diff.after) head.classList.add("transient");
    wrap.append(head);
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
function recordRow(record, extra, hideDiff) {
  const item = el("div", `rec${extra ?? ""}`);
  item.tabIndex = 0;
  item.append(headRow(record), el("div", "rec-body", bodyText(record)));
  if (state.showDiff && record.diff && !hideDiff) item.append(diffBlock(record.diff));
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

function matchesBundle(change, bundle) {
  if (!bundle) return true;
  if (bundle.commit && bundle.commit !== "uncommitted") {
    const cCommit = change.commit ?? "";
    const bCommit = bundle.commit;
    return Boolean(cCommit && (cCommit === bCommit || cCommit.startsWith(bCommit) || bCommit.startsWith(cCommit)));
  }
  if (bundle.commit === "uncommitted") {
    return change.commit === "uncommitted" || change.epistemic === "uncommitted";
  }
  return change.epistemic === bundle.epistemic;
}

async function renderHistory(pane) {
  if (!state.file) {
    paneWelcome();
    return;
  }
  const data = await api(`/api/compare?path=${encodeURIComponent(state.file)}`);
  const changes = data.changes ?? [];
  const unattributed = data.unattributed ?? [];

  let shownChanges = changes;
  let shownUnattributed = unattributed;

  if (state.view === "bundle" && state.selectedBundle) {
    shownChanges = changes.filter((c) => matchesBundle(c, state.selectedBundle));
    shownUnattributed = state.selectedBundle.commit ? [] : unattributed;
  }

  const witnessCount = shownChanges.reduce((n, c) => n + (c.witnesses?.length ?? 0), 0) + shownUnattributed.length;
  state.moments = [...shownChanges.flatMap((c) => c.witnesses ?? []), ...shownUnattributed];

  const shortCommit = state.selectedBundle?.commit
    ? (state.selectedBundle.commit === "uncommitted" ? "uncommitted" : state.selectedBundle.commit.slice(0, 7))
    : "";
  $("#sub-note").textContent = state.view === "bundle" && state.selectedBundle
    ? `${shownChanges.length} changes · ${witnessCount} moments (${shortCommit})`
    : `${changes.length} changes · ${witnessCount} moments`;

  if (shownChanges.length === 0 && shownUnattributed.length === 0) {
    fill(pane, empty(state.view === "bundle" ? "no witnesses in this bundle for this file." : "nothing heard for this file yet."));
    return;
  }
  const cards = shownChanges.map((change) => changeCard(change));
  if (shownUnattributed.length > 0) {
    if (shownChanges.length > 0) cards.push(el("div", "unattributed-head", "moments without an attributable change"));
    for (const record of shownUnattributed) cards.push(recordRow(record, undefined, true));
  }
  fill(pane, ...cards);
}

/** One unique change: its header names the evidence once, the single diff
 *  follows, and every witness reason nests inside the same bordered card
 *  so a reason can never be mistaken for the neighbouring change. */
function changeCard(change) {
  const card = el("div", "change");
  card.append(el("div", "change-head", changeLabel(change)));
  card.append(diffBlock(change.diff, true));
  const witnesses = change.witnesses ?? [];
  if (witnesses.length > 0) {
    const list = el("div", "witnesses");
    for (const witness of witnesses) list.append(recordRow(witness, " wit", true));
    card.append(list);
  }
  return card;
}

function changeLabel(change) {
  const epi = epistemicLabel(change.epistemic);
  const what = change.commit && change.commit !== "uncommitted" ? ` · commit ${change.commit}` : "";
  const n = change.witnesses?.length ?? 0;
  const who = ` · ${noteWord(n)}`;
  return `${epi}${what}${who}`;
}

/* mode: two moments */

async function renderCompare(pane) {
  $("#sub-note").textContent = state.strict ? "Exact lines" : "Whole file";

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

  const scope = el("button", "moments-scope", state.strict ? "Exact lines" : "Whole file");
  scope.type = "button";
  scope.title = "Toggle between matching exact lines or the whole file";
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
  const parts = [el("p", "card-head assembled", record.machine ? "intent | Agent Raw" : "intent")];

  if (record.machine) {
    parts.push(el("p", "card-line", "machine note, not human words"));
    const raw = el("button", "card-more", "Show Raw");
    raw.type = "button";
    const rawText = el("p", "rung", record.intent ?? bodyText(record));
    raw.addEventListener("click", () => {
      const open = raw.textContent === "Hide Raw";
      raw.textContent = open ? "Show Raw" : "Hide Raw";
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

function applyBundleHighlights() {
  if (state.view !== "bundle" || !state.selectedBundle || !state.file) return;
  const bundleFile = state.selectedBundle.files?.find((f) => f.path === state.file);
  const spans = bundleFile?.spans ?? [];
  if (spans.length === 0) return;
  const inSpan = (line) => spans.some(([s, e]) => line >= s && line <= e);
  for (const row of $("#pane-body").querySelectorAll(".cl")) {
    const line = Number(row.dataset.line);
    if (inSpan(line)) {
      row.classList.add("picked", "hl");
    }
  }
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
  const text = selection.toString().trim();
  return {
    rows,
    start: Number(rows[0].dataset.line),
    end: Number(rows[rows.length - 1].dataset.line),
    rect,
    text,
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
    if (state.view === "bundle") applyBundleHighlights();
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
  $("#sel").textContent = "";
  if (state.view === "bundle") applyBundleHighlights();
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
async function askModel(anchor, prompt, keep, ctx) {
  openPop(anchor, ...keep, box("guess", el("p", "guess-head", "Model Guess (Beta)"), skeleton()));

  let answer;
  try {
    answer = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // only the prompt travels: endpoint, model and key are read server side.
      // the file context lets rocky dig the evidence pack before forwarding.
      body: JSON.stringify({ prompt, ...ctx }),
    });
  } catch {
    openPop(anchor, ...keep, box("guess", el("p", "guess-head", "Model Guess (Beta)"),
      el("p", "guess-body", "model not answer. check endpoint, key, model, question")));
    return;
  }

  const paragraphs = guessNodes(answer.text || answer.error || "model said nothing.");
  const guess = box(
    "guess",
    el("p", "guess-head", "Model Guess (Beta)"),
    ...paragraphs,
    el("div", "card-ev", `guessed by ${settings.model}. not evidence. cross check`),
  );
  openPop(anchor, ...keep, guess);
}

/**
 * The model is bound to the teach shape, so its answer is read as one:
 * CUPINGAN heads it, KODE and BISNIS open tracks, why rows carry their
 * number, stop closes a track, SUMBER and DISCLAIMER sign off. An answer
 * that ignores the shape falls back to plain paragraphs, two sentences each.
 */
function guessNodes(text) {
  const lines = String(text).split(/\r?\n/);
  const shaped = lines.some((line) => /^\s*(KODE|BISNIS)\s*$/.test(line));
  if (!shaped) {
    const sentences = String(text).trim().replace(/([.!?]+)\s+/g, "$1\n").split("\n").filter(Boolean);
    const paragraphs = [];
    for (let i = 0; i < sentences.length; i += 2) paragraphs.push(sentences.slice(i, i + 2).join(" "));
    return paragraphs.filter(Boolean).map((para) => el("p", "guess-body", para));
  }

  const nodes = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const why = line.match(/^why\s+(\d+)[.:]?\s*(.*)$/i);
    if (/^CUPINGAN\b/.test(line)) nodes.push(el("p", "guess-cup", line.replace(/^CUPINGAN\s*/, "")));
    else if (/^(KODE|BISNIS)\s*$/.test(line)) nodes.push(el("p", "guess-track", line));
    else if (why) nodes.push(box("guess-why", el("span", "guess-num", `#${why[1]}`), el("span", null, why[2])));
    else if (/^stop\b/i.test(line)) nodes.push(el("p", "guess-stop", line.replace(/^stop\s*/i, "")));
    else if (/^SUMBER\b/.test(line)) nodes.push(el("p", "guess-src", line.replace(/^SUMBER\s*/, "")));
    else if (/^DISCLAIMER\b/.test(line)) nodes.push(el("p", "guess-warn", line.replace(/^DISCLAIMER[:\s]*/i, "")));
    else nodes.push(el("p", "guess-body", line));
  }
  return nodes;
}

/** Adds action controls: find-usages button and optional BYOK ask. */
function withAsk(anchor, parts, prompt, held, ctx) {
  const actions = el("div", "why-actions");

  const refsBtn = el("button", "card-more refs-btn", "Find usages");
  refsBtn.type = "button";
  refsBtn.title = "Show where this symbol is defined and used";
  refsBtn.setAttribute("aria-label", "Find usages: show definition and usages");
  refsBtn.addEventListener("click", () => showReferences(anchor, ctx));
  actions.append(refsBtn);

  if (byokReady()) {
    const label = held
      ? "Explain with AI"
      : "Ask AI to explain";
    const button = el("button", "card-more ask-agent", label);
    button.type = "button";
    button.title = "Uses your own API key. Rocky evidence stays local.";
    button.addEventListener("click", () => askModel(anchor, prompt, parts, ctx));
    actions.append(button);
  }

  return [...parts, actions];
}

async function showReferences(anchor, ctx) {
  openPop(anchor, skeleton());

  const filePath = ctx?.path ?? state.file;
  const line = ctx?.start ?? 1;
  let selectedSymbol = ctx?.symbol ?? "";
  if (!/^[A-Za-z_$][\w$]*$/.test(selectedSymbol)) {
    const m = /([A-Za-z_$][\w$]*)/.exec(selectedSymbol);
    if (selectedSymbol.includes("(") && m) {
      selectedSymbol = m[1];
    } else if (selectedSymbol.split(/\s+/).length > 2) {
      selectedSymbol = "";
    }
  }

  let url = `/api/refer?path=${encodeURIComponent(filePath)}&line=${line}`;
  if (selectedSymbol) {
    url += `&symbol=${encodeURIComponent(selectedSymbol)}`;
  }

  let data;
  try {
    data = await api(url);
  } catch {
    openPop(anchor, failed(() => showReferences(anchor, ctx)));
    return;
  }

  if (!data || (!data.definition && (!data.references || data.references.length === 0))) {
    openPop(anchor, el("p", "card-head assembled", "rocky not hear this name. try another symbol, question"));
    return;
  }

  const parts = [];
  const sym = data.symbol || selectedSymbol;
  parts.push(el("p", "card-head", sym ? `Usages of ${sym}` : "Usages"));

  if (data.definition) {
    const def = data.definition;
    const defBox = el("div", "refer-def");
    const top = el("div", "refer-def-head");
    const link = el("button", "refer-link", `${def.path}:${def.line}`);
    link.type = "button";
    link.addEventListener("click", () => jumpToFileLine(def.path, def.line));
    top.append(el("span", "refer-tag", "Definition"), link);
    const snippet = el("pre", "refer-snippet", def.text);
    defBox.append(top, snippet);
    parts.push(defBox);
  }

  if (data.references && data.references.length > 0) {
    const list = el("div", "moments-list refer-list");
    for (const ref of data.references) {
      const item = el("button", "moment refer-hit");
      item.type = "button";
      const loc = ref.line > 0 ? `${ref.path}:${ref.line}` : `${ref.path} · witnessed`;
      const top = el("span", "moment-top", `${loc} · ${ref.confidence}`);
      const body = el("span", "moment-body", ref.text);
      item.append(top, body);
      item.addEventListener("click", () => {
        jumpToFileLine(ref.path, ref.line > 0 ? ref.line : 1);
      });
      list.append(item);
    }
    parts.push(list);
  }

  openPop(anchor, ...parts);
}

async function jumpToFileLine(path, line) {
  if (state.mode !== "lines") {
    setMode("lines");
  }
  if (path && path !== state.file) {
    openFile(path);
    if (line > 0) {
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        const row = $("#pane-body").querySelector(`.cl[data-line="${line}"]`);
        if (row) {
          row.scrollIntoView({ block: "center", behavior: "smooth" });
          row.classList.add("picked");
          setTimeout(() => row.classList.remove("picked"), 2000);
          break;
        }
      }
    }
  } else if (line > 0) {
    const row = $("#pane-body").querySelector(`.cl[data-line="${line}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      row.classList.add("picked");
      setTimeout(() => row.classList.remove("picked"), 2000);
    }
  }
}

/** The snippet the question is about, read straight off the painted lines. */
function snippetFor(start, end) {
  return [...$("#pane-body").querySelectorAll(".cl")]
    .filter((row) => Number(row.dataset.line) >= start && Number(row.dataset.line) <= end)
    .map((row) => row.querySelector(".lt").textContent)
    .join("\n");
}

function findFunctionSpan(originLine) {
  const clRows = [...$("#pane-body").querySelectorAll(".cl")];
  const lines = clRows.map((r) => r.querySelector(".lt")?.textContent ?? "");
  const FN_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const ARROW_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  const METHOD_RE = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/;
  for (let i = originLine - 2; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (FN_RE.test(line) || ARROW_RE.test(line) || METHOD_RE.test(line)) {
      let depth = 0;
      let opened = false;
      let end = -1;
      for (let j = i; j < lines.length; j += 1) {
        for (const ch of lines[j] ?? "") {
          if (ch === "{") { depth += 1; opened = true; }
          else if (ch === "}") {
            depth -= 1;
            if (opened && depth <= 0) {
              end = j + 1;
              if (originLine <= end) return { start: i + 1, end };
              break;
            }
          }
        }
        if (opened && depth <= 0) break;
      }
      if (end === -1) {
        const fallbackEnd = Math.min(lines.length, i + 30);
        if (originLine <= fallbackEnd) return { start: i + 1, end: fallbackEnd };
      }
      break;
    }
  }
  return null;
}

function findHunkSpan(originLine) {
  if (state.view === "bundle" && state.selectedBundle) {
    const bf = state.selectedBundle.files?.find((f) => f.path === state.file);
    for (const [s, e] of bf?.spans ?? []) {
      if (originLine >= s && originLine <= e) {
        return { start: s, end: e };
      }
    }
  }
  if (state.bundleDiff?.files) {
    const bf = state.bundleDiff.files.find((f) => f.path === state.file);
    if (bf?.rows) {
      for (const row of bf.rows) {
        if (row.k !== "@") continue;
        const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row.t);
        if (!m) continue;
        const n = Number(m[1]);
        const count = m[2] !== undefined ? Number(m[2]) : 1;
        const end = n + (count > 0 ? count - 1 : 0);
        if (originLine >= n && originLine <= end) {
          return { start: n, end };
        }
      }
    }
  }
  return null;
}

function buildContextTiers(originLine, expandedWhy, expandedStart, expandedEnd) {
  const total = $("#pane-body").querySelectorAll(".cl").length;
  const tiers = [];

  // 1. line
  tiers.push({ why: "line", start: originLine, end: originLine });

  // 2. window
  tiers.push({
    why: "window",
    start: Math.max(1, originLine - 3),
    end: Math.min(total, originLine + 3),
  });

  // 3. function
  if (expandedWhy === "function") {
    tiers.push({ why: "function", start: expandedStart, end: expandedEnd });
  } else {
    const fn = findFunctionSpan(originLine);
    if (fn) {
      tiers.push({ why: "function", start: fn.start, end: fn.end });
    }
  }

  // 4. hunk
  if (expandedWhy === "hunk") {
    tiers.push({ why: "hunk", start: expandedStart, end: expandedEnd });
  } else {
    const hunk = findHunkSpan(originLine);
    if (hunk) {
      tiers.push({ why: "hunk", start: hunk.start, end: hunk.end });
    }
  }

  return tiers;
}

function renderContextBadge(tiers, currentIdx, originLine, anchor) {
  const cur = tiers[currentIdx];
  if (!cur) return;

  clearPicked();
  for (const row of $("#pane-body").querySelectorAll(".cl")) {
    const line = Number(row.dataset.line);
    if (line >= cur.start && line <= cur.end) {
      row.classList.add("picked");
    }
  }

  const badge = el("span", "ctx-badge");
  const label = el("span", "ctx-text", `sel ${cur.start}–${cur.end} · ${cur.why}`);

  const minusBtn = el("button", "ctx-btn", "−");
  minusBtn.type = "button";
  minusBtn.title = "Shrink context level";
  minusBtn.disabled = currentIdx <= 0;
  minusBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (currentIdx > 0) {
      const nextIdx = currentIdx - 1;
      const target = tiers[nextIdx];
      renderContextBadge(tiers, nextIdx, originLine, anchor);
      askWhy(target.start, target.end, anchor, false);
    }
  });

  const plusBtn = el("button", "ctx-btn", "+");
  plusBtn.type = "button";
  plusBtn.title = "Expand context level";
  plusBtn.disabled = currentIdx >= tiers.length - 1;
  plusBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (currentIdx < tiers.length - 1) {
      const nextIdx = currentIdx + 1;
      const target = tiers[nextIdx];
      renderContextBadge(tiers, nextIdx, originLine, anchor);
      askWhy(target.start, target.end, anchor, false);
    }
  });

  badge.append(label, minusBtn, plusBtn);
  fill($("#sel"), badge);
}

async function askWhy(start, end, at, expand = (start === end)) {
  const anchor = at ?? ask.getBoundingClientRect();
  const snippet = snippetFor(start, end);
  const selectedSymbol = pending?.text ?? "";
  ask.hidden = true;
  openPop(anchor, skeleton());

  let data;
  try {
    const payload = { path: state.file, start, end };
    if (expand) payload.expand = 1;
    if (state.view === "bundle" && state.selectedBundle?.commit && /^[0-9a-fA-F]{4,128}$/.test(state.selectedBundle.commit)) {
      payload.commit = state.selectedBundle.commit;
    }
    data = await api("/api/teach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    openPop(anchor, failed(() => askWhy(start, end, anchor, expand)));
    return;
  }

  const effectiveStart = data?.expanded?.start ?? start;
  const effectiveEnd = data?.expanded?.end ?? end;
  const effectiveSnippet = data?.expanded ? snippetFor(effectiveStart, effectiveEnd) : snippet;
  const askedAbout = `${state.file} lines ${effectiveStart}-${effectiveEnd}\n\n${effectiveSnippet}`;

  if (data?.expanded) {
    const originLine = start;
    const tiers = buildContextTiers(originLine, data.expanded.why, data.expanded.start, data.expanded.end);
    let curIdx = tiers.findIndex((t) => t.why === data.expanded.why);
    if (curIdx === -1) {
      curIdx = tiers.findIndex((t) => t.start === data.expanded.start && t.end === data.expanded.end);
    }
    renderContextBadge(tiers, curIdx >= 0 ? curIdx : tiers.length - 1, originLine, anchor);
  }

  if (data === null || data.header === undefined) {
    const bare = [empty("no witness, no ladder.", "", "ask agent to explain, question")];
    openPop(anchor, ...withAsk(
      anchor,
      bare,
      `Why is this code written this way? Rocky has no recorded reason for it.\n\n${askedAbout}\n\nFollow the rules and shape you were given. Ground every claim in the code quoted above, and say plainly if you cannot tell from the code alone.`,
      undefined,
      { path: state.file, start: effectiveStart, end: effectiveEnd, symbol: selectedSymbol },
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
    const more = el("button", "card-more", "Show reasoning steps");
    more.type = "button";
    more.title = "Show the checked steps Rocky used to build this reason";
    // the core writes "why 1 …"; here they are numbered steps under a caption
    const rungs = [
      el("p", "rung-note", "Steps Rocky walked from the code to a reason. They exist so the reason is a chain you can check, not one jump you have to trust. Each cites where it came from."),
      ...data.rungs.map((rung) => el("p", "rung", rung.replace(/^why (\d+)/, "#$1"))),
    ];
    more.addEventListener("click", () => {
      const open = more.textContent === "Hide reasoning steps";
      more.textContent = open ? "Show reasoning steps" : "Hide reasoning steps";
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
      "Explain what that recorded reason means for this code, following the rules and shape you were given. " +
      "Do not invent history rocky did not record; the record's labels (KODE, BISNIS, why 1, stop) are yours to use, not to quote as prose.",
    true,
    { path: state.file, start: effectiveStart, end: effectiveEnd, symbol: selectedSymbol },
  ));
}

/* ---- settings ----------------------------------------------------------
 *
 * BYOK is beta and off until filled in. It is the one place this page talks
 * to a host other than 127.0.0.1, so the key lives in this browser only and
 * never reaches rocky: the evidence stays local whatever the model answers.
 */

// The key lives in rocky home, never here. `hasKey` is all the page is told.
const settings = { provider: "openai", endpoint: "", model: "", lang: "id", hasKey: false };

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
  $("#set-lang").value = settings.lang;
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
$("#scrim").addEventListener("click", () => {
  closeSettings();
  closeRepoFilter();
});
$("#settings").addEventListener("click", (event) => event.stopPropagation());

$("#settings-save").addEventListener("click", () => {
  const typed = $("#set-key").value;
  void pushSettings({
    provider: settings.provider,
    endpoint: currentEndpoint(),
    model: $("#set-model").value,
    lang: $("#set-lang").value,
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
  if (event.key !== "Escape") return;
  if (!$("#repo-filter").hidden) closeRepoFilter();
  else if (!$("#settings").hidden) closeSettings();
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
  else if (state.view === "bundle") loadBundles();
  else loadFiles();
});
