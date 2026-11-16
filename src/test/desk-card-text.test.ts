import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPrompt, labelChip, promptTitle } from "../desk/card-text.js";

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
