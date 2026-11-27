import assert from "node:assert/strict";
import test from "node:test";
import { loadHarnessDecoder } from "../../harnesses/index.js";
import { projectToAgent } from "../../harnesses/projections/to-agent.js";

test("Claude transcript pairs tool calls and results across lines within the same session", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer();
  assert.deepEqual(reducer.consume(JSON.stringify({
    type: "assistant", sessionId: "session-a", uuid: "turn-a", message: { content: [
      { type: "tool_use", id: "tool-a", name: "Bash", input: { command: "npm test" } },
      { type: "tool_use", id: "unmatched", name: "Write", input: { file_path: "planned.ts" } },
    ] },
  })), []);
  const result = { type: "tool_result", tool_use_id: "tool-a", content: "Exit code 7\nbuild failed", is_error: true };
  assert.deepEqual(reducer.consume(JSON.stringify({
    type: "user", sessionId: "session-b", message: { content: [result] },
  })), []);
  const [event] = reducer.consume(JSON.stringify({
    type: "user", sessionId: "session-a", message: { content: [result] },
  }));
  assert.equal(event?.kind, "tool-outcome");
  assert.equal(event.toolName, "Bash");
  assert.equal(event.outcome.command, "npm test");
  assert.equal(event.outcome.toolUseId, "tool-a");
  assert.equal(event.outcome.exitCode, 7);
  assert.equal(event.outcome.exitCodeSource, "header");
  assert.equal(event.outcome.output, "build failed");
  assert.deepEqual(reducer.finish(), []);
});

test("Codex transcript combines item updates with a terminal item", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer({ sessionId: "session-a" });
  assert.deepEqual(reducer.consume(JSON.stringify({
    type: "item.started", item: { id: "item-1", type: "command_execution", command: "npm test" },
  })), []);
  assert.deepEqual(reducer.consume(JSON.stringify({
    type: "item.updated", item: { id: "item-1", aggregated_output: "build failed" },
  })), []);
  const [event] = reducer.consume(JSON.stringify({
    type: "item.completed", item: { id: "item-1", exit_code: 7 },
  }));
  assert.equal(event?.kind, "tool-outcome");
  assert.equal(event.outcome.command, "npm test");
  assert.equal(event.outcome.exitCode, 7);
  assert.equal(event.outcome.exitCodeSource, "structured");
  assert.equal(event.outcome.output, "build failed");
});

test("Codex rollout pairs function calls by call ID", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer();
  for (const record of [
    { type: "session_meta", payload: { id: "session-a", cwd: process.cwd() } },
    { type: "response_item", payload: {
      type: "function_call", name: "exec_command", call_id: "call-a", arguments: '{"cmd":"npm test"}',
    } },
  ]) assert.deepEqual(reducer.consume(JSON.stringify(record)), []);
  const [event] = reducer.consume(JSON.stringify({
    type: "response_item", payload: { type: "function_call_output", call_id: "call-a", output: "build failed" },
  }));
  assert.equal(event?.kind, "tool-outcome");
  assert.equal(event.sessionId, "session-a");
  assert.equal(event.outcome.command, "npm test");
  assert.equal(event.outcome.exitCodeSource, "unknown");
});

test("DSH transcript preserves the scan's raw thinking fidelity and source", async () => {
  const decoder = await loadHarnessDecoder("dsh");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer({ logPath: "session.jsonl.zstd" });
  assert.deepEqual(reducer.consume("damaged line"), []);
  assert.deepEqual(reducer.consume('{"session":"session-a","version":1}'), []);
  assert.deepEqual(reducer.consume('{"type":"reasoning","seq":3,"time":42,"data":{"reasoning":"investigate the build"}}'), [{
    kind: "rationale", agent: "dsh", sessionId: "session-a", turnRef: "3", ts: 42,
    text: "investigate the build", fidelity: "raw", source: "log-thinking", logPath: "session.jsonl.zstd",
  }]);
  assert.deepEqual(reducer.finish(), []);
});

test("Codex agent projection carries apply_patch move coverage and its digest", async () => {
  const decoder = await loadHarnessDecoder("codex");
  const decoded = decoder?.decodeHook({
    hook_event_name: "PostToolUse", session_id: "session-a", turn_id: "turn-a", cwd: process.cwd(),
    tool_name: "apply_patch", tool_input: {
      command: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch",
    },
  });
  assert.ok(decoded);
  const result = projectToAgent(decoded);
  assert.equal(result?.action, "append");
  assert.deepEqual(result.coveragePaths, ["old.ts", "new.ts"]);
  assert.equal(result.coveragePathsComplete, true);
  assert.match(result.coverageDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.deepEqual(decoded.outcome?.edits.map((edit) => edit.path), result.coveragePaths);
  assert.equal(decoded.outcome?.coverageDigest, result.coverageDigest);
});
