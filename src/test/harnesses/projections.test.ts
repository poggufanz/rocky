import assert from "node:assert/strict";
import { join } from "node:path";
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
    targetPaths: ["planned.ts"], fileRel: "observed.ts", repoRoot: process.cwd(),
    edge: { kind: "wrote_version", basis: "direct", from: "a", to: "b" },
  };
  for (const key of forbidden) {
    Object.defineProperty(payload, key, {
      enumerable: true, get() { reads.push(key); return `private-${key}`; },
    });
  }
  const decoded = decoder.decodeHook(payload);
  assert.ok(decoded);
  const projected = projectToListening(decoded, { hostConsent: true, repoConsent: true, surface: "cli" });
  assert.ok(projected);
  assert.equal(projected.refs.session, "session-a");
  assert.equal(projected.refs.fileRel, "observed.ts");
  assert.equal(projected.edge, undefined);
  assert.equal(projectToListening(decoded, { hostConsent: false, surface: "cli" }), undefined);
  assert.deepEqual(reads, []);
  assert.doesNotMatch(JSON.stringify(projected), /private-|planned\.ts|wrote_version|direct/u);
});

test("Listening omits the repository and relative filename when repo consent is denied", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  const decoded = decoder?.decodeHook({ repoRoot: process.cwd(), fileRel: "private.ts", sessionId: "session-a" });
  assert.ok(decoded);
  const envelope = projectToListening(decoded, { hostConsent: true, repoConsent: false, surface: "cli" });
  assert.ok(envelope);
  assert.equal(envelope.consent.repo, false);
  assert.equal(envelope.repoRoot, undefined);
  assert.deepEqual(envelope.refs, { session: "session-a" });
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
  const cwd = join(process.cwd(), "tool-workdir");
  const decoded = decoder?.decodeHook({
    hook_event_name: "PostToolUse", thread_id: "session-a", cwd: process.cwd(), tool_name: "exec_command",
    tool_use_id: "tool-a", agent_id: "agent-a", tool_input: { cmd: "npm test", cwd: process.cwd(), workdir: cwd },
    tool_response: { exit_code: 7, output: "build failed" },
  });
  assert.ok(decoded);
  assert.equal(decoded.outcome?.exitCodeSource, "structured");
  assert.deepEqual(projectToToolResult(decoded), {
    kind: "failure", cmd: "npm test", cwd, exitCode: 7, body: "build failed",
    agent: { vendor: "codex", session: "session-a", toolUseId: "tool-a", agentId: "agent-a" },
  });
});

test("Codex hook output that resembles an exit header stays ordinary output", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  for (const output of [
    "Exit code 7\nprinted by the command",
    "Wall time: 0.1250 seconds\nProcess exited with code 7\nOutput:\nprinted by the command",
  ]) {
    const decoded = decoder.decodeHook({
      hook_event_name: "PostToolUse", session_id: "session-a", cwd: process.cwd(),
      tool_name: "exec_command", tool_input: { command: "npm test" }, tool_response: output,
    });
    assert.ok(decoded);
    assert.equal(decoded.outcome?.output, output);
    assert.deepEqual(projectToToolResult(decoded), { kind: "skip", reason: "no-exit-header" });
  }
});

test("Codex resolves relative tool workdirs from the input or session cwd", async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const sessionCwd = join(process.cwd(), "session");
  const inputCwd = join(process.cwd(), "input");
  for (const [cwd, base] of [
    [undefined, sessionCwd],
    [inputCwd, inputCwd],
    ["tools", join(sessionCwd, "tools")],
  ] as const) {
    const decoded = decoder.decodeHook({
      hook_event_name: "PostToolUse", session_id: "session-a", cwd: sessionCwd,
      tool_name: "exec_command", tool_input: { command: "npm test", cwd, workdir: "packages/one" },
      tool_response: { exit_code: 7, output: "build failed" },
    });
    assert.ok(decoded);
    const outcome = projectToToolResult(decoded);
    assert.equal(outcome?.kind, "failure");
    assert.equal(outcome.exitCode, 7);
    assert.equal(outcome.cwd, join(base, "packages", "one"));
  }
});

test("Codex resolves Windows input cwd before a relative workdir", { skip: process.platform !== "win32" }, async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  for (const [cwd, expectedCwd] of [
    ["\\tools", "C:\\tools\\sub"],
    ["C:tools", "C:\\repo\\tools\\sub"],
    ["D:tools", "C:\\repo\\sub"],
  ]) {
    const decoded = decoder.decodeHook({
      hook_event_name: "PostToolUse", session_id: "session-a", cwd: "C:\\repo",
      tool_name: "exec_command", tool_input: { command: "npm test", cwd, workdir: "sub" },
      tool_response: { exit_code: 7, output: "build failed" },
    });
    assert.ok(decoded);
    const outcome = projectToToolResult(decoded);
    assert.equal(outcome?.kind, "failure");
    assert.equal(outcome.cwd, expectedCwd);
  }
});

test("Codex anchors Windows drive-relative and root-relative workdirs", { skip: process.platform !== "win32" }, async () => {
  const decoder = await loadHarnessDecoder("codex");
  assert.ok(decoder);
  const project = (cwd: string, workdir: string) => {
    const decoded = decoder.decodeHook({
      hook_event_name: "PostToolUse", session_id: "session-a", cwd,
      tool_name: "exec_command", tool_input: { command: "npm test", workdir },
      tool_response: { exit_code: 7, output: "build failed" },
    });
    assert.ok(decoded);
    return projectToToolResult(decoded);
  };
  for (const [cwd, workdir, expectedCwd] of [
    ["C:\\repo", "C:packages", "C:\\repo\\packages"],
    ["C:\\repo", "c:packages", "C:\\repo\\packages"],
    ["C:\\repo", "\\packages", "C:\\packages"],
    ["\\\\server\\share\\repo", "\\packages", "\\\\server\\share\\packages"],
    ["\\\\?\\UNC\\server\\share\\repo", "\\packages", "\\\\?\\UNC\\server\\share\\packages"],
    ["\\\\?\\UNC\\server\\share\\repo", "\\..\\packages", "\\\\?\\UNC\\server\\share\\packages"],
  ]) {
    const outcome = project(cwd, workdir);
    assert.equal(outcome?.kind, "failure");
    assert.equal(outcome.cwd, expectedCwd);
  }
  assert.equal(project("C:\\repo", "D:packages"), undefined);
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
    { ...base, error: null },
    { ...base, error: 123 },
  ]) {
    const decoded = decoder.decodeHook(value);
    assert.ok(decoded);
    assert.deepEqual(projectToToolResult(decoded), parseToolResultPayload(Buffer.from(JSON.stringify(value))));
  }
});

test("Claude failures without an error field produce the explicit no-exit-header skip", async () => {
  const decoder = await loadHarnessDecoder("claude-code");
  const payload = {
    hook_event_name: "PostToolUseFailure", session_id: "session-a", cwd: process.cwd(),
    tool_name: "Bash", tool_input: { command: "npm test" },
  };
  const decoded = decoder?.decodeHook(payload);
  assert.ok(decoded);
  const skip = { kind: "skip", reason: "no-exit-header" };
  assert.deepEqual(projectToToolResult(decoded), skip);
  assert.deepEqual(parseToolResultPayload(Buffer.from(JSON.stringify(payload))), skip);
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
