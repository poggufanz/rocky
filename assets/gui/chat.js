/*
 * rocky chat -- the Main surface: chat list, thread, composer, sources.
 *
 * Each question is its own POST /api/chat. The server keeps no conversation,
 * so a chat here is a transcript, not context: earlier turns never travel
 * with a new question.
 *
 * Chats live in this browser's localStorage (this origin, this machine). They
 * are a convenience copy of answers already shown, never evidence: deleting
 * one changes nothing Rocky remembers.
 *
 * Memory-only turns scan locally, require relevant records, and hold instead
 * of summarizing weak matches. BYOK and remote Jev are for code questions.
 * No keys ever travel: POST /api/chat carries only { message, jev, model? }.
 * The route picker only adds the server's own `memory:` / `code:` prefix.
 * GET /api/settings is read for key presence only (booleans + provider).
 *
 * Colour is a claim: only hold states and the armed Jev toggle borrow emphasis.
 */

const TOKEN = location.hash.slice(1);

const MAX_PROMPT = 4_000; // the server's CHAT_MAX_MESSAGE_CHARS
const COUNT_FROM = 3_500;
const STORE_KEY = "rocky.chat.v1";
const SIDE_KEY = "rocky.chat.side";
// ponytail: whole-list rewrite per save; fine at 50 chats, index per chat if it grows
const MAX_CHATS = 50;
const DAY_MS = 86_400_000;
const NARROW = "(max-width: 900px)";
const JUMP_GAP = 160;
const CONFIRM_MS = 4_000;
const WHY = new Set(["rationale", "explain", "triple"]);
const HELD = new Set(["hold", "hedge", "held", "hedged", "low_confidence"]);

const ROUTES = {
  auto: {
    tag: "",
    prefix: "",
    note: "Auto: Rocky answers from memory, and also reads code when you name a file, a line, or a symbol.",
  },
  memory: {
    tag: "Memory only",
    prefix: "memory: ",
    note: "Memory: local records only. Nothing leaves this machine.",
  },
  code: {
    tag: "Code",
    prefix: "code: ",
    note: "Code: Rocky also reads repo files. Your question, quoted excerpts, and memory evidence go to the model you picked.",
  },
};

const chatState = {
  jev: false,
  armed: false,
  model: "",
  route: "auto",
  pending: null, // { chatId, turnId } while a question is out
  abort: null,
  sourcesFor: null,
  renaming: null,
  confirmDelete: null,
};

/* ---- network ----------------------------------------------------------- */

async function chatApi(message, signal) {
  const body = { message, jev: chatState.jev };
  // The server tolerates and ignores fields it does not need.
  if (chatState.model) body.model = chatState.model;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Rocky-Token": TOKEN },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/** Models the server can serve. Empty means unknown -- the box falls back local. */
async function chatModels() {
  try {
    const response = await fetch("/api/chat-models", { headers: { "X-Rocky-Token": TOKEN } });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body?.models) ? body.models : [];
  } catch {
    return [];
  }
}

/** Presence only: key values never travel to the page, only booleans + provider. */
async function jevKeyState() {
  const fallback = { unified: false, provider: "typesafe", hasJevKey: false, hasOpenRouterKey: false, hasKey: false };
  try {
    const response = await fetch("/api/settings", { headers: { "X-Rocky-Token": TOKEN } });
    if (!response.ok) return fallback;
    const body = await response.json();
    // Unified mode: the main provider is OpenRouter, so one shared key covers
    // the LLM model and Jev. Provider id wins, endpoint text is the fallback.
    const unified = body?.unified === true || body?.provider === "openrouter"
      || (typeof body?.endpoint === "string" && body.endpoint.toLowerCase().includes("openrouter"));
    return {
      unified,
      provider: body?.jevProvider === "openrouter" ? "openrouter" : "typesafe",
      hasJevKey: body?.hasJevKey === true,
      hasOpenRouterKey: body?.hasOpenRouterKey === true,
      hasKey: body?.hasKey === true,
    };
  } catch {
    return fallback;
  }
}

/* ---- dom helpers ------------------------------------------------------- */

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

function button(className, label, onClick, icon) {
  const node = el("button", className);
  node.type = "button";
  if (icon) node.append(svgIcon(icon, 14));
  if (label) node.append(el("span", null, label));
  node.addEventListener("click", onClick);
  return node;
}

const arr = (value) => (Array.isArray(value) ? value : []);
const str = (value) => (typeof value === "string" ? value : "");
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const baseName = (path) => String(path).replace(/\\/g, "/").split("/").pop() ?? String(path);

const ICONS = {
  check: [["polyline", { points: "20 6 9 17 4 12" }]],
  chevron: [["polyline", { points: "6 9 12 15 18 9" }]],
  copy: [["rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ["path", { d: "M5 15V5a2 2 0 0 1 2-2h10" }]],
  edit: [["path", { d: "M12 20h9" }], ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" }]],
  retry: [["polyline", { points: "1 4 1 10 7 10" }], ["path", { d: "M3.5 15a9 9 0 1 0 2.1-9.4L1 10" }]],
  trash: [["path", { d: "M3 6h18" }], ["path", { d: "M8 6V4h8v2" }], ["path", { d: "M19 6l-1 14H6L5 6" }]],
  book: [["path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" }], ["path", { d: "M4 19.5V21h16" }]],
  down: [["line", { x1: 12, y1: 5, x2: 12, y2: 19 }], ["polyline", { points: "19 12 12 19 5 12" }]],
  memory: [["ellipse", { cx: 12, cy: 5, rx: 8, ry: 3 }], ["path", { d: "M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" }], ["path", { d: "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" }]],
  code: [["polyline", { points: "16 18 22 12 16 6" }], ["polyline", { points: "8 6 2 12 8 18" }]],
  steps: [["path", { d: "M9 6h11M9 12h11M9 18h11" }], ["circle", { cx: 4, cy: 6, r: 1 }], ["circle", { cx: 4, cy: 12, r: 1 }], ["circle", { cx: 4, cy: 18, r: 1 }]],
};

function svgIcon(name, size = 14) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  const base = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  };
  for (const [key, value] of Object.entries(base)) svg.setAttribute(key, String(value));
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const child = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, String(value));
    svg.append(child);
  }
  return svg;
}

/** Rocky hears; his mark is five bars of an ear, moving only while he listens. */
function ear(listening) {
  const node = el("span", listening ? "cx-ear is-listening" : "cx-ear");
  node.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 5; i += 1) node.append(el("i"));
  return node;
}

/* ---- store --------------------------------------------------------------- */

function isChat(value) {
  return value !== null && typeof value === "object" && typeof value.id === "string"
    && typeof value.title === "string" && Array.isArray(value.turns);
}

function readChats() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(isChat) : [];
  } catch {
    return [];
  }
}

let chats = readChats();
let activeId = null;
let storeNote = "";

function newId() {
  try {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // insecure origin: fall through to a time-based id
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Newest first, capped; when storage is full the oldest chats stop being saved. */
function saveChats() {
  chats = [...chats].sort((a, b) => b.updated - a.updated).slice(0, MAX_CHATS);
  for (let keep = chats.length; keep >= 0; keep -= 1) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(chats.slice(0, keep)));
      const lost = chats.length - keep;
      storeNote = lost > 0 ? `Browser storage full. ${lost} oldest chat${lost === 1 ? "" : "s"} not saved.` : "";
      return;
    } catch {
      // too big or storage off: try with one chat fewer
    }
  }
  storeNote = "Browser storage off. Chats last until this tab closes.";
}

const activeChat = () => chats.find((chat) => chat.id === activeId) ?? null;

function patchChat(id, patch) {
  chats = chats.map((chat) => (chat.id === id ? { ...chat, ...patch(chat) } : chat));
}

function patchTurn(chatId, turnId, patch) {
  patchChat(chatId, (chat) => ({
    turns: chat.turns.map((turn) => (turn.id === turnId ? { ...turn, ...patch } : turn)),
  }));
}

function titleFrom(prompt) {
  return clip(prompt.split(/\r?\n/)[0].trim(), 60) || "Untitled chat";
}

/* ---- markdown ------------------------------------------------------------ */

function formatInlineNodes(text) {
  const container = document.createDocumentFragment();
  // code `...`, bold **...** or __...__, italic *...* or _..._, and [ref] tags
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[(?:triple|failure|fix|evidence)-[a-zA-Z0-9_-]+\])/g;
  let lastIndex = 0;
  for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
    if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      container.append(el("code", "cx-code-inline", token.slice(1, -1)));
    } else if (token.startsWith("**") || token.startsWith("__")) {
      container.append(el("strong", null, token.slice(2, -2)));
    } else if (token.startsWith("[")) {
      container.append(el("span", "cx-ref", token));
    } else {
      container.append(el("em", null, token.slice(1, -1)));
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
  return container;
}

/**
 * Small Markdown for answers: headings, lists, fenced code, inline marks.
 * `renderer:` lines are disclosure, so they move into the decision drawer.
 */
function markdownNode(text, className) {
  const container = el("div", className);
  let list = null;
  let listType = null;
  let fence = null;
  const closeList = () => {
    if (list) container.append(list);
    list = null;
    listType = null;
  };
  const listItem = (type, body) => {
    if (listType !== type) {
      closeList();
      list = el(type, `cx-${type}`);
      listType = type;
    }
    const li = el("li");
    li.append(formatInlineNodes(body));
    list.append(li);
  };

  for (const raw of String(text).split(/\r?\n/)) {
    if (fence !== null) {
      if (/^\s*```/.test(raw)) {
        container.append(el("pre", "cx-pre", fence.join("\n")));
        fence = null;
      } else {
        fence.push(raw);
      }
      continue;
    }
    if (/^\s*```/.test(raw)) {
      closeList();
      fence = [];
      continue;
    }
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }
    if (line.startsWith("renderer:")) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const h = el(`h${Math.min(6, heading[1].length + 2)}`, "cx-h");
      h.append(formatInlineNodes(heading[2]));
      container.append(h);
      continue;
    }
    const ordered = /^(?:\d+[.)]|\(\d+\))\s+(.+)$/.exec(line);
    if (ordered) {
      listItem("ol", ordered[1]);
      continue;
    }
    const bullet = /^[-*+•◦▪]\s+(.+)$/.exec(line);
    if (bullet) {
      listItem("ul", bullet[1]);
      continue;
    }
    closeList();
    const p = el("p", "cx-p");
    p.append(formatInlineNodes(line));
    container.append(p);
  }
  if (fence !== null) container.append(el("pre", "cx-pre", fence.join("\n")));
  closeList();
  if (container.childElementCount === 0) container.textContent = text;
  return container;
}

/* ---- answer anatomy ------------------------------------------------------ */

function codeRan(body) {
  return (body?.codeTrace !== null && typeof body?.codeTrace === "object")
    || (body?.codeAnswer !== null && typeof body?.codeAnswer === "object")
    || arr(body?.codeEvidence).length > 0;
}

function isHeld(body) {
  const status = String(body?.decisionTrace?.status ?? "").toLowerCase();
  return HELD.has(status);
}

/** Badges say where the answer came from and whether Rocky held back. */
function badges(body) {
  const out = [];
  const llm = body?.decisionTrace?.llm ?? {};
  if (codeRan(body)) {
    const tag = el("span", "cx-badge", "Memory + code");
    tag.title = "Rocky searched memory and read repo files for this answer";
    out.push(tag);
  } else {
    const tag = el("span", "cx-badge", llm.structurerStatus === "memory-only" ? "Local memory" : "Memory");
    tag.title = "Answered from Rocky's local records";
    out.push(tag);
  }
  if (isHeld(body)) {
    const tag = el("span", "cx-badge is-held", "Held");
    tag.title = "Rocky held back: evidence weak, incomplete, or too big";
    out.push(tag);
  }
  if (str(body?.coverage?.reason)) {
    const tag = el("span", "cx-badge", "Partial memory");
    tag.title = `Coverage: ${body.coverage.reason}`;
    out.push(tag);
  }
  if (body?.decisionTrace?.engine === "jev") out.push(el("span", "cx-badge", "Jev"));
  return out;
}

/**
 * One honest disclosure line for a code phase: the server's own disclosure
 * first, then any codeTrace flag the user must know about. Null when the
 * answer never touched code.
 */
function codeDisclosure(body) {
  const answer = body && typeof body.codeAnswer === "object" && body.codeAnswer !== null ? body.codeAnswer : null;
  const trace = body && typeof body.codeTrace === "object" && body.codeTrace !== null ? body.codeTrace : null;
  if (!answer && !trace) return null;
  // Server disclosure first; a trace flag only adds a line the server did not
  // already state, so one condition never renders twice.
  const candidates = [];
  if (answer && str(answer.disclosure).trim().length > 0) candidates.push({ text: answer.disclosure.trim(), markers: [] });
  if (trace && trace.mode === "unranked") {
    candidates.push({ text: "scan unranked: file list unavailable, excerpts come from memory-named files only.", markers: ["unranked"] });
  }
  if (trace && trace.truncated === true) candidates.push({ text: "scan truncated: not every file read.", markers: ["truncated"] });
  if (trace && trace.roundsExhausted === true) {
    candidates.push({ text: "budget spent after 3 rounds. files not read are not checked.", markers: ["budget spent", "round budget", "rounds exhausted", "not checked"] });
  }
  if (answer && typeof answer.stripped === "number" && answer.stripped > 0) {
    candidates.push({ text: `model claims not backed by quoted lines: ${answer.stripped} stripped.`, markers: ["stripped"] });
  }
  const kept = [];
  for (const candidate of candidates) {
    if (candidate.markers.length > 0 && candidate.markers.some((marker) => kept.join(" ").toLowerCase().includes(marker))) continue;
    kept.push(candidate.text);
  }
  return kept.length > 0 ? kept.join(" ") : null;
}

/**
 * Decision trace as one line. Missing fields render as unknown, never blank --
 * a trace that goes quiet would read as a verdict.
 */
function traceLine(trace) {
  const t = trace ?? {};
  const bits = [`engine ${t.engine ?? "unknown"}`, `status ${t.status ?? "unknown"}`];
  // confidence is nullable: null means hold/abstain, so it is named, never blank.
  bits.push(t.confidence !== undefined && t.confidence !== null ? `confidence ${t.confidence}` : "confidence withheld");
  const refs = arr(t.evidenceRefs).length;
  bits.push(`${refs} evidence ref${refs === 1 ? "" : "s"}`);
  const latency = t.latencyMs ?? t.latency;
  if (latency !== undefined && latency !== null) bits.push(`${latency}ms`);
  const llm = t.llm ?? {};
  const model = str(llm.model) || "no model";
  bits.push(`llm ${llm.active === true ? "active" : "inactive"} ${str(llm.structurerStatus) || "unknown"}/${str(llm.rendererStatus) || "unknown"} (${model})`);
  const node = el("p", "cx-trace", bits.join(" | "));
  if (HELD.has(String(t.status ?? "").toLowerCase())) node.classList.add("is-held");
  return node;
}

function stepRow(label, value) {
  const row = el("p", "cx-step-row");
  row.append(el("span", "cx-step-key", label), el("span", "cx-step-val", String(value)));
  return row;
}

function step(title, ...rows) {
  const li = el("li", "cx-step");
  li.append(el("p", "cx-step-title", title), ...rows);
  return li;
}

/** The route Rocky took, step by step. Evidence itself lives in Sources. */
function decisionDrawer(turn) {
  const body = turn.body ?? {};
  const t = body.decisionTrace ?? {};
  const llm = t.llm ?? {};
  const cards = arr(body.evidenceCards);
  const memoryOnly = llm.structurerStatus === "memory-only";
  const coverageReason = str(body.coverage?.reason);
  const latency = t.latencyMs ?? t.latency ?? null;

  const drawer = el("details", "cx-think");
  const head = el("summary", "cx-think-head");
  const meta = el("span", "cx-think-meta");
  meta.append(el("span", null, `${cards.length} record${cards.length === 1 ? "" : "s"}`));
  if (latency !== null) meta.append(el("span", null, `${latency}ms`));
  const chevron = el("span", "cx-think-chevron");
  chevron.append(svgIcon("chevron", 12));
  head.append(svgIcon("steps", 14), el("span", "cx-think-title", "How Rocky answered"), meta, chevron);

  const steps = el("ol", "cx-steps");

  const heard = memoryOnly ? `${cards.length} whole record${cards.length === 1 ? "" : "s"} accepted` : `${cards.length} evidence card${cards.length === 1 ? "" : "s"}`;
  const searched = step("Searched memory", stepRow("Found", heard));
  if (cards.length === 0) {
    const why = coverageReason
      ? (memoryOnly ? "Memory coverage incomplete; answer held." : "Memory coverage incomplete; code answer may miss memory evidence.")
      : (memoryOnly ? "No whole memory record matched well enough." : "No matching memory evidence for this question.");
    searched.append(el("p", "cx-step-note", why));
  } else {
    const refs = el("p", "cx-step-refs");
    for (const card of cards.slice(0, 6)) refs.append(el("span", "cx-ref", String(card?.ref ?? card?.kind ?? "record")));
    if (cards.length > 6) refs.append(el("span", "cx-step-note", `+${cards.length - 6} more`));
    searched.append(refs, button("cx-link", "View sources", () => openSources(turn)));
  }
  steps.append(searched);

  const confidence = t.confidence !== undefined && t.confidence !== null ? String(t.confidence) : "withheld";
  steps.append(step(
    memoryOnly ? "Checked relevance" : `Weighed evidence (${t.engine ?? "heuristic"})`,
    stepRow("Decision", t.status ?? "unknown"),
    stepRow(memoryOnly ? "Relevance" : "Confidence", confidence),
    stepRow(memoryOnly ? "Records kept" : "Shortlist", arr(t.evidenceRefs).length),
  ));

  const model = str(llm.model) || "rocky local";
  const wrote = step(
    memoryOnly ? (llm.active === true ? `Rendered locally with ${model}` : "Wrote answer without a remote model") : `Wrote answer with ${model}`,
    stepRow("Structurer", llm.structurerStatus ?? "baseline"),
    stepRow("Renderer", llm.rendererStatus ?? "baseline"),
    stepRow("Citations", llm.stripped && llm.stripped > 0 ? `${llm.stripped} uncited claims stripped` : "no uncited lines found"),
  );
  for (const line of str(body.text).split(/\r?\n/)) {
    if (line.trim().startsWith("renderer:")) wrote.append(el("p", "cx-step-note", line.trim()));
  }
  steps.append(wrote);

  if (codeRan(body)) {
    const trace = body.codeTrace && typeof body.codeTrace === "object" ? body.codeTrace : {};
    const known = (value) => (value !== undefined && value !== null ? value : "unknown");
    const coverage = trace.truncated === true ? "truncated, not every file read" : trace.truncated === false ? "complete" : "unknown";
    const read = step(
      "Read code",
      stepRow("Files", `${known(trace.filesScanned)} of ${known(trace.filesTotal)}`),
      stepRow("Scan", str(trace.mode) || "unknown"),
      stepRow("Rounds", `${known(trace.rounds)} of 3`),
      stepRow("Coverage", coverage),
    );
    if (trace.roundsExhausted === true) read.append(el("p", "cx-step-note", "Round budget spent; files not read are not checked."));
    steps.append(read);
  }

  drawer.append(head, steps);
  return drawer;
}

/* ---- messages ------------------------------------------------------------ */

function actionButton(label, icon, onClick, className = "") {
  const node = button(`cx-act ${className}`.trim(), null, onClick, icon);
  node.title = label;
  node.setAttribute("aria-label", label);
  return node;
}

function copyButton(text) {
  const node = actionButton("Copy", "copy", async () => {
    try {
      await navigator.clipboard.writeText(text);
      node.dataset.done = "Copied";
    } catch {
      node.dataset.done = "Copy blocked";
    }
    setTimeout(() => delete node.dataset.done, 1_500);
  });
  return node;
}

function youNode(turn, isNew) {
  const wrap = el("div", `cx-msg cx-you${isNew ? " is-new" : ""}`);
  wrap.dataset.turn = turn.id;
  wrap.append(el("div", "cx-you-bubble", turn.prompt));
  const foot = el("div", "cx-you-foot");
  const tag = ROUTES[turn.route]?.tag;
  if (tag) foot.append(el("span", "cx-badge", tag));
  foot.append(
    copyButton(turn.prompt),
    actionButton("Edit in box", "edit", () => editPrompt(turn)),
  );
  wrap.append(foot);
  return wrap;
}

function rockyShell(isNew, listening) {
  const node = el("article", `cx-msg cx-rocky${isNew ? " is-new" : ""}`);
  const col = el("div", "cx-rocky-col");
  node.append(ear(listening), col);
  return { node, col };
}

function rockyNode(turn, isNew, isLast) {
  const body = turn.body ?? {};
  const { node, col } = rockyShell(isNew, false);
  node.dataset.turn = turn.id;
  if (isHeld(body)) node.classList.add("is-held");

  const head = el("div", "cx-rocky-head");
  head.append(el("span", "cx-name", "Rocky"), ...badges(body));
  col.append(head, decisionDrawer(turn));

  const text = str(body.text) || "rocky heard nothing matching that yet.";
  col.append(markdownNode(text, "cx-answer"));
  if (str(body.coverage?.reason)) col.append(el("p", "cx-aside", `Coverage: ${body.coverage.reason}`));

  // Code support: a labelled second answer after the memory one, never replacing it.
  const codeText = str(body.codeAnswer?.text);
  if (codeText) {
    const code = el("section", "cx-code-answer");
    const label = el("p", "cx-code-label");
    label.append(svgIcon("code", 13), el("span", null, "From the code"));
    code.append(label, markdownNode(codeText, "cx-answer"));
    col.append(code);
  }
  const disclosure = codeDisclosure(body);
  if (disclosure) col.append(el("p", "cx-aside", disclosure));

  const actions = el("div", "cx-actions");
  const sourceCount = arr(body.evidenceCards).length + arr(body.codeEvidence).length;
  const sources = button("cx-sources-btn", `Sources ${sourceCount}`, () => openSources(turn), "book");
  sources.setAttribute("aria-controls", "cx-sources");
  sources.setAttribute("aria-expanded", String(chatState.sourcesFor === turn.id));
  sources.dataset.turn = turn.id;
  actions.append(copyButton([text, codeText].filter(Boolean).join("\n\n")), sources);
  if (isLast) actions.append(actionButton("Ask again", "retry", () => retry(turn), "cx-retry"));
  const trace = body.decisionTrace ?? {};
  const meta = el("span", "cx-meta");
  // the model is named only when it actually wrote part of this answer
  const model = str(trace.llm?.model);
  if (model && (trace.llm?.active === true || codeText)) meta.append(el("span", null, model));
  const rawLatency = trace.latencyMs ?? trace.latency;
  const latency = Number(rawLatency);
  if (rawLatency !== undefined && rawLatency !== null && Number.isFinite(latency)) meta.append(el("span", null, latency < 1_000 ? `${latency}ms` : `${(latency / 1_000).toFixed(1)}s`));
  actions.append(meta);
  col.append(actions);
  return node;
}

function failNode(turn, isNew, isLast) {
  const { node, col } = rockyShell(isNew, false);
  node.dataset.turn = turn.id;
  node.classList.add("is-failed");
  const text = turn.error === "stopped"
    ? "Stopped. Rocky kept no answer for this question."
    : turn.error === "failed"
      ? "Rocky not hear answer. Check rocky dash still runs, then ask again."
      : "No answer kept. Tab closed before Rocky replied.";
  col.append(el("p", "cx-fail-text", text));
  if (isLast) col.append(button("cx-pill", "Ask again", () => retry(turn), "retry"));
  return node;
}

function waitingNode(turn) {
  const { node, col } = rockyShell(true, true);
  node.id = "cx-waiting";
  node.setAttribute("role", "status");
  node.setAttribute("aria-label", "rocky listening");
  const label = turn.route === "code" ? "Rocky search memory, read code, check evidence" : "Rocky search memory, check relevance";
  col.append(el("p", "cx-wait-text", label));
  return node;
}

function turnNodes(turn, isNew, isLast) {
  const nodes = [youNode(turn, isNew)];
  if (chatState.pending?.turnId === turn.id) nodes.push(waitingNode(turn));
  else if (turn.body) nodes.push(rockyNode(turn, isNew, isLast));
  else nodes.push(failNode(turn, isNew, isLast));
  return nodes;
}

/* ---- thread -------------------------------------------------------------- */

const cx = () => $("#cx");

function setEmpty(isEmpty) {
  const shell = cx();
  if (shell) shell.dataset.empty = String(isEmpty);
}

function scrollToLatest(smooth) {
  const log = $("#chat-log");
  if (!log) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  log.scrollTo({ top: log.scrollHeight, behavior: smooth && !reduce ? "smooth" : "auto" });
}

function renderThread() {
  const chat = activeChat();
  const turns = chat ? chat.turns : [];
  setEmpty(turns.length === 0);
  const title = $("#cx-title");
  if (title) title.textContent = chat ? chat.title : "New chat";
  fill($("#chat-thread"), ...turns.flatMap((turn, index) => turnNodes(turn, false, index === turns.length - 1)));
  // an empty chat reads from the top, where Rocky's face is
  if (turns.length > 0) scrollToLatest(false);
  else $("#chat-log")?.scrollTo({ top: 0 });
}

function editPrompt(turn) {
  const input = $("#chat-input");
  if (!input) return;
  input.value = turn.prompt;
  setRoute(turn.route in ROUTES ? turn.route : "auto");
  syncComposer();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/* ---- send ---------------------------------------------------------------- */

/** A typed `code:` / `memory:` prefix wins over the picker, and is shown as a tag. */
function splitRoute(text, route) {
  const typed = /^\s*(code|memory):\s*/i.exec(text);
  if (typed) return { route: typed[1].toLowerCase(), prompt: text.slice(typed[0].length).trim() };
  return { route, prompt: text.trim() };
}

async function send(rawText, routeOverride) {
  if (chatState.pending) return;
  const { route, prompt } = splitRoute(rawText, routeOverride ?? chatState.route);
  if (!prompt) return;

  const now = Date.now();
  const turn = { id: newId(), prompt: prompt.slice(0, MAX_PROMPT), route, at: now };
  let chat = activeChat();
  if (!chat) {
    chat = { id: newId(), title: titleFrom(prompt), created: now, updated: now, turns: [] };
    chats = [chat, ...chats];
    activeId = chat.id;
  }
  const chatId = chat.id;
  patchChat(chatId, (current) => ({ turns: [...current.turns, turn], updated: now }));

  const controller = new AbortController();
  chatState.pending = { chatId, turnId: turn.id };
  chatState.abort = controller;
  saveChats();
  renderSessions();

  // Append, never re-render: earlier answers keep their open drawers and scroll.
  const thread = $("#chat-thread");
  thread?.querySelectorAll(".cx-retry, .is-failed .cx-pill").forEach((node) => node.remove());
  setEmpty(false);
  const title = $("#cx-title");
  if (title) title.textContent = activeChat()?.title ?? "New chat";
  thread?.append(...turnNodes(turn, true, true));
  clearComposer();
  setBusy(true);
  scrollToLatest(true);

  let patch;
  try {
    patch = { body: await chatApi(ROUTES[route].prefix + turn.prompt, controller.signal) };
  } catch {
    patch = { error: controller.signal.aborted ? "stopped" : "failed" };
  }
  chatState.pending = null;
  chatState.abort = null;
  patchTurn(chatId, turn.id, patch);
  saveChats();
  setBusy(false);
  renderSessions();

  if (activeId !== chatId) return;
  const done = activeChat()?.turns.find((t) => t.id === turn.id);
  const waiting = $("#cx-waiting");
  if (!done) return;
  const answer = done.body ? rockyNode(done, true, true) : failNode(done, true, true);
  if (waiting) waiting.replaceWith(answer);
  else renderThread();
  scrollToLatest(true);
}

function retry(turn) {
  const chat = activeChat();
  if (!chat || chatState.pending) return;
  patchChat(chat.id, (current) => ({ turns: current.turns.filter((t) => t.id !== turn.id) }));
  saveChats();
  renderThread();
  void send(turn.prompt, turn.route);
}

/* ---- composer ------------------------------------------------------------ */

function setBusy(busy) {
  const form = $("#chat-form");
  const sendButton = $("#chat-send");
  const log = $("#chat-log");
  form?.classList.toggle("is-busy", busy);
  log?.setAttribute("aria-busy", String(busy));
  if (sendButton) sendButton.setAttribute("aria-label", busy ? "stop" : "send");
  syncComposer();
}

function syncComposer() {
  const input = $("#chat-input");
  const sendButton = $("#chat-send");
  if (!input) return;
  const maxHeight = 200;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";

  const length = input.value.length;
  const count = $("#cx-count");
  if (count) {
    count.hidden = length < COUNT_FROM;
    count.textContent = `${length} / ${MAX_PROMPT}`;
    count.classList.toggle("is-full", length >= MAX_PROMPT);
  }
  if (sendButton) sendButton.disabled = chatState.pending === null && input.value.trim().length === 0;
}

function clearComposer() {
  const input = $("#chat-input");
  if (!input) return;
  input.value = "";
  syncComposer();
  input.focus();
}

const routeButtons = () => [...document.querySelectorAll("#cx-route [data-route]")];

function setRoute(route) {
  chatState.route = route in ROUTES ? route : "auto";
  for (const option of routeButtons()) {
    const on = option.dataset.route === chatState.route;
    option.setAttribute("aria-checked", String(on));
    option.tabIndex = on ? 0 : -1;
  }
  const note = $("#cx-route-note");
  if (note) note.textContent = ROUTES[chatState.route].note;
}

function bindRoutes() {
  const options = routeButtons();
  for (const option of options) {
    option.addEventListener("click", () => setRoute(option.dataset.route));
    option.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = options[(options.indexOf(option) + step + options.length) % options.length];
      setRoute(next.dataset.route);
      next.focus();
    });
  }
  setRoute(chatState.route);
}

/* ---- jev ----------------------------------------------------------------- */

function paintJev() {
  const toggle = $("#chat-jev");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(chatState.jev));
  toggle.classList.toggle("is-on", chatState.jev);
  toggle.classList.toggle("is-unarmed", chatState.jev && !chatState.armed);
}

async function refreshJevArmed() {
  const toggle = $("#chat-jev");
  const state = await jevKeyState();
  // Unified mode reads the shared main credential; otherwise the active
  // Jev-provider booleans apply.
  chatState.armed = state.unified ? state.hasKey : (state.provider === "openrouter" ? state.hasOpenRouterKey : state.hasJevKey);
  const path = state.unified ? "OpenRouter, shared key" : (state.provider === "openrouter" ? "OpenRouter" : "Native TypeSafe");
  if (toggle) {
    toggle.title = chatState.armed
      ? `Jev second opinion on code questions (${path})`
      : "Jev needs a key. Save one in Settings first";
  }
  paintJev();
}

function bindJev() {
  const toggle = $("#chat-jev");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    chatState.jev = !chatState.jev;
    paintJev();
  });
  paintJev();
  void refreshJevArmed().catch(() => {});
}

/* ---- model picker -------------------------------------------------------- */

/** The model box only ever offers models the server says it serves. */
async function paintChatModels() {
  const select = $("#chat-model");
  if (!select) return;
  const rows = [];
  for (const model of await chatModels()) {
    const id = String(model?.id ?? model ?? "");
    if (id.length > 0) rows.push({ id, label: String(model?.label ?? id) });
  }
  if (rows.length === 0) rows.push({ id: "", label: "rocky local" });
  const kept = rows.some((row) => row.id === chatState.model) ? chatState.model : rows[0].id;
  fill(select, ...rows.map((row) => Object.assign(el("option", null, row.label), { value: row.id })));
  select.value = kept;
  chatState.model = kept;
  if (!select.dataset.rockyBound) {
    select.dataset.rockyBound = "1";
    select.addEventListener("change", () => setChatModel(select.value));
  }
  paintModelPanel(rows, kept);
}

function setChatModel(id) {
  chatState.model = id;
  const select = $("#chat-model");
  if (select && select.value !== id) select.value = id;
  syncModelPanel(id);
}

/** Custom listbox over the verbatim catalog. Missing markup means the native box stays. */
function paintModelPanel(rows, current) {
  const wrap = $("#chat-modelwrap");
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!wrap || !btn || !panel) return;
  wrap.classList.add("custom");
  fill(panel, ...rows.map((row) => {
    const opt = el("button", "cx-modelopt");
    opt.type = "button";
    opt.setAttribute("role", "option");
    opt.dataset.id = row.id;
    const check = el("span", "cx-check");
    check.append(svgIcon("check", 12));
    opt.append(el("span", "cx-modelname", row.label), check);
    opt.addEventListener("click", () => {
      setChatModel(row.id);
      closeModelPanel(true);
    });
    return opt;
  }));
  syncModelPanel(current);
  if (btn.dataset.rockyBound) return;
  btn.dataset.rockyBound = "1";
  btn.addEventListener("click", () => (panel.hidden ? openModelPanel() : closeModelPanel(false)));
  btn.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openModelPanel();
    }
  });
  panel.addEventListener("keydown", (event) => {
    const items = [...panel.querySelectorAll(".cx-modelopt")];
    const at = items.indexOf(document.activeElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // Esc shuts the list, not the sources panel too
      closeModelPanel(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (items[at + 1] ?? items[0])?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      (items[at - 1] ?? items[items.length - 1])?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!panel.hidden && !wrap.contains(event.target)) closeModelPanel(false);
  });
}

function syncModelPanel(current) {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  let label = "rocky local";
  for (const opt of panel.querySelectorAll(".cx-modelopt")) {
    const on = opt.dataset.id === current;
    opt.setAttribute("aria-selected", String(on));
    if (on) label = opt.querySelector(".cx-modelname")?.textContent ?? label;
  }
  btn.textContent = label;
  btn.title = `Model for code answers: ${label}`;
}

function openModelPanel() {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  panel.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  (panel.querySelector('.cx-modelopt[aria-selected="true"]') ?? panel.querySelector(".cx-modelopt"))?.focus();
}

function closeModelPanel(refocus) {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  panel.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  if (refocus) btn.focus();
}

/* ---- sources ------------------------------------------------------------- */

function sourceSection(title, count, children) {
  const section = el("section", "cx-src-group");
  const head = el("h3", "cx-src-title");
  head.append(el("span", null, title), el("span", "cx-src-count", String(count)));
  section.append(head, ...children);
  return section;
}

const textOf = (value) => (typeof value === "string" ? value
  : value !== null && typeof value === "object" && typeof value.text === "string" ? value.text : "");

/** The fields a reader asks about first, pulled out of a whole memory record. */
const RECORD_FIELDS = [
  ["Command", (r) => textOf(r.cmd)],
  ["Error", (r) => arr(r.signature).filter((line) => typeof line === "string" && line.trim()).slice(0, 3).join("\n")],
  ["File", (r) => textOf(r.path)],
  ["Intent", (r) => textOf(r.intent)],
  ["Reason", (r) => textOf(r.rationale) || textOf(r.excerpt)],
  ["Code shape", (r) => textOf(r.code)],
  ["Concern", (r) => textOf(r.business)],
  ["Files", (r) => arr(r.mechanism?.files).map((file) => file?.path).filter(Boolean).slice(0, 4).join(", ")],
];

function ago(ts) {
  const span = Date.now() - ts;
  if (!Number.isFinite(span) || span < 0) return "";
  const units = [["day", DAY_MS], ["hour", 3_600_000], ["minute", 60_000]];
  for (const [name, size] of units) {
    const n = Math.floor(span / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function parseRecord(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Long text folds to a few lines; the reader opens it when they want it. */
function foldText(text) {
  const p = el("p", "cx-src-text", text);
  if (text.length <= 280) return [p];
  p.classList.add("is-folded");
  const more = button("cx-link", "Show all", () => {
    const folded = p.classList.toggle("is-folded");
    more.querySelector("span").textContent = folded ? "Show all" : "Show less";
  });
  return [p, more];
}

/** Evidence cards are read-only display: refs quoted, never invented. */
function memoryCard(card) {
  const box = el("article", "cx-src");
  if (card === null || typeof card !== "object") {
    box.append(...foldText(String(card)));
    return box;
  }
  const top = el("p", "cx-src-top");
  const kind = el("span", "cx-kind", String(card.kind ?? "evidence"));
  if (WHY.has(String(card.kind))) kind.classList.add("is-why");
  top.append(kind, el("span", "cx-src-ref", String(card.ref ?? card.label ?? card.title ?? "record")));
  box.append(top);
  const text = String(card.snippet ?? card.detail ?? card.excerpt ?? "");
  const record = parseRecord(text);
  if (!record) {
    if (text) box.append(...foldText(text));
    return box;
  }

  const meta = [str(record.agent), typeof record.ts === "number" ? ago(record.ts) : "", baseName(str(record.cwd))]
    .filter(Boolean);
  if (typeof record.exitCode === "number") meta.push(`exit ${record.exitCode}`);
  if (meta.length > 0) {
    const line = el("p", "cx-src-meta");
    line.append(...meta.map((bit) => el("span", null, bit)));
    box.append(line);
  }
  const fields = el("dl", "cx-src-fields");
  for (const [label, pick] of RECORD_FIELDS) {
    const value = pick(record).trim();
    if (!value) continue;
    const dd = el("dd", label === "Command" || label === "Error" || label === "File" || label === "Files" ? "is-mono" : null, clip(value, 600));
    fields.append(el("dt", null, label), dd);
  }
  if (fields.childElementCount > 0) box.append(fields);
  const raw = el("details", "cx-raw");
  raw.append(el("summary", null, "Whole record"), el("pre", "cx-pre", JSON.stringify(record, null, 2)));
  box.append(raw);
  return box;
}

/** Code excerpts are quotes: `path:start-end` and the server's own lines. */
function codeCard(excerpt) {
  const box = el("article", "cx-src");
  if (excerpt === null || typeof excerpt !== "object") {
    box.append(el("p", "cx-src-text", String(excerpt)));
    return box;
  }
  const path = String(excerpt.path ?? excerpt.ref ?? "unknown");
  const start = excerpt.startLine;
  const end = excerpt.endLine;
  const label = start !== undefined && start !== null ? `${path}:${start}${end !== undefined && end !== null ? `-${end}` : ""}` : path;
  const top = el("p", "cx-src-top");
  top.append(el("span", "cx-kind", "code"), el("span", "cx-src-ref", label));
  box.append(top);
  const lines = arr(excerpt.lines).map((line) => {
    if (line === null || line === undefined) return "";
    if (typeof line === "object") return String(line.text ?? line.line ?? "");
    return String(line);
  });
  if (lines.length > 0) box.append(el("pre", "cx-pre", lines.join("\n")));
  return box;
}

function openSources(turn) {
  const panel = $("#cx-sources");
  const shell = cx();
  if (!panel || !shell || !turn.body) return;
  const body = turn.body;
  const cards = arr(body.evidenceCards);
  const code = arr(body.codeEvidence);
  const nodes = [
    sourceSection("Memory records", cards.length, cards.length === 0
      ? [el("p", "cx-src-empty", "No memory record cited for this answer.")]
      : cards.map(memoryCard)),
  ];
  if (codeRan(body)) {
    nodes.push(sourceSection("Code excerpts", code.length, code.length === 0
      ? [el("p", "cx-src-empty", "No code excerpt quoted.")]
      : code.map(codeCard)));
  }
  const disclosure = codeDisclosure(body);
  if (disclosure) nodes.push(el("p", "cx-aside", disclosure));
  nodes.push(sourceSection("Decision trace", "", [traceLine(body.decisionTrace)]));

  const forLine = $("#cx-sources-for");
  if (forLine) forLine.textContent = clip(turn.prompt, 140);
  fill($("#cx-sources-body"), ...nodes);
  chatState.sourcesFor = turn.id;
  panel.hidden = false;
  shell.dataset.sources = "open";
  for (const btn of document.querySelectorAll(".cx-sources-btn")) {
    btn.setAttribute("aria-expanded", String(btn.dataset.turn === turn.id));
  }
  $("#cx-sources-close")?.focus({ preventScroll: true });
}

function closeSources() {
  const panel = $("#cx-sources");
  const shell = cx();
  if (!panel || !shell) return;
  const was = chatState.sourcesFor;
  chatState.sourcesFor = null;
  panel.hidden = true;
  shell.dataset.sources = "closed";
  for (const btn of document.querySelectorAll(".cx-sources-btn")) btn.setAttribute("aria-expanded", "false");
  if (was) document.querySelector(`.cx-sources-btn[data-turn="${CSS.escape(was)}"]`)?.focus({ preventScroll: true });
}

/* ---- chat list ----------------------------------------------------------- */

function dayGroup(ts, now) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (ts >= start) return "Today";
  if (ts >= start - DAY_MS) return "Yesterday";
  if (ts >= start - 6 * DAY_MS) return "Previous 7 days";
  if (ts >= start - 29 * DAY_MS) return "Previous 30 days";
  return "Older";
}

function matches(chat, needle) {
  if (!needle) return true;
  return chat.title.toLowerCase().includes(needle)
    || chat.turns.some((turn) => String(turn.prompt).toLowerCase().includes(needle));
}

function renameField(chat) {
  const input = el("input", "cx-rename");
  input.value = chat.title;
  input.setAttribute("aria-label", "chat name");
  let done = false;
  const commit = (keep) => {
    if (done) return;
    done = true;
    chatState.renaming = null;
    const title = input.value.trim();
    if (keep && title && title !== chat.title) {
      patchChat(chat.id, () => ({ title: clip(title, 80) }));
      saveChats();
      if (activeId === chat.id) {
        const head = $("#cx-title");
        if (head) head.textContent = activeChat()?.title ?? "New chat";
      }
    }
    renderSessions();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") commit(true);
    else if (event.key === "Escape") {
      event.stopPropagation();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
  return input;
}

function sessionItem(chat) {
  const li = el("li", "cx-item");
  if (chat.id === activeId) li.classList.add("is-active");
  if (chatState.renaming === chat.id) {
    li.append(renameField(chat));
    return li;
  }
  const open = button("cx-item-open", chat.title, () => openChat(chat.id));
  open.title = chat.title;
  if (chat.id === activeId) open.setAttribute("aria-current", "page");
  if (chatState.pending?.chatId === chat.id) open.prepend(ear(true));
  li.append(open);

  const tools = el("span", "cx-item-tools");
  if (chatState.confirmDelete === chat.id) {
    const confirm = button("cx-item-confirm", "Delete", () => deleteChat(chat.id));
    tools.append(confirm);
    li.classList.add("is-confirming");
    queueMicrotask(() => confirm.focus());
  } else {
    tools.append(
      actionButton("Rename", "edit", () => {
        chatState.renaming = chat.id;
        renderSessions();
      }),
      actionButton("Delete chat", "trash", () => {
        chatState.confirmDelete = chat.id;
        renderSessions();
        setTimeout(() => {
          if (chatState.confirmDelete !== chat.id) return;
          chatState.confirmDelete = null;
          renderSessions();
        }, CONFIRM_MS);
      }),
    );
  }
  li.append(tools);
  return li;
}

function renderSessions() {
  const host = $("#cx-sessions");
  if (!host) return;
  const needle = ($("#cx-search")?.value ?? "").trim().toLowerCase();
  const shown = chats.filter((chat) => matches(chat, needle));
  const nodes = [];
  if (chats.length === 0) {
    nodes.push(el("p", "cx-sessions-empty", "No chats yet. Your questions and Rocky's answers land here."));
  } else if (shown.length === 0) {
    nodes.push(el("p", "cx-sessions-empty", "No chat matches that search."));
  } else {
    const now = Date.now();
    const groups = new Map();
    for (const chat of shown) {
      const name = dayGroup(chat.updated, now);
      groups.set(name, [...(groups.get(name) ?? []), chat]);
    }
    for (const [name, list] of groups) {
      const group = el("section", "cx-group");
      const items = el("ul", "cx-items");
      items.append(...list.map(sessionItem));
      group.append(el("h3", "cx-group-title", name), items);
      nodes.push(group);
    }
  }
  if (storeNote) nodes.push(el("p", "cx-store-note", storeNote));
  fill(host, ...nodes);
}

function openChat(id) {
  activeId = id;
  chatState.confirmDelete = null;
  closeSources();
  renderThread();
  renderSessions();
  if (isNarrow()) setSide(false, false);
}

function newChat() {
  activeId = null;
  closeSources();
  renderThread();
  renderSessions();
  if (isNarrow()) setSide(false, false);
  $("#chat-input")?.focus();
}

function deleteChat(id) {
  if (chatState.pending?.chatId === id) chatState.abort?.abort();
  chats = chats.filter((chat) => chat.id !== id);
  chatState.confirmDelete = null;
  saveChats();
  if (activeId === id) newChat();
  else renderSessions();
}

/* ---- side ---------------------------------------------------------------- */

const isNarrow = () => window.matchMedia?.(NARROW)?.matches === true;

function setSide(open, remember) {
  const shell = cx();
  if (!shell) return;
  shell.dataset.side = open ? "open" : "closed";
  $("#cx-side-close")?.setAttribute("aria-expanded", String(open));
  $("#cx-side-open")?.setAttribute("aria-expanded", String(open));
  if (remember) {
    try {
      localStorage.setItem(SIDE_KEY, open ? "open" : "closed");
    } catch {
      // a remembered sidebar is a convenience only
    }
  }
}

function initialSide() {
  if (isNarrow()) return false;
  try {
    return localStorage.getItem(SIDE_KEY) !== "closed";
  } catch {
    return true;
  }
}

/* ---- home: memory card and suggestions ----------------------------------- */

function statCell(value, label, isWhy) {
  const cell = el("div", "cx-stat");
  const number = el("b", isWhy && value > 0 ? "is-why" : null, String(value));
  cell.append(number, el("span", null, label));
  return cell;
}

function paintMemory(detail) {
  const mem = $("#cx-mem");
  const sub = $("#cx-sub");
  if (!mem) return;
  if (!detail || detail.error || !detail.data) {
    const again = button("cx-link", "Listen again", () => {
      fill(mem, el("p", "cx-mem-wait", "listening…"));
      void detail?.retry?.();
    });
    fill(mem, el("p", "cx-mem-fail", `Rocky not hear memory (${detail?.error ?? "offline"}).`), again);
    return;
  }
  const data = detail.data;
  const total = typeof data.total === "number" ? data.total : null;
  const day = data.day ?? {};
  const num = (value) => Number(value ?? 0) || 0;

  const nodes = [];
  if (total !== null) {
    const line = el("p", "cx-mem-total");
    line.append(el("b", null, total.toLocaleString()), el("span", null, " records remembered"));
    nodes.push(line);
  }
  const stats = el("div", "cx-stats");
  stats.setAttribute("aria-label", "last 24 hours");
  stats.append(
    statCell(num(day.heard), "heard 24h"),
    statCell(num(day.failures), "failures"),
    statCell(num(day.fixes), "fixes"),
    statCell(num(day.whys), "reasons", true),
  );
  nodes.push(stats);

  // the kinds drawn as hairlines, each as long as its share of the biggest
  const kinds = arr(data.byKind).slice(0, 4);
  const top = Math.max(1, ...kinds.map((entry) => num(entry?.count)));
  if (kinds.length > 0) {
    const list = el("ul", "cx-kinds");
    for (const entry of kinds) {
      const li = el("li");
      if (WHY.has(String(entry?.kind))) li.classList.add("is-why");
      li.style.setProperty("--share", String(num(entry?.count) / top));
      li.append(el("span", null, String(entry?.kind ?? "unknown")), el("b", null, String(num(entry?.count))));
      list.append(li);
    }
    nodes.push(list);
  }
  const newest = arr(data.recent)[0];
  if (newest) {
    const last = el("p", "cx-mem-last");
    last.append(el("span", "cx-mem-key", "Last heard"), Object.assign(el("span", "cx-mem-label", String(newest.label ?? "")), { title: String(newest.label ?? "") }), el("span", "cx-mem-ago", String(newest.agoText ?? "")));
    nodes.push(last);
  }
  if (data.coverageLine && !/coverage full/i.test(String(data.coverageLine))) {
    nodes.push(el("p", "cx-mem-cov", String(data.coverageLine)));
  }
  fill(mem, ...nodes);

  if (sub && total !== null) {
    sub.textContent = newest
      ? `Rocky remember ${total.toLocaleString()} records. Last heard ${newest.agoText}. Ask, question.`
      : `Rocky remember ${total.toLocaleString()} records. Ask, question.`;
  }
}

const FALLBACK_SUGGESTIONS = [
  { route: "memory", text: "Which commands failed most this week?", hint: "Searches failure records" },
  { route: "memory", text: "What fixed the last build failure?", hint: "Failure to fix links" },
  { route: "memory", text: "Why did the agent make the last change?", hint: "Reasons agents recorded" },
  { route: "code", text: "Where is the chat route handled?", hint: "Reads repo files" },
];

/** Suggestions come from what Rocky actually heard, then fall back to plain ones. */
function suggestionsFrom(data) {
  const out = [];
  const recent = arr(data?.recent);
  const failure = recent.find((hit) => hit?.kind === "failure" && str(hit.label));
  if (failure) out.push({ route: "memory", text: `What fixed ${clip(failure.label, 48)}?`, hint: `Last failure, ${failure.agoText}` });
  const reason = recent.find((hit) => hit?.kind === "rationale" && str(hit.label) && hit.label !== hit.kind)
    ?? recent.find((hit) => WHY.has(hit?.kind) && str(hit.label) && hit.label !== hit.kind);
  if (reason) out.push({ route: "memory", text: `Why: ${clip(reason.label, 56)}`, hint: `Reason recorded ${reason.agoText}` });
  const file = arr(data?.topFiles)[0]?.name;
  if (file) out.push({ route: "code", text: `Why does ${baseName(file)} look the way it does?`, hint: "Most heard file, reads code" });
  for (const fallback of FALLBACK_SUGGESTIONS) {
    if (out.length >= 4) break;
    if (!out.some((item) => item.route === fallback.route && item.text === fallback.text)) out.push(fallback);
  }
  return out.slice(0, 4);
}

function paintSuggestions(data) {
  const host = $("#cx-suggest");
  if (!host) return;
  fill(host, ...suggestionsFrom(data).map((item) => {
    const card = el("button", "cx-sug");
    card.type = "button";
    const route = el("span", "cx-sug-route");
    route.append(svgIcon(item.route === "code" ? "code" : "memory", 13), el("span", null, item.route === "code" ? "Code" : "Memory"));
    card.append(route, el("span", "cx-sug-text", item.text), el("span", "cx-sug-hint", item.hint));
    // fills the box instead of sending: a code question leaves this machine,
    // so the user presses send knowing that
    card.addEventListener("click", () => {
      const input = $("#chat-input");
      if (!input) return;
      input.value = item.text;
      setRoute(item.route);
      syncComposer();
      input.focus();
    });
    return card;
  }));
}

function onHome(detail) {
  paintMemory(detail);
  paintSuggestions(detail?.data ?? null);
}

/* ---- boot ---------------------------------------------------------------- */

function bindJump() {
  const log = $("#chat-log");
  const main = document.querySelector(".cx-main");
  if (!log || !main) return;
  const jump = button("cx-jump", null, () => scrollToLatest(true), "down");
  jump.setAttribute("aria-label", "jump to latest");
  jump.hidden = true;
  main.append(jump);
  log.addEventListener("scroll", () => {
    jump.hidden = log.scrollHeight - log.scrollTop - log.clientHeight < JUMP_GAP;
  }, { passive: true });
}

function bindKeys() {
  document.addEventListener("keydown", (event) => {
    const mainShown = $("#view-main")?.hidden === false;
    if (!mainShown) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      newChat();
      return;
    }
    if (event.key !== "Escape") return;
    if (isNarrow() && cx()?.dataset.side === "open") setSide(false, false);
    else if (chatState.sourcesFor) closeSources();
  });
}

function boot() {
  const form = $("#chat-form");
  const input = $("#chat-input");
  if (!form || !input || !$("#chat-thread")) return;

  setSide(initialSide(), false);
  bindRoutes();
  bindJev();
  bindJump();
  bindKeys();
  void paintChatModels().catch(() => {});

  $("#cx-new")?.addEventListener("click", newChat);
  $("#cx-new-mini")?.addEventListener("click", newChat);
  $("#cx-side-close")?.addEventListener("click", () => setSide(false, !isNarrow()));
  $("#cx-side-open")?.addEventListener("click", () => setSide(true, !isNarrow()));
  $("#cx-sources-close")?.addEventListener("click", closeSources);
  $("#cx-search")?.addEventListener("input", renderSessions);
  // on a narrow screen the chat list floats over the thread; a tap outside shuts it
  document.querySelector(".cx-main")?.addEventListener("click", (event) => {
    if (isNarrow() && cx()?.dataset.side === "open" && !event.target.closest("#cx-side-open")) setSide(false, false);
  });

  input.addEventListener("input", syncComposer);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!chatState.pending) form.requestSubmit();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (chatState.pending) {
      chatState.abort?.abort();
      return;
    }
    void send(input.value).catch(() => {});
  });

  window.addEventListener("rocky:home", (event) => onHome(event.detail));
  window.addEventListener("rocky:settings-saved", () => {
    void paintChatModels().catch(() => {});
    void refreshJevArmed().catch(() => {});
  });
  // another tab saved chats: take its list, keep this tab's open chat if it survived
  window.addEventListener("storage", (event) => {
    if (event.key !== STORE_KEY || chatState.pending) return;
    chats = readChats();
    if (activeId && !activeChat()) activeId = null;
    renderSessions();
    renderThread();
  });

  if (window.rockyHome) onHome(window.rockyHome);
  else paintSuggestions(null);
  renderSessions();
  renderThread();
  syncComposer();

  // ?v=chat stays a valid explicit flag: it only brings focus to the box.
  const all = new URLSearchParams(location.search).getAll("v");
  if (all.length === 1 && all[0] === "chat") input.focus();
}

try {
  boot();
} catch {
  // chat enhancements must never break the rest of the page
}
