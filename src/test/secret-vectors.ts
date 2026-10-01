import { AMBIGUOUS_SECRET_CONTINUATION } from "../core/redact.js";

export interface SecretClosureVector {
  readonly name: string;
  readonly text: string;
  readonly kind: "password assignment" | "credential assignment" | "openai key";
  readonly replacement: string;
}

export const AMBIGUOUS_CONTINUATION_MARKER = AMBIGUOUS_SECRET_CONTINUATION;

export const SYNTHETIC_SECRET_CLOSURE_VECTORS: readonly SecretClosureVector[] = [
  {
    name: "quoted JSON password key",
    text: '"password": "pA7!cV2@kL9"',
    kind: "password assignment",
    replacement: "[redacted password assignment]",
  },
  {
    name: "quoted YAML API key",
    text: "'api_key': 'api-aB3dE5fG7hI9jK2mN4pQ6'",
    kind: "credential assignment",
    replacement: "[redacted credential assignment]",
  },
  {
    name: "realistic password containing test",
    text: "password=pA7!test!cV2@kL9",
    kind: "password assignment",
    replacement: "[redacted password assignment]",
  },
  {
    name: "realistic authorization containing example",
    text: "authorization: Bearer live-example-9Zx!4Q",
    kind: "credential assignment",
    replacement: "[redacted credential assignment]",
  },
  {
    name: "TAB-split password name",
    text: "pass\tword=pA7!cV2@kL9",
    kind: "password assignment",
    replacement: "[redacted password assignment]\t",
  },
  {
    name: "LF-split API key name",
    text: '"api_\nkey": "api-aB3dE5fG7hI9jK2mN4pQ6"',
    kind: "credential assignment",
    replacement: "[redacted credential assignment]\n",
  },
  {
    name: "CR-split secret value",
    text: "secret=pA7!cV2\r@kL9",
    kind: "password assignment",
    replacement: `[redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER}`,
  },
  {
    name: "assignment overlapping modern key",
    text: "token=sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4",
    kind: "openai key",
    replacement: "[redacted credential assignment]",
  },
];

export const EXACT_PLACEHOLDER_ASSIGNMENTS = [
  'password="test-password-123"',
  "secret=example-secret",
  "token=changeme",
  'api_key="placeholder-value"',
  'authorization="Bearer example-token"',
] as const;

export const SYNTHETIC_DELIMITER_PRESERVATION_VECTORS = [
  {
    name: "LF continuation after complete-looking password prefix",
    text: "before password=abcd\nafter words",
    kind: "password assignment",
    durable: `before [redacted password assignment]\n${AMBIGUOUS_CONTINUATION_MARKER} words`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER} words`,
  },
  {
    name: "TAB continuation after complete-looking token prefix",
    text: "before token=abcd1234\tafter words",
    kind: "credential assignment",
    durable: `before [redacted credential assignment]\t${AMBIGUOUS_CONTINUATION_MARKER} words`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER} words`,
  },
  {
    name: "CR continuation after complete-looking secret prefix",
    text: "before secret=abcd1234\rafter words",
    kind: "password assignment",
    durable: `before [redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER} words`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER} words`,
  },
  {
    name: "punctuation-led LF continuation stays bound to canonical match",
    text: "before password=abcd\n@after mention",
    kind: "password assignment",
    durable: `before [redacted password assignment]\n${AMBIGUOUS_CONTINUATION_MARKER} mention`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER} mention`,
  },
  {
    name: "quoted record proves LF boundary after complete value",
    text: 'before password=abcd\n"event": "ok"',
    kind: "password assignment",
    durable: 'before [redacted password assignment]\n"event": "ok"',
    sanitizedMcp: 'before [redacted] "event": "ok"',
  },
] as const;

export interface EveryControlSplitVector {
  readonly name: string;
  readonly text: string;
  readonly kind: "password assignment" | "credential assignment" | "openai key";
  readonly durable: string;
  readonly sanitizedMcp: string;
  readonly control: "\t" | "\n" | "\r";
  readonly split: number;
  readonly context: "EOF" | "whitespace word" | "punctuation-led token" | "quoted tail" | "provable next record";
  readonly reconstructableSuffix?: string;
  readonly outsideText: string;
}

const CONTROL_SPLIT_BASES = [
  {
    name: "unquoted secret assignment",
    text: "secret=pA7!cV2@kL9",
    kind: "password assignment" as const,
    replacement: "[redacted password assignment]",
    structure: "assignment" as const,
    valueStart: "secret=".length,
    punctuationContinuation: "@after",
  },
  {
    name: "modern key assignment",
    text: "token=sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4",
    kind: "openai key" as const,
    replacement: "[redacted credential assignment]",
    structure: "assignment" as const,
    valueStart: "token=".length,
    punctuationContinuation: "@after",
  },
  {
    name: "standalone modern key",
    text: "sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4",
    kind: "openai key" as const,
    replacement: "[redacted openai key]",
    structure: "standalone" as const,
    valueStart: 0,
    punctuationContinuation: "-after",
  },
] as const;

const CONTROL_SUFFIX_CONTEXTS = [
  { name: "EOF" as const, input: "", outside: "", absorbsPunctuation: false },
  { name: "whitespace word" as const, input: " after", outside: " after", absorbsPunctuation: false },
  { name: "punctuation-led token" as const, input: "", outside: " mention", absorbsPunctuation: true },
  {
    name: "provable next record" as const,
    input: '\n"event": "ok"',
    outside: '\n"event": "ok"',
    absorbsPunctuation: false,
  },
] as const;

const QUOTED_CONTROL_SPLIT_BASES = [
  {
    name: "quoted password assignment",
    text: 'password="pA7!cV2@kL9"',
    kind: "password assignment" as const,
    replacement: "[redacted password assignment]",
  },
  {
    name: "quoted token assignment",
    text: 'token="tK8!cV2@kL9"',
    kind: "credential assignment" as const,
    replacement: "[redacted credential assignment]",
  },
] as const;

function normalizedExpected(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function reconstructableSuffix(text: string, split: number, absorbed = ""): string | undefined {
  const suffix = `${text.slice(split)}${absorbed}`;
  return suffix.length >= 4 ? suffix : undefined;
}

/**
 * Every internal TAB/LF/CR split is crossed with suffix structure. Only text
 * outside the canonical match is retained; a quoted record proves a boundary
 * because an unquoted value cannot consume its opening quote.
 */
const UNQUOTED_CONTROL_SPLIT_VECTORS: readonly EveryControlSplitVector[] = CONTROL_SPLIT_BASES.flatMap(
  (base) => CONTROL_SUFFIX_CONTEXTS.flatMap((context) =>
    (["\t", "\n", "\r"] as const).flatMap((control) =>
      Array.from({ length: base.text.length - 1 }, (_, index) => {
        const split = index + 1;
        const ambiguous = base.structure === "standalone" || split >= base.valueStart;
        const absorbed = context.absorbsPunctuation ? base.punctuationContinuation : "";
        const inputSuffix = context.absorbsPunctuation ? `${absorbed}${context.outside}` : context.input;
        const retained = `${control}${ambiguous ? AMBIGUOUS_CONTINUATION_MARKER : ""}${context.outside}`;
        return {
          name: `${base.name} ${context.name} ${JSON.stringify(control)} split ${split}`,
          text: `${base.text.slice(0, split)}${control}${base.text.slice(split)}${inputSuffix}`,
          kind: base.kind,
          durable: `${base.replacement}${retained}`,
          sanitizedMcp: normalizedExpected(`[redacted]${retained}`),
          control,
          split,
          context: context.name,
          reconstructableSuffix: reconstructableSuffix(base.text, split, absorbed),
          outsideText: context.outside,
        };
      }),
    ),
  ),
);

const QUOTED_CONTROL_SPLIT_VECTORS: readonly EveryControlSplitVector[] = QUOTED_CONTROL_SPLIT_BASES.flatMap(
  (base) => (["\t", "\n", "\r"] as const).flatMap(
    (control) => Array.from({ length: base.text.length - 1 }, (_, index) => {
      const split = index + 1;
      const outside = " after";
      return {
        name: `${base.name} quoted tail ${JSON.stringify(control)} split ${split}`,
        text: `${base.text.slice(0, split)}${control}${base.text.slice(split)}${outside}`,
        kind: base.kind,
        durable: `${base.replacement}${control}${outside}`,
        sanitizedMcp: "[redacted] after",
        control,
        split,
        context: "quoted tail" as const,
        reconstructableSuffix: reconstructableSuffix(base.text, split),
        outsideText: outside,
      };
    }),
  ),
);

export const SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS: readonly EveryControlSplitVector[] = [
  ...UNQUOTED_CONTROL_SPLIT_VECTORS,
  ...QUOTED_CONTROL_SPLIT_VECTORS,
];

export const SYNTHETIC_NON_EOF_CONTROL_PROBES = [
  {
    name: "CR after first two unquoted value characters with visible tail",
    text: "secret=pA\r7!cV2@kL9 after",
    kind: "password assignment" as const,
    durable: `[redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER} after`,
    sanitizedMcp: `[redacted] ${AMBIGUOUS_CONTINUATION_MARKER} after`,
    leakedSuffix: "7!cV2@kL9",
  },
  {
    name: "CR after first four unquoted value characters with visible tail",
    text: "secret=pA7!\rcV2@kL9 after",
    kind: "password assignment" as const,
    durable: `[redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER} after`,
    sanitizedMcp: `[redacted] ${AMBIGUOUS_CONTINUATION_MARKER} after`,
    leakedSuffix: "cV2@kL9",
  },
  {
    name: "CR inside quoted value with closing delimiter and tail",
    text: 'password="pA\r7!cV2@kL9" after',
    kind: "password assignment" as const,
    durable: "[redacted password assignment]\r after",
    sanitizedMcp: "[redacted] after",
    leakedSuffix: '7!cV2@kL9"',
  },
] as const;

export const SYNTHETIC_MULTI_CONTROL_PROBES = [
  {
    name: "multiple controls in unquoted value each disclose ambiguity",
    text: "secret=pA\r7!\tcV2@kL9 after",
    kind: "password assignment" as const,
    durable: `[redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER}\t${AMBIGUOUS_CONTINUATION_MARKER} after`,
    sanitizedMcp: `[redacted] ${AMBIGUOUS_CONTINUATION_MARKER} ${AMBIGUOUS_CONTINUATION_MARKER} after`,
  },
  {
    name: "multiple controls in quoted credential value preserve delimiters without markers",
    text: 'token="tK8!\ncV2\r@kL9" after',
    kind: "credential assignment" as const,
    durable: "[redacted credential assignment]\n\r after",
    sanitizedMcp: "[redacted] after",
  },
] as const;

export const SYNTHETIC_EOF_AMBIGUITY_VECTORS = [
  {
    name: "punctuation-led EOF record is conservatively disclosed",
    text: "before password=ab12\n@after",
    kind: "password assignment" as const,
    durable: `before [redacted password assignment]\n${AMBIGUOUS_CONTINUATION_MARKER}`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER}`,
  },
  {
    name: "mixed EOF record is conservatively disclosed",
    text: "before password=ab12\raB1!shape",
    kind: "password assignment" as const,
    durable: `before [redacted password assignment]\r${AMBIGUOUS_CONTINUATION_MARKER}`,
    sanitizedMcp: `before [redacted] ${AMBIGUOUS_CONTINUATION_MARKER}`,
  },
] as const;

export interface TeachProvenanceSecretVector {
  name: string;
  text: string;
  raw: string;
}

/**
 * Synthetic secret subjects/comments for the teach provenance redaction
 * battery. Token shapes mirror the closure families above; `raw` is the
 * exact fragment that must not survive `redactSecretsAtBoundary`.
 */
export const SYNTHETIC_TEACH_PROVENANCE_VECTORS: readonly TeachProvenanceSecretVector[] = [
  { name: "bare synthetic test key", text: "sk-test-00000000000000000000", raw: "sk-test-00000000000000000000" },
  { name: "commit subject carrying a test key", text: "fix login with sk-test-00000000000000000000 deployed", raw: "sk-test-00000000000000000000" },
  { name: "openai project key", text: "sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4", raw: "sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4" },
  { name: "anthropic key", text: "sk-ant-abcdefghijklmnopqrst123456", raw: "sk-ant-abcdefghijklmnopqrst123456" },
  { name: "aws access key", text: "AKIAABCDEFGHIJKLMNOP", raw: "AKIAABCDEFGHIJKLMNOP" },
  { name: "github personal token", text: "ghp_abcdefghijklmnopqrstuvwxyz1234567890", raw: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
  { name: "github fine-grained token", text: "github_pat_abcdefghijklmnopqrstuvwxyz1234567890ABCD", raw: "github_pat_abcdefghijklmnopqrstuvwxyz1234567890ABCD" },
  { name: "github oauth token", text: "gho_abcdefghijklmnopqrstuvwxyz1234567890", raw: "gho_abcdefghijklmnopqrstuvwxyz1234567890" },
  { name: "npm token", text: "npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", raw: "npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
  { name: "slack bot token", text: "xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt", raw: "xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt" },
  { name: "slack user token", text: "xoxp-123456789012-abcdefghij", raw: "xoxp-123456789012-abcdefghij" },
  { name: "private key header", text: "-----BEGIN RSA PRIVATE KEY-----", raw: "-----BEGIN RSA PRIVATE KEY-----" },
  { name: "password assignment", text: "password=pA7!cV2@kL9", raw: "pA7!cV2@kL9" },
  { name: "quoted secret assignment", text: "secret='rT8$wX3!nM6'", raw: "rT8$wX3!nM6" },
  { name: "bare secret assignment", text: "secret=8f3kL9!qZ2#xM7@nB4", raw: "8f3kL9!qZ2#xM7@nB4" },
  { name: "token credential assignment", text: "token=tok_aB3d-E5fG7hI9jK2mN4pQ6", raw: "tok_aB3d-E5fG7hI9jK2mN4pQ6" },
  { name: "api key credential assignment", text: 'api_key="api-aB3dE5fG7hI9jK2mN4pQ6"', raw: "api-aB3dE5fG7hI9jK2mN4pQ6" },
  { name: "bearer credential assignment", text: "authorization: Bearer syn_aB3dE5fG7hI9jK2mN4pQ6", raw: "syn_aB3dE5fG7hI9jK2mN4pQ6" },
  { name: "comment quoting an oauth token", text: "fix auth with gho_abcdefghijklmnopqrstuvwxyz1234567890 merged", raw: "gho_abcdefghijklmnopqrstuvwxyz1234567890" },
  { name: "comment quoting a rotated slack token", text: "deploy key xoxp-123456789012-abcdefghij rotated", raw: "xoxp-123456789012-abcdefghij" },
];
