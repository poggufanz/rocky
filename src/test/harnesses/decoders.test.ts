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
    type: "response_item", payload: { type: "function_call_output", call_id: "call-a", output: "Exit code 7\nbuild failed" },
  }));
  assert.equal(event?.kind, "tool-outcome");
  assert.equal(event.sessionId, "session-a");
  assert.equal(event.outcome.command, "npm test");
  assert.equal(event.outcome.exitCodeSource, "unknown");
});

test("Codex rollout accepts the vendor exec envelope and keeps its command output separate", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer();
  for (const exitCode of [0, 7]) {
    assert.deepEqual(reducer.consume(JSON.stringify({
      type: "response_item", payload: {
        type: "function_call", name: "exec_command", call_id: "call-a", arguments: '{"cmd":"npm test"}',
      },
    })), []);
    const [event] = reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "function_call_output", call_id: "call-a",
        output: `Chunk ID: a87e2b\nWall time: 0.1250 seconds\nProcess exited with code ${exitCode}\nOriginal token count: 3\nOutput:\nExit code 14\n`,
      },
    }));
    assert.equal(event?.kind, "tool-outcome");
    assert.equal(event.outcome.exitCodeSource, "header");
    assert.equal(event.outcome.exitCode, exitCode);
    assert.equal(event.outcome.output, "Exit code 14\n");
  }
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

test("Codex apply_patch rollout keeps move coverage only for a successful completion", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const cwd = process.cwd();
  const reducer = decoder.createTranscriptReducer({ sessionId: "session-a" });
  const patch = "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch";
  assert.deepEqual(reducer.consume(JSON.stringify({ type: "session_meta", payload: { id: "session-a", cwd } })), []);
  const complete = (callId: string, output: string) => {
    assert.deepEqual(reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: callId, input: patch },
    })), []);
    return reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output },
    }))[0];
  };
  const succeeded = complete("call-a", "Success. Updated the following files:\nM new.ts\n");
  assert.equal(succeeded?.kind, "tool-outcome");
  assert.deepEqual(succeeded.outcome.coveragePaths, ["old.ts", "new.ts"]);
  assert.deepEqual(succeeded.outcome.edits.map(({ path }) => path), ["old.ts", "new.ts"]);
  assert.equal(succeeded.outcome.coveragePathsComplete, true);
  const hook = decoder.decodeHook({
    hook_event_name: "PostToolUse", session_id: "session-a", turn_id: "turn-a", cwd,
    tool_name: "apply_patch", tool_input: { command: patch },
  });
  assert.match(succeeded.outcome.coverageDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(succeeded.outcome.coverageDigest, hook?.outcome?.coverageDigest);
  const failed = complete("call-b", "apply_patch verification failed: no matching hunk");
  assert.equal(failed?.kind, "tool-outcome");
  assert.deepEqual(failed.outcome.edits, []);
  assert.equal(failed.outcome.coverageDigest, undefined);
});
