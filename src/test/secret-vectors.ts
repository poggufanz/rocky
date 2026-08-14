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
    name: "LF after complete password value",
    text: "before password=abcd\nafter words",
    kind: "password assignment",
    durable: "before [redacted password assignment]\nafter words",
    sanitizedMcp: "before [redacted] after words",
  },
  {
    name: "TAB after complete token value",
    text: "before token=abcd1234\tafter words",
    kind: "credential assignment",
    durable: "before [redacted credential assignment]\tafter words",
    sanitizedMcp: "before [redacted] after words",
  },
  {
    name: "CR after complete secret value",
    text: "before secret=abcd1234\rafter words",
    kind: "password assignment",
    durable: "before [redacted password assignment]\rafter words",
    sanitizedMcp: "before [redacted] after words",
  },
  {
    name: "punctuation-led ordinary LF record after simple value",
    text: "before password=abcd\n@after mention",
    kind: "password assignment",
    durable: "before [redacted password assignment]\n@after mention",
    sanitizedMcp: "before [redacted] @after mention",
  },
] as const;

interface EveryControlSplitVector {
  readonly name: string;
  readonly text: string;
  readonly cleartext: string;
  readonly kind: "password assignment" | "openai key";
  readonly durable: string;
  readonly sanitizedMcp: string;
  readonly control: "\t" | "\n" | "\r";
  readonly split: number;
}

const CONTROL_SPLIT_BASES = [
  {
    name: "unquoted secret assignment",
    text: "secret=pA7!cV2@kL9",
    kind: "password assignment" as const,
    replacement: "[redacted password assignment]",
  },
  {
    name: "modern key assignment",
    text: "token=sk-proj-aB3dE5fG7hI9-jK2mN4pQ6rS8tU0vW1xY2zA4",
    kind: "openai key" as const,
    replacement: "[redacted credential assignment]",
  },
] as const;

/** Every internal split point proves control stripping, mapped replacement, and overlap policy. */
export const SYNTHETIC_EVERY_CONTROL_SPLIT_VECTORS: readonly EveryControlSplitVector[] = CONTROL_SPLIT_BASES.flatMap(
  (base) => (["\t", "\n", "\r"] as const).flatMap((control) =>
    Array.from({ length: base.text.length - 1 }, (_, index) => {
      const split = index + 1;
      const valueStart = base.text.indexOf("=") + 1;
      const ambiguous = split >= valueStart;
      return {
        name: `${base.name} ${JSON.stringify(control)} split ${split}`,
        text: `${base.text.slice(0, split)}${control}${base.text.slice(split)}`,
        cleartext: base.text,
        kind: base.kind,
        durable: `${base.replacement}${control}${ambiguous ? AMBIGUOUS_CONTINUATION_MARKER : ""}`,
        sanitizedMcp: `[redacted] ${ambiguous ? AMBIGUOUS_CONTINUATION_MARKER : ""}`.trim(),
        control,
        split,
      };
    }),
  ),
);

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
