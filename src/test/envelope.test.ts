import test from "node:test";
import assert from "node:assert/strict";
import { isAgentEnvelopeText } from "../core/envelope.js";

test("detects a task-notification envelope at the start", () => {
  assert.equal(isAgentEnvelopeText("<task-notification>\nCI run finished\n</task-notification>"), true);
});

test("detects an envelope behind leading whitespace", () => {
  assert.equal(isAgentEnvelopeText("\n  <task-notification> <task-id>x</task-id>"), true);
});

test("detects a system-reminder envelope", () => {
  assert.equal(isAgentEnvelopeText("<system-reminder>background note</system-reminder>"), true);
});

test("a rationale that mentions the tag mid-text is not an envelope", () => {
  assert.equal(isAgentEnvelopeText("fix parsing of <task-notification> wrappers in the adapter"), false);
});

test("ordinary rationale is not an envelope", () => {
  assert.equal(isAgentEnvelopeText("pin the release check before publishing"), false);
});

test("empty text is not an envelope", () => {
  assert.equal(isAgentEnvelopeText(""), false);
});
