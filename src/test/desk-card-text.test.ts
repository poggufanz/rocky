import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPrompt, labelChip, promptTitle, sequenceSentence } from "../desk/card-text.js";
import type { StoredBlock, StoredCard } from "../desk/cards-record.js";

interface LabelChipVector {
  readonly label: {
    readonly id: string;
    readonly args?: Record<string, unknown>;
  };
  readonly kind: string | null;
  readonly chip: string;
}

type PromptKindVector =
  | { readonly prompt: string; readonly kind: "plain" | "task_notification" | "cross_session" }
  | { readonly prompt: string; readonly kind: "slash_command"; readonly name: string; readonly args: string };

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const labelChipVectors = JSON.parse(
  readFileSync(join(packageRoot, "fixtures", "cards", "label-chips-en.json"), "utf8"),
) as readonly LabelChipVector[];

const promptKindVectors = JSON.parse(
  readFileSync(join(packageRoot, "fixtures", "cards", "prompt-kinds.json"), "utf8"),
) as readonly PromptKindVector[];

test("labelChip matches every vector in fixtures/cards/label-chips-en.json", () => {
  assert.ok(labelChipVectors.length >= 40);
  for (const vector of labelChipVectors) {
    assert.equal(
      labelChip(vector.label, vector.kind),
      vector.chip,
      `chip mismatch for ${vector.label.id} (${String(vector.kind)})`,
    );
  }
});

test("labelChip falls back gracefully for unknown ids, missing args, and custom kinds", () => {
  assert.equal(labelChip({ id: "future_label", args: { count: 2 } }, "function"), "future_label");
  assert.equal(labelChip({ id: "future_label" }, null), "future_label");
  assert.equal(labelChip({ id: "constructor" }, "function"), "constructor");
  assert.equal(labelChip({ id: "toString" }, "function"), "toString");
  assert.equal(labelChip({ id: "__proto__" }, null), "__proto__");
  assert.equal(labelChip({ id: "call_added", args: {} }, "function"), "call_added");
  assert.equal(labelChip({ id: "call_removed" }, "method"), "call_removed");
  assert.equal(labelChip({ id: "symbol_added", args: {} }, "macro"), "new macro");
  assert.equal(labelChip({ id: "symbol_removed", args: {} }, ""), "file removed");
  assert.equal(labelChip({ id: "symbol_renamed", args: {} }, "namespace"), "namespace renamed");
});

test("classifyPrompt matches every vector in fixtures/cards/prompt-kinds.json", () => {
  assert.ok(promptKindVectors.length >= 15);
  for (const vector of promptKindVectors) {
    const actual = classifyPrompt(vector.prompt);
    if (vector.kind === "slash_command") {
      assert.deepEqual(
        actual,
        { kind: "slash_command", name: vector.name, args: vector.args },
        `slash command mismatch for ${JSON.stringify(vector.prompt)}`,
      );
    } else {
      assert.deepEqual(
        actual,
        { kind: vector.kind },
        `prompt kind mismatch for ${JSON.stringify(vector.prompt)}`,
      );
    }
  }
});

test("promptTitle formats plain, notification, cross-session, and slash commands", () => {
  assert.equal(promptTitle("  Fix the bug in cart.ts  "), "Fix the bug in cart.ts");
  assert.equal(promptTitle("\n\r\n  \t \n  First meaningful line\r\nSecond line"), "First meaningful line");
  assert.equal(promptTitle("   \n\t\r\n  "), "");

  assert.equal(
    promptTitle("<task-notification>\n<task-id>bg-1</task-id>\n</task-notification>"),
    "Background task notice",
  );
  assert.equal(
    promptTitle("  \n<cross-session-message from=\"sess-1\">hello</cross-session-message>"),
    "Message from another session",
  );
  assert.equal(
    promptTitle("<command-name>/compact</command-name>"),
    "/compact",
  );
  assert.equal(
    promptTitle("\n <command-message>review</command-message>\n<command-name>review</command-name>\n<command-args>64\n--fast</command-args>"),
    "/review 64 --fast",
  );
});

const BANNED_WORDS = /\b(?:because|so that|in order to|to ensure|fixed|resolved)\b/i;

function cardWithSequence(
  blocks: StoredBlock[],
  sequence: StoredCard["sequence"],
): StoredCard {
  return {
    v: 1,
    card_id: "c-seq",
    rev: 1,
    root: "/work/app",
    started_ms: 1000,
    ended_ms: 5000,
    prompt: "p",
    blocks,
    sequence,
  };
}

function seqBlock(seq: number, path: string, symbol: StoredBlock["symbol"] = null): StoredBlock {
  return {
    seq,
    path,
    symbol,
    labels: [],
    importance: "low",
  };
}

test("sequenceSentence produces exact EN sentence for single edit without and with error_names", () => {
  const noErr = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts")],
      { pattern: "fix_after_fail", command: "npm test", exit_code: 1, edit_seqs: [1] },
    ),
  );
  assert.equal(noErr, "`npm test` failed (exit 1). Edited src/auth.ts. `npm test` passed.");
  assert.doesNotMatch(noErr!, BANNED_WORDS);

  const withErr = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts")],
      { pattern: "fix_after_fail", command: "npm test", exit_code: 1, edit_seqs: [1], error_names: "auth.ts" },
    ),
  );
  assert.equal(
    withErr,
    "`npm test` failed (exit 1). The error names auth.ts. Edited src/auth.ts. `npm test` passed.",
  );
  assert.doesNotMatch(withErr!, BANNED_WORDS);
});

test("sequenceSentence formats symbols with U+203A and parens for functions and methods", () => {
  const fnSentence = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts", { kind: "function", name: "verifyToken" })],
      { pattern: "fix_after_fail", command: "npm test", exit_code: 1, edit_seqs: [1] },
    ),
  );
  assert.equal(
    fnSentence,
    "`npm test` failed (exit 1). Edited src/auth.ts \u203a verifyToken(). `npm test` passed.",
  );

  const structSentence = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts", { kind: "struct", name: "Token" })],
      { pattern: "fix_after_fail", command: "npm test", exit_code: 1, edit_seqs: [1] },
    ),
  );
  assert.equal(
    structSentence,
    "`npm test` failed (exit 1). Edited src/auth.ts \u203a Token. `npm test` passed.",
  );
});

test("sequenceSentence walks edit_seqs in chronological order, deduplicates, and summarizes N more", () => {
  const ordered = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/later.ts"), seqBlock(2, "src/earlier.ts"), seqBlock(3, "src/third.ts")],
      { pattern: "fix_after_fail", command: "npm test", exit_code: 2, edit_seqs: [99, 2, 2, 1, 3, 1] },
    ),
  );
  assert.equal(
    ordered,
    "`npm test` failed (exit 2). Edited src/earlier.ts and 2 more. `npm test` passed.",
  );
  assert.doesNotMatch(ordered!, BANNED_WORDS);
});

test("sequenceSentence normalizes whitespace, sanitizes control chars, and cuts command at 80 chars", () => {
  const longCmd = "x".repeat(120);
  const longLine = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts")],
      { pattern: "fix_after_fail", command: longCmd, exit_code: 1, edit_seqs: [1] },
    ),
  );
  const expectedCmd = `${"x".repeat(79)}\u2026`;
  assert.equal(
    longLine,
    `\`${expectedCmd}\` failed (exit 1). Edited src/auth.ts. \`${expectedCmd}\` passed.`,
  );

  const ctrlLine = sequenceSentence(
    cardWithSequence(
      [seqBlock(1, "src/auth.ts")],
      { pattern: "fix_after_fail", command: "  npm\u0007test   --watch\n", exit_code: 1, edit_seqs: [1] },
    ),
  );
  assert.equal(
    ctrlLine,
    "`npm test --watch` failed (exit 1). Edited src/auth.ts. `npm test --watch` passed.",
  );
});

test("sequenceSentence returns undefined when sequence is absent, empty cmd, or no edit_seq resolves", () => {
  assert.equal(sequenceSentence(cardWithSequence([seqBlock(1, "src/auth.ts")], undefined)), undefined);
  assert.equal(sequenceSentence(cardWithSequence([seqBlock(1, "src/auth.ts")], null)), undefined);
  assert.equal(
    sequenceSentence(
      cardWithSequence([seqBlock(1, "src/auth.ts")], {
        pattern: "fix_after_fail",
        command: "   \n ",
        exit_code: 1,
        edit_seqs: [1],
      }),
    ),
    undefined,
  );
  assert.equal(
    sequenceSentence(
      cardWithSequence([seqBlock(1, "src/auth.ts")], {
        pattern: "fix_after_fail",
        command: "npm test",
        exit_code: 1,
        edit_seqs: [2, 3],
      }),
    ),
    undefined,
  );
});
