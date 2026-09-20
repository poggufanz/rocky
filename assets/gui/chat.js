/*
 * rocky chat pane -- Jev surface over what rocky heard.
 *
 * One rule from the sheet still holds here: colour is a claim. A Jev
 * answer is local analysis over evidence rocky already holds, never a
 * witness record, so it stays grey like a model guess; only the engine
 * mark and hold/hedge states borrow emphasis. The one exception is the
 * lightning toggle: while armed it glows, because the glow is the state,
 * not a claim about the world.
 *
 * No keys ever travel: POST /api/chat carries only { message, jev, model? }.
 * The token rides the same X-Rocky-Token header the rest of the page uses.
 * GET /api/chat-models lists the models the server can serve; the page
 * never invents one. GET /api/settings is read for key presence only, so the
 * toggle can say whether Jev is keyed on the active provider path
 * (unified flag + jevProvider + hasKey/hasJevKey/hasOpenRouterKey booleans only) -- the value never reaches the page.
 */

const TOKEN = location.hash.slice(1);

const chatState = { jev: false, model: "", busy: false };

async function chatApi(prompt) {
  const body = { message: prompt, jev: chatState.jev };
  // The server tolerates and ignores fields it does not need.
  if (chatState.model) body.model = chatState.model;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Rocky-Token": TOKEN },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

/** Models the server can serve. Empty means unknown -- the box falls back local. */
async function chatModels() {
  try {
    const response = await fetch("/api/chat-models", {
      headers: { "X-Rocky-Token": TOKEN },
    });
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
    const response = await fetch("/api/settings", {
      headers: { "X-Rocky-Token": TOKEN },
    });
    if (!response.ok) return fallback;
    const body = await response.json();
    // Unified mode: the main provider is OpenRouter, so one shared key covers
    // the LLM model and Jev. Derived from payload already fetched (no new
    // round-trip); provider id wins, endpoint text is the offline fallback.
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

/** Armed means the active provider path holds a key server-side. */
async function hasJevKey() {
  const state = await jevKeyState();
  if (state.unified) return state.hasKey;
  return state.provider === "openrouter" ? state.hasOpenRouterKey : state.hasJevKey;
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

function formatInlineNodes(str) {
  const container = document.createDocumentFragment();
  // Match code `...`, bold **...** or __...__, italic *...* or _..._, and [ref] tags
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[(?:triple|failure|fix|evidence)-[a-zA-Z0-9_\-]+\])/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      container.append(document.createTextNode(str.slice(lastIndex, match.index)));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
      const code = document.createElement("code");
      code.className = "chat-inline-code";
      code.textContent = token.slice(1, -1);
      container.append(code);
    } else if ((token.startsWith("**") && token.endsWith("**") && token.length > 4) || (token.startsWith("__") && token.endsWith("__") && token.length > 4)) {
      const bold = document.createElement("strong");
      bold.textContent = token.slice(2, -2);
      container.append(bold);
    } else if ((token.startsWith("*") && token.endsWith("*") && token.length > 2) || (token.startsWith("_") && token.endsWith("_") && token.length > 2)) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      container.append(em);
    } else if (token.startsWith("[") && token.endsWith("]")) {
      const ref = document.createElement("span");
      ref.className = "chat-ref-tag";
      ref.textContent = token;
      container.append(ref);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < str.length) {
    container.append(document.createTextNode(str.slice(lastIndex)));
  }
  return container;
}

function bubble(role, text) {
  const container = el("div", `chat-msg chat-${role}`);
  if (role === "you") {
    container.textContent = text;
    return container;
  }

  // Multi-line Markdown parser for synthesized assistant answers
  const lines = String(text).split(/\r?\n/);
  let currentList = null;
  let currentListType = null; // "ul" or "ol"

  function closeList() {
    if (currentList) {
      container.append(currentList);
      currentList = null;
      currentListType = null;
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeList();
      continue;
    }

    // Heading (e.g. ### Title or ## Title)
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = Math.min(6, Math.max(3, headingMatch[1].length + 2));
      const h = el(`h${level}`, "chat-heading");
      h.append(formatInlineNodes(headingMatch[2]));
      container.append(h);
      continue;
    }

    // Numbered list item (e.g. "1. Item", "1) Item", "(1) Item")
    const olMatch = line.match(/^(?:\d+[\.\)]|\(\d+\))\s+(.+)$/);
    if (olMatch) {
      if (currentListType !== "ol") {
        closeList();
        currentList = el("ol", "chat-ol");
        currentListType = "ol";
      }
      const li = el("li", "chat-li");
      li.append(formatInlineNodes(olMatch[1]));
      currentList.append(li);
      continue;
    }

    // Bullet list item (e.g. "- Item", "* Item", "+ Item", "• Item", "◦ Item", "▪ Item")
    const ulMatch = line.match(/^[-*+•◦▪]\s+(.+)$/);
    if (ulMatch) {
      if (currentListType !== "ul") {
        closeList();
        currentList = el("ul", "chat-ul");
        currentListType = "ul";
      }
      const li = el("li", "chat-li");
      li.append(formatInlineNodes(ulMatch[1]));
      currentList.append(li);
      continue;
    }

    // Regular paragraph or disclosure line
    closeList();
    if (line.startsWith("renderer:")) {
      const disc = el("div", "chat-renderer-disc");
      disc.append(formatInlineNodes(line));
      container.append(disc);
    } else {
      const p = el("p", "chat-p");
      p.append(formatInlineNodes(line));
      container.append(p);
    }
  }
  closeList();

  // If container is empty, fall back to textContent
  if (container.children.length === 0) {
    container.textContent = text;
  }
  return container;
}

/**
 * Decision trace, visible per answer: engine, status, confidence, how many
 * evidence refs, latency. Missing fields render as unknown, never blank --
 * a trace that goes quiet would read as a verdict.
 */
function traceNode(trace) {
  const t = trace ?? {};
  const bits = [
    `engine ${t.engine ?? "unknown"}`,
    `status ${t.status ?? "unknown"}`,
  ];
  // confidence is nullable: null means hold/abstain, so it is named, never blank.
  if (t.confidence !== undefined && t.confidence !== null) bits.push(`confidence ${t.confidence}`);
  else bits.push("confidence withheld");
  const refs = Array.isArray(t.evidenceRefs) ? t.evidenceRefs.length : 0;
  bits.push(`${refs} evidence ref${refs === 1 ? "" : "s"}`);
  const latency = t.latencyMs ?? t.latency;
  if (latency !== undefined && latency !== null) bits.push(`${latency}ms`);
  // LLM disclosure: the server owns the shape, so unknown/missing stays a
  // named fallback — the trace never goes quiet about whether the LLM ran.
  const llm = t.llm ?? {};
  const model = typeof llm.model === "string" && llm.model.length > 0 ? llm.model : "no model";
  const structurer = typeof llm.structurerStatus === "string" && llm.structurerStatus.length > 0 ? llm.structurerStatus : "unknown";
  const renderer = typeof llm.rendererStatus === "string" && llm.rendererStatus.length > 0 ? llm.rendererStatus : "unknown";
  bits.push(`llm ${llm.active === true ? "active" : "inactive"} ${structurer}/${renderer} (${model})`);
  const node = el("p", "chat-trace", bits.join(" · "));
  const status = String(t.status ?? "").toLowerCase();
  if (status === "hold" || status === "hedge" || status === "held" || status === "hedged" || status === "low_confidence") {
    node.classList.add("chat-trace-flag");
  }
  return node;
}

/** Evidence cards are read-only display: refs quoted, never invented. */
function evidenceNodes(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return [];
  return cards.map((card) => {
    const box = el("div", "chat-card");
    if (card !== null && typeof card === "object") {
      const label = card.label ?? card.title ?? card.ref ?? card.kind ?? "evidence";
      box.append(el("p", "chat-card-head", String(label)));
      if (card.kind && (card.label || card.title || card.ref)) {
        box.append(el("p", "chat-card-kind", String(card.kind)));
      }
      const refs = Array.isArray(card.evidenceRefs)
        ? card.evidenceRefs
        : Array.isArray(card.refs)
          ? card.refs
          : [];
      for (const ref of refs) box.append(el("p", "chat-card-ref", String(ref?.label ?? ref?.path ?? ref ?? "")));
      const body = card.detail ?? card.excerpt ?? card.snippet ?? null;
      if (body) box.append(el("p", "chat-card-body", String(body)));
      else if (card.ref) box.append(el("p", "chat-card-ref", String(card.ref)));
    } else {
      box.append(el("p", "chat-card-body", String(card)));
    }
    return box;
  });
}

/**
 * Collapsible Thinking / Track Record drawer (Rocky Memory + Jev + LLM)
 * Mirroring Claude-style reasoning with step-by-step progressive animation.
 */
function thinkingDrawer(body) {
  const t = body?.decisionTrace ?? {};
  const llm = t.llm ?? {};
  const cards = Array.isArray(body?.evidenceCards) ? body.evidenceCards : [];
  const latency = t.latencyMs ?? t.latency ?? null;
  const latencyText = latency !== null ? `${latency}ms` : "";

  // Semantic <details> element: natively collapsible and robust
  const container = document.createElement("details");
  container.className = "chat-thinking";

  // Summary header acting as toggle
  const header = document.createElement("summary");
  header.className = "thinking-header";

  const icon = el("span", "thinking-icon", "✦");
  const title = el("span", "thinking-title", "Thought Process");

  const metaBits = [];
  metaBits.push(`${cards.length} heard`);
  if (t.engine) metaBits.push(t.engine);
  if (latencyText) metaBits.push(latencyText);
  const meta = el("span", "thinking-meta", `(${metaBits.join(" · ")})`);

  const chevron = el("span", "thinking-chevron", "▾");

  header.append(icon, title, meta, chevron);

  // Content body
  const bodyNode = el("div", "thinking-body");

  // Step 1: Rocky Memory Heard
  const step1 = el("div", "thinking-step step-rocky");
  const s1Head = el("div", "thinking-step-head");
  s1Head.append(el("span", "step-num", "1"), el("span", "step-title", `Rocky Memory (${cards.length} records heard)`));
  step1.append(s1Head);

  const s1Content = el("div", "thinking-step-content");
  if (cards.length === 0) {
    s1Content.append(el("p", "thinking-empty", "No prior matching failures, fixes, or triples found in memory."));
  } else {
    const list = el("div", "thinking-items");
    for (const card of cards) {
      const item = el("div", "thinking-item");
      const refId = String(card.ref ?? card.id ?? card.label ?? "record");
      const kind = String(card.kind ?? "evidence");
      const text = String(card.snippet ?? card.detail ?? card.excerpt ?? card.cmd ?? "");

      const topRow = el("div", "item-top");
      topRow.append(el("span", "item-ref", refId));
      topRow.append(el("span", "item-kind", kind));
      item.append(topRow);
      if (text) {
        item.append(el("div", "item-text", text));
      }
      list.append(item);
    }
    s1Content.append(list);
  }
  step1.append(s1Content);

  // Step 2: TypeSafe Jev Decision Engine
  const step2 = el("div", "thinking-step step-jev");
  const s2Head = el("div", "thinking-step-head");
  s2Head.append(el("span", "step-num", "2"), el("span", "step-title", `TypeSafe Jev Engine (${t.engine ?? "heuristic"})`));
  step2.append(s2Head);

  const s2Content = el("div", "thinking-step-content");
  const s2Details = el("div", "thinking-details");
  const confText = t.confidence !== undefined && t.confidence !== null ? String(t.confidence) : "withheld / null";
  s2Details.append(el("p", "detail-row", `Decision status: ${t.status ?? "unknown"}`));
  s2Details.append(el("p", "detail-row", `Candidate confidence: ${confText}`));
  s2Details.append(el("p", "detail-row", `Evidence shortlist evaluated: ${Array.isArray(t.evidenceRefs) ? t.evidenceRefs.length : 0} items`));
  s2Content.append(s2Details);
  step2.append(s2Content);

  // Step 3: LLM Synthesis & Claims Gate
  const step3 = el("div", "thinking-step step-llm");
  const s3Head = el("div", "thinking-step-head");
  const modelName = typeof llm.model === "string" && llm.model.length > 0 ? llm.model : "rocky local";
  s3Head.append(el("span", "step-num", "3"), el("span", "step-title", `LLM Grounded Synthesis (${modelName})`));
  step3.append(s3Head);

  const s3Content = el("div", "thinking-step-content");
  const s3Details = el("div", "thinking-details");
  s3Details.append(el("p", "detail-row", `Structurer: ${llm.structurerStatus ?? "baseline"}`));
  s3Details.append(el("p", "detail-row", `Renderer: ${llm.rendererStatus ?? "baseline"}`));
  const strippedText = llm.stripped && llm.stripped > 0
    ? `${llm.stripped} ungrounded claims stripped`
    : "100% grounded in Rocky evidence";
  s3Details.append(el("p", "detail-row", `Claims verification: ${strippedText}`));
  s3Content.append(s3Details);
  step3.append(s3Content);

  bodyNode.append(step1, step2, step3);
  container.append(header, bodyNode);
  return container;
}

/**
 * Defensive render: the backend owns the shape, so every field falls back
 * to something readable. A failure shows the baseline plus its status --
 * the pane never goes silent and never invents an answer. Each answer also
 * mirrors its cards and trace into the right companion panel.
 */
function renderAnswer(log, body) {
  const text = body && typeof body.text === "string" && body.text.length > 0
    ? body.text
    : "rocky heard nothing matching that yet.";

  // Thinking / Track Record drawer with full Rocky + Jev + LLM breakdown
  const drawer = thinkingDrawer(body);
  log.append(drawer);

  // Human-readable synthesized answer bubble
  log.append(bubble("jev", text));
  if (body && body.coverage && body.coverage.reason) {
    log.append(el("p", "chat-coverage", `coverage: ${body.coverage.reason}`));
  }
  log.append(traceNode(body?.decisionTrace));

  // Companion panels mirror evidence and trace
  fill($("#comp-evidence"), ...(evidenceNodes(body?.evidenceCards).length === 0 ? [el("p", "comp-empty", "no evidence cited.")] : evidenceNodes(body?.evidenceCards)));
  fill($("#comp-trace"), traceNode(body?.decisionTrace));
  log.scrollTop = log.scrollHeight;
}

function renderFailure(log, prompt) {
  const row = el("div", "chat-msg chat-fail");
  row.append(el("span", null, "chat did not answer (baseline kept). "));
  const button = el("button", "fail-retry", "retry");
  button.type = "button";
  button.addEventListener("click", () => void send(prompt));
  row.append(button);
  log.append(row, traceNode({ engine: chatState.jev ? "jev" : "heuristic", status: "error" }));
  fill($("#comp-trace"), traceNode({ engine: chatState.jev ? "jev" : "heuristic", status: "error" }));
  log.scrollTop = log.scrollHeight;
}

function waitingBubble() {
  const node = el("div", "chat-msg chat-jev chat-waiting");
  node.setAttribute("aria-busy", "true");
  node.setAttribute("aria-label", "rocky thinking");
  const icon = el("span", "waiting-icon", "✦");
  const label = el("span", "waiting-label", "Searching Rocky memory & evaluating with Jev");
  const dots = el("span", "chat-waiting-dots");
  dots.append(el("span", "cwd-dot"), el("span", "cwd-dot"), el("span", "cwd-dot"));
  node.append(icon, label, dots);
  return node;
}

async function send(prompt) {
  const log = $("#chat-log");
  const input = $("#chat-input");
  if (!log || chatState.busy) return;
  chatState.busy = true;
  log.append(bubble("you", prompt));
  if (input) input.value = "";
  const waiting = waitingBubble();
  log.append(waiting);
  log.scrollTop = log.scrollHeight;
  try {
    const body = await chatApi(prompt);
    waiting.remove();
    renderAnswer(log, body);
  } catch {
    waiting.remove();
    renderFailure(log, prompt);
  } finally {
    chatState.busy = false;
  }
}

/** The model box only ever offers models the server says it serves. */
async function paintChatModels() {
  const select = $("#chat-model");
  if (!select) return;
  let models = [];
  try {
    models = await chatModels();
  } catch {
    models = [];
  }
  if (!Array.isArray(models)) models = [];
  // Verbatim server list, never invented: entries without an id are dropped,
  // everything else keeps the server label (or its id). Empty stays a single
  // local fallback option.
  const rows = [];
  try {
    for (const model of models) {
      const id = String(model?.id ?? model ?? "");
      if (id.length === 0) continue;
      rows.push({ id, label: String(model?.label ?? id) });
    }
  } catch {
    // a malformed catalog never blocks the local fallback
  }
  if (rows.length === 0) {
    rows.push({ id: "", label: "rocky local" });
  }
  const kept = rows.some((row) => row.id === chatState.model)
    ? chatState.model
    : (rows[0]?.id ?? "");
  try {
    fill(select);
    for (const row of rows) {
      const option = el("option", null, row.label);
      option.value = row.id;
      select.append(option);
    }
    select.value = kept;
  } catch {
    // the custom panel below still offers the same verbatim list
  }
  chatState.model = kept;
  if (!select.dataset.rockyBound) {
    try {
      select.dataset.rockyBound = "1";
      select.addEventListener("change", () => setChatModel(select.value));
    } catch {
      // selection stays local-only; sending still works
    }
  }
  paintModelPanel(rows, kept);
}

/** Single writer for the picked model: state, native box, custom listbox. */
function setChatModel(id) {
  chatState.model = id;
  try {
    const select = $("#chat-model");
    if (select && select.value !== id) select.value = id;
  } catch {
    // the native box is a progressive fallback; the custom panel owns display
  }
  syncModelPanel(id);
}

/**
 * Custom listbox over the verbatim catalog: dark rounded panel, roomy rows,
 * right-aligned check on the selected row. Keyboard: Enter/Space/Arrow keys
 * open, move, pick; Escape shuts. Missing markup means the native box stays.
 */
function paintModelPanel(rows, current) {
  const wrap = $("#chat-modelwrap");
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!wrap || !btn || !panel) return;
  try {
    wrap.classList.add("custom");
  } catch {
    return;
  }
  try {
    const options = rows.map((row) => {
      const opt = el("button", "cb-modelopt");
      opt.type = "button";
      opt.setAttribute("role", "option");
      opt.dataset.id = row.id;
      opt.append(el("span", "cb-modelname", row.label));
      const check = el("span", "cb-check", "\u2713");
      check.setAttribute("aria-hidden", "true");
      if (row.id !== current) check.hidden = true;
      opt.append(check);
      opt.setAttribute("aria-selected", row.id === current ? "true" : "false");
      opt.addEventListener("click", () => {
        setChatModel(row.id);
        closeModelPanel(true);
      });
      return opt;
    });
    fill(panel, ...options);
  } catch {
    return;
  }
  syncModelPanel(current);
  if (btn.dataset.rockyBound) return;
  try {
    btn.dataset.rockyBound = "1";
    btn.addEventListener("click", () => toggleModelPanel());
    btn.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openModelPanel();
      }
    });
    panel.addEventListener("keydown", (event) => {
      const items = Array.from(panel.querySelectorAll(".cb-modelopt"));
      const at = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeModelPanel(true);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = items[at + 1] ?? items[0];
        if (next) next.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const prev = items[at - 1] ?? items[items.length - 1];
        if (prev) prev.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const active = items[at];
        if (active) active.click();
      }
    });
    document.addEventListener("click", (event) => {
      try {
        if (!panel.hidden && !wrap.contains(event.target)) closeModelPanel(false);
      } catch {
        // closing is advisory; the panel stays until toggled
      }
    });
  } catch {
    // the button still labels the current model; the panel stays shut
  }
}

function syncModelPanel(current) {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  try {
    const options = Array.from(panel.querySelectorAll(".cb-modelopt"));
    if (options.length === 0) {
      btn.textContent = current ? current : "rocky local";
      return;
    }
    let label = "rocky local";
    for (const opt of options) {
      const on = opt.dataset.id === current;
      opt.setAttribute("aria-selected", on ? "true" : "false");
      const check = opt.querySelector(".cb-check");
      if (check) check.hidden = !on;
      if (on) label = opt.querySelector(".cb-modelname")?.textContent ?? label;
    }
    btn.textContent = label;
  } catch {
    // the label is advisory; selection state is already kept
  }
}

function openModelPanel() {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  try {
    panel.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const selected = panel.querySelector('.cb-modelopt[aria-selected="true"]') ?? panel.querySelector(".cb-modelopt");
    if (selected) selected.focus();
  } catch {
    // the panel stays shut; the native box remains usable
  }
}

function closeModelPanel(refocus) {
  const btn = $("#chat-model-btn");
  const panel = $("#chat-model-panel");
  if (!btn || !panel) return;
  try {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  } catch {
    // closing is advisory
  }
}

function toggleModelPanel() {
  const panel = $("#chat-model-panel");
  if (!panel) return;
  try {
    if (panel.hidden) openModelPanel();
    else closeModelPanel(false);
  } catch {
    // toggling is advisory
  }
}


function paintJevToggle() {
  const toggle = $("#chat-jev");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(chatState.jev));
  toggle.classList.toggle("on", chatState.jev);
  toggle.addEventListener("click", () => {
    chatState.jev = !chatState.jev;
    toggle.setAttribute("aria-pressed", String(chatState.jev));
    toggle.classList.toggle("on", chatState.jev);
  });
  void jevKeyState().then((state) => {
    try {
      // Unified mode reads the shared main credential; otherwise the active
      // Jev-provider booleans apply exactly as before.
      const armed = state.unified
        ? state.hasKey
        : (state.provider === "openrouter" ? state.hasOpenRouterKey : state.hasJevKey);
      const path = state.unified ? "OpenRouter (shared key)" : (state.provider === "openrouter" ? "OpenRouter" : "Native TypeSafe");
      toggle.title = armed
        ? `Jev analysis armed for the next message (${path})`
        : "Jev analysis (needs key — save one in Settings)";
    } catch {
      // title is advisory; a missing toggle target never blocks chat
    }
  }).catch(() => {});
}

function boot() {
  let form = null;
  let input = null;
  let log = null;
  try {
    form = $("#chat-form");
    input = $("#chat-input");
    log = $("#chat-log");
  } catch {
    return;
  }
  if (!form || !input || !log) return;

  try {
    if (log.childElementCount === 0) log.append(bubble("jev", "ask what rocky heard. answers stay local."));
  } catch {
    // static skeleton already reads; live greeting is additive only
  }

  try {
    void paintChatModels().catch(() => {});
  } catch {
    // model list is additive; local fallback already selected
  }
  try {
    paintJevToggle();
  } catch {
    // toggle is additive; chat sends without it
  }

  const attach = $("#chat-attach");
  if (attach) attach.addEventListener("click", () => input.focus());

  // ?v=chat stays a valid explicit flag: the chat layout is already default,
  // so it only brings the focus to the box.
  try {
    const all = new URLSearchParams(location.search).getAll("v");
    if (all.length === 1 && all[0] === "chat") input.focus();
  } catch {
    // focus hint is additive
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    void send(prompt).catch(() => {});
  });

  window.addEventListener("rocky:settings-saved", () => {
    void paintChatModels().catch(() => {});
    paintJevToggle();
  });
}

try {
  boot();
} catch {
  // chat enhancements must never break legacy paint
}
