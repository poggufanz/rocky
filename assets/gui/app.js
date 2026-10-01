/*
 * rocky gui -- one page, one route, three segments.
 *
 * The server hands the token in the URL fragment; every fetch carries it back
 * as X-Rocky-Token. Main and Dash read memory; Listening reads the
 * change-lineage projection. Nothing here mutates evidence except the
 * explicit Listening repo-consent Add/Revoke control.
 * Teach has no view of its own -- it is what selecting lines does.
 */

const TOKEN = location.hash.slice(1);

/** Repeated or unknown ?v= falls back to main rather than throwing. */
function initialSegment() {
  const all = new URLSearchParams(location.search).getAll("v");
  const value = all.length === 1 ? all[0] : "";
  if (value === "dash") return "dash";
  if (value === "listening") return "listening";
  return "main";
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
  if (host) host.replaceChildren(...children);
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
  // Listening tab: poll timer + checkpoint cursor. Hidden tab stops polling
  // and render only; the foreground process owns the watcher throughout.
  listenTimer: 0,
  listenCursor: "",
  listenRepo: "",
  listenLaunch: "",
  listenCustom: "",
  listenResolved: false,
  // timeline rows the viewer expanded, kept open across the 5s re-render
  listenOpen: new Set(),
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
  const text = parts.join(" | ");
  const tally = $("#tally");
  if (tally) tally.textContent = text;
}

// data-seg, not .seg-btn: the provider control reuses that class and has no panel
const tabs = [...document.querySelectorAll("[data-seg]")];

function showSegment(name) {
  state.segment = name;
  for (const tab of tabs) {
    const on = tab.dataset.seg === name;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    const panel = $(`#${tab.getAttribute("aria-controls")}`);
    if (panel) panel.hidden = !on;
  }
  if (name !== "listening") stopListeningPoll();
  setTally();
  if (name === "main") void loadMain().catch(() => {});
  else if (name === "listening") void loadListening().catch(() => {});
  else if (state.view === "bundle") loadBundles();
  else loadFiles();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => showSegment(tab.dataset.seg));
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? tabs.length - 1 : 1;
    const next = tabs[(tabs.indexOf(tab) + step) % tabs.length];
    next.focus();
    showSegment(next.dataset.seg);
  });
}

/* ---- main ------------------------------------------------------------- */

/** Kinds that are rocky explaining himself. These carry the voice colour. */
const WHY_KINDS = new Set(["rationale", "explain", "triple"]);

/**
 * Main is the chat surface; chat.js paints it. This side fetches the home
 * payload once per visit, keeps the tally, and hands the payload over as a
 * `rocky:home` event. A failure is handed over too, with its retry, so the
 * memory card never goes blank.
 */
function announceHome(detail) {
  window.rockyHome = detail;
  window.dispatchEvent(new CustomEvent("rocky:home", { detail }));
}

async function loadMain() {
  if (state.mainLoaded) return;
  state.mainLoaded = true;

  let data;
  try {
    data = await api("/api/home");
  } catch {
    state.mainLoaded = false;
    announceHome({ error: "offline", retry: loadMain });
    return;
  }

  // A 200 with the wrong shape must read as an error, never a blank panel.
  const sane = data && typeof data === "object"
    && Array.isArray(data.byKind) && data.day && typeof data.day === "object"
    && Array.isArray(data.topFiles) && Array.isArray(data.recent);
  if (!sane) {
    state.mainLoaded = false;
    announceHome({ error: "bad reply", retry: loadMain });
    return;
  }

  state.total = typeof data.total === "number" ? data.total : state.total;
  setTally();
  announceHome({ data });
}

// Rocky himself greets an empty chat; the face lives here with its source note.
const cxFace = $("#cx-face");
if (cxFace) cxFace.textContent = FACE.join("\n");

/* ---- dash: picker ----------------------------------------------------- */

/** The total lives in the home payload, so Dash asks for it once. */
async function ensureTotal() {
  if (state.total !== null) return;
  try {
    const home = await api("/api/home");
    state.total = home.total;
    setTally();
  } catch {
    // a missing tally is not worth an error state
  }
}

/** A path reads from its repo down. The machine prefix above the repo root is
 *  the same on every row, so the list drops it and the title keeps it. */
function splitPath(path, repo) {
  const parts = path.split("/");
  const base = parts.pop() ?? path;
  const at = repo ? parts.findIndex((part) => part.toLowerCase() === repo.toLowerCase()) : -1;
  if (at >= 0) return { base, repo: parts[at], dir: parts.slice(at + 1).join("/") };
  // outside any repo: the two nearest folders say enough about where it sits
  const near = parts.slice(-2).join("/");
  return { base, repo: "", dir: parts.length > 2 ? `…/${near}` : near };
}

/** What each pane mode answers, said once and shared by the welcome guide,
 *  the mode tabs and the hint line above the pane. */
const MODE_GUIDE = {
  lines: {
    name: "Lines",
    ask: "Why a line exists",
    how: "Click a line to ask why it exists, or drag across several and press Why. Rocky answers from the notes left when that code was written.",
  },
  history: {
    name: "History",
    ask: "What changed, and why",
    how: "Every change Rocky heard for this file, newest first. Each change carries the notes that explain it.",
  },
  compare: {
    name: "Compare",
    ask: "Then against now",
    how: "Pick two moments, A and B. Rocky holds them side by side with their diffs, so drift in intent shows.",
  },
};

/** By change, the pane holds one change and every file it touched. */
const BUNDLE_GUIDE = {
  lines: "Every file this change touched, with its diff. Open a file row to read it.",
  history: "Every file this change touched, with the notes Rocky heard for each.",
  compare: MODE_GUIDE.compare.how,
};

/** Top of the pane: repo, folder, then the file name at full brightness. */
function paintPanePath(path) {
  const host = $("#pane-path");
  if (!host) return;
  host.title = path ?? "";
  if (!path) {
    host.textContent = "No file picked";
    return;
  }
  const file = state.files.find((f) => f.path === path);
  const { base, repo, dir } = splitPath(path, file?.repo ?? null);
  fill(host);
  if (repo) host.append(el("span", "pp-repo", repo));
  if (dir) host.append(el("span", "pp-dir", dir));
  host.append(el("span", "pp-base", base));
}

/** The hint line under the pane bar names what the current mode answers. */
function paintPaneGuide() {
  const picked = state.view === "bundle" ? state.selectedBundle !== null : state.file !== null;
  $("#pane-sub").hidden = !picked;
  $("#diff-toggle").hidden = state.mode === "lines";
  const hint = $("#pane-guide");
  if (hint) hint.textContent = state.view === "bundle" ? BUNDLE_GUIDE[state.mode] : MODE_GUIDE[state.mode].how;
  if (state.mode === "lines") $("#sub-note").textContent = "";
}

/**
 * What the pane says before a file is picked. An empty screen is an
 * invitation to act: it names the three questions Dash answers, lets a mode
 * be chosen up front, and offers the files Rocky holds the most notes on.
 */
function paneWelcome() {
  const guide = el("div", "guide");
  guide.append(
    el("h2", "guide-title", "Hear why your code is the way it is"),
    el("p", "guide-lede", "Rocky keeps the notes agents and you leave while files change. Pick a file from the list, then pick what to ask of it."),
  );

  const modesRow = el("div", "guide-modes");
  modesRow.setAttribute("role", "group");
  modesRow.setAttribute("aria-label", "what to ask of a file");
  for (const [mode, text] of Object.entries(MODE_GUIDE)) {
    const card = el("button", "guide-mode");
    card.type = "button";
    card.setAttribute("aria-pressed", String(state.mode === mode));
    card.append(
      el("span", "guide-mode-name", text.name),
      el("span", "guide-mode-ask", text.ask),
      el("span", "guide-mode-how", text.how),
    );
    card.addEventListener("click", () => {
      setMode(mode);
      for (const other of modesRow.children) other.setAttribute("aria-pressed", String(other === card));
    });
    modesRow.append(card);
  }
  guide.append(modesRow);

  const shown = (state.files ?? []).filter((file) => !state.repoHidden.has(fileGroup(file)));
  const section = el("section", "guide-block");
  section.append(el("h3", "guide-head", "Start with the files Rocky knows best"));
  if (shown.length === 0) {
    section.append(el("p", "guide-note", "No file notes heard yet. Run work through rocky, or connect an agent hook, and files land here."));
  } else {
    const top = el("div", "guide-files");
    const most = Math.max(1, ...shown.map((file) => file.count));
    for (const file of shown.slice(0, 5)) {
      const { base, repo, dir } = splitPath(file.path, file.repo);
      const row = el("button", "guide-file");
      row.type = "button";
      row.title = file.path;
      row.style.setProperty("--heat", String(file.count / most));
      const where = [repo, dir].filter(Boolean).join(" / ");
      row.append(
        el("span", "guide-file-count", noteWord(file.count)),
        el("span", "guide-file-name", base),
        el("span", "guide-file-dir", where),
        el("span", "guide-file-ago", file.last?.agoText ?? ""),
      );
      row.addEventListener("click", () => openFile(file.path));
      top.append(row);
    }
    section.append(top);
  }
  guide.append(section);

  const legend = el("section", "guide-block");
  legend.append(el("h3", "guide-head", "Reading the list"));
  const terms = el("dl", "guide-legend");
  for (const [term, meaning] of [
    ["63", "Notes Rocky holds for that file. More notes, fuller answers."],
    ["By change", "Groups files that changed together, one row per commit or uncommitted batch."],
    ["!md", "Typed in the search box, hides .md files. Works for any word."],
    ["All repos", "Hides whole repos from the list when one project is noise."],
  ]) {
    terms.append(el("dt", null, term), el("dd", null, meaning));
  }
  legend.append(terms);
  guide.append(legend);

  fill($("#pane-body"), guide);
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

/** The repo button names the current scope, so a hidden repo is never a
 *  surprise when a file seems to be missing. */
function paintRepoButton() {
  const button = $("#repo-filter-btn");
  const hidden = state.repoHidden.size;
  button.textContent = hidden === 0 ? "All repos" : `${hidden} repo${hidden === 1 ? "" : "s"} hidden`;
  button.classList.toggle("on", hidden > 0);
}

function renderFiles() {
  const files = state.files;
  const shown = files.filter((file) => !state.repoHidden.has(fileGroup(file)));
  state.fileCount = shown.length;
  setTally();
  $("#files-head").textContent = shown.length === 0
    ? ""
    : `${shown.length} ${shown.length === 1 ? "file" : "files"}, most notes first`;
  paintRepoButton();
  // Main may have loaded first, and search or repo scope changes what the
  // guide offers; the pane never sits blank beside a list
  if (state.file === null) paneWelcome();

  if (shown.length === 0) {
    fill($("#files"), files.length === 0
      ? empty(state.filter ? "no heard file matches that search." : "no file notes heard yet.")
      : empty("every repo is hidden. All repos opens them again."));
    return;
  }

  const most = Math.max(1, ...shown.map((file) => file.count));
  fill(
    $("#files"),
    ...shown.map((file) => {
      const button = el("button", "file");
      button.type = "button";
      button.title = `${file.path}\n${noteWord(file.count)}`;
      button.dataset.path = file.path;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(file.path === state.file));
      // the heat bar is the count drawn: how much of the busiest file this one holds
      button.style.setProperty("--heat", String(file.count / most));
      const { base, repo, dir } = splitPath(file.path, file.repo);
      const count = el("span", "file-count", String(file.count));
      count.setAttribute("aria-label", noteWord(file.count));
      const text = el("span", "file-text");
      const top = el("span", "file-top");
      top.append(el("span", "file-name", base));
      const sub = el("span", "file-sub");
      sub.append(el("span", "file-dir", [repo, dir].filter(Boolean).join(" / ")));
      if (file.last) sub.append(el("span", "file-ago", listenAgo(file.last.ts, Date.now())));
      text.append(top, sub);
      button.append(count, text);
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
    // grouping asks git about every heard file, which can take a while;
    // the wait says what it is doing instead of reading as a hang
    $("#files-head").textContent = "Grouping files by change. Rocky asks git about each file, this can take a minute.";
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
  if (!state.selectedBundle && state.bundles.length > 0) {
    const shown = state.bundles.filter((b) => !state.repoHidden.has(b.repo ?? ""));
    if (shown.length > 0) {
      selectBundle(shown[0]);
    }
  }
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
  $("#files-head").textContent = shown.length === 0
    ? ""
    : `${shown.length} ${shown.length === 1 ? "change" : "changes"}, files grouped by commit`;
  paintRepoButton();

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

  const shaBit = bundle.commit && bundle.commit !== "uncommitted"
    ? ` · ${bundle.commit.slice(0, 7)}`
    : "";
  $("#pane-path").textContent = `${epistemicLabel(bundle.epistemic)}${shaBit}`;
  $("#pane-path").title = "";
  paintPaneGuide();

  $("#sel").textContent = "";
  closeMoments();
  closePop();
  renderPane();
}

/* By file / By change: two named choices, so the control says what the list
   is now instead of a toggle whose label means either state */
const viewButtons = [...document.querySelectorAll(".view-seg-btn")];

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  for (const button of viewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  }
  setTally();
  if (view === "bundle") {
    loadBundles();
  } else {
    state.selectedBundle = null;
    state.bundleDiff = null;
    paintPanePath(state.file);
    paintPaneGuide();
    loadFiles();
    if (state.file) renderPane();
  }
}

for (const button of viewButtons) {
  button.addEventListener("click", () => setView(button.dataset.view));
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
  paintPaneGuide();
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
  paintPanePath(path);
  paintPaneGuide();
  $("#sel").textContent = "";
  closeMoments();
  for (const button of $("#files").querySelectorAll(".file")) {
    button.setAttribute("aria-selected", String(button.dataset.path === path));
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

function getBundleFiles(bundle) {
  const filesMap = new Map();

  if (bundle.files) {
    for (const f of bundle.files) {
      filesMap.set(f.path, {
        path: f.path,
        witnessCount: f.witnessCount ?? 0,
        rows: f.rows ?? null,
        plus: f.plus,
        minus: f.minus,
        spans: f.spans ?? [],
      });
    }
  }

  if (state.bundleDiff?.files) {
    for (const f of state.bundleDiff.files) {
      const existing = filesMap.get(f.path);
      if (existing) {
        if (f.rows && f.rows.length > 0) {
          existing.rows = f.rows;
        }
      } else {
        filesMap.set(f.path, {
          path: f.path,
          witnessCount: 0,
          rows: f.rows ?? null,
          spans: [],
        });
      }
    }
  }

  return Array.from(filesMap.values());
}

async function renderLines(body) {
  if (state.view === "bundle") {
    const bundle = state.selectedBundle;
    if (!bundle) {
      paneWelcome();
      return;
    }

    const allBundleFiles = getBundleFiles(bundle);
    const fileCount = allBundleFiles.length;
    const totalWitnesses = bundle.witnessCount ?? allBundleFiles.reduce((sum, f) => sum + (f.witnessCount || 0), 0);

    const shaBit = bundle.commit && bundle.commit !== "uncommitted"
      ? ` · ${bundle.commit.slice(0, 7)}`
      : "";

    const nodes = [];

    const summaryWrap = el("div", "bundle-summary");
    const topTitle = el("div", "bundle-summary-title", `${epistemicLabel(bundle.epistemic)}${shaBit}`);
    const topMeta = el("div", "bundle-summary-meta", `${fileCount} ${fileCount === 1 ? "file" : "files"} · ${noteWord(totalWitnesses)}`);
    summaryWrap.append(topTitle, topMeta);
    nodes.push(summaryWrap);

    if (allBundleFiles.length === 0) {
      nodes.push(empty("no files recorded in this bundle."));
    } else {
      const bundleFilesWrap = el("div", "bundle-files");
      bundleFilesWrap.setAttribute("role", "list");

      allBundleFiles.forEach((fileItem, index) => {
        const card = el("div", "bundle-file-card");
        const head = el("button", "bundle-file-head");
        head.type = "button";

        let isOpen = index === 0;
        head.setAttribute("aria-expanded", String(isOpen));

        const headLeft = el("div", "bundle-file-head-left");
        const toggleIcon = el("span", "bundle-file-toggle", isOpen ? "▾" : "▸");
        const split = splitPath(fileItem.path, bundle.repo ?? null);
        const baseName = split.base;
        const dir = [split.repo, split.dir].filter(Boolean).join(" / ");

        const nameSpan = el("span", "bundle-file-name", baseName);
        headLeft.append(toggleIcon, nameSpan);
        if (dir) {
          const dirSpan = el("span", "bundle-file-dir", dir);
          headLeft.append(dirSpan);
        }

        const headRight = el("div", "bundle-file-head-right");
        const hasDiff = Boolean(fileItem.rows && fileItem.rows.length > 0);
        const witCount = fileItem.witnessCount ?? 0;

        const statParts = [];
        if (hasDiff) {
          statParts.push("1 change");
        }
        if (witCount > 0) {
          statParts.push(noteWord(witCount));
        } else if (!hasDiff) {
          statParts.push("no diff");
        }

        const statsSpan = el("span", "bundle-file-stats", statParts.join(" · "));
        headRight.append(statsSpan);

        head.append(headLeft, headRight);

        const bodyWrap = el("div", "bundle-file-body");
        bodyWrap.hidden = !isOpen;

        if (hasDiff) {
          bodyWrap.append(diffBlock({ commit: bundle.commit, rows: fileItem.rows }, true));
        } else {
          const notice = el("div", "bundle-diff-empty", "diff not available for this file.");
          bodyWrap.append(notice);
        }

        head.addEventListener("click", (event) => {
          event.stopPropagation();
          isOpen = !isOpen;
          head.setAttribute("aria-expanded", String(isOpen));
          toggleIcon.textContent = isOpen ? "▾" : "▸";
          bodyWrap.hidden = !isOpen;
          card.classList.toggle("open", isOpen);
        });

        card.append(head, bodyWrap);
        bundleFilesWrap.append(card);
      });

      if (state.bundleDiff?.truncated || bundle.truncated) {
        const total = state.bundleDiff?.total ?? allBundleFiles.length;
        bundleFilesWrap.append(el("div", "trunc", `… diff truncated (${allBundleFiles.length} of ${total} files)`));
      }

      nodes.push(bundleFilesWrap);
    }

    fill(body, ...nodes);
    return;
  }

  if (!state.file) {
    paneWelcome();
    return;
  }
  const nodes = [];

  const data = await api(`/api/file?path=${encodeURIComponent(state.file)}`);
  if (data.missing) {
    nodes.push(empty("file not on disk. rocky cannot read it, question"));
    fill(body, ...nodes);
    return;
  }

  let open = false;
  const rows = data.lines.map((text, index) => {
    const lineNum = index + 1;
    const row = el("div", "cl");
    row.dataset.line = String(lineNum);
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
  $("#sub-note").textContent = `${data.lines.length}${data.truncated ? "+" : ""} lines`;
  nodes.push(...rows);
  fill(body, ...nodes);
}

const KIND_CLASS = { "@": "dl-at", h: "dl-h", "+": "dl-p", "-": "dl-m" };

/** A stored diff can span the whole commit. Inside one file's view only that
 *  file's sections belong, and its git header lines repeat the pane path.
 *  When the stored diff holds only other files, the rows go but their names
 *  stay, so the card says what was kept instead of passing another file's
 *  change off as this one's. */
function diffForFile(diff, path) {
  if (!diff?.rows || !path) return diff;
  const want = path.toLowerCase();
  const kept = [];
  const others = [];
  let keep = false;
  let sectioned = false;
  for (const row of diff.rows) {
    if (row.k === "h" && row.t.startsWith("diff --git ")) {
      sectioned = true;
      const target = /\sb\/(.+)$/.exec(row.t)?.[1] ?? "";
      const lower = target.toLowerCase();
      keep = lower !== "" && (want === lower || want.endsWith(`/${lower}`));
      if (!keep && target) others.push(target);
    }
    if (keep && row.k !== "h") kept.push(row);
  }
  if (!sectioned) return diff;
  return kept.length > 0 ? { ...diff, rows: kept } : { ...diff, rows: [], elsewhere: others };
}

/** Long diffs open folded: the first rows show the shape of the change, the
 *  rest wait behind one button that says how much is left. */
const DIFF_PREVIEW_ROWS = 40;
const DIFF_FOLD_MIN = 60;

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
  const rows = diff.rows ?? [];
  if (rows.length === 0 && diff.elsewhere?.length) {
    const names = diff.elsewhere.map((path) => path.split("/").pop()).join(", ");
    wrap.append(el("p", "diff-elsewhere", `Diff kept for this change covers ${names} only. No lines of this file were stored with it.`));
    return wrap;
  }
  const folds = rows.length >= DIFF_FOLD_MIN;
  const rest = el("div", "diff-rest");
  rest.hidden = true;
  let open = false;
  rows.forEach((row, index) => {
    const line = el("div", `dl ${KIND_CLASS[row.k] ?? ""}`);
    // hunk headers are not code, so they are never tokenised
    if (row.k === "@") {
      line.append(el("span", "ln", ""), el("span", "lt", row.t));
    } else {
      const painted = codeCell(row.t, open);
      open = painted.openComment;
      line.append(el("span", "ln", row.n ? String(row.n) : ""), painted.cell);
    }
    (folds && index >= DIFF_PREVIEW_ROWS ? rest : wrap).append(line);
  });
  if (folds) {
    const more = el("button", "diff-more", `Show ${rows.length - DIFF_PREVIEW_ROWS} more lines`);
    more.type = "button";
    more.setAttribute("aria-expanded", "false");
    more.addEventListener("click", (event) => {
      // a diff inside a record row must not also pick the record
      event.stopPropagation();
      const opening = rest.hidden;
      rest.hidden = !opening;
      more.setAttribute("aria-expanded", String(opening));
      more.textContent = opening ? "Fold diff" : `Show ${rows.length - DIFF_PREVIEW_ROWS} more lines`;
      if (!opening) more.scrollIntoView({ block: "nearest" });
    });
    wrap.append(rest, more);
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
  if (state.view === "bundle") {
    const bundle = state.selectedBundle;
    if (!bundle) {
      paneWelcome();
      return;
    }

    const allBundleFiles = getBundleFiles(bundle);

    const results = await Promise.allSettled(
      allBundleFiles.map(async (fileItem) => {
        const data = await api(`/api/compare?path=${encodeURIComponent(fileItem.path)}`);
        const changes = data.changes ?? [];
        const unattributed = data.unattributed ?? [];
        const shownChanges = changes.filter((c) => matchesBundle(c, bundle));
        const shownUnattributed = bundle.commit ? [] : unattributed;
        return {
          fileItem,
          changes: shownChanges,
          unattributed: shownUnattributed,
        };
      })
    );

    let totalBundleChanges = 0;
    let totalBundleWitnesses = 0;
    const allMoments = [];

    const fileHistoryList = results.map((res, idx) => {
      const fileItem = allBundleFiles[idx];
      if (res.status === "fulfilled") {
        const { changes, unattributed } = res.value;
        const fileWitCount = changes.reduce((n, c) => n + (c.witnesses?.length ?? 0), 0) + unattributed.length;
        totalBundleChanges += changes.length;
        totalBundleWitnesses += fileWitCount;
        allMoments.push(...changes.flatMap((c) => c.witnesses ?? []), ...unattributed);
        return {
          fileItem,
          changes,
          unattributed,
          witnessCount: fileWitCount,
          error: null,
        };
      } else {
        return {
          fileItem,
          changes: [],
          unattributed: [],
          witnessCount: fileItem.witnessCount ?? 0,
          error: res.reason,
        };
      }
    });

    state.moments = allMoments;

    const fileCount = allBundleFiles.length;
    const totalWit = Math.max(totalBundleWitnesses, bundle.witnessCount ?? 0);

    const shaBit = bundle.commit && bundle.commit !== "uncommitted"
      ? ` · ${bundle.commit.slice(0, 7)}`
      : "";

    const shortCommit = bundle.commit
      ? (bundle.commit === "uncommitted" ? "uncommitted" : bundle.commit.slice(0, 7))
      : "";

    $("#sub-note").textContent = `${totalBundleChanges} changes · ${totalWit} moments (${shortCommit})`;

    const nodes = [];

    const summaryWrap = el("div", "bundle-summary");
    const topTitle = el("div", "bundle-summary-title", `${epistemicLabel(bundle.epistemic)}${shaBit}`);
    const topMeta = el("div", "bundle-summary-meta", `${fileCount} ${fileCount === 1 ? "file" : "files"} · ${noteWord(totalWit)}`);
    summaryWrap.append(topTitle, topMeta);
    nodes.push(summaryWrap);

    if (fileHistoryList.length === 0) {
      nodes.push(empty("no files recorded in this bundle."));
    } else {
      const bundleFilesWrap = el("div", "bundle-files");
      bundleFilesWrap.setAttribute("role", "list");

      fileHistoryList.forEach((entry, index) => {
        const { fileItem, changes, unattributed, witnessCount, error } = entry;
        const card = el("div", "bundle-file-card");
        const head = el("button", "bundle-file-head");
        head.type = "button";

        let isOpen = index === 0;
        head.setAttribute("aria-expanded", String(isOpen));

        const headLeft = el("div", "bundle-file-head-left");
        const toggleIcon = el("span", "bundle-file-toggle", isOpen ? "▾" : "▸");
        const split = splitPath(fileItem.path, bundle.repo ?? null);
        const baseName = split.base;
        const dir = [split.repo, split.dir].filter(Boolean).join(" / ");

        const nameSpan = el("span", "bundle-file-name", baseName);
        headLeft.append(toggleIcon, nameSpan);
        if (dir) {
          const dirSpan = el("span", "bundle-file-dir", dir);
          headLeft.append(dirSpan);
        }

        const headRight = el("div", "bundle-file-head-right");
        const statParts = [];
        if (changes.length > 0) {
          statParts.push(`${changes.length} ${changes.length === 1 ? "change" : "changes"}`);
        }
        if (witnessCount > 0) {
          statParts.push(noteWord(witnessCount));
        } else if (changes.length === 0) {
          statParts.push(fileItem.rows && fileItem.rows.length > 0 ? "1 change" : "no diff");
        }

        const statsSpan = el("span", "bundle-file-stats", statParts.join(" · "));
        headRight.append(statsSpan);

        head.append(headLeft, headRight);

        const bodyWrap = el("div", "bundle-file-body");
        bodyWrap.hidden = !isOpen;

        if (error) {
          bodyWrap.append(el("div", "bundle-diff-empty", "rocky could not hear history for this file."));
        } else if (changes.length === 0 && unattributed.length === 0) {
          if (fileItem.rows && fileItem.rows.length > 0) {
            bodyWrap.append(diffBlock({ commit: bundle.commit, rows: fileItem.rows }, true));
          } else {
            bodyWrap.append(el("div", "bundle-diff-empty", "no witnesses in this bundle for this file."));
          }
        } else {
          for (const change of changes) {
            const changeDiff = change.diff ?? (fileItem.rows && fileItem.rows.length > 0 ? { commit: bundle.commit, rows: fileItem.rows } : undefined);
            bodyWrap.append(changeCard({ ...change, diff: diffForFile(changeDiff, fileItem.path) }));
          }
          if (unattributed.length > 0) {
            if (changes.length > 0) bodyWrap.append(el("div", "unattributed-head", "moments without an attributable change"));
            for (const record of unattributed) bodyWrap.append(recordRow(record, undefined, true));
          }
        }

        head.addEventListener("click", (event) => {
          event.stopPropagation();
          isOpen = !isOpen;
          head.setAttribute("aria-expanded", String(isOpen));
          toggleIcon.textContent = isOpen ? "▾" : "▸";
          bodyWrap.hidden = !isOpen;
          card.classList.toggle("open", isOpen);
        });

        card.append(head, bodyWrap);
        bundleFilesWrap.append(card);
      });

      if (state.bundleDiff?.truncated || bundle.truncated) {
        const total = state.bundleDiff?.total ?? allBundleFiles.length;
        bundleFilesWrap.append(el("div", "trunc", `… diff truncated (${allBundleFiles.length} of ${total} files)`));
      }

      nodes.push(bundleFilesWrap);
    }

    fill(pane, ...nodes);
    return;
  }

  if (!state.file) {
    paneWelcome();
    return;
  }
  const data = await api(`/api/compare?path=${encodeURIComponent(state.file)}`);
  const changes = data.changes ?? [];
  const unattributed = data.unattributed ?? [];

  const witnessCount = changes.reduce((n, c) => n + (c.witnesses?.length ?? 0), 0) + unattributed.length;
  state.moments = [...changes.flatMap((c) => c.witnesses ?? []), ...unattributed];

  $("#sub-note").textContent = `${changes.length} changes · ${witnessCount} moments`;

  if (changes.length === 0 && unattributed.length === 0) {
    fill(pane, empty("nothing heard for this file yet."));
    return;
  }
  const cards = changes.map((change) => changeCard({ ...change, diff: diffForFile(change.diff, state.file) }));
  if (unattributed.length > 0) {
    if (changes.length > 0) cards.push(el("div", "unattributed-head", "moments without an attributable change"));
    for (const record of unattributed) cards.push(recordRow(record, undefined, true));
  }
  fill(pane, ...cards);
}

/** One unique change: its header names the evidence once, the single diff
 *  follows, and every witness reason nests inside the same bordered card
 *  so a reason can never be mistaken for the neighbouring change. */
function changeCard(change) {
  const card = el("div", "change");
  card.append(el("div", "change-head", changeLabel(change)));
  // Show diff governs History as it does Compare; a change with no stored
  // diff keeps its notes rather than failing the whole pane
  if (state.showDiff && change.diff) card.append(diffBlock(change.diff, true));
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
  if (state.showDiff && diff) detail.append(diffBlock(diffForFile(diff, state.file)));
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

/** Live drag/row selection backing the Why button; null when nothing picked. */
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
  if (!ask || !pop || !pop.hidden) return;
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
  const sel = $("#sel");
  if (sel) sel.textContent = `sel ${picked.start}–${picked.end}`;
  ask.hidden = false;
  ask.style.left = `${Math.max(8, picked.rect.left)}px`;
  ask.style.top = `${Math.max(8, picked.rect.top - 38)}px`;
});

if (ask) ask.addEventListener("click", (event) => {
  // the document listener closes the popover, so this click must not reach it
  event.stopPropagation();
  if (pending !== null) askWhy(pending.start, pending.end, ask.getBoundingClientRect());
});

/* ---- the why popover ---------------------------------------------------- */

const pop = $("#pop");
const csCard = $("#cs-card");

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
  if (!pop) return;
  pop.hidden = true;
  fill(pop);
  clearPicked();
  const sel = $("#sel");
  if (sel) sel.textContent = "";
  if (state.view === "bundle") applyBundleHighlights();
}

if (pop) pop.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  if (pop && !pop.hidden) closePop();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pop && !pop.hidden) closePop();
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
  if (!select || !note) return;
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
  // an endpoint change settles unified visibility too
  syncJevBlock();
}

let modelTimer = 0;
$("#set-endpoint").addEventListener("input", () => {
  clearTimeout(modelTimer);
  // a URL is typed a character at a time; only the pause is worth a lookup
  modelTimer = setTimeout(refreshModels, 450);
});

async function paintModelChip() {
  const chip = $("#model-chip");
  if (!chip) return;
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
async function askModel(anchor, prompt, keep, ctx, after = []) {
  const name = modelLabel();
  const shell = () => answerBox("guess", "Model guess", `${name} · not evidence`);
  showAnswer(anchor, keep, answerWait(shell(), `Asking ${name}. It reads what Rocky holds and the lines you picked.`), after);

  let answer;
  try {
    answer = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // only the prompt travels: endpoint, model and key are read server side.
      // the file context lets rocky dig the evidence pack before forwarding.
      body: JSON.stringify({ prompt, ...askBody(ctx) }),
    });
  } catch {
    const miss = shell();
    miss.append(el("p", "answer-fail", `${name} did not answer. Check endpoint, key and model in Settings, then try again.`));
    const open = el("button", "answer-link", "Open Settings");
    open.type = "button";
    open.addEventListener("click", () => { closePop(); void openSettings(); });
    miss.append(open);
    showAnswer(anchor, keep, miss, after);
    return;
  }

  const guess = shell();
  guess.append(...guessNodes(answer.text || answer.error || "The model returned an empty answer."));

  const chain = Array.isArray(answer.referenceChain) ? answer.referenceChain : [];
  if (chain.length > 0) {
    const drawer = el("details", "ref-chain-drawer");
    drawer.append(el("summary", "ref-chain-head", `How the code connects, ${chain.length} steps`));
    const list = el("ol", "ref-chain-list");
    for (const step of chain) list.append(el("li", "ref-chain-step", String(step)));
    drawer.append(list);
    guess.append(drawer);
  }

  guess.append(el("p", "answer-foot", `Guessed by ${name} from what Rocky holds. Not evidence itself: cross-check before you trust it.`));
  showAnswer(anchor, keep, guess, after);
}

/* ---- answers under the why card -------------------------------------------
 *
 * Every way to dig (usages, Jev, a model) answers in the same shell below
 * the card: a badge naming who answered, what that answer is worth, then
 * the body. The card and the dig row stay, so a second option is one click
 * away instead of a reopened popover. */

/** A path as the file list shows it: from the repo down, machine prefix off. */
function shortPath(path) {
  const file = state.files.find((f) => f.path.toLowerCase() === String(path).toLowerCase());
  const { base, repo, dir } = splitPath(String(path), file?.repo ?? null);
  return [repo, dir, base].filter(Boolean).join("/");
}

/** The ask body stays exactly what the server has always read: the clicked
 *  line (origin) only steers Find usages and never travels to a model. */
function askBody(ctx) {
  const { origin: _origin, ...rest } = ctx ?? {};
  return rest;
}

/** The model's display name, as the header chip shows it. */
function modelLabel() {
  // the chip already resolved the provider's own name for this model
  const chip = $("#model-chip");
  if (chip && !chip.hidden && chip.textContent.trim()) return chip.textContent.trim();
  const named = provider?.models?.find((m) => m.id === settings.model)?.name;
  // the vendor prefix ("deepseek/") repeats the model's own name
  return named ?? prettyModel(String(settings.model).split("/").pop() ?? "");
}

function answerBox(kind, title, note) {
  const wrap = el("section", `answer answer-${kind}`);
  const head = el("div", "answer-head");
  head.append(el("span", "answer-badge", title));
  if (note) head.append(el("span", "answer-note", note));
  wrap.append(head);
  return wrap;
}

/** A wait says who is being asked, in the answer's own shape. */
function answerWait(shell, text) {
  shell.classList.add("waiting");
  shell.append(el("p", "answer-wait", text), listSkeleton(3));
  return shell;
}

/** Card, then the answer, then the dig row again; the answer scrolls into
 *  view because the card above it may already fill the popover. */
function showAnswer(anchor, keep, answer, after) {
  openPop(anchor, ...keep, answer, ...after);
  answer.scrollIntoView({ block: "nearest" });
}

/** "memory.ts:334" or "src/x.ts:12-20" -> a heard file and line, when the
 *  name matches one; otherwise the cite stays plain text. */
function citeTarget(cite) {
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(cite.trim());
  if (!m) return null;
  const want = m[1].replace(/\\/g, "/").toLowerCase();
  const hit = [state.file, ...state.files.map((f) => f.path)]
    .find((path) => path && (path.toLowerCase() === want || path.toLowerCase().endsWith(`/${want}`)));
  return hit ? { path: hit, line: Number(m[2]) } : null;
}

function citeNode(cite) {
  const target = citeTarget(cite);
  if (!target) return el("span", "answer-cite", cite);
  const link = el("button", "answer-cite answer-cite-link", cite);
  link.type = "button";
  link.title = `Open ${target.path} at line ${target.line}`;
  link.addEventListener("click", () => jumpToFileLine(target.path, target.line));
  return link;
}
/**
 * Jev analysis over what rocky heard: local, no key, read-only display.
 * Grey like a guess, never clay: only the engine mark and hold/hedge
 * states borrow emphasis. No claims invented client-side -- every row
 * quotes the answer, its refs, and its trace, or says what is unknown.
 */
async function askJev(anchor, prompt, keep, ctx, after = []) {
  const shell = (note) => answerBox("jev", "Jev analysis", note);
  showAnswer(anchor, keep, answerWait(shell("reading what Rocky holds"), "Jev is weighing the evidence Rocky holds for these lines."), after);
  let answer;
  try {
    answer = await api("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, ...askBody(ctx), analysis: "jev" }),
    });
  } catch {
    const miss = shell("no answer");
    miss.append(el("p", "answer-fail", "Jev did not answer. The card above still stands; try again in a moment."));
    showAnswer(anchor, keep, miss, after);
    return;
  }
  const status = jevStatus(answer?.decisionTrace?.status);
  const result = shell(status.label);
  if (status.held) result.classList.add("held");
  result.append(...jevNodes(answer, status));
  showAnswer(anchor, keep, result, after);
}

/** Jev's status in words: held and hedged answers say so before anything. */
function jevStatus(raw) {
  const status = String(raw ?? "").toLowerCase();
  if (status === "hold" || status === "held") return { label: "held back", held: true, note: "Evidence was too thin for a firm answer, so Jev held back." };
  if (status === "hedge" || status === "hedged" || status === "low_confidence") return { label: "unsure", held: true, note: "Jev answered, but with low confidence. Treat it as a lead." };
  return { label: status ? status.replace(/_/g, " ") : "answered", held: false, note: "" };
}

/** Read-only Jev branch: the verdict first, then the evidence it leaned on,
 *  then the trace. No claims invented client-side -- every row quotes the
 *  answer, its refs, and its trace, or says what is unknown. */
function jevNodes(answer, status) {
  const nodes = [];
  if (status.note) nodes.push(el("p", "answer-flag", status.note));
  const text = answer && typeof answer.text === "string" && answer.text.length > 0
    ? answer.text
    : "Jev held: no typed answer, the card above stands on its own.";
  nodes.push(...guessNodes(text));

  const cards = Array.isArray(answer?.evidenceCards) ? answer.evidenceCards : [];
  if (cards.length > 0) {
    nodes.push(el("p", "answer-sub", `Evidence Jev leaned on, ${cards.length}`));
    const list = el("ul", "answer-evidence");
    for (const card of cards) {
      const item = el("li");
      if (card !== null && typeof card === "object") {
        item.append(el("span", "answer-ev-label", String(card.label ?? card.title ?? card.ref ?? card.kind ?? "evidence")));
        const body = card.detail ?? card.excerpt ?? card.snippet ?? card.ref ?? null;
        if (body) item.append(el("span", "answer-ev-body", String(body)));
      } else {
        item.append(el("span", "answer-ev-body", String(card)));
      }
      list.append(item);
    }
    nodes.push(list);
  }
  if (answer?.coverage?.reason) nodes.push(el("p", "answer-foot", `Coverage: ${answer.coverage.reason}`));
  nodes.push(jevTraceNode(answer?.decisionTrace));
  return nodes;
}
/** Trace visible per answer; null confidence is named, never blank. */
function jevTraceNode(trace) {
  const t = trace ?? {};
  const bits = [`engine ${t.engine ?? "jev"}`];
  if (t.confidence !== undefined && t.confidence !== null) bits.push(`confidence ${t.confidence}`);
  else bits.push("confidence withheld");
  const refs = Array.isArray(t.evidenceRefs) ? t.evidenceRefs.length : 0;
  bits.push(`${refs} evidence ref${refs === 1 ? "" : "s"}`);
  const latency = t.latencyMs ?? t.latency;
  if (latency !== undefined && latency !== null) bits.push(`${latency}ms`);
  const node = el("p", "jev-trace", bits.join(" · "));
  if (jevStatus(t.status).held) node.classList.add("jev-trace-flag");
  return node;
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

  // the protocol tokens stay in the answer text; the page names them in the
  // same words the witness card uses, so both read as one vocabulary
  const TRACK = { KODE: "Why this shape", BISNIS: "What it serves" };
  const nodes = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const why = line.match(/^why\s+(\d+)[.:]?\s*(.*)$/i);
    if (/^CUPINGAN\b/.test(line)) {
      const cup = el("p", "guess-cup", "Read ");
      cup.append(citeNode(line.replace(/^CUPINGAN\s*/, "")));
      nodes.push(cup);
    } else if (/^(KODE|BISNIS)\s*$/.test(line)) {
      nodes.push(el("p", "guess-track", TRACK[line] ?? line));
    } else if (why) {
      // a why row may end in " · path:line", its citation; that becomes a link
      const last = why[2].lastIndexOf(" · ");
      const cut = last >= 0 && /^\S+:\d+(?:-\d+)?$/.test(why[2].slice(last + 3).trim()) ? last : -1;
      const text = cut >= 0 ? why[2].slice(0, cut) : why[2];
      const row = box("guess-why", el("span", "guess-num", why[1]), el("span", "guess-text", text));
      if (cut >= 0) row.append(citeNode(why[2].slice(cut + 3)));
      nodes.push(row);
    } else if (/^stop\b/i.test(line)) {
      nodes.push(el("p", "guess-stop", `Ends at: ${line.replace(/^stop\s*/i, "")}`));
    } else if (/^SUMBER\b/.test(line)) {
      nodes.push(el("p", "guess-src", `Sources: ${line.replace(/^SUMBER\s*/, "")}`));
    } else if (/^DISCLAIMER\b/.test(line)) {
      nodes.push(el("p", "guess-warn", line.replace(/^DISCLAIMER[:\s]*/i, "")));
    } else {
      nodes.push(el("p", "guess-body", line));
    }
  }
  return nodes;
}

/** Adds action controls: find-usages button and optional BYOK ask. */
function withAsk(anchor, parts, prompt, held, ctx) {
  const actions = el("div", "why-actions");
  // the dig row is re-attached under every answer, so the next option is
  // one click away; the option that produced the answer shows as pressed
  const after = [el("p", "why-dig-head", "Dig deeper"), actions];

  // Each way to dig says what it costs in the button itself: none of them
  // is the answer, so none of them is dressed as the primary one.
  const dig = (className, name, note, run) => {
    const button = el("button", `why-dig ${className}`);
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.append(el("span", "why-dig-name", name), el("span", "why-dig-note", note));
    button.setAttribute("aria-label", `${name}: ${note}`);
    button.addEventListener("click", () => {
      for (const other of actions.children) other.setAttribute("aria-pressed", String(other === button));
      run();
    });
    actions.append(button);
  };
  dig("refs-btn", "Find usages", "Where this name is defined and used", () => showReferences(anchor, ctx, parts, after));
  dig("jev-btn", "Explain with Jev", "Analysis over what Rocky holds", () => askJev(anchor, prompt, parts, ctx, after));
  if (byokReady()) {
    dig("ai-btn", held ? "Explain with AI" : "Ask AI to explain",
      `${modelLabel()} guesses from this evidence`, () => askModel(anchor, prompt, parts, ctx, after));
  }

  return [...parts, ...after];
}

async function showReferences(anchor, ctx, keep = [], after = []) {
  const shell = (note) => answerBox("refs", "Usages", note);
  showAnswer(anchor, keep, answerWait(shell("searching this repo"), "Looking for where this name is defined and used."), after);

  const filePath = ctx?.path ?? state.file;
  // the clicked line names the symbol; the widened context window may start on a comment
  const line = ctx?.origin ?? ctx?.start ?? 1;
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
    const miss = shell("no answer");
    miss.append(failed(() => showReferences(anchor, ctx, keep, after)));
    showAnswer(anchor, keep, miss, after);
    return;
  }

  if (!data || (!data.definition && (!data.references || data.references.length === 0))) {
    const none = shell(selectedSymbol || "nothing found");
    none.append(el("p", "answer-fail", "Rocky found no definition or use of this name. Select one word, a function or variable name, then try again."));
    showAnswer(anchor, keep, none, after);
    return;
  }

  const sym = data.symbol || selectedSymbol;
  const refCount = data.references?.length ?? 0;
  const parts = shell(`${sym ? `${sym} · ` : ""}${refCount} ${refCount === 1 ? "use" : "uses"}`);

  if (data.definition) {
    const def = data.definition;
    const defBox = el("div", "refer-def");
    const top = el("div", "refer-def-head");
    const link = el("button", "refer-link", `${shortPath(def.path)}:${def.line}`);
    link.type = "button";
    link.title = `${def.path}:${def.line}`;
    link.addEventListener("click", () => jumpToFileLine(def.path, def.line));
    top.append(el("span", "refer-tag", "Definition"), link);
    const snippet = el("pre", "refer-snippet", def.text);
    defBox.append(top, snippet);
    parts.append(defBox);
  }

  if (data.references && data.references.length > 0) {
    const list = el("div", "moments-list refer-list");
    for (const ref of data.references) {
      const item = el("button", "moment refer-hit");
      item.type = "button";
      // a line-0 hit is a note that names the symbol, not a place in code
      const loc = ref.line > 0 ? `${shortPath(ref.path)}:${ref.line}` : `${shortPath(ref.path)} · note`;
      const top = el("span", "moment-top", `${loc} · ${ref.confidence}`);
      item.title = ref.line > 0 ? `${ref.path}:${ref.line}` : ref.path;
      const body = el("span", "moment-body", ref.text);
      item.append(top, body);
      item.addEventListener("click", () => {
        jumpToFileLine(ref.path, ref.line > 0 ? ref.line : 1);
      });
      list.append(item);
    }
    parts.append(list);
  }

  showAnswer(anchor, keep, parts, after);
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

/* ---- the why card --------------------------------------------------------
 *
 * The core hands the same teach card to the CLI, MCP and this page: a
 * header, "label: text" lines, an evidence string and "why N" rungs. The
 * page reads that shape back into parts instead of printing it raw, so the
 * first thing seen is how Rocky knows, then the reason, then where to dig.
 */

/** Plain names for where a reasoning step came from. */
const RUNG_SOURCE = {
  comment: "Comment",
  git: "Git history",
  ast: "Code structure",
  catalog: "Known pattern",
  def: "Definition",
  test: "Test",
};

/** Why the trail ended, in words a reader can weigh. */
const STOP_REASON = {
  "evidence-exhausted": "Rocky ran out of evidence after this step.",
  "max-hops": "Rocky stops after five steps, even when more evidence exists.",
  "library-boundary": "The trail leaves this repo into a library.",
  cycle: "The trail loops back on itself, so Rocky stopped.",
};

const WHY_KIND = {
  heard: { badge: "Witnessed", title: "rocky heard this. agent say why, rocky remember" },
  assembled: { badge: "Assembled", title: "rocky not hear this. assembled from evidence, not witnessed" },
  none: { badge: "Nothing held", title: "no witness, no ladder" },
};

/** Badge, the lines asked about, and a close control that says it exists. */
function whyTop(kind, start, end) {
  const top = el("div", "why-top");
  const badge = el("span", `why-badge why-${kind}`, WHY_KIND[kind].badge);
  badge.title = WHY_KIND[kind].title;
  const base = (state.file ?? "").split("/").pop() ?? "";
  const where = el("span", "why-where", start === end ? `${base} · line ${start}` : `${base} · lines ${start}–${end}`);
  where.title = state.file ?? "";
  const close = el("button", "why-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "close");
  close.addEventListener("click", () => closePop());
  top.append(badge, where, close);
  return top;
}

/** "label: text" -> [label, text]; a line without a label keeps it all. */
function splitLabel(line) {
  const m = /^([a-z]+):\s+([\s\S]*)$/.exec(line);
  return m ? [m[1], m[2]] : ["", line];
}

/** A witness is the author's own words, so they lead, labelled by concern. */
function witnessCard(data, start, end) {
  const parts = [
    whyTop("heard", start, end),
    el("p", "why-lede", "The agent that wrote these lines recorded why, at the time."),
  ];
  const facts = el("dl", "why-facts");
  const names = { code: "Why this shape", business: "What it serves", form: "Form" };
  for (const line of data.lines ?? []) {
    const [label, text] = splitLabel(line);
    facts.append(el("dt", null, names[label] ?? label), el("dd", null, text));
  }
  parts.push(facts);
  // "source: agent:claude-code · 3d ago" reads as who said it and when
  parts.push(el("div", "card-ev", String(data.evidence ?? "").replace(/^source:\s*/, "Heard from ")));
  return parts;
}

/** An assembly is a chain, not a verdict: every step shows its source, and
 *  the reason the chain stopped is said out loud. */
function assembledCard(data, start, end) {
  const parts = [
    whyTop("assembled", start, end),
    el("p", "why-lede", "No note was recorded for these lines. Rocky pieced a reason together from the code and git. Check each step before trusting it."),
  ];
  const rungs = (data.rungs ?? [])
    .map((rung) => /^why \d+\s+([\s\S]*) · (\w+)$/.exec(rung))
    .filter(Boolean);
  if (rungs.length > 0) {
    const chain = el("ol", "why-chain");
    chain.setAttribute("aria-label", "reasoning steps");
    for (const [, finding, source] of rungs) {
      const step = el("li", "why-step");
      step.append(el("span", "why-step-text", finding), el("span", "why-step-src", RUNG_SOURCE[source] ?? source));
      chain.append(step);
    }
    parts.push(chain);
  }
  // the file label and the "reason:" digest repeat what the chain shows;
  // any other line (provenance exhausted) is kept as a note
  for (const line of data.lines ?? []) {
    const [label] = splitLabel(line);
    if (label === "reason" || line.startsWith(`${state.file} · `)) continue;
    parts.push(el("p", "why-note", line));
  }
  const stop = /· ([a-z-]+)$/.exec(String(data.evidence ?? ""))?.[1];
  if (stop && STOP_REASON[stop]) parts.push(el("p", "why-stop", STOP_REASON[stop]));
  return parts;
}

async function askWhy(start, end, at, expand = (start === end)) {
  const anchor = at ?? ask?.getBoundingClientRect();
  const snippet = snippetFor(start, end);
  const selectedSymbol = pending?.text ?? "";
  if (ask) ask.hidden = true;
  if (!anchor) return;
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
    const bare = [whyTop("none", effectiveStart, effectiveEnd),
      el("p", "why-lede", "Rocky holds no note for these lines and found no evidence trail in the code or git. Dig deeper below, or ask the agent that wrote it.")];
    openPop(anchor, ...withAsk(
      anchor,
      bare,
      `Why is this code written this way? Rocky has no recorded reason for it.\n\n${askedAbout}\n\nFollow the rules and shape you were given. Ground every claim in the code quoted above, and say plainly if you cannot tell from the code alone.`,
      undefined,
      { path: state.file, start: effectiveStart, end: effectiveEnd, symbol: selectedSymbol, origin: start },
    ));
    return;
  }

  const assembled = data.header.startsWith("rocky not hear");
  const parts = assembled
    ? assembledCard(data, effectiveStart, effectiveEnd)
    : witnessCard(data, effectiveStart, effectiveEnd);

  // the model is given what rocky holds, so it interprets rather than invents
  const held = [data.header, ...data.lines, data.evidence].join("\n");
  openPop(anchor, ...withAsk(
    anchor,
    parts,
    `Rocky recorded this about the code below:\n\n${held}\n\n${askedAbout}\n\n` +
      "Explain what that recorded reason means for this code, following the rules and shape you were given. " +
      "Do not invent history rocky did not record; the record's labels (KODE, BISNIS, why 1, stop) are yours to use, not to quote as prose.",
    true,
    { path: state.file, start: effectiveStart, end: effectiveEnd, symbol: selectedSymbol, origin: start },
  ));
  renderCsCard(state.file, effectiveStart, effectiveEnd);
}

async function renderCsCard(path, start, end) {
  const box = csCard || document.getElementById("cs-card");
  if (!box) return;
  try {
    const res = await fetch(`/api/cs-explain?path=${encodeURIComponent(path)}&start=${start}&end=${end}`, {
      headers: { "X-Rocky-Token": window.__rockyToken || location.hash.slice(1) },
    });
    const body = await res.json().catch(() => null);
    if (!body || !body.definition) { box.hidden = true; return; }
    if (!pop.contains(box)) pop.append(box);
    document.getElementById("cs-title").textContent = `cs concept ${body.conceptId}`;
    document.getElementById("cs-definition").textContent = body.definition;
    document.getElementById("cs-trace").textContent = (body.trace || []).join("\n");
    document.getElementById("cs-check").textContent = body.check;
    box.hidden = false;
  } catch { box.hidden = true; }
}

/* ---- settings ----------------------------------------------------------
 *
 * BYOK is beta and off until filled in. It is the one place this page talks
 * to a host other than 127.0.0.1, so the key lives in this browser only and
 * never reaches rocky: the evidence stays local whatever the model answers.
 */

// The keys live server-side, never here. hasKey/hasJevKey/hasOpenRouterKey is all the page is told.
const settings = { provider: "openai", endpoint: "", model: "", lang: "id", hasKey: false, hasJevKey: false, jevProvider: "typesafe", hasOpenRouterKey: false };

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
function activeJevProvider() {
  const select = $("#set-jevprovider");
  if (select && (select.value === "openrouter" || select.value === "typesafe")) return select.value;
  return settings.jevProvider === "openrouter" ? "openrouter" : "typesafe";
}
function syncJevProviderSections() {
  const active = activeJevProvider();
  const nativeField = $("#jevkey-field");
  if (nativeField) nativeField.hidden = active !== "typesafe";
  const orField = $("#openrouter-key-field");
  if (orField) orField.hidden = active !== "openrouter";
}

/**
 * Unified OpenRouter mode: the main provider serves both the LLM model and
 * Jev (typesafe/jev-1.13) behind the single main key, so the whole Jev block
 * stays hidden. Detection checks the active provider catalogue id first,
 * then the currently selected or typed endpoint.
 */
function mainIsOpenRouter() {
  if (provider !== null && typeof provider.id === "string") {
    return provider.id === "openrouter";
  }
  const ep = currentEndpoint();
  if (ep) {
    return ep.toLowerCase().includes("openrouter.ai");
  }
  if (!chosen.custom && chosen.endpoint) {
    return chosen.endpoint.toLowerCase().includes("openrouter.ai");
  }
  const search = $("#provider-search") ? $("#provider-search").value.trim().toLowerCase() : "";
  if (search && search !== "custom…" && search !== "custom...") {
    return search.includes("openrouter");
  }
  if (settings.endpoint) {
    return settings.endpoint.toLowerCase().includes("openrouter.ai");
  }
  return settings.provider === "openrouter";
}

/**
 * Hides the Jev block (fields, alpha note, both Forget buttons) as one unit
 * in unified mode; otherwise restores it with the existing per-provider
 * subsections unchanged.
 */
function syncJevBlock() {
  const unified = mainIsOpenRouter();
  const block = $("#jev-settings-block");
  if (block) block.hidden = unified;
  const clearJev = $("#settings-clear-jev");
  if (clearJev) clearJev.hidden = unified;
  const clearOr = $("#settings-clear-openrouter");
  if (clearOr) clearOr.hidden = unified;
  if (!unified) syncJevProviderSections();
}

function paintSettings() {
  const key = $("#set-key");
  if (!key) return;
  key.value = "";
  key.placeholder = settings.hasKey ? "key saved. type to replace" : "";
  const jev = $("#set-jevkey");
  if (jev) {
    jev.value = "";
    jev.placeholder = settings.hasJevKey ? "jev key saved. type to replace" : "";
  }
  const note = $("#jevkey-note");
  if (note) note.textContent = settings.hasJevKey ? "Jev key saved server-side. Lightning toggle armed." : "Server-side only. Never shown back. Enables the lightning toggle.";
  const providerSelect = $("#set-jevprovider");
  if (providerSelect) providerSelect.value = settings.jevProvider === "openrouter" ? "openrouter" : "typesafe";
  const orKey = $("#set-openrouterkey");
  if (orKey) {
    orKey.value = "";
    orKey.placeholder = settings.hasOpenRouterKey ? "openrouter key saved. type to replace" : "";
  }
  const orNote = $("#openrouterkey-note");
  if (orNote) orNote.textContent = settings.hasOpenRouterKey ? "OpenRouter key saved server-side. Lightning toggle armed." : "Server-side only. Never shown back. Enables the lightning toggle on the OpenRouter path.";
  syncJevBlock();
  const lang = $("#set-lang");
  if (lang) lang.value = settings.lang;
}

async function openSettings() {
  await pullSettings();
  await paintProviders();
  await refreshModels();
  paintSettings();
  $("#scrim").hidden = false;
  $("#settings").hidden = false;
  $("#set-endpoint").focus();
}

function closeSettings() {
  closeProviders();
  $("#settings").hidden = true;
  if ($("#repo-filter").hidden) $("#scrim").hidden = true;
  $("#settings-btn").focus();
}

for (const [selector, event, handler] of [
  ["#settings-btn", "click", (event) => { event.stopPropagation(); openSettings(); }],
  ["#settings-close", "click", closeSettings],
  ["#scrim", "click", () => {
    if (!$("#repo-filter").hidden) closeRepoFilter();
    if (!$("#settings").hidden) closeSettings();
  }],
  ["#set-jevprovider", "change", () => { syncJevBlock(); }],
  ["#settings-save", "click", () => {
    const typed = $("#set-key").value;
    // Unified OpenRouter mode: one main key covers LLM + Jev, so the hidden
    // Jev fields are omitted — no stale Jev values are ever written.
    const block = $("#jev-settings-block");
    const unified = block ? block.hidden : mainIsOpenRouter();
    const jevField = !unified ? $("#set-jevkey") : null;
    const orField = !unified ? $("#set-openrouterkey") : null;
    const jevTyped = jevField ? jevField.value : "";
    const orTyped = orField ? orField.value : "";
    const jevProvider = $("#set-jevprovider") ? $("#set-jevprovider").value : settings.jevProvider;
    const nextProvider = unified ? "openrouter" : (provider?.id === "anthropic" ? "anthropic" : "openai");
    void pushSettings({
      provider: nextProvider,
      endpoint: currentEndpoint(),
      model: $("#set-model").value,
      lang: $("#set-lang").value,
      ...(!unified ? { jevProvider } : {}),
      // an untouched field leaves the stored key alone rather than erasing it
      ...(typed ? { key: typed } : {}),
      ...(jevTyped ? { jevKey: jevTyped } : {}),
      ...(orTyped ? { openRouterKey: orTyped } : {}),
    }).then(() => {
      paintSettings();
      window.dispatchEvent(new CustomEvent("rocky:settings-saved"));
    });
    closeSettings();
  }],
  ["#settings-clear", "click", () => {
    $("#set-key").value = "";
    void pushSettings({ key: "" }).then(() => {
      paintSettings();
      window.dispatchEvent(new CustomEvent("rocky:settings-saved"));
    });
  }],
  ["#settings-clear-jev", "click", () => {
    const field = $("#set-jevkey");
    if (field) field.value = "";
    void pushSettings({ jevKey: "" }).then(() => {
      paintSettings();
      window.dispatchEvent(new CustomEvent("rocky:settings-saved"));
    });
  }],
  ["#settings-clear-openrouter", "click", () => {
    const field = $("#set-openrouterkey");
    if (field) field.value = "";
    void pushSettings({ openRouterKey: "" }).then(() => {
      paintSettings();
      window.dispatchEvent(new CustomEvent("rocky:settings-saved"));
    });
  }],
]) {
  const node = $(selector);
  if (node) node.addEventListener(event, handler);
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#repo-filter").hidden) closeRepoFilter();
  else if (!$("#settings").hidden) closeSettings();
});

/* ---- listening ------------------------------------------------------
 * Third tab: portable change-lineage graph. Polling and render stop when
 * the tab hides; the foreground process owns the watcher throughout.
 * On re-show the checkpoint cursor resumes and missing intermediates
 * render as partial, never as causal claims.
 */
function stopListeningPoll() {
  if (state.listenTimer) { clearInterval(state.listenTimer); state.listenTimer = 0; }
}
function listenSpin() {
  const s = el("span", "listen-spin");
  s.setAttribute("aria-hidden", "true");
  return s;
}
// A rationale wait must end: first load resolves, errors, or states the
// empty outcome within one poll interval, so the spinner never reads stuck.
const LISTEN_TIMEOUT_MS = 5000;
let listenDeadline = 0;
// The pick is a consented-repo id or a path; the server resolves both.
const LISTEN_OTHER = "__other";
const LISTEN_PICK_KEY = "rocky.listen.repo";
const LISTEN_TAIL_LIMIT = 200;
function listenRepo() {
  return state.listenRepo || "";
}
// per-viewer convenience only: a blocked store just means no recall
function rememberListenRepo(value) {
  try { localStorage.setItem(LISTEN_PICK_KEY, value); } catch { /* no recall */ }
}
function recalledListenRepo() {
  try { return localStorage.getItem(LISTEN_PICK_KEY) || ""; } catch { return ""; }
}
function listenStatus(text, resolved) {
  const node = $("#listen-status");
  if (!node) return;
  // the status is a live region: repainting the same words each poll would
  // read them aloud every five seconds
  const said = `${text}|${resolved}`;
  if (node.dataset.said === said) return;
  node.dataset.said = said;
  node.classList.toggle("is-resolved", Boolean(resolved));
  node.replaceChildren();
  node.append(`${text} `, resolved ? "\u2713" : listenSpin());
  // every terminal state ends the header spinner too, not only a resolved chain
  const headerSpin = $("#listen-spin");
  if (headerSpin && resolved) headerSpin.remove();
}
function listenEmpty(title, hint) {
  const li = el("li", "listen-empty");
  li.append(el("b", null, title), el("p", null, hint));
  return li;
}
function setListenState(value) {
  const root = $("#listen-root");
  if (root) root.dataset.state = value;
}

// Mirrors COLLECTOR_TICK_MS in src/listening/collector-loop.ts.
const LISTEN_TICK_S = 10;
// Plain words for every v1 link basis. Weak bases read as context, never cause.
const LISTEN_BASIS = {
  direct: { label: "Reported by tool", tone: "heard", means: "The tool reported this event itself." },
  filesystem_observed: { label: "Heard on disk", tone: "heard", means: "Rocky heard this file change on disk. That proves the change, not who made it." },
  content_mapped: { label: "Matches commit", tone: "heard", means: "Snapshot text equals a Git commit exactly." },
  candidate_link: { label: "Possible link", tone: "weak", means: "Lines up with a commit, but not exactly. Context only, never cause." },
  temporal_candidate: { label: "Near in time", tone: "weak", means: "Happened close in time to other evidence. Context only, never cause." },
  unknown: { label: "Snapshot only", tone: "none", means: "Rocky holds this event with no link for it. Unknown is not nothing." },
};
const LISTEN_SOURCE = { watcher: "File watcher", git: "Git", hook: "hook", adapter: "log" };
const LISTEN_NODE = {
  agent_session: "Agent session", tool_action: "Tool action", test_run: "Test run",
  commit: "Commit", work_episode: "Work episode", repo: "Repo",
};
const LISTEN_COVERAGE = {
  complete: "Complete. Every event in this record read cleanly.",
  partial: "Partial. Some events went missing or failed to read.",
  unknown: "Unknown. Rocky cannot tell what is missing.",
};
const LISTEN_FILTER_IDS = ["listen-session", "listen-agent", "listen-surface", "listen-file", "listen-since"];
const LISTEN_WAVE_BARS = 48;
const LISTEN_WAVE_MIN_MS = 30 * 60 * 1000;

function listenClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function listenAgo(ts, now) {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
function listenDay(ts, now) {
  const midnight = (value) => { const day = new Date(value); day.setHours(0, 0, 0, 0); return day.getTime(); };
  // round, not floor: a DST day is 23 or 25 hours long
  const days = Math.round((midnight(now) - midnight(ts)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(ts).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
// A path reads by its file name; the folder stays quiet beside it.
function listenPathLabel(rel) {
  const cut = rel.lastIndexOf("/");
  const span = el("span", "listen-path");
  span.title = rel;
  if (cut >= 0) span.append(el("span", "listen-dir", rel.slice(0, cut + 1)));
  span.append(el("span", "listen-base", rel.slice(cut + 1)));
  return span;
}

// One file change arrives as two events, the version and its hunk. They
// merge by version id, so the timeline shows one change, not two rows.
function listenEntries(items) {
  const groups = [];
  const byVersion = new Map();
  for (const item of items) {
    const key = item.node === "file_version" ? item.nodeId
      : item.edge && item.edge.kind === "generated_hunk" ? item.edge.from : "";
    const group = key ? byVersion.get(key) : undefined;
    if (group) { group.push(item); continue; }
    const fresh = [item];
    if (key) byVersion.set(key, fresh);
    groups.push(fresh);
  }
  return groups.map(listenEntry);
}
function listenEntry(items) {
  const first = (read) => items.map(read).find((value) => value !== undefined && value !== "");
  const lead = items.find((item) => item.node) || items[0];
  const linked = items.find((item) => item.edge && item.edge.basis && item.edge.basis !== "unknown")
    || items.find((item) => item.edge);
  const covered = items.map((item) => item.coverage || "unknown");
  return {
    key: lead.eventId || "",
    items,
    ts: Math.max(...items.map((item) => item.ts || 0)),
    node: first((item) => item.node) || "",
    file: first((item) => item.refs && item.refs.fileRel) || "",
    deleted: items.some((item) => item.refs && item.refs.deleted),
    lines: first((item) => item.refs && item.refs.lineCount),
    commit: first((item) => item.refs && item.refs.commit) || "",
    session: first((item) => item.refs && item.refs.session) || "",
    basis: (linked && linked.edge.basis) || "unknown",
    source: lead.source || "unknown",
    harness: first((item) => item.harnessId) || "",
    surface: first((item) => item.surface) || "",
    redacted: items.every((item) => item.redaction && item.redaction.applied),
    consentRepo: items.every((item) => item.consent && item.consent.repo),
    consentHost: items.some((item) => item.consent && item.consent.host),
    coverage: covered.includes("partial") ? "partial" : covered.includes("unknown") ? "unknown" : "complete",
  };
}
function listenKind(entry) {
  if (entry.node === "file_version" || entry.items.some((item) => item.edge && item.edge.kind === "generated_hunk")) {
    return entry.deleted ? "Deleted" : "Changed";
  }
  return LISTEN_NODE[entry.node] || "Event";
}
function listenSourceLabel(entry) {
  const base = LISTEN_SOURCE[entry.source];
  if (entry.source === "hook" || entry.source === "adapter") return `${entry.harness || "agent"} ${base}`;
  return base || entry.source;
}
function listenBasis(entry) {
  const basis = LISTEN_BASIS[entry.basis] || LISTEN_BASIS.unknown;
  // no edge on a deletion or a non-file event holds no snapshot to speak of
  if (entry.basis === "unknown" && (entry.node !== "file_version" || entry.deleted)) return { ...basis, label: "No link yet" };
  return basis;
}
function listenMeta(entry) {
  const parts = [listenSourceLabel(entry)];
  if (entry.surface) parts.push(entry.surface);
  if (entry.session) parts.push(`session ${entry.session.slice(0, 8)}`);
  if (typeof entry.lines === "number" && !entry.deleted) parts.push(`snapshot ${entry.lines} lines`);
  if (entry.node === "file_version") parts.push(entry.redacted ? "redacted" : "not redacted");
  if (entry.coverage === "partial") parts.push("partial");
  return parts;
}
function listenEvidence(entry) {
  const host = el("div", "listen-evidence");
  host.append(el("p", "listen-means", listenBasis(entry).means));
  const facts = el("dl", "listen-ev-facts");
  const add = (term, value, isCode) => facts.append(el("dt", null, term), el("dd", isCode ? "is-code" : null, value));
  add("Link basis", entry.basis, true);
  add("Source", `${listenSourceLabel(entry)} (${entry.source})`);
  if (entry.file) add("File", entry.file, true);
  add("Commit", entry.commit || "Not matched to a commit.", Boolean(entry.commit));
  add("Redaction", entry.redacted ? "Applied before storage. Secret may remain despite redaction." : "Not applied to this event.");
  add("Consent", `Repo ${entry.consentRepo ? "yes" : "no"}, host ${entry.consentHost ? "yes" : "no"}`);
  add("Record", LISTEN_COVERAGE[entry.coverage] || LISTEN_COVERAGE.unknown);
  add(entry.items.length === 1 ? "Event" : "Events", entry.items.map((item) => item.eventId || "?").join("\n"), true);
  host.append(facts);
  return host;
}
function listenRow(entry, now) {
  const basis = listenBasis(entry);
  const li = el("li", `listen-row tone-${basis.tone}`);
  li.dataset.key = entry.key;
  // weak links never borrow the solid look of heard evidence
  if (basis.tone === "weak") li.classList.add("weak-candidate");
  if (entry.coverage === "partial") li.classList.add("is-partial");
  const open = state.listenOpen.has(entry.key);
  const head = el("button", "listen-row-main");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  const clock = el("time", "listen-clock", listenClock(entry.ts));
  clock.dateTime = new Date(entry.ts).toISOString();
  const ago = el("span", "listen-ago", listenAgo(entry.ts, now));
  ago.dataset.ts = String(entry.ts);
  const when = el("span", "listen-when");
  when.append(clock, ago);
  const dot = el("span", "listen-dot");
  dot.setAttribute("aria-hidden", "true");
  const title = el("span", "listen-title");
  title.append(el("span", `listen-kind${entry.deleted ? " is-deleted" : ""}`, listenKind(entry)));
  if (entry.file) title.append(listenPathLabel(entry.file));
  const meta = el("span", "listen-meta");
  for (const part of listenMeta(entry)) meta.append(el("span", null, part));
  const what = el("span", "listen-what");
  what.append(title, meta);
  head.append(when, dot, what, el("span", "listen-basis", basis.label));
  const evidence = listenEvidence(entry);
  evidence.hidden = !open;
  head.addEventListener("click", () => {
    const next = head.getAttribute("aria-expanded") !== "true";
    head.setAttribute("aria-expanded", String(next));
    evidence.hidden = !next;
    evidence.classList.toggle("is-opening", next);
    if (next) state.listenOpen.add(entry.key);
    else state.listenOpen.delete(entry.key);
  });
  li.append(head, evidence);
  return li;
}
// Repaint only when the heard set changes: a full repaint every poll would
// throw keyboard focus out of the list. Otherwise only the ages move.
function paintListenChain(chain, sig, rows, now) {
  if (chain.dataset.sig === sig) {
    for (const node of chain.querySelectorAll(".listen-ago[data-ts]")) node.textContent = listenAgo(Number(node.dataset.ts), now);
    return;
  }
  const focused = chain.contains(document.activeElement) ? document.activeElement.closest("[data-key]") : null;
  chain.dataset.sig = sig;
  chain.replaceChildren(...rows);
  if (focused) {
    const again = chain.querySelector(`[data-key="${CSS.escape(focused.dataset.key)}"] .listen-row-main`);
    if (again) again.focus();
  }
}

// The waveform is what Rocky heard over time: one bar per slice, height by
// change count. Quiet slices stay a flat mark, like silence on a track.
function renderListenWave(entries, now, rise) {
  const figure = $("#listen-wave");
  const bars = $("#listen-wave-bars");
  if (!figure || !bars) return;
  figure.hidden = false;
  const oldest = entries.reduce((low, entry) => Math.min(low, entry.ts), now);
  const start = Math.min(oldest, now - LISTEN_WAVE_MIN_MS);
  const slice = (now - start) / LISTEN_WAVE_BARS;
  const counts = new Array(LISTEN_WAVE_BARS).fill(0);
  for (const entry of entries) {
    counts[Math.min(LISTEN_WAVE_BARS - 1, Math.max(0, Math.floor((entry.ts - start) / slice)))] += 1;
  }
  const peak = Math.max(1, ...counts);
  bars.classList.toggle("is-rising", Boolean(rise));
  bars.replaceChildren(...counts.map((count, index) => {
    const bar = el("span", count ? "wave-bar" : "wave-bar is-quiet");
    // square root keeps one busy minute from flattening every other bar
    bar.style.setProperty("--h", count ? Math.max(0.12, Math.sqrt(count / peak)).toFixed(3) : "0");
    bar.style.setProperty("--i", String(index));
    bar.title = `${listenClock(start + index * slice).slice(0, 5)}  ${count} change${count === 1 ? "" : "s"}`;
    return bar;
  }));
  const clockFrom = listenClock(start).slice(0, 5);
  const dayFrom = listenDay(start, now);
  const fromText = dayFrom === "Today" ? clockFrom : `${dayFrom} ${clockFrom}`;
  const from = $("#listen-wave-from");
  if (from) from.textContent = fromText;
  const busiest = counts.indexOf(peak);
  bars.setAttribute("aria-label", entries.length > 0
    ? `${entries.length} changes heard from ${fromText} to now, busiest near ${listenClock(start + busiest * slice).slice(0, 5)}`
    : `No changes heard from ${fromText} to now`);
}
function renderListenStats(entries, heard, now) {
  const stats = $("#listen-stats");
  if (!stats) return;
  stats.hidden = false;
  const files = new Set(entries.map((entry) => entry.file).filter(Boolean)).size;
  const newest = heard.reduce((high, item) => Math.max(high, item.ts || 0), 0);
  const cells = [
    ["changes", String(entries.length)],
    ["files", String(files)],
    ["last heard", newest ? listenAgo(newest, now) : "nothing yet"],
  ];
  stats.replaceChildren(...cells.map(([term, value]) => {
    const cell = el("div", "listen-stat");
    cell.append(el("dt", null, term), el("dd", null, value));
    return cell;
  }));
}
// Most changed files double as a one-click file filter.
function renderListenTop(entries) {
  const wrap = $("#listen-top-wrap");
  const list = $("#listen-top");
  if (!wrap || !list) return;
  const active = ($("#listen-file") || {}).value || "";
  const counts = new Map();
  for (const entry of entries) if (entry.file) counts.set(entry.file, (counts.get(entry.file) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6);
  wrap.hidden = top.length === 0;
  const peak = top.length > 0 ? top[0][1] : 1;
  list.replaceChildren(...top.map(([file, count]) => {
    const on = file === active;
    const button = el("button", "listen-top-btn");
    button.type = "button";
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? "Show every file again" : `Show only ${file}`;
    button.style.setProperty("--w", (count / peak).toFixed(3));
    button.append(listenPathLabel(file), el("span", "listen-top-n", String(count)));
    button.addEventListener("click", () => setListenFilter("listen-file", on ? "" : file));
    const item = el("li");
    item.append(button);
    return item;
  }));
}
function hideListenLive() {
  for (const id of ["listen-wave", "listen-stats", "listen-top-wrap"]) {
    const node = $(`#${id}`);
    if (node) node.hidden = true;
  }
}
function listenFiltersOn() {
  return LISTEN_FILTER_IDS.filter((id) => ($(`#${id}`) || {}).value).length;
}
function syncListenFilterBar() {
  const on = listenFiltersOn();
  const label = $("#listen-more-label");
  if (label) label.textContent = on ? `Filters (${on} on)` : "Filters";
  const clear = $("#listen-clear");
  if (clear) clear.hidden = on === 0;
}
function setListenFilter(id, value) {
  const select = $(`#${id}`);
  if (!select) return;
  if (value && ![...select.options].some((option) => option.value === value)) {
    const option = el("option", null, value);
    option.value = value;
    select.append(option);
  }
  select.value = value;
  const form = $("#listen-filters");
  if (form) form.dispatchEvent(new Event("change"));
}
function renderListenCoverage(host, status, reasons, capped) {
  const kinds = [...new Set(reasons.map((reason) => reason.split(":")[0]))];
  const head = status === "complete" ? "Record complete."
    : status === "partial" ? "Record partial: some events went missing."
      : "Record coverage unknown.";
  host.textContent = `${head}${kinds.length ? ` (${kinds.join(", ")})` : ""}${capped ? ` Showing newest ${LISTEN_TAIL_LIMIT} events.` : ""}`;
  host.title = reasons.join("\n");
  host.dataset.status = status;
}
const LISTEN_REASONS = {
  "not-a-git-root": "That folder is not inside a Git repo.",
  "path-must-be-absolute": "Paste a full folder path, not a relative one.",
  "path-unresolvable": "That folder does not exist here.",
  "symlink-rejected": "Symlinked repo roots stay off.",
  "store-unavailable": "Rocky could not write the consent store.",
};
function listenConsentButton(action, text, repo) {
  const btn = el("button", action === "allow" ? "listen-go" : "listen-consent-btn", text);
  btn.type = "button";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    let result = null;
    try {
      // raw fetch: a refusal carries its reason in a 400 body
      const response = await fetch("/api/listening/consent", {
        method: "POST",
        headers: { "X-Rocky-Token": TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ repo, action, yes: true }),
      });
      result = await response.json().catch(() => null);
    } catch { /* reported below */ }
    if (!result || !result.ok) {
      btn.disabled = false;
      const host = $("#listen-consent");
      const reason = result && typeof result.reason === "string" ? result.reason : "";
      if (host) host.append(el("p", "listen-refused", LISTEN_REASONS[reason] || "Rocky could not change capture. Try again."));
      return;
    }
    // a pasted path becomes its consented id, so the pick survives reloads
    if (action === "allow" && result.id && repo !== state.listenLaunch) chooseListenRepo(result.id, false);
    await loadListenRepos();
    listenDeadline = Date.now() + LISTEN_TIMEOUT_MS;
    void refreshListening(true).catch(() => {});
  });
  return btn;
}
// One explicit click grants; picking a repo never does (spec §3, §8).
function renderListenConsent(host, consent, repo) {
  const label = consent.label || "this repo";
  // a repaint each poll would drop focus off the button and re-announce it
  const sig = `${repo}|${consent.allowed ? 1 : 0}|${label}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  if (consent.allowed) {
    const line = el("p", "listen-consent-state");
    line.append(el("b", null, "Listening."),
      ` Rocky checks the text files Git tracks here every ${LISTEN_TICK_S} seconds, while rocky dash stays open.`);
    host.append(line, listenConsentButton("revoke", "Stop listening", repo));
    return;
  }
  const card = el("div", "listen-offer");
  card.append(
    el("p", "listen-offer-title", `Rocky is not listening to ${label} yet.`),
    el("p", null, "Listen keeps redacted, bounded snapshots of the text files Git tracks here, while rocky dash stays open. Secret may remain despite redaction. Stop anytime; history stays."),
    listenConsentButton("allow", `Listen to ${label}`, repo),
  );
  host.append(card);
}
// Filter choices come from events already heard, so nothing is typed.
function fillListenFilter(id, values) {
  const select = $(`#${id}`);
  if (!select) return;
  const current = select.value;
  const wanted = ["", ...[...new Set(values.filter(Boolean))].sort()];
  if (current && !wanted.includes(current)) wanted.push(current);
  const have = [...select.options].map((option) => option.value);
  if (have.length === wanted.length && have.every((value, i) => value === wanted[i])) return;
  select.replaceChildren(...wanted.map((value) => {
    const option = el("option", null, value || "any");
    option.value = value;
    return option;
  }));
  select.value = current;
}
async function refreshListening(first) {
  const repo = listenRepo();
  const consentHost = $("#listen-consent");
  const coverageHost = $("#listen-coverage");
  const chain = $("#listen-chain");
  if (!repo) {
    setListenState("none");
    hideListenLive();
    if (consentHost) {
      consentHost.dataset.sig = "";
      consentHost.textContent = "Pick one repo above. Picking never grants capture.";
    }
    if (coverageHost) coverageHost.textContent = "";
    if (chain) paintListenChain(chain, "none", [listenEmpty("No repo selected.", "Pick a repo above, or choose Other folder and paste any folder inside one.")], Date.now());
    listenStatus("Waiting for a repo", true);
    return;
  }
  let consent = { allowed: false, label: "" };
  try {
    consent = await api(`/api/listening/consent?repo=${encodeURIComponent(repo)}`);
  } catch { /* fail open: skeleton stays */ }
  if (repo !== listenRepo()) return; // the pick changed mid-flight
  const repoLine = $("#listen-repo");
  if (repoLine && consent.label) repoLine.textContent = consent.label;
  if (consentHost) renderListenConsent(consentHost, consent, repo);
  if (!consent.allowed) {
    setListenState("off");
    hideListenLive();
    if (coverageHost) coverageHost.textContent = "Coverage unknown: capture is off, so Rocky cannot hear this repo.";
    if (chain) paintListenChain(chain, "off", [listenEmpty("Capture is off for this repo.", "Unknown activity is not no activity. Press Listen above to start the evidence chain.")], Date.now());
    listenStatus("Waiting for consent", true);
    return;
  }
  setListenState("on");
  const session = ($("#listen-session") || {}).value || "";
  const agent = ($("#listen-agent") || {}).value || "";
  const surface = ($("#listen-surface") || {}).value || "";
  const file = ($("#listen-file") || {}).value || "";
  const since = Number(($("#listen-since") || {}).value || 0);
  // Newest page every poll; every filter applies client-side to that page.
  const params = new URLSearchParams({ repo, limit: String(LISTEN_TAIL_LIMIT), newest: "1" });
  let tail = { events: [], nextCursor: "", coverage: "unknown" };
  let graph = { nodes: [], edges: [], coverage: { status: "unknown", reasons: [] }, truncated: false };
  let failed = false;
  try {
    tail = await api(`/api/listening/events?${params.toString()}`);
    graph = await api(`/api/listening/graph?${new URLSearchParams({ repo }).toString()}`);
  } catch { failed = true; }
  if (repo !== listenRepo()) return;
  const heard = (tail.events || []).slice().reverse();
  fillListenFilter("listen-session", heard.map((item) => item.refs && item.refs.session));
  fillListenFilter("listen-agent", heard.map((item) => item.harnessId));
  fillListenFilter("listen-file", heard.map((item) => item.refs && item.refs.fileRel));
  const floor = since > 0 ? Date.now() - since : 0;
  const shown = heard.filter((item) => {
    if (session && ((item.refs && item.refs.session) || "") !== session) return false;
    if (agent && (item.harnessId || "") !== agent) return false;
    if (surface && (item.surface || "") !== surface) return false;
    if (file && ((item.refs && item.refs.fileRel) || "") !== file) return false;
    if (floor && (item.ts || 0) < floor) return false;
    return true;
  });
  // First snapshots are the consent-start state, not edits: one summary line.
  const now = Date.now();
  const isBaseline = (item) => Boolean(item.refs && item.refs.baseline);
  const firsts = shown.filter(isBaseline);
  const entries = listenEntries(shown.filter((item) => !isBaseline(item)));
  const filtersOn = listenFiltersOn();
  syncListenFilterBar();
  // a full page that lost the last top event skipped events in between
  const gap = Boolean(state.listenCursor) && !first && heard.length >= LISTEN_TAIL_LIMIT
    && !heard.some((item) => item.eventId === state.listenCursor);
  const settled = now >= listenDeadline;
  if (chain) {
    const rows = [];
    if (failed) {
      rows.push(listenEmpty("Listening read failed.", "The request did not finish. Rocky retries on the next poll, or check the server log."));
    } else {
      if (gap) rows.push(el("li", "listen-gap is-partial", `Missing intermediates: partial. More than ${LISTEN_TAIL_LIMIT} events arrived between two checks. The older ones stay stored.`));
      let day = "";
      for (const entry of entries) {
        const label = listenDay(entry.ts, now);
        if (label !== day) {
          day = label;
          rows.push(el("li", "listen-day", label));
        }
        rows.push(listenRow(entry, now));
      }
      if (entries.length === 0 && firsts.length > 0 && filtersOn === 0) {
        rows.push(listenEmpty("Quiet so far.", `Rocky holds the starting state. Change a tracked file and it lands here within about ${LISTEN_TICK_S} seconds.`));
      }
      if (firsts.length > 0) {
        // a full page may hold only part of them: say so with a plus
        const count = `${firsts.length}${heard.length >= LISTEN_TAIL_LIMIT ? "+" : ""}`;
        rows.push(el("li", "listen-firsts", `${count} first snapshot${firsts.length === 1 ? "" : "s"}: state when listening began, not edits`));
      }
      if (shown.length === 0 && settled) {
        rows.push(filtersOn > 0
          ? listenEmpty("No events match these filters.", "Loosen a filter, or clear them all. Rocky checks the repo every few seconds while rocky dash stays open.")
          : listenEmpty("Nothing heard yet.", `Rocky takes the starting snapshot on the next check, within about ${LISTEN_TICK_S} seconds.`));
      }
    }
    const sig = [failed, gap, firsts.length, filtersOn, shown.length === 0 && settled, new Date(now).toDateString(),
      ...entries.map((entry) => `${entry.key}:${entry.items.length}`)].join("|");
    paintListenChain(chain, sig, rows, now);
  }
  if (!failed) {
    renderListenWave(entries, now, first);
    renderListenStats(entries, heard, now);
    renderListenTop(listenEntries(heard.filter((item) => !isBaseline(item))));
  }
  if (coverageHost) {
    const reasons = (graph.coverage && graph.coverage.reasons) || [];
    renderListenCoverage(coverageHost, tail.coverage || graph.coverage.status, reasons, heard.length >= LISTEN_TAIL_LIMIT);
  }
  if (heard.length > 0) state.listenCursor = heard[0].eventId || state.listenCursor;
  state.listenResolved = shown.length > 0 || failed || settled;
  if (failed) listenStatus("Listening read failed", true);
  else listenStatus(state.listenResolved ? (shown.length > 0 ? "Up to date" : "No events match") : "Getting rationale", state.listenResolved);
  const headerSpin = $("#listen-spin");
  if (headerSpin && state.listenResolved) headerSpin.remove();
}
// Picker from /api/listening/context: the launch repo plus consented repos
// as {id, label} (no consented path on the wire). Zero-click default: the
// recalled pick, else the launch repo when it listens, else the first
// consented repo, else the launch repo with its Listen offer.
async function loadListenRepos() {
  const select = $("#listen-repo-pick");
  if (!select) return;
  let context = null;
  try { context = await api("/api/listening/context"); } catch { context = null; }
  const launch = context && typeof context.launchRoot === "string" ? context.launchRoot.trim() : "";
  const launchOn = Boolean(context && context.launchConsented);
  const repos = context && Array.isArray(context.repos)
    ? context.repos.filter((repo) => repo && typeof repo.id === "string" && typeof repo.label === "string")
    : [];
  state.listenLaunch = launch;
  const options = [];
  if (launch) options.push([launch, `${(context && context.launchLabel) || launch} (here)${launchOn ? "" : " · not listening"}`]);
  for (const repo of repos) options.push([repo.id, repo.label]);
  if (state.listenCustom && !options.some(([value]) => value === state.listenCustom)) options.push([state.listenCustom, state.listenCustom]);
  options.push([LISTEN_OTHER, "Other folder…"]);
  select.replaceChildren(...options.map(([value, text]) => {
    const option = el("option", null, text);
    option.value = value;
    return option;
  }));
  const values = options.map(([value]) => value).filter((value) => value !== LISTEN_OTHER);
  const pick = [state.listenRepo, recalledListenRepo()].find((value) => value && values.includes(value))
    || (launchOn ? launch : "") || (repos[0] && repos[0].id) || launch;
  select.value = pick || LISTEN_OTHER;
  state.listenRepo = pick || "";
}
function chooseListenRepo(value, refresh = true) {
  if (value !== state.listenRepo) {
    state.listenCursor = "";
    state.listenOpen.clear();
    for (const id of ["listen-session", "listen-agent", "listen-file"]) {
      const select = $(`#${id}`);
      if (select) select.value = "";
      fillListenFilter(id, []);
    }
    syncListenFilterBar();
  }
  state.listenRepo = value;
  rememberListenRepo(value);
  const select = $("#listen-repo-pick");
  if (select && [...select.options].some((option) => option.value === value)) select.value = value;
  if (!refresh) return;
  listenDeadline = Date.now() + LISTEN_TIMEOUT_MS;
  listenStatus("Getting rationale", false);
  void refreshListening(true).catch(() => {});
}

async function loadListening() {
  stopListeningPoll();
  listenDeadline = Date.now() + LISTEN_TIMEOUT_MS;
  listenStatus("Getting rationale", false);
  try { await loadListenRepos(); } catch { /* Other folder always works */ }
  try { await refreshListening(true); } catch {
    const chain = $("#listen-chain");
    if (chain) {
      chain.replaceChildren();
      chain.append(listenEmpty("Listening read failed.", "The request did not finish. Retry Apply, or check the server log."));
    }
    listenStatus("Listening read failed", true);
  }
  stopListeningPoll();
  state.listenTimer = setInterval(() => {
    if (state.segment !== "listening" || document.visibilityState !== "visible") return;
    void refreshListening(false).catch(() => {});
  }, 5000);
}
const listenForm = $("#listen-filters");
if (listenForm) {
  // filters apply on change: no Apply button to forget
  listenForm.addEventListener("change", () => {
    state.listenCursor = "";
    syncListenFilterBar();
    listenDeadline = Date.now() + LISTEN_TIMEOUT_MS;
    listenStatus("Getting rationale", false);
    void refreshListening(true).catch(() => {});
  });
  listenForm.addEventListener("submit", (event) => event.preventDefault());
}
const listenClear = $("#listen-clear");
if (listenClear && listenForm) listenClear.addEventListener("click", () => {
  for (const id of LISTEN_FILTER_IDS) {
    const select = $(`#${id}`);
    if (select) select.value = "";
  }
  listenForm.dispatchEvent(new Event("change"));
  // the button hides itself now, so keyboard focus needs somewhere to land
  const summary = $("#listen-more-label");
  if (summary) summary.focus();
});
const listenPick = $("#listen-repo-pick");
const listenPath = $("#listen-repo-path");
if (listenPick) listenPick.addEventListener("change", () => {
  const other = listenPick.value === LISTEN_OTHER;
  if (listenPath) {
    listenPath.hidden = !other;
    if (other) listenPath.focus();
  }
  if (!other) chooseListenRepo(listenPick.value);
});
if (listenPath) listenPath.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const typed = listenPath.value.trim();
  if (!typed) return;
  state.listenCustom = typed;
  listenPath.hidden = true;
  if (listenPick && ![...listenPick.options].some((option) => option.value === typed)) {
    const option = el("option", null, typed);
    option.value = typed;
    listenPick.insertBefore(option, listenPick.lastElementChild);
  }
  chooseListenRepo(typed);
});

/* ---- boot -------------------------------------------------------------- */
closePop();
void pullSettings().catch(() => {});
try {
  showSegment(state.segment);
} catch {
  const main = $("#view-main");
  if (main) main.hidden = false;
  void loadMain().catch(() => {});
}

// A read surface goes stale while the tab is away, so it refetches on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  state.mainLoaded = false;
  if (state.segment === "main") loadMain();
  else if (state.segment === "listening") { state.listenCursor = state.listenCursor; void loadListening().catch(() => {}); }
  else if (state.view === "bundle") loadBundles();
  else loadFiles();
});
