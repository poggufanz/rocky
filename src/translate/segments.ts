export interface CodeSpan {
  text: string;
  spaceBefore: boolean;
  spaceAfter: boolean;
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

interface MatchRange {
  start: number;
  end: number;
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const PATH_TOKEN_RE = /[^\s"'<>()[\]{}]+/g;
const EXT_NAME_RE = /(?<![\w-])[A-Za-z0-9_][\w-]*(?:\.[\w-]+)*\.[a-z0-9]{1,6}(?![\w-])/g;
const FLAG_RE = /(?<![\w-])--?[a-z][\w-]*/g;
const HASH_RE = /(?<![\w])[0-9a-fA-F]{7,}(?![\w])/g;
const EXIT_CODE_RE = /\bexit \d+\b/g;

const LINK_RE = /(?<!\w)\[([^\]]+)\]\((?:[^()\s]+|\([^()\s]*\))+\)/g;
const PLACEHOLDER_SPLIT_RE = /<x id="(\d+)"><\/x>/;
const STRAY_TAG_RE = /<[A-Za-z/]/;
const UNICODE_LETTER_RE = /\p{L}/u;
const UNICODE_ALNUM_RE = /[\p{L}\p{N}]/u;

function stripBlockMarkers(line: string): string {
  let cleaned = line.replace(/^#{1,6}[ \t]+/, "");
  cleaned = cleaned.replace(/^(?:>[ \t]*)+/, "");
  cleaned = cleaned.replace(/^[-*+][ \t]+/, "");
  return cleaned.trim();
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

function splitProseSegments(
  segments: Segment[],
  findMatches: (prose: string) => MatchRange[],
): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.kind !== "prose") {
      out.push(seg);
      continue;
    }
    const matches = findMatches(seg.text);
    if (matches.length === 0) {
      out.push(seg);
      continue;
    }
    let cursor = 0;
    for (const { start, end } of matches) {
      if (start > cursor) {
        out.push({ kind: "prose", text: seg.text.slice(cursor, start) });
      }
      out.push({ kind: "code", text: seg.text.slice(start, end) });
      cursor = end;
    }
    if (cursor < seg.text.length) {
      out.push({ kind: "prose", text: seg.text.slice(cursor) });
    }
  }
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

function findUrlMatches(prose: string): MatchRange[] {
  const matches: MatchRange[] = [];
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(prose)) !== null) {
    let candidate = m[0];
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
    if (candidate.length > protoEnd) {
      matches.push({ start: m.index, end: m.index + candidate.length });
    }
  }
  return matches;
}

function findPathMatches(prose: string): MatchRange[] {
  const matches: MatchRange[] = [];
  PATH_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_TOKEN_RE.exec(prose)) !== null) {
    let token = m[0];
    if (!/[\/\\]/.test(token)) {
      continue;
    }

    let tokenStart = m.index;
    let tokenEnd = tokenStart + token.length;
    const leadMatch = token.match(/^(?:\*\*|~~|\*)+/);
    let strippedSingleStar = false;
    if (leadMatch) {
      const lead = leadMatch[0];
      strippedSingleStar = lead.replace(/\*\*|~~/g, "").includes("*");
      tokenStart += lead.length;
      token = token.slice(lead.length);
    }

    while (token.length > 0) {
      if (/[.,;:!?]$/.test(token)) {
        token = token.slice(0, -1);
        tokenEnd--;
      } else if (token.endsWith("**") || token.endsWith("~~")) {
        token = token.slice(0, -2);
        tokenEnd -= 2;
      } else if (strippedSingleStar && token.endsWith("*")) {
        token = token.slice(0, -1);
        tokenEnd--;
      } else {
        break;
      }
    }

    if (!/[\/\\]/.test(token) || !/[A-Za-z0-9]/.test(token)) {
      continue;
    }
    // Keep HTML/XML tag fragments such as </x> or <br/> as prose so stray-tag detection works.
    if (tokenStart > 0 && prose[tokenStart - 1] === "<" && token.startsWith("/")) {
      continue;
    }
    if (tokenEnd < prose.length && prose[tokenEnd] === ">" && token.endsWith("/")) {
      continue;
    }

    matches.push({ start: tokenStart, end: tokenEnd });
  }
  return matches;
}

function findRegexMatches(
  prose: string,
  re: RegExp,
  accept?: (match: string) => boolean,
): MatchRange[] {
  const matches: MatchRange[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    if (accept && !accept(m[0])) {
      continue;
    }
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  return matches;
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
    let line = rawLine.trim();

    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      if (line.length === 0) {
        pushBlank();
      } else {
        lines.push({ send: false, html: "", codes: [], plain: line });
      }
      continue;
    }

    if (line.length === 0) {
      pushBlank();
      continue;
    }

    line = stripBlockMarkers(line);
    if (line.length === 0) {
      pushBlank();
      continue;
    }

    let segments = extractBacktickSpans(line);

    segments = segments.map((seg) =>
      seg.kind === "prose"
        ? { kind: "prose", text: seg.text.replace(LINK_RE, "$1") }
        : seg,
    );

    segments = splitProseSegments(segments, findUrlMatches);
    segments = splitProseSegments(segments, findPathMatches);
    segments = splitProseSegments(segments, (prose) =>
      findRegexMatches(prose, EXT_NAME_RE, (m) => /[A-Za-z]/.test(m)),
    );
    segments = splitProseSegments(segments, (prose) => findRegexMatches(prose, FLAG_RE));
    segments = splitProseSegments(segments, (prose) =>
      findRegexMatches(prose, HASH_RE, (m) => /\d/.test(m)),
    );
    segments = splitProseSegments(segments, (prose) => findRegexMatches(prose, EXIT_CODE_RE));

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
      pushBlank();
      continue;
    }

    const codes: CodeSpan[] = rawCodes.map((codeText, i) => ({
      text: codeText,
      spaceBefore: /\s$/.test(prosePieces[i]),
      spaceAfter: /^\s/.test(prosePieces[i + 1]),
    }));

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
    return parts[0].replace(/[ \t]+/g, " ").trim();
  }

  const cleanedParts = parts.map((part, i) => {
    let p = part;
    if (i > 0) p = p.replace(/^[ \t]+/, "");
    if (i < parts.length - 1) p = p.replace(/[ \t]+$/, "");
    if (i === 0) p = p.trimStart();
    if (i === parts.length - 1) p = p.trimEnd();
    // Collapse horizontal spaces inside prose pieces only so code text stays byte-exact.
    return p.replace(/[ \t]+/g, " ");
  });

  let result = cleanedParts[0];
  let pendingSpace = false;

  for (let i = 0; i < ids.length; i++) {
    const code = line.codes[ids[i]];
    const leftNonEmpty = result.length > 0;
    const rightHasMore = i < ids.length - 1 || cleanedParts[i + 1].length > 0;

    if ((pendingSpace || code.spaceBefore) && leftNonEmpty) {
      result += " ";
    }
    result += code.text;
    pendingSpace = code.spaceAfter && rightHasMore;

    const nextPart = cleanedParts[i + 1];
    if (nextPart.length > 0) {
      if (pendingSpace) {
        result += " ";
        pendingSpace = false;
      }
      result += nextPart;
    }
  }

  return result;
}
