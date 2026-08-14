/** Canonical secret families shared by durable replacement and hull detection. */
interface SecretDefinition {
  readonly replacementLabel: string;
  readonly detectionKind: string;
  readonly source: string;
  readonly flags?: string;
  readonly leadingBoundary?: boolean;
  readonly trailingBoundary?: boolean;
  readonly fragmentSource: string;
  readonly assignmentValueGroups?: readonly number[];
}

const SECRET_DEFINITIONS: ReadonlyArray<SecretDefinition> = [
  {
    replacementLabel: "aws access key",
    detectionKind: "aws access key",
    source: "AKIA[0-9A-Z]{16}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "AKIA[0-9A-Z]{8,}",
  },
  {
    replacementLabel: "private key",
    detectionKind: "private key",
    source: "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    fragmentSource: "-----BEGIN[ A-Za-z0-9_-]*",
  },
  {
    replacementLabel: "github token",
    detectionKind: "github token",
    source: "(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{4,}|github_pat_[A-Za-z0-9_]{4,}",
  },
  {
    replacementLabel: "slack token",
    detectionKind: "slack token",
    source: "xox[baprs]-[A-Za-z0-9-]{10,}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "xox[baprs]-[A-Za-z0-9-]{4,}",
  },
  {
    replacementLabel: "anthropic key",
    detectionKind: "anthropic key",
    source: "sk-ant-[A-Za-z0-9_-]{20,}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "sk-ant-[A-Za-z0-9_-]{3,}",
  },
  {
    replacementLabel: "openai key",
    detectionKind: "openai key",
    source: "sk-[A-Za-z0-9_-]{20,}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "sk-[A-Za-z0-9_-]{3,}",
  },
  {
    replacementLabel: "npm token",
    detectionKind: "npm token",
    source: "npm_[A-Za-z0-9]{36}",
    leadingBoundary: true,
    trailingBoundary: true,
    fragmentSource: "npm_[A-Za-z0-9_]{8,}",
  },
  {
    replacementLabel: "password assignment",
    detectionKind: "password assignment",
    source: String.raw`(?:(?:"(?:password|secret)"|'(?:password|secret)'|(?:password|secret)))\s*[:=]\s*(?:(['"])([^'"\r\n]{4,})\1|([^\s'"\x60,;]{4,}))`,
    flags: "i",
    leadingBoundary: true,
    fragmentSource: String.raw`(?:(?:"(?:password|secret)"|'(?:password|secret)'|(?:password|secret)))\s*[:=]\s*(?:["'][^"']*|[^\s]*)`,
    assignmentValueGroups: [2, 3],
  },
  {
    replacementLabel: "credential assignment",
    detectionKind: "credential assignment",
    source: String.raw`(?:(?:"(?:token|api[_-]?key|authorization)"|'(?:token|api[_-]?key|authorization)'|(?:token|api[_-]?key|authorization)))\s*[:=]\s*(?:(['"])([^'"\r\n]{4,})\1|((?:(?:Bearer|Basic|Token)\s+)?[^\s'"\x60,;]{4,}))`,
    flags: "i",
    leadingBoundary: true,
    fragmentSource: String.raw`(?:(?:"(?:token|api[_-]?key|authorization)"|'(?:token|api[_-]?key|authorization)'|(?:token|api[_-]?key|authorization)))\s*[:=]\s*(?:["'][^"']*|(?:(?:Bearer|Basic|Token)\s+)?[^\s]*)`,
    assignmentValueGroups: [2, 3],
  },
];

function patternFor(definition: SecretDefinition, boundaryFree: boolean): RegExp {
  const leading = !boundaryFree && definition.leadingBoundary ? "(?<![A-Za-z0-9_])" : "";
  const trailing = !boundaryFree && definition.trailingBoundary ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${leading}(?:${definition.source})${trailing}`, definition.flags ?? "");
}

const INVISIBLE_CONTROL_SINGLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;
const CSI_8BIT = 0x9b;
const SS2_8BIT = 0x8e;
const SS3_8BIT = 0x8f;
const OSC_8BIT = 0x9d;
const DCS_8BIT = 0x90;
const SOS_8BIT = 0x98;
const PM_8BIT = 0x9e;
const APC_8BIT = 0x9f;

function isControlStringStart(code: number): boolean {
  return code === OSC_8BIT || code === DCS_8BIT || code === SOS_8BIT || code === PM_8BIT || code === APC_8BIT;
}

function consumeCsi(text: string, start: number): number {
  let offset = start;
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code >= 0x30 && code <= 0x3f) {
      offset += 1;
      continue;
    }
    break;
  }
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if (code >= 0x20 && code <= 0x2f) {
      offset += 1;
      continue;
    }
    break;
  }
  if (offset < text.length && text.charCodeAt(offset) >= 0x40 && text.charCodeAt(offset) <= 0x7e) {
    return offset + 1;
  }
  // An unterminated sequence is still untrusted payload. Consume its bounded tail.
  return text.length;
}

function consumeControlString(text: string, start: number, terminatesAtBel: boolean): number {
  let offset = start;
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    if ((terminatesAtBel && code === BEL) || code === ST) return offset + 1;
    if (code === ESC && text.charCodeAt(offset + 1) === 0x5c) return offset + 2;
    offset += 1;
  }
  // A missing terminator must not expose payload bytes to later redaction logic.
  return text.length;
}

function consumeEscape(text: string, start: number): number {
  const next = text.charCodeAt(start + 1);
  if (next === 0x5b) return consumeCsi(text, start + 2);
  if (next === 0x4e || next === 0x4f) return consumeShiftedGraphic(text, start + 1);
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return consumeControlString(text, start + 2, next === 0x5d);
  }
  if (next >= 0x20 && next <= 0x2f) {
    let offset = start + 2;
    while (offset < text.length && text.charCodeAt(offset) >= 0x20 && text.charCodeAt(offset) <= 0x2f) offset += 1;
    return offset < text.length && text.charCodeAt(offset) >= 0x30 && text.charCodeAt(offset) <= 0x7e
      ? offset + 1
      : offset;
  }
  // Standard two-byte ESC Fe sequences (and unknown ESC payload) are removed as a unit.
  return next >= 0x40 && next <= 0x7e ? start + 2 : start + 1;
}

function consumeShiftedGraphic(text: string, introducer: number): number {
  const codePoint = text.codePointAt(introducer + 1);
  if (codePoint === undefined) return Math.min(introducer + 1, text.length);
  return Math.min(introducer + 1 + (codePoint > 0xffff ? 2 : 1), text.length);
}

function isC0OrC1(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/** Replace ANSI, C0, and C1 controls while preserving one logical boundary per removal. */
export function replaceAnsiAndControls(text: string, replacement = "", c0Replacement = replacement): string {
  if (!text) return text;
  const pieces: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const code = text.charCodeAt(offset);
    let end = offset;
    let isSequence = false;
    if (code === ESC) {
      end = consumeEscape(text, offset);
      isSequence = true;
    } else if (code === CSI_8BIT) {
      end = consumeCsi(text, offset + 1);
      isSequence = true;
    } else if (code === SS2_8BIT || code === SS3_8BIT) {
      end = consumeShiftedGraphic(text, offset);
      isSequence = true;
    } else if (isControlStringStart(code)) {
      end = consumeControlString(text, offset + 1, code === OSC_8BIT);
      isSequence = true;
    } else if (isC0OrC1(code)) {
      end = offset + 1;
    }

    if (end !== offset) {
      const isWhitespaceControl = code === 0x09 || code === 0x0a || code === 0x0d;
      pieces.push(isWhitespaceControl ? String.fromCharCode(code) : (isSequence ? replacement : c0Replacement));
      offset = end;
      continue;
    }

    const codePoint = text.codePointAt(offset) ?? 0;
    pieces.push(String.fromCodePoint(codePoint));
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return pieces.join("");
}

const SECRET_BOUNDARY_FREE_PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = SECRET_DEFINITIONS.map(
  (definition) => [definition.replacementLabel, new RegExp(patternFor(definition, true).source, `${definition.flags ?? ""}g`)] as const,
);

const SECRET_FRAGMENT_PATTERNS: ReadonlyArray<readonly [kind: string, re: RegExp]> = SECRET_DEFINITIONS.map(
  (definition) => [definition.replacementLabel, new RegExp(definition.fragmentSource, `${definition.flags ?? ""}g`)] as const,
);

interface InvisibleControlStripResult {
  readonly text: string;
  /** UTF-16 offsets in `text` where one or more invisible controls were removed. */
  readonly removedOffsets: ReadonlySet<number>;
}

interface SecretBoundaryInput extends InvisibleControlStripResult {
  readonly displayText: string;
  readonly displayStarts: ReadonlyMap<number, number>;
  readonly displayEnds: ReadonlyMap<number, number>;
}

/** Remove format controls without inserting separators before secret matching. */
export function stripInvisibleControls(text: string): string {
  return stripInvisibleControlsWithOffsets(text).text;
}

/** Strip hidden format controls while retaining the resulting boundary map. */
function stripInvisibleControlsWithOffsets(text: string): InvisibleControlStripResult {
  if (!text) return { text, removedOffsets: new Set<number>() };
  const pieces: string[] = [];
  const removedOffsets = new Set<number>();
  let outputOffset = 0;
  for (const character of text) {
    if (INVISIBLE_CONTROL_SINGLE_RE.test(character)) {
      removedOffsets.add(outputOffset);
      continue;
    }
    pieces.push(character);
    outputOffset += character.length;
  }
  return { text: pieces.join(""), removedOffsets };
}

/**
 * Build a control-free matching view and offsets into a safe display view.
 * CR/LF/TAB are omitted while matching so they cannot split a credential, but
 * remain in display text unless the selected replacement spans them.
 */
function normalizeSecretBoundaryInput(text: string): SecretBoundaryInput {
  if (!text) {
    return {
      text,
      displayText: text,
      removedOffsets: new Set<number>(),
      displayStarts: new Map<number, number>(),
      displayEnds: new Map<number, number>(),
    };
  }

  const matching: string[] = [];
  const display: string[] = [];
  const removedOffsets = new Set<number>();
  const displayStarts = new Map<number, number>();
  const displayEnds = new Map<number, number>();
  let sourceOffset = 0;
  let matchingOffset = 0;
  let displayOffset = 0;

  while (sourceOffset < text.length) {
    const code = text.charCodeAt(sourceOffset);
    let end = sourceOffset;
    let isSequence = false;
    if (code === ESC) {
      end = consumeEscape(text, sourceOffset);
      isSequence = true;
    } else if (code === CSI_8BIT) {
      end = consumeCsi(text, sourceOffset + 1);
      isSequence = true;
    } else if (code === SS2_8BIT || code === SS3_8BIT) {
      end = consumeShiftedGraphic(text, sourceOffset);
      isSequence = true;
    } else if (isControlStringStart(code)) {
      end = consumeControlString(text, sourceOffset + 1, code === OSC_8BIT);
      isSequence = true;
    } else if (isC0OrC1(code)) {
      end = sourceOffset + 1;
    }

    if (end !== sourceOffset) {
      removedOffsets.add(matchingOffset);
      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        display.push(String.fromCharCode(code));
        displayOffset += 1;
      } else if (!isSequence) {
        display.push(" ");
        displayOffset += 1;
      }
      sourceOffset = end;
      continue;
    }

    const character = String.fromCodePoint(text.codePointAt(sourceOffset) ?? 0);
    if (INVISIBLE_CONTROL_SINGLE_RE.test(character)) {
      removedOffsets.add(matchingOffset);
      sourceOffset += character.length;
      continue;
    }

    displayStarts.set(matchingOffset, displayOffset);
    matching.push(character);
    display.push(character);
    matchingOffset += character.length;
    displayOffset += character.length;
    displayEnds.set(matchingOffset, displayOffset);
    sourceOffset += character.length;
  }

  return {
    text: matching.join(""),
    displayText: display.join(""),
    removedOffsets,
    displayStarts,
    displayEnds,
  };
}

const EXACT_PLACEHOLDER_VALUE = /^(?:(?:test|example|dummy|placeholder)(?:[-_ ](?:password|secret|token|key|value)(?:[-_ ]\d{1,4})?)?|changeme)$/i;
const INDIRECT_SECRET_VALUE = /^(?:process\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]+>)$/i;
const SECRET_TOKEN_PREFIX = /^(?:AKIA|github_pat_|gh[opurs]_|xox[baprs]-|sk-(?:[A-Za-z0-9]+-)*|npm_)/;

function assignmentValue(definition: SecretDefinition, match: RegExpExecArray): string | undefined {
  for (const group of definition.assignmentValueGroups ?? []) {
    const value = match[group];
    if (value !== undefined) return value.trim();
  }
  return undefined;
}

function isPlaceholderMatch(definition: SecretDefinition, match: RegExpExecArray): boolean {
  const assigned = assignmentValue(definition, match);
  if (assigned !== undefined) {
    const candidate = assigned.replace(/^(?:Bearer|Basic|Token)\s+/i, "").trim();
    return EXACT_PLACEHOLDER_VALUE.test(candidate)
      || INDIRECT_SECRET_VALUE.test(candidate)
      || /^([A-Za-z0-9])\1+$/.test(candidate);
  }

  const body = match[0].replace(SECRET_TOKEN_PREFIX, "");
  return body.length > 0 && /^([A-Za-z0-9])\1+$/.test(body);
}

/**
 * Return the first non-placeholder secret family found after removing terminal
 * and bidi obfuscation. Detection and durable replacement compile from the
 * same canonical family definitions above, while retaining distinct labels.
 */
export function detectSecretKind(text: string): string | undefined {
  const normalized = normalizeSecretBoundaryInput(text).text;
  for (const definition of SECRET_DEFINITIONS) {
    const base = patternFor(definition, false);
    const flags = `${base.flags.replace("g", "")}g`;
    const pattern = new RegExp(base.source, flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(normalized)) !== null) {
      if (!isPlaceholderMatch(definition, match)) return definition.detectionKind;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return undefined;
}

export function redactSecrets(text: string): string {
  return redactSecretsAtBoundary(text);
}

/** Boundary context for a raw value entering a durable or AI/log sink. */
export interface SecretBoundaryOptions {
  /** The caller's bounded prefix may end in a partial secret family marker. */
  readonly mayBeTruncated?: boolean;
}

interface SecretBoundaryContext extends SecretBoundaryOptions {
  readonly removedOffsets: ReadonlySet<number>;
}

function isAsciiWord(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/u.test(character);
}

function hasLeadingBoundary(text: string, start: number): boolean {
  return !isAsciiWord(text[start - 1]);
}

function hasTrailingBoundary(text: string, end: number): boolean {
  return !isAsciiWord(text[end]);
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly order: number;
}

function collectReplacements(text: string, context: SecretBoundaryContext): Replacement[] {
  const removedOffsets = context.removedOffsets;
  const full: Replacement[] = [];
  for (let order = 0; order < SECRET_BOUNDARY_FREE_PATTERNS.length; order += 1) {
    const [kind, re] = SECRET_BOUNDARY_FREE_PATTERNS[order] as [string, RegExp];
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0;
      const matched = match[0] ?? "";
      const rawEnd = start + matched.length;
      const definition = SECRET_DEFINITIONS[order];
      if (!definition) continue;
      // Keep all contiguous normalized token-body characters: an invisible
      // split followed by more body text is ambiguous, so never expose tail.
      const end = rawEnd;
      const normalLeading = !definition.leadingBoundary || hasLeadingBoundary(text, start);
      const normalTrailing = !definition.trailingBoundary || hasTrailingBoundary(text, end);
      const hasRecordedLeading = !definition.leadingBoundary || removedOffsets.has(start);
      const hasRecordedTrailing = !definition.trailingBoundary || removedOffsets.has(end);
      if ((!normalTrailing && !hasRecordedTrailing) || (!normalLeading && !hasRecordedLeading)) continue;
      full.push({ start, end, value: `[redacted ${kind}]`, order });
    }
  }

  const replacements = [...full];
  if (!context.mayBeTruncated) return replacements;

  for (let order = 0; order < SECRET_FRAGMENT_PATTERNS.length; order += 1) {
    const [, re] = SECRET_FRAGMENT_PATTERNS[order] as [string, RegExp];
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0;
      const matched = match[0] ?? "";
      const rawEnd = start + matched.length;
      const definition = SECRET_DEFINITIONS[order];
      if (!definition) continue;
      // `mayBeTruncated` only authorizes scrubbing a fragment at normalized
      // input EOF; visible tail proves this prefix was not cut at the cap.
      if (rawEnd !== text.length) continue;
      const end = rawEnd;
      const normalLeading = !definition.leadingBoundary || hasLeadingBoundary(text, start);
      const hasRecordedBoundary = !definition.leadingBoundary || removedOffsets.has(start);
      if (!normalLeading && !hasRecordedBoundary) continue;
      replacements.push({ start, end, value: "", order: SECRET_BOUNDARY_FREE_PATTERNS.length + order });
    }
  }
  return replacements;
}

/**
 * Strip the exact invisible controls and redact a raw boundary value.
 * Complete matches retain the normal placeholder. A complete family match may
 * ignore its leading word boundary only when a removed control created that
 * normalized offset; partial matching is additionally opt-in for callers that
 * know their input may be capped.
 */
export function redactSecretsAtBoundary(text: string, options: SecretBoundaryOptions = {}): string {
  const normalized = normalizeSecretBoundaryInput(text);
  const replacements = collectReplacements(normalized.text, {
    removedOffsets: normalized.removedOffsets,
    mayBeTruncated: options.mayBeTruncated,
  })
    .sort((left, right) => left.start - right.start || right.end - left.end || left.order - right.order);
  const selected: Replacement[] = [];
  for (const replacement of replacements) {
    if (selected.some((chosen) => replacement.end > chosen.start && replacement.start < chosen.end)) continue;
    selected.push(replacement);
  }

  let out = normalized.displayText;
  for (const replacement of selected.sort((left, right) => right.start - left.start)) {
    const start = normalized.displayStarts.get(replacement.start) ?? replacement.start;
    const end = normalized.displayEnds.get(replacement.end) ?? replacement.end;
    out = out.slice(0, start) + replacement.value + out.slice(end);
  }
  return out;
}
