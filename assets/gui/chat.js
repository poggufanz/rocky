/*
 * rocky chat pane -- whole-record local memory search and code questions.
 *
 * Memory-only turns scan locally, require relevant records, and hold instead
 * of summarizing weak matches. BYOK and remote Jev are for code questions;
 * loopback Ollama may render whole relevant memory records.
 *
 * Colour is a claim: only engine and hold/hedge states borrow emphasis. The
 * lightning toggle marks explicit Jev state, not truth.
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

function svgIcon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");

  if (name === "sparkle") {
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z");
    svg.append(path);
  } else if (name === "chevron-down") {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "6 9 12 15 18 9");
    svg.append(polyline);
  } else if (name === "check") {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", "20 6 9 17 4 12");
    svg.append(polyline);
  }
  return svg;
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

/** Collapsible trace for memory search, relevance decisions, model use, and code scans. */
function thinkingDrawer(body) {
  const t = body?.decisionTrace ?? {};
  const llm = t.llm ?? {};
  const cards = Array.isArray(body?.evidenceCards) ? body.evidenceCards : [];
  const memoryOnly = llm.structurerStatus === "memory-only";
  const coverageReason = typeof body?.coverage?.reason === "string" ? body.coverage.reason : "";
  const latency = t.latencyMs ?? t.latency ?? null;
  const latencyText = latency !== null ? `${latency}ms` : "";

  // Semantic <details> element: natively collapsible and robust
  const container = document.createElement("details");
  container.className = "chat-thinking";

  // Summary header acting as toggle
  const header = document.createElement("summary");
  header.className = "thinking-header";

  const icon = el("span", "thinking-icon");
  icon.append(svgIcon("sparkle", 13));
  const title = el("span", "thinking-title", "Thought Process");

  const metaBits = [];
  metaBits.push(`${cards.length} heard`);
  if (t.engine) metaBits.push(t.engine);
  if (latencyText) metaBits.push(latencyText);
  const meta = el("span", "thinking-meta", `(${metaBits.join(" · ")})`);

  const chevron = el("span", "thinking-chevron");
  chevron.append(svgIcon("chevron-down", 11));

  header.append(icon, title, meta, chevron);

  // Content body
  const bodyNode = el("div", "thinking-body");

  // Step 1: Rocky Memory Heard
  const step1 = el("div", "thinking-step step-rocky");
  const s1Head = el("div", "thinking-step-head");
  const memoryLabel = memoryOnly ? `Rocky Memory (${cards.length} whole records)` : `Rocky Memory (${cards.length} evidence cards)`;
  s1Head.append(el("span", "step-num", "1"), el("span", "step-title", memoryLabel));
  step1.append(s1Head);

  const s1Content = el("div", "thinking-step-content");
  if (cards.length === 0) {
    const emptyEvidenceText = memoryOnly
      ? (coverageReason.length > 0 ? "Memory coverage incomplete; answer held." : "No whole memory records included in answer.")
      : (coverageReason.length > 0 ? "Memory coverage incomplete; code answer may miss memory evidence." : "No matching memory evidence for this code question.");
    s1Content.append(el("p", "thinking-empty", emptyEvidenceText));
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

  // Step 2: local memory relevance or Jev decision, depending on route.
  const step2 = el("div", "thinking-step step-jev");
  const s2Head = el("div", "thinking-step-head");
  const decisionTitle = memoryOnly ? "Local Memory Relevance Gate" : `TypeSafe Jev Engine (${t.engine ?? "heuristic"})`;
  s2Head.append(el("span", "step-num", "2"), el("span", "step-title", decisionTitle));
  step2.append(s2Head);

  const s2Content = el("div", "thinking-step-content");
  const s2Details = el("div", "thinking-details");
  const confText = t.confidence !== undefined && t.confidence !== null ? String(t.confidence) : "withheld / null";
  s2Details.append(el("p", "detail-row", `Decision status: ${t.status ?? "unknown"}`));
  s2Details.append(el("p", "detail-row", `${memoryOnly ? "Memory relevance score" : "Candidate confidence"}: ${confText}`));
  const decisionCount = Array.isArray(t.evidenceRefs) ? t.evidenceRefs.length : 0;
  const decisionCountLabel = memoryOnly ? `Whole records accepted: ${decisionCount}` : `Evidence shortlist evaluated: ${decisionCount} items`;
  s2Details.append(el("p", "detail-row", decisionCountLabel));
  s2Content.append(s2Details);
  step2.append(s2Content);

  // Step 3: local renderer or code-chat LLM stages.
  const step3 = el("div", "thinking-step step-llm");
  const s3Head = el("div", "thinking-step-head");
  const modelName = typeof llm.model === "string" && llm.model.length > 0 ? llm.model : "rocky local";
  const synthesisTitle = memoryOnly
    ? (llm.active === true ? `Local Memory Renderer (${modelName})` : "No remote model used")
    : `LLM Grounded Synthesis (${modelName})`;
  s3Head.append(el("span", "step-num", "3"), el("span", "step-title", synthesisTitle));
  step3.append(s3Head);

  const s3Content = el("div", "thinking-step-content");
  const s3Details = el("div", "thinking-details");
  s3Details.append(el("p", "detail-row", `Structurer: ${llm.structurerStatus ?? "baseline"}`));
  s3Details.append(el("p", "detail-row", `Renderer: ${llm.rendererStatus ?? "baseline"}`));
  const strippedText = llm.stripped && llm.stripped > 0
    ? `${llm.stripped} uncited claims stripped`
    : "no uncited factual lines detected";
  s3Details.append(el("p", "detail-row", `Citation check: ${strippedText}`));
  s3Content.append(s3Details);
  step3.append(s3Content);

  bodyNode.append(step1, step2, step3);

  // Step 4: append code scan details only when that phase actually ran.
  const codeTrace = body && typeof body.codeTrace === "object" && body.codeTrace !== null ? body.codeTrace : null;
  const codeAnswer = body && typeof body.codeAnswer === "object" && body.codeAnswer !== null ? body.codeAnswer : null;
  const codeExcerpts = Array.isArray(body?.codeEvidence) ? body.codeEvidence : [];
  if (codeTrace !== null || codeAnswer !== null || codeExcerpts.length > 0) {
    const step4 = el("div", "thinking-step step-code");
    const s4Head = el("div", "thinking-step-head");
    s4Head.append(el("span", "step-num", "4"), el("span", "step-title", "Code Scan"));
    step4.append(s4Head);

    const s4Content = el("div", "thinking-step-content");
    const s4Details = el("div", "thinking-details");
    const scanned = codeTrace && codeTrace.filesScanned !== undefined && codeTrace.filesScanned !== null ? codeTrace.filesScanned : "unknown";
    const total = codeTrace && codeTrace.filesTotal !== undefined && codeTrace.filesTotal !== null ? codeTrace.filesTotal : "unknown";
    const mode = codeTrace && typeof codeTrace.mode === "string" && codeTrace.mode.length > 0 ? codeTrace.mode : "unknown";
    const rounds = codeTrace && codeTrace.rounds !== undefined && codeTrace.rounds !== null ? codeTrace.rounds : "unknown";
    s4Details.append(el("p", "detail-row", `Files scanned: ${scanned} of ${total}`));
    s4Details.append(el("p", "detail-row", `Scan mode: ${mode}`));
    s4Details.append(el("p", "detail-row", `Rounds: ${rounds} of 3`));
    const scanCoverage = codeTrace && codeTrace.truncated === true
      ? "truncated, not every file read"
      : codeTrace && codeTrace.truncated === false
        ? "complete"
        : "unknown";
    s4Details.append(el("p", "detail-row", `Scan coverage: ${scanCoverage}`));
    if (codeTrace && codeTrace.roundsExhausted === true) {
      s4Details.append(el("p", "detail-row", "Round budget spent; files not read are not checked"));
    }
    const stripped = codeAnswer && typeof codeAnswer.stripped === "number" ? codeAnswer.stripped : 0;
    const claimText = stripped > 0 ? `${stripped} ungrounded claims stripped` : "quoted-only, no unquoted claims";
    s4Details.append(el("p", "detail-row", `Code answer: ${codeExcerpts.length} excerpt${codeExcerpts.length === 1 ? "" : "s"}, ${claimText}`));
    s4Content.append(s4Details);
    step4.append(s4Content);
    bodyNode.append(step4);
  }

  container.append(header, bodyNode);
  return container;
}

/**
 * One honest disclosure line for a code phase: the server's own disclosure
 * first, then any codeTrace flag the user must know about. Null when the
 * answer never touched code, so memory-only renders stay unchanged.
 */
function codeDisclosure(body) {
  const answer = body && typeof body.codeAnswer === "object" && body.codeAnswer !== null ? body.codeAnswer : null;
  const trace = body && typeof body.codeTrace === "object" && body.codeTrace !== null ? body.codeTrace : null;
  if (!answer && !trace) return null;
  // Server disclosure first; a trace flag only adds a line the server did not
  // already state, so one condition never renders twice.
  const candidates = [];
  if (answer && typeof answer.disclosure === "string" && answer.disclosure.trim().length > 0) {
    candidates.push({ text: answer.disclosure.trim(), markers: [] });
  }
  if (trace && trace.mode === "unranked") {
    candidates.push({ text: "scan unranked: file list unavailable, excerpts come from memory-named files only.", markers: ["unranked"] });
  }
  if (trace && trace.truncated === true) {
    candidates.push({ text: "scan truncated: not every file read.", markers: ["truncated"] });
  }
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
 * Code excerpts are quotes, not summaries: label `path:startLine-endLine`, a
 * code kind chip, and the server's own lines in monospace. Read-only, no click
 * target, no link into Dash, no open-file affordance.
 */
function codeEvidenceNodes(excerpts) {
  if (!Array.isArray(excerpts) || excerpts.length === 0) return [];
  return excerpts.map((excerpt) => {
    const box = el("div", "chat-card chat-code-card");
    if (excerpt === null || typeof excerpt !== "object") {
      box.append(el("p", "chat-card-body", String(excerpt)));
      return box;
    }
    const path = String(excerpt.path ?? excerpt.ref ?? "unknown");
    const start = excerpt.startLine;
    const end = excerpt.endLine;
    const label = start !== undefined && start !== null
      ? `${path}:${start}${end !== undefined && end !== null ? `-${end}` : ""}`
      : path;
    box.append(el("p", "chat-card-head", label));
    box.append(el("p", "chat-card-kind", "code"));
    const lines = Array.isArray(excerpt.lines) ? excerpt.lines : [];
    if (lines.length > 0) {
      const text = lines.map((line) => {
        if (line === null || line === undefined) return "";
        if (typeof line === "string") return line;
        if (typeof line === "object") return String(line.text ?? line.line ?? "");
        return String(line);
      }).join("\n");
      box.append(el("pre", "chat-code-lines", text));
    }
    return box;
  });
}

function scrollToLatest(log) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    log.scrollTop = log.scrollHeight;
    return;
  }
  log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
}

/**
 * Defensive render: the backend owns the shape, so every field falls back
 * to something readable. A failure shows the baseline plus its status --
 * the pane never goes silent and never invents an answer. Each answer also
 * mirrors its cards and trace into the right companion panel.
 */
function renderAnswer(thread, log, body) {
  const text = body && typeof body.text === "string" && body.text.length > 0
    ? body.text
    : "rocky heard nothing matching that yet.";

  // Thinking / Track Record drawer with full Rocky + Jev + LLM breakdown
  const drawer = thinkingDrawer(body);
  thread.append(drawer);

  // Human-readable synthesized answer bubble
  thread.append(bubble("jev", text));
  if (body && body.coverage && body.coverage.reason) {
    thread.append(el("p", "chat-coverage", `coverage: ${body.coverage.reason}`));
  }

  // Code support (code questions only): one clearly labelled paragraph after
  // the memory answer, then the single disclosure line. Never replaces the
  // memory answer, and never blank when the server sent no code text.
  const codeText = body && typeof body.codeAnswer === "object" && body.codeAnswer !== null && typeof body.codeAnswer.text === "string"
    ? body.codeAnswer.text
    : "";
  if (codeText.length > 0) {
    const codeBubble = bubble("jev", codeText);
    codeBubble.classList.add("chat-code-answer");
    codeBubble.prepend(el("p", "chat-code-head", "code"));
    thread.append(codeBubble);
  }
  const disclosure = codeDisclosure(body);
  if (disclosure) thread.append(el("p", "chat-code-disc", disclosure));

  thread.append(traceNode(body?.decisionTrace));

  // Companion panels mirror evidence and trace. Memory cards stay primary and
  // first; code excerpts are support, quoted below them, plus the disclosure.
  const memoryCards = evidenceNodes(body?.evidenceCards);
  const codeBlocks = codeEvidenceNodes(body?.codeEvidence);
  if (disclosure && codeBlocks.length > 0) codeBlocks.push(el("p", "chat-code-disc", disclosure));
  const evidencePanel = memoryCards.length === 0 && codeBlocks.length === 0
    ? [el("p", "comp-empty", "no evidence cited.")]
    : [...memoryCards, ...codeBlocks];
  fill($("#comp-evidence"), ...evidencePanel);
  fill($("#comp-trace"), traceNode(body?.decisionTrace));
  scrollToLatest(log);
}

function renderFailure(thread, log, prompt) {
  const row = el("div", "chat-msg chat-fail");
  row.append(el("span", null, "chat did not answer (baseline kept). "));
  const button = el("button", "fail-retry", "retry");
  button.type = "button";
  button.addEventListener("click", () => void send(prompt));
  row.append(button);
  thread.append(row, traceNode({ engine: chatState.jev ? "jev" : "heuristic", status: "error" }));
  fill($("#comp-trace"), traceNode({ engine: chatState.jev ? "jev" : "heuristic", status: "error" }));
  scrollToLatest(log);
}

/* Memory turns search local records; code turns may read repository files. */
const WAITING_LABEL = "Searching available memory; checking relevance";
const CODE_WAITING_LABEL = "Searching memory, reading code, checking evidence";

function waitingBubble(prompt) {
  const node = el("div", "chat-msg chat-jev chat-waiting");
  node.setAttribute("role", "status");
  node.setAttribute("aria-busy", "true");
  node.setAttribute("aria-label", "rocky thinking");
  const icon = el("span", "waiting-icon");
  icon.append(svgIcon("sparkle", 13));
  const forcedCode = typeof prompt === "string" && /^\s*code:\s*\S/.test(prompt);
  const label = el("span", "waiting-label", forcedCode ? CODE_WAITING_LABEL : WAITING_LABEL);
  const dots = el("span", "chat-waiting-dots");
  dots.append(el("span", "chat-waiting-dot"), el("span", "chat-waiting-dot"), el("span", "chat-waiting-dot"));
  node.append(icon, label, dots);
  return node;
}

function resizeChatInput(input) {
  const maxHeight = 160;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

async function send(prompt) {
  const log = $("#chat-log");
  const thread = $("#chat-thread");
  const input = $("#chat-input");
  const sendButton = $("#chat-send");
  if (!log || !thread || chatState.busy) return;
  if (log.classList.contains("chat-log-empty")) {
    log.classList.remove("chat-log-empty");
    $("#chat-welcome")?.remove();
  }
  chatState.busy = true;
  log.setAttribute("aria-busy", "true");
  if (sendButton) sendButton.disabled = true;
  thread.append(bubble("you", prompt));
  if (input) {
    input.value = "";
    resizeChatInput(input);
    input.focus();
  }
  const waiting = waitingBubble(prompt);
  thread.append(waiting);
  scrollToLatest(log);
  try {
    const body = await chatApi(prompt);
    waiting.remove();
    renderAnswer(thread, log, body);
  } catch {
    waiting.remove();
    renderFailure(thread, log, prompt);
  } finally {
    chatState.busy = false;
    log.setAttribute("aria-busy", "false");
    if (sendButton) sendButton.disabled = false;
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
      const check = el("span", "cb-check");
      check.append(svgIcon("check", 12));
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
        ? `Jev analysis armed for next code question (${path})`
        : "Jev analysis for code questions (needs key; save one in Settings)";
    } catch {
      // title is advisory; a missing toggle target never blocks chat
    }
  }).catch(() => {});
}

function boot() {
  let form = null;
  let input = null;
  let log = null;
  let thread = null;
  try {
    form = $("#chat-form");
    input = $("#chat-input");
    log = $("#chat-log");
    thread = $("#chat-thread");
  } catch {
    return;
  }
  if (!form || !input || !log || !thread) return;

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


  // ?v=chat stays a valid explicit flag: the chat layout is already default,
  // so it only brings the focus to the box.
  try {
    const all = new URLSearchParams(location.search).getAll("v");
    if (all.length === 1 && all[0] === "chat") input.focus();
  } catch {
    // focus hint is additive
  }

  input.addEventListener("input", () => resizeChatInput(input));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  resizeChatInput(input);
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
