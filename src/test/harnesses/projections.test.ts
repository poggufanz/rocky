import assert from "node:assert/strict";
import test from "node:test";
import { parseToolResultPayload } from "../../core/tool-result.js";
import { loadHarnessDecoder } from "../../harnesses/index.js";
import { projectToListening } from "../../harnesses/projections/to-listening.js";
import { projectToToolResult, renderSyncResponse } from "../../harnesses/projections/to-tool-result.js";

test("Listening reads only allowlisted metadata and treats PreToolUse paths as intent", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  assert.ok(decoder);
  const reads: string[] = [];
  const forbidden = ["prompt", "args", "response", "transcript", "thinking", "tool_input", "tool_response"];
  const payload = {
    hook_event_name: "PreToolUse", session_id: "session-a", tool_name: "Write",
    targetPaths: ["planned.ts"], fileRel: "observed.ts",
    edge: { kind: "wrote_version", basis: "direct", from: "a", to: "b" },
  };
  for (const key of forbidden) {
    Object.defineProperty(payload, key, {
      enumerable: true, get() { reads.push(key); return `private-${key}`; },
    });
  }
  const decoded = decoder.decodeHook(payload);
  assert.ok(decoded);
  const projected = projectToListening(decoded, { hostConsent: true, surface: "cli" });
  assert.ok(projected);
  assert.equal(projected.refs.session, "session-a");
  assert.equal(projected.refs.fileRel, "observed.ts");
  assert.equal(projected.edge, undefined);
  assert.equal(projectToListening(decoded, { hostConsent: false, surface: "cli" }), undefined);
  assert.deepEqual(reads, []);
  assert.doesNotMatch(JSON.stringify(projected), /private-|planned\.ts|wrote_version|direct/u);
});

test("Codex PostToolUse without an exit code is skipped even if it reports success", async () => {
  const decoder = await loadHarnessDecoder("codex");
  const decoded = decoder?.decodeHook({
    hook_event_name: "PostToolUse", threadId: "session-a", cwd: process.cwd(),
    toolName: "exec_command", toolInput: { cmd: "npm test" }, toolResponse: { status: "success" },
  });
  assert.ok(decoded);
  assert.equal(decoded.outcome?.exitCodeSource, "unknown");
  assert.deepEqual(projectToToolResult(decoded), { kind: "skip", reason: "no-exit-header" });
});

test("Codex PostToolUse with a structured nonzero exit is a failure with attribution", async () => {
  const decoder = await loadHarnessDecoder("codex");
  const cwd = process.cwd();
  const decoded = decoder?.decodeHook({
    hook_event_name: "PostToolUse", thread_id: "session-a", cwd, tool_name: "exec_command",
    tool_use_id: "tool-a", agent_id: "agent-a", tool_input: { cmd: "npm test" },
    tool_response: { exit_code: 7, output: "build failed" },
  });
  assert.ok(decoded);
  assert.equal(decoded.outcome?.exitCodeSource, "structured");
  assert.deepEqual(projectToToolResult(decoded), {
    kind: "failure", cmd: "npm test", cwd, exitCode: 7, body: "build failed",
    agent: { vendor: "codex", session: "session-a", toolUseId: "tool-a", agentId: "agent-a" },
  });
});

test("Claude sync response caps the serialized UTF-8 envelope at under 2 KiB", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  assert.ok(decoder);
  assert.equal(renderSyncResponse(decoder, "build note"), '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"build note"}}');
  const overhead = Buffer.byteLength(renderSyncResponse(decoder, ""));
  assert.equal(Buffer.byteLength(renderSyncResponse(decoder, "x".repeat(2047 - overhead))), 2047);
  assert.equal(renderSyncResponse(decoder, "x".repeat(2048 - overhead)), "{}");
  assert.equal(renderSyncResponse(decoder, "é".repeat(1024)), "{}");
  assert.equal(decoder.renderSyncResponse?.("é".repeat(1024)), "{}");
  const codex = await loadHarnessDecoder("codex");
  assert.ok(codex);
  assert.equal(renderSyncResponse(codex, "build note"), "{}");
});

test("Claude tool-result projection preserves shell pass, failure, and skip semantics", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  assert.ok(decoder);
  const base = {
    hook_event_name: "PostToolUseFailure", session_id: "session-a", cwd: process.cwd(),
    tool_name: "Bash", tool_use_id: "tool-a", agent_id: "agent-a",
    tool_input: { command: "npm test" }, error: "Exit code 7\r\nbuild failed",
  };
  for (const value of [
    base,
    { ...base, hook_event_name: "PostToolUse" },
    { ...base, error: "no exit header" },
    { ...base, is_interrupt: true },
    { ...base, hook_event_name: "PostToolUse", tool_response: { interrupted: true } },
    { ...base, tool_input: { ...base.tool_input, run_in_background: true } },
    { ...base, tool_input: { command: "rocky run npm" } },
    { ...base, error: undefined },
  ]) {
    const decoded = decoder.decodeHook(value);
    assert.ok(decoded);
    assert.deepEqual(projectToToolResult(decoded), parseToolResultPayload(Buffer.from(JSON.stringify(value))));
  }
});

test("tool-result projection does not request agent-owned edit inputs", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  let read = false;
  const decoded = decoder?.decodeHook({
    hook_event_name: "PostToolUse", tool_name: "Write", session_id: "session-a", prompt_id: "turn-a",
    get tool_input() { read = true; return {}; },
  });
  assert.ok(decoded);
  assert.equal(projectToToolResult(decoded), undefined);
  assert.equal(read, false);
});
