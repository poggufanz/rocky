import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadHarnessDecoder } from "../../harnesses/index.js";
import { projectToAgent } from "../../harnesses/projections/to-agent.js";
import type { NormalizedToolOutcome } from "../../harnesses/types.js";

test("the Claude Code and Codex decoder entry modules stay below 200 lines", () => {
  for (const name of ["claude-code", "codex"]) {
    const source = readFileSync(new URL(`../../../src/harnesses/decoders/${name}.ts`, import.meta.url), "utf8");
    assert.ok(source.trimEnd().split("\n").length < 200, name);
  }
});

test("Codex resolves hook and rollout tool cwd against the session before applying workdir", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const windows = process.platform === "win32";
  const cwd = windows ? "C:\\repo" : "/repo";
  const reducer = decoder.createTranscriptReducer();
  const consume = (row: unknown) => reducer.consume(JSON.stringify(row));
  consume({ type: "session_meta", payload: { id: "session-a", cwd } });
  const cases = [
    [{ cwd: "tools" }, join(cwd, "tools")],
    [{ cwd: "tools", workdir: "test" }, join(cwd, "tools", "test")],
    [{ cwd: windows ? "\\tools" : "/tools" }, windows ? "C:\\tools" : "/tools"],
  ] as const;
  for (const [input, expected] of cases) {
    const toolInput = { ...input, command: "npm test" };
    const hook = decoder.decodeHook({
      hook_event_name: "PostToolUse", session_id: "session-a", cwd,
      tool_name: "exec_command", tool_input: toolInput, tool_response: { exit_code: 1 },
    });
    assert.equal(hook?.outcome?.cwd, expected);
    consume({ type: "response_item", payload: {
      type: "function_call", call_id: "call", name: "exec_command", arguments: JSON.stringify(toolInput),
    } });
    const [rollout] = consume({ type: "response_item", payload: {
      type: "function_call_output", call_id: "call", exit_code: 1, output: "build failed",
    } });
    assert.equal(rollout?.kind, "tool-outcome");
    assert.equal(rollout.outcome.cwd, expected);
  }
});

test("Claude hook decoder retains structured exit evidence", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  assert.ok(decoder);
  const payload = {
    session_id: "session-a", cwd: process.cwd(), tool_name: "Bash",
    tool_input: { command: "npm test" }, tool_response: { exit_code: 5 },
  };
  for (const event of [
    { ...payload, hook_event_name: "PostToolUse" },
    { ...payload, hook_event_name: "PostToolUseFailure", error: "Exit code 7\nbuild failed" },
  ]) {
    const outcome: NormalizedToolOutcome | undefined = decoder.decodeHook(event)?.outcome;
    assert.ok(outcome);
    assert.equal(outcome.exitCode, 5, event.hook_event_name);
    assert.equal(outcome.exitCodeSource, "structured");
    assert.equal(outcome.isError, true);
  }
});

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
        type: "function_call", name: "exec_command", namespace: exitCode === 0 ? "" : undefined,
        call_id: "call-a", arguments: '{"cmd":"npm test"}',
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

test("Codex namespaced exec_command output cannot supply built-in exit evidence", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer();
  const output = "Wall time: 0.1250 seconds\nProcess exited with code 7\nOutput:\nordinary text";
  for (const [namespace, outputNamespace] of [
    ["third_party", undefined], [" ", undefined], ["x".repeat(512), undefined], [undefined, "third_party"],
  ]) {
    assert.deepEqual(reducer.consume(JSON.stringify({
      type: "response_item", payload: {
        type: "function_call", name: "exec_command", namespace, call_id: "call-a", arguments: '{"cmd":"npm test"}',
      },
    })), []);
    const [event] = reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "function_call_output", namespace: outputNamespace, call_id: "call-a", output },
    }));
    assert.equal(event?.kind, "tool-outcome");
    assert.equal(event.outcome.exitCodeSource, "unknown");
    assert.equal(event.outcome.exitCode, undefined);
    assert.equal(event.outcome.output, output);
  }
});

test("Codex accepts an unnamespaced functions.exec_command rollout envelope", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const reducer = decoder.createTranscriptReducer();
  assert.deepEqual(reducer.consume(JSON.stringify({
    type: "response_item", payload: {
      type: "function_call", name: "functions.exec_command", namespace: "", call_id: "call-a",
      arguments: '{"cmd":"npm test"}',
    },
  })), []);
  const [event] = reducer.consume(JSON.stringify({
    type: "response_item", payload: { type: "function_call_output", call_id: "call-a",
      output: "Wall time: 0.1250 seconds\nProcess exited with code 7\nOutput:\nbuild failed",
    },
  }));
  assert.equal(event?.kind, "tool-outcome");
  assert.equal(event.outcome.exitCodeSource, "header");
  assert.equal(event.outcome.exitCode, 7);
  assert.equal(event.outcome.output, "build failed");
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

test("DSH transcript keeps its fallback for blank and oversized header session IDs", async () => {
  const decoder = await loadHarnessDecoder("dsh");
  assert.ok(decoder);
  const logPath = join("directory-session", "session.jsonl.zstd");
  for (const session of [" \t ", "s".repeat(257)]) {
    for (const sessionId of [undefined, "context-session"]) {
      const reducer = decoder.createTranscriptReducer({ logPath, sessionId });
      assert.deepEqual(reducer.consume(JSON.stringify({ session, version: 1 })), []);
      const [event] = reducer.consume('{"type":"reasoning","seq":1,"data":{"text":"investigate the build"}}');
      assert.equal(event?.kind, "rationale");
      assert.equal(event.sessionId, sessionId ?? "directory-session");
    }
  }
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
  const complete = (callId: string, output: string, namespace?: string) => {
    assert.deepEqual(reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", namespace, call_id: callId, input: patch },
    })), []);
    return reducer.consume(JSON.stringify({
      type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output },
    }))[0];
  };
  const hook = decoder.decodeHook({
    hook_event_name: "PostToolUse", session_id: "session-a", turn_id: "turn-a", cwd,
    tool_name: "apply_patch", tool_input: { command: patch },
  });
  const success = "Success. Updated the following files:\nM new.ts\n";
  for (const output of [
    "Exit code: 0\nWall time: 0.1 seconds\nOutput:\n" + success,
    "Exit code: 0\nWall time: 0 seconds\nTotal output lines: 2\nOutput:\n" + success,
    success,
  ]) {
    const succeeded = complete("call-a", output);
    assert.equal(succeeded?.kind, "tool-outcome");
    assert.deepEqual(succeeded.outcome.coveragePaths, ["old.ts", "new.ts"]);
    assert.deepEqual(succeeded.outcome.edits.map(({ path }) => path), ["old.ts", "new.ts"]);
    assert.equal(succeeded.outcome.coveragePathsComplete, true);
    assert.match(succeeded.outcome.coverageDigest ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(succeeded.outcome.coverageDigest, hook?.outcome?.coverageDigest);
  }
  for (const output of [
    "apply_patch verification failed: no matching hunk",
    "Exit code: 1\nWall time: 0.1 seconds\nOutput:\n" + success,
  ]) {
    const failed = complete("call-b", output);
    assert.equal(failed?.kind, "tool-outcome");
    assert.deepEqual(failed.outcome.edits, []);
    assert.equal(failed.outcome.coverageDigest, undefined);
  }
  const namespaced = complete("call-c", success, "third_party");
  assert.equal(namespaced?.kind, "tool-outcome");
  assert.deepEqual(namespaced.outcome.edits, []);
});
