export interface CodeSpan {
  text: string;
  spaceBefore: boolean;
  spaceAfter: boolean;
  edgeBefore?: boolean;
  edgeAfter?: boolean;
}

export interface PreparedLine {
  send: boolean;
  html: string;
  codes: CodeSpan[];
  plain: string;
}

export interface PreparedQuote {
  lines: (PreparedLine | null)[];
  prose: string;
}

type Segment =
  | { kind: "prose"; text: string }
  | { kind: "code"; text: string };

interface EmphasisState {
  bold: boolean;
  strike: boolean;
  italic: boolean;
}

const URL_STICKY_RE = /https?:\/\/[^\s"'<>]+/y;
const PATH_STICKY_RE = /[^\s"'<>()[\]{}]+/y;
const EXT_NAME_STICKY_RE = /(?<![\w-]|[\w-]\.)[\w-]+(?:\.[\w-]+)*\.[a-z0-9]{1,6}(?![\w-])/y;
const FLAG_STICKY_RE = /(?<![\w-])--?[a-z][\w-]*/y;
const HASH_STICKY_RE = /(?<![\w])[0-9a-fA-F]{7,}(?![\w])/y;
const EXIT_CODE_STICKY_RE = /\bexit \d+\b/y;
const URL_SCHEME_RE = /https?:\/\//;

const PATH_DELIM_RE = /[\s"'<>()[\]{}]/;
const OPEN_PREDECESSOR_RE = /[\s\p{P}\p{S}]/u;
const OPEN_BRACKET_RE = /[\p{Ps}\p{Pi}]/u;
const CLOSE_BRACKET_RE = /[\p{Pe}\p{Pf}]/u;

const PLACEHOLDER_SPLIT_RE = /<x id="(\d+)"><\/x>/;
const STRAY_TAG_RE = /<[\p{L}/]/u;
const UNICODE_LETTER_RE = /\p{L}/u;
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;
const LEADING_HSPACE_RE = /^[\t\p{Zs}]+/u;
const TRAILING_HSPACE_RE = /[\t\p{Zs}]+$/u;
const RUN_HSPACE_RE = /[\t\p{Zs}]+/gu;
const ENDS_ALNUM_RE = /[\p{L}\p{N}]$/u;
const STARTS_ALNUM_RE = /^[\p{L}\p{N}]/u;

function stripBlockMarkers(line: string): string {
  let rest = line;
  while (true) {
    let hashes = 0;
    while (hashes < rest.length && rest[hashes] === "#") {
      hashes++;
    }
    if (
      hashes >= 1 &&
      hashes <= 6 &&
      (hashes === rest.length || rest[hashes] === " ")
    ) {
      rest = rest.slice(hashes).trimStart();
    } else if (rest.startsWith(">")) {
      rest = rest.slice(1).trimStart();
    } else {
      break;
    }
  }
  for (const marker of ["- ", "* ", "+ "]) {
    if (rest.startsWith(marker)) {
      return rest.slice(marker.length).trimStart();
    }
  }
  return rest;
}

function extractBacktickSpans(text: string): Segment[] {
  const out: Segment[] = [];
  let proseStart = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }

    let openEnd = i + 1;
    while (openEnd < text.length && text[openEnd] === "`") {
      openEnd++;
    }
    const tickLen = openEnd - i;

    let search = openEnd;
    let closeStart = -1;
    let closeEnd = -1;
    while (search < text.length) {
      if (text[search] !== "`") {
        search++;
        continue;
      }
      let runEnd = search + 1;
      while (runEnd < text.length && text[runEnd] === "`") {
        runEnd++;
      }
      if (runEnd - search === tickLen) {
        closeStart = search;
        closeEnd = runEnd;
        break;
      }
      search = runEnd;
    }

    if (closeStart !== -1 && closeStart > openEnd) {
      if (i > proseStart) {
        out.push({ kind: "prose", text: text.slice(proseStart, i) });
      }
      out.push({ kind: "code", text: text.slice(openEnd, closeStart) });
      proseStart = closeEnd;
      i = closeEnd;
    } else {
      i = openEnd;
    }
  }

  if (proseStart < text.length) {
    out.push({ kind: "prose", text: text.slice(proseStart) });
  }
  return out;
}

function appendSegment(target: Segment[], seg: Segment): void {
  if (seg.kind === "prose") {
    if (seg.text.length === 0) return;
    const prev = target[target.length - 1];
    if (prev && prev.kind === "prose") {
      prev.text += seg.text;
    } else {
      target.push({ kind: "prose", text: seg.text });
    }
    return;
  }
  target.push(seg);
}

function computeParenMatches(text: string): Map<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      stack.length = 0;
    } else if (ch === "(") {
      stack.push(i);
    } else if (ch === ")" && stack.length > 0) {
      matches.set(stack.pop()!, i);
    }
  }
  return matches;
}

function unlinkSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  let pending: Segment[] | null = null;

  const flushPending = (): void => {
    if (pending === null) return;
    appendSegment(out, { kind: "prose", text: "[" });
    for (const seg of pending) {
      appendSegment(out, seg);
    }
    pending = null;
  };

  const hasLabelContent = (segs: Segment[]): boolean =>
    segs.some((seg) => seg.kind === "code" || seg.text.length > 0);

  for (const seg of segments) {
    if (seg.kind === "code") {
      if (pending !== null) {
        appendSegment(pending, seg);
      } else {
        appendSegment(out, seg);
      }
      continue;
    }

    const parenMatches = seg.text.includes("](") ? computeParenMatches(seg.text) : null;
    let chunkStart = 0;

    const emitProseSlice = (end: number): void => {
      if (end > chunkStart) {
        appendSegment(pending ?? out, { kind: "prose", text: seg.text.slice(chunkStart, end) });
      }
    };

    for (let i = 0; i < seg.text.length; i++) {
      const ch = seg.text[i];
      if (ch === "[") {
        emitProseSlice(i);
        if (pending !== null) {
          flushPending();
        }
        pending = [];
        chunkStart = i + 1;
      } else if (ch === "]" && pending !== null) {
        emitProseSlice(i);
        if (i + 1 < seg.text.length && seg.text[i + 1] === "(" && parenMatches !== null) {
          const closeParen = parenMatches.get(i + 1);
          if (closeParen !== undefined && closeParen > i + 2 && hasLabelContent(pending)) {
            for (const labelSeg of pending) {
              appendSegment(out, labelSeg);
            }
            pending = null;
            i = closeParen;
            chunkStart = closeParen + 1;
            continue;
          }
        }
        flushPending();
        appendSegment(out, { kind: "prose", text: "]" });
        chunkStart = i + 1;
      }
    }
    emitProseSlice(seg.text.length);
  }

  flushPending();
  return out;
}

function hasUnmatchedClosing(text: string, openCh: string, closeCh: string): boolean {
  let balance = 0;
  for (const ch of text) {
    if (ch === openCh) balance++;
    else if (ch === closeCh) balance--;
  }
  return balance < 0;
}

function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const code = text.charCodeAt(index - 1);
  if (index >= 2 && code >= 0xdc00 && code <= 0xdfff) {
    const hi = text.charCodeAt(index - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) {
      return text.slice(index - 2, index);
    }
  }
  return text[index - 1];
}

function charAt(text: string, index: number): string {
  if (index < 0 || index >= text.length) return "";
  const cp = text.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
}

function markerRunLength(text: string, index: number): number {
  const ch = text[index];
  if (ch !== "*" && ch !== "~") return 0;
  let end = index + 1;
  while (end < text.length && text[end] === ch) {
    end++;
  }
  return end - index;
}

function findClosingMarkerInToken(raw: string, emphasis: EmphasisState): number {
  if (!emphasis.bold && !emphasis.strike && !emphasis.italic) {
    return -1;
  }

  let i = 1;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "*") {
      const runLen = markerRunLength(raw, i);
      const closes =
        (runLen === 1 && emphasis.italic) ||
        (runLen === 2 && emphasis.bold) ||
        (runLen >= 3 && (emphasis.bold || emphasis.italic));
      if (closes) {
        return i;
      }
      i += runLen;
      continue;
    }

    if (ch === "~") {
      const runLen = markerRunLength(raw, i);
      if (runLen >= 2 && emphasis.strike) {
        return i;
      }
      i += runLen;
      continue;
    }

    i++;
  }

  return -1;
}

function matchStickyAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/**
 * A matched code token. `closeAt` is the absolute index of the marker run that
 * cut the token because it closes open emphasis, or -1 when the token was not cut.
 */
interface TokenMatch {
  end: number;
  closeAt: number;
}

function plainMatch(end: number | null): TokenMatch | null {
  return end === null ? null : { end, closeAt: -1 };
}

function matchUrlAt(text: string, pos: number, emphasis: EmphasisState): TokenMatch | null {
  if (text[pos] !== "h") return null;
  const m = matchStickyAt(URL_STICKY_RE, text, pos);
  if (!m) return null;

  const raw = m[0];
  const cut = findClosingMarkerInToken(raw, emphasis);
  let candidate = cut === -1 ? raw : raw.slice(0, cut);

  while (candidate.length > 0) {
    const last = candidate[candidate.length - 1];
    if (/[.,;:!?]/.test(last)) {
      candidate = candidate.slice(0, -1);
    } else if (
      (last === ")" && hasUnmatchedClosing(candidate, "(", ")")) ||
      (last === "]" && hasUnmatchedClosing(candidate, "[", "]")) ||
      (last === "}" && hasUnmatchedClosing(candidate, "{", "}"))
    ) {
      candidate = candidate.slice(0, -1);
    } else {
      break;
    }
  }

  const protoEnd = candidate.indexOf("://") + 3;
  if (protoEnd < 3 || candidate.length <= protoEnd) {
    return null;
  }
  return { end: pos + candidate.length, closeAt: cut === -1 ? -1 : pos + cut };
}

function matchPathAt(
  text: string,
  pos: number,
  canStartPath: boolean,
  emphasis: EmphasisState,
): TokenMatch | null {
  if (!canStartPath) return null;
  const m = matchStickyAt(PATH_STICKY_RE, text, pos);
  if (!m) return null;

  const raw = m[0];
  // Keep HTML/XML tag fragments such as </x> as prose so stray-tag detection works.
  if (pos > 0 && text[pos - 1] === "<" && raw.startsWith("/")) {
    return null;
  }

  const cut = findClosingMarkerInToken(raw, emphasis);

  // A URL that starts mid-candidate (`--url=https://...`) ends where the URL
  // matcher ends, so brackets inside the URL stay protected with the prefix.
  const schemeAt = raw.search(URL_SCHEME_RE);
  if (schemeAt > 0 && (cut === -1 || cut > schemeAt)) {
    const url = matchUrlAt(text, pos + schemeAt, emphasis);
    if (url !== null) {
      return isTagTail(text, pos, url.end) ? null : url;
    }
  }

  let token = cut === -1 ? raw : raw.slice(0, cut);
  while (token.length > 0 && /[.,;:!?]$/.test(token)) {
    token = token.slice(0, -1);
  }

  if (!/[\/\\]/.test(token) || !UNICODE_ALNUM_RE.test(token)) {
    return null;
  }

  const tokenEnd = pos + token.length;
  if (isTagTail(text, pos, tokenEnd)) {
    return null;
  }

  return { end: tokenEnd, closeAt: cut === -1 ? -1 : pos + cut };
}

// Keep self-closing tag fragments such as <br/> as prose so stray-tag detection works.
function isTagTail(text: string, start: number, end: number): boolean {
  return end > start && end < text.length && text[end] === ">" && text[end - 1] === "/";
}

function matchExtNameAt(text: string, pos: number): number | null {
  const m = matchStickyAt(EXT_NAME_STICKY_RE, text, pos);
  if (!m) return null;
  const match = m[0];
  if (!/[A-Za-z]/.test(match)) return null;
  const end = pos + match.length;
  if (text.startsWith("://", end) && /https?$/.test(match)) {
    return null;
  }
  return end;
}

function matchFlagAt(text: string, pos: number): number | null {
  if (text[pos] !== "-") return null;
  const m = matchStickyAt(FLAG_STICKY_RE, text, pos);
  if (!m) return null;
  const match = m[0];
  const end = pos + match.length;
  if (text.startsWith("://", end) && /https?$/.test(match)) {
    return null;
  }
  return end;
}

function matchHashAt(text: string, pos: number): number | null {
  const m = matchStickyAt(HASH_STICKY_RE, text, pos);
  if (!m || !/\d/.test(m[0])) return null;
  return pos + m[0].length;
}

function matchExitCodeAt(text: string, pos: number, emphasis: EmphasisState): number | null {
  if (text[pos] !== "e") return null;
  const m = matchStickyAt(EXIT_CODE_STICKY_RE, text, pos);
  if (!m) return null;
  const numPos = pos + 5;
  if (
    matchPathAt(text, numPos, true, emphasis) !== null ||
    matchExtNameAt(text, numPos) !== null ||
    matchHashAt(text, numPos) !== null
  ) {
    return null;
  }
  return pos + m[0].length;
}

function matchCodeTokenAt(
  text: string,
  pos: number,
  canStartPath: boolean,
  emphasis: EmphasisState,
): TokenMatch | null {
  return (
    matchUrlAt(text, pos, emphasis) ??
    matchPathAt(text, pos, canStartPath, emphasis) ??
    plainMatch(matchExtNameAt(text, pos)) ??
    plainMatch(matchFlagAt(text, pos)) ??
    plainMatch(matchHashAt(text, pos)) ??
    plainMatch(matchExitCodeAt(text, pos, emphasis))
  );
}

/**
 * Consumes a marker run that already cut the preceding token as a closing
 * marker. The run only closes; it never opens emphasis for the next token.
 */
function consumeClosingRun(text: string, pos: number, emphasis: EmphasisState): number {
  const runLen = Math.max(1, markerRunLength(text, pos));
  if (text[pos] === "~") {
    emphasis.strike = false;
  } else if (runLen === 1) {
    emphasis.italic = false;
  } else if (runLen === 2) {
    emphasis.bold = false;
  } else {
    emphasis.bold = false;
    emphasis.italic = false;
  }
  return pos + runLen;
}

function consumeEmphasisMarker(
  text: string,
  pos: number,
  segIndex: number,
  totalSegs: number,
  emphasis: EmphasisState,
): number | null {
  const ch = text[pos];
  if (ch !== "*" && ch !== "~") return null;

  const runLen = markerRunLength(text, pos);
  if (ch === "~" && runLen < 2) {
    return null;
  }

  const runEnd = pos + runLen;

  const prevChar = pos > 0 ? charBefore(text, pos) : segIndex > 0 ? "a" : "";
  const nextChar = runEnd < text.length ? charAt(text, runEnd) : segIndex + 1 < totalSegs ? "a" : "";

  const prevIsNonSpace = prevChar.length > 0 && !/\s/.test(prevChar);
  const nextIsNonSpace = nextChar.length > 0 && !/\s/.test(nextChar);
  const prevAllowsOpen = prevChar === "" || OPEN_PREDECESSOR_RE.test(prevChar);
  const prevIsOpenPunct = prevChar.length > 0 && OPEN_BRACKET_RE.test(prevChar);
  const prevIsClosePunct = prevChar.length > 0 && CLOSE_BRACKET_RE.test(prevChar);
  const nextIsPunct = nextChar.length > 0 && OPEN_PREDECESSOR_RE.test(nextChar);

  const startsCodeAfter = (nextState: EmphasisState): boolean =>
    (runEnd === text.length && segIndex + 1 < totalSegs) ||
    matchCodeTokenAt(text, runEnd, true, nextState) !== null;

  const canOpenAsTokenPrefix = (nextState: EmphasisState): boolean =>
    nextIsNonSpace &&
    prevAllowsOpen &&
    !prevIsClosePunct &&
    (prevIsOpenPunct || startsCodeAfter(nextState));

  const canOpenNormally = (nextState: EmphasisState): boolean =>
    nextIsNonSpace &&
    (prevAllowsOpen || (pos === 0 && segIndex > 0 && startsCodeAfter(nextState)));

  const toggleSingleKind = (kind: keyof EmphasisState): void => {
    const nextState = { ...emphasis, [kind]: true };
    if (emphasis[kind] && canOpenAsTokenPrefix(nextState)) {
      emphasis[kind] = true;
    } else if (emphasis[kind] && prevIsNonSpace) {
      emphasis[kind] = false;
    } else if (canOpenNormally(nextState)) {
      emphasis[kind] = true;
    }
  };

  if (ch === "~") {
    toggleSingleKind("strike");
    return runEnd;
  }

  if (runLen === 1) {
    toggleSingleKind("italic");
  } else if (runLen === 2) {
    toggleSingleKind("bold");
  } else if (runLen === 3) {
    const nextState = { ...emphasis, bold: true, italic: true };
    if ((emphasis.bold || emphasis.italic) && canOpenAsTokenPrefix(nextState)) {
      emphasis.bold = true;
      emphasis.italic = true;
    } else if (prevIsNonSpace && (emphasis.bold || emphasis.italic)) {
      const canFollowOpen = (followState: EmphasisState): boolean =>
        nextIsNonSpace &&
        (!nextIsPunct || prevAllowsOpen || startsCodeAfter(followState));
      if (emphasis.bold && emphasis.italic) {
        emphasis.bold = false;
        emphasis.italic = false;
      } else if (emphasis.bold) {
        emphasis.bold = false;
        if (canFollowOpen({ ...emphasis, bold: false, italic: true })) {
          emphasis.italic = true;
        }
      } else {
        emphasis.italic = false;
        if (canFollowOpen({ ...emphasis, italic: false, bold: true })) {
          emphasis.bold = true;
        }
      }
    } else if (canOpenNormally(nextState)) {
      emphasis.bold = true;
      emphasis.italic = true;
    }
  } else {
    const odd = runLen % 2 === 1;
    const nextState = { ...emphasis, bold: true, italic: odd ? true : emphasis.italic };
    if ((emphasis.bold || emphasis.italic) && canOpenAsTokenPrefix(nextState)) {
      emphasis.bold = true;
      if (odd) emphasis.italic = true;
    } else if (prevIsNonSpace && (emphasis.bold || emphasis.italic)) {
      emphasis.bold = false;
      emphasis.italic = false;
    } else if (canOpenNormally(nextState)) {
      emphasis.bold = true;
      if (odd) emphasis.italic = true;
    }
  }

  return runEnd;
}

/**
 * Extracts code tokens across prose segments on a line while tracking open
 * emphasis left to right so markers inside open spans close the token cleanly
 * and token-content markers stay byte-exact.
 */
function extractCodeTokens(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  const emphasis: EmphasisState = { bold: false, strike: false, italic: false };

  for (let segIndex = 0; segIndex < segments.length; segIndex++) {
    const seg = segments[segIndex];
    if (seg.kind === "code") {
      appendSegment(out, seg);
      continue;
    }

    const text = seg.text;
    let pos = 0;
    let proseStart = 0;
    let canStartPath = true;
    // Index of a marker run that closed emphasis when it cut the previous token.
    let pendingClose = -1;

    const flushProse = (end: number): void => {
      if (end > proseStart) {
        appendSegment(out, { kind: "prose", text: text.slice(proseStart, end) });
      }
    };

    while (pos < text.length) {
      if (pendingClose !== -1 && pos >= pendingClose) {
        const closeAt = pendingClose;
        pendingClose = -1;
        if (pos === closeAt) {
          pos = consumeClosingRun(text, pos, emphasis);
          canStartPath = true;
          continue;
        }
      }

      const markerEnd = consumeEmphasisMarker(text, pos, segIndex, segments.length, emphasis);
      if (markerEnd !== null) {
        pos = markerEnd;
        canStartPath = true;
        continue;
      }

      const token = matchCodeTokenAt(text, pos, canStartPath, emphasis);
      if (token !== null) {
        flushProse(pos);
        appendSegment(out, { kind: "code", text: text.slice(pos, token.end) });
        pos = token.end;
        proseStart = token.end;
        canStartPath = true;
        pendingClose = token.closeAt;
        continue;
      }

      const ch = charAt(text, pos);
      canStartPath = PATH_DELIM_RE.test(ch);
      pos += ch.length;
    }

    flushProse(text.length);
  }

  return out;
}

function stripEmphasisMarkers(text: string): string {
  const noDouble = text.replace(/\*\*|~~/g, "");
  const chars = Array.from(noDouble);
  let out = "";

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch !== "*") {
      out += ch;
      continue;
    }
    const prev = i > 0 ? chars[i - 1] : "";
    const next = i + 1 < chars.length ? chars[i + 1] : "";
    const keepSpaces = /\s/.test(prev) && /\s/.test(next);
    const keepAlnum = UNICODE_ALNUM_RE.test(prev) && UNICODE_ALNUM_RE.test(next);
    if (keepSpaces || keepAlnum) {
      out += ch;
    }
  }
  return out;
}

function escapeProseHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeProseHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Splits a markdown quote into engine-ready HTML lines with numbered code
 * placeholders, paragraph breaks, and code-free prose for language detection.
 */
export function prepareQuote(text: string): PreparedQuote {
  const lines: (PreparedLine | null)[] = [];
  const proseParts: string[] = [];
  let inFence = false;

  const pushBlank = (): void => {
    if (lines.length > 0 && lines[lines.length - 1] !== null) {
      lines.push(null);
    }
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      lines.push({ send: false, html: "", codes: [], plain: trimmed });
      continue;
    }

    if (trimmed.length === 0) {
      pushBlank();
      continue;
    }

    const line = stripBlockMarkers(rawLine.trimStart()).trimEnd();
    if (line.length === 0) {
      continue;
    }

    let segments = extractBacktickSpans(line);
    segments = unlinkSegments(segments);
    segments = extractCodeTokens(segments);

    segments = segments.map((seg) =>
      seg.kind === "prose"
        ? { kind: "prose", text: stripEmphasisMarkers(seg.text) }
        : seg,
    );

    const prosePieces: string[] = [""];
    const rawCodes: string[] = [];
    for (const seg of segments) {
      if (seg.kind === "prose") {
        prosePieces[prosePieces.length - 1] += seg.text;
      } else {
        rawCodes.push(seg.text);
        prosePieces.push("");
      }
    }

    prosePieces[0] = prosePieces[0].trimStart();
    prosePieces[prosePieces.length - 1] = prosePieces[prosePieces.length - 1].trimEnd();

    if (rawCodes.length === 0 && prosePieces[0].length === 0) {
      continue;
    }

    const codes: CodeSpan[] = rawCodes.map((codeText, i) => {
      const span: CodeSpan = {
        text: codeText,
        spaceBefore: /\s$/.test(prosePieces[i]),
        spaceAfter: /^\s/.test(prosePieces[i + 1]),
      };
      if (i === 0 && prosePieces[0].length === 0) {
        span.edgeBefore = true;
      }
      if (i === rawCodes.length - 1 && prosePieces[prosePieces.length - 1].length === 0) {
        span.edgeAfter = true;
      }
      return span;
    });

    let plain = prosePieces[0];
    let html = escapeProseHtml(prosePieces[0]);
    for (let i = 0; i < rawCodes.length; i++) {
      plain += rawCodes[i] + prosePieces[i + 1];
      html += `<x id="${i}"></x>${escapeProseHtml(prosePieces[i + 1])}`;
    }

    for (const piece of prosePieces) {
      const trimmed = piece.trim();
      if (trimmed.length > 0) {
        proseParts.push(trimmed);
      }
    }

    const send = prosePieces.some((piece) => UNICODE_LETTER_RE.test(piece));
    lines.push({ send, html, codes, plain });
  }

  if (lines.length > 0 && lines[lines.length - 1] === null) {
    lines.pop();
  }

  return { lines, prose: proseParts.join(" ") };
}

/**
 * Validates placeholders and restores protected code spans into an engine
 * output line using the source line's spacing. Returns undefined on drift.
 */
export function restoreLine(out: string, line: PreparedLine): string | undefined {
  const split = out.split(PLACEHOLDER_SPLIT_RE);
  const rawParts: string[] = [];
  const idStrings: string[] = [];

  for (let i = 0; i < split.length; i++) {
    if (i % 2 === 0) {
      rawParts.push(split[i]);
    } else {
      idStrings.push(split[i]);
    }
  }

  if (idStrings.length !== line.codes.length) {
    return undefined;
  }

  const seen = new Set<number>();
  const ids: number[] = [];
  for (const idStr of idStrings) {
    const id = Number(idStr);
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      id >= line.codes.length ||
      String(id) !== idStr ||
      seen.has(id)
    ) {
      return undefined;
    }
    seen.add(id);
    ids.push(id);
  }

  for (const raw of rawParts) {
    if (STRAY_TAG_RE.test(raw)) {
      return undefined;
    }
  }

  const parts = rawParts.map(unescapeProseHtml);

  if (ids.length === 0) {
    return parts[0].replace(RUN_HSPACE_RE, " ").trim();
  }

  const cleanedParts = parts.map((part, i) => {
    let p = part;
    if (i > 0) p = p.replace(LEADING_HSPACE_RE, "");
    if (i < parts.length - 1) p = p.replace(TRAILING_HSPACE_RE, "");
    if (i === 0) p = p.trimStart();
    if (i === parts.length - 1) p = p.trimEnd();
    // Collapse horizontal spaces inside prose pieces only so code text stays byte-exact.
    return p.replace(RUN_HSPACE_RE, " ");
  });

  let result = cleanedParts[0];
  let pendingSpace = false;
  let pendingEdgeAfter = false;

  for (let i = 0; i < ids.length; i++) {
    const code = line.codes[ids[i]];
    const leftNonEmpty = result.length > 0;
    const rightHasMore = i < ids.length - 1 || cleanedParts[i + 1].length > 0;

    const needSpaceBefore =
      leftNonEmpty &&
      (pendingSpace ||
        code.spaceBefore ||
        (Boolean(code.edgeBefore) && ENDS_ALNUM_RE.test(result)) ||
        (pendingEdgeAfter && STARTS_ALNUM_RE.test(code.text)));

    if (needSpaceBefore) {
      result += " ";
    }
    result += code.text;
    pendingSpace = code.spaceAfter && rightHasMore;
    pendingEdgeAfter = Boolean(code.edgeAfter) && rightHasMore;

    const nextPart = cleanedParts[i + 1];
    if (nextPart.length > 0) {
      if (pendingSpace || (pendingEdgeAfter && STARTS_ALNUM_RE.test(nextPart))) {
        result += " ";
      }
      pendingSpace = false;
      pendingEdgeAfter = false;
      result += nextPart;
    }
  }

  return result;
}
