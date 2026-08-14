export interface SecretClosureVector {
  readonly name: string;
  readonly text: string;
  readonly kind: "password assignment" | "credential assignment" | "openai key";
  readonly replacement: "[redacted password assignment]" | "[redacted credential assignment]";
}

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
    replacement: "[redacted password assignment]",
  },
  {
    name: "LF-split API key name",
    text: '"api_\nkey": "api-aB3dE5fG7hI9jK2mN4pQ6"',
    kind: "credential assignment",
    replacement: "[redacted credential assignment]",
  },
  {
    name: "CR-split secret value",
    text: "secret=pA7!cV2\r@kL9",
    kind: "password assignment",
    replacement: "[redacted password assignment]",
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
