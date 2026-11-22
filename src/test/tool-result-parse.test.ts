import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  TOOL_RESULT_STDIN_CAP_BYTES,
  classifyRockyWrap,
  parseExitCodeHeader,
  parseToolResultPayload,
  type RockyWrap,
} from "../core/tool-result.js";

const ABS_CWD = tmpdir();
const ENCODER = new TextEncoder();

function encodePayload(payload: unknown): Uint8Array {
  return ENCODER.encode(JSON.stringify(payload));
}

function baseFailurePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUseFailure",
    session_id: "s",
    tool_name: "Bash",
    tool_use_id: "t1",
    cwd: ABS_CWD,
    tool_input: { command: "npm test" },
    error: "Exit code 1\nError: boom\n",
    is_interrupt: false,
    ...overrides,
  };
}

function basePassPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: "PostToolUse",
    session_id: "s",
    tool_name: "Bash",
    tool_use_id: "t1",
    cwd: ABS_CWD,
    tool_input: { command: "npm test" },
    tool_response: { stdout: "ok\n", stderr: "", interrupted: false },
    ...overrides,
  };
}

test("parseExitCodeHeader reads the first-line header and strips it", () => {
  assert.deepEqual(parseExitCodeHeader("Exit code 1\nError: x\n"), {
    exitCode: 1,
    body: "Error: x\n",
  });
  assert.deepEqual(parseExitCodeHeader("Exit code -2\r\nboom"), {
    exitCode: -2,
    body: "boom",
  });
  assert.deepEqual(parseExitCodeHeader("  Exit code 127  "), {
    exitCode: 127,
    body: "",
  });

  // Int32 boundary values are accepted.
  assert.deepEqual(parseExitCodeHeader("Exit code 2147483647\nmax"), {
    exitCode: 2147483647,
    body: "max",
  });
  assert.deepEqual(parseExitCodeHeader("Exit code -2147483648\nmin"), {
    exitCode: -2147483648,
    body: "min",
  });

  // Non-headers, malformed codes, out-of-range int32, and zero exit return undefined.
  for (const input of [
    "Command timed out",
    "Exit code \nx",
    "Exit code 1x",
    "Exit code 99999999999",
    "Exit code 2147483648\nover",
    "Exit code -2147483649\nunder",
    "Exit code 0\nx",
    "Exit code -0\nx",
  ]) {
    assert.equal(parseExitCodeHeader(input), undefined, `expected undefined for ${JSON.stringify(input)}`);
  }
});

test("classifyRockyWrap classifies wrapped, undecidable, and plain commands", () => {
  const cases: ReadonlyArray<readonly [string, RockyWrap]> = [
    // wrapped
    ['rocky run "npm test"', "wrapped"],
    ['rocky watch "npm test"', "wrapped"],
    ['FOO=1 BAR="a b" rocky run "npm test"', "wrapped"],
    ['cd app && rocky run "npm test"', "wrapped"],
    [`cd "my app"; rocky run 'npm test'`, "wrapped"],
    ['& rocky.cmd run "npm test"', "wrapped"],
    ['& "C:\\Users\\x\\AppData\\Roaming\\npm\\rocky.ps1" run "npm test"', "wrapped"],
    ['/usr/local/bin/rocky run "npm test"', "wrapped"],
    ["ROCKY.CMD run x", "wrapped"],
    ['rocky run "npm i && npm test"', "wrapped"],

    // undecidable
    ['npm test | rocky run "cat"', "undecidable"],
    ['(rocky run "npm test")', "undecidable"],
    ['rocky run "npm test" && npm i', "undecidable"],
    ['rocky run "a"; rocky run "b"', "undecidable"],
    ['cd app && rocky run "npm test" && npm i', "undecidable"],
    ['echo hi && rocky watch "x"', "undecidable"],
    ['rocky run "a"\nnpm test', "undecidable"],
    ['true && "/usr/local/bin/rocky" run false', "undecidable"],
    ["true && '/usr/local/bin/rocky' run false", "undecidable"],
    ['echo hi; & "C:\\x\\rocky.ps1" run y', "undecidable"],
    ['true && & "C:\\x\\rocky.ps1" run y', "undecidable"],
    ["echo hi; & 'C:\\x\\rocky.ps1' watch y", "undecidable"],
    ['("/usr/local/bin/rocky" run "npm test")', "undecidable"],
    [`bash -c 'rocky run "npm test"'`, "undecidable"],
    ['cmd /c "rocky run npm test"', "undecidable"],
    [`pwsh -Command "rocky run 'npm test'"`, "undecidable"],
    [`sh -c 'rocky watch "npm run dev"'`, "undecidable"],
    [`/bin/zsh -c 'cd app && rocky run "npm test"'`, "undecidable"],
    [`dash -c 'rocky watch "npm test"'`, "undecidable"],
    [`PowerShell.EXE -Command "rocky run 'npm test'"`, "undecidable"],
    ['C:\\Windows\\System32\\cmd.exe /c "rocky.cmd run npm test"', "undecidable"],
    [`wsl.exe -e sh -c 'rocky run "npm test"'`, "undecidable"],
    [`echo hi && bash -c 'rocky run "npm test"'`, "undecidable"],

    // plain
    ["npm test", "plain"],
    ["npm i && npm test", "plain"],
    [`bash -c 'npm test'`, "plain"],
    ['echo "rocky run is great"', "plain"],
    ['echo "/usr/local/bin/rocky" run false', "plain"],
    ['echo "true && \\"/usr/local/bin/rocky\\" run false"', "plain"],
    ["rockyfoo run x", "plain"],
    ["git log --grep rocky", "plain"],
    ['rocky\nrun "x"', "plain"],
  ];

  for (const [command, expected] of cases) {
    assert.equal(classifyRockyWrap(command), expected, `command: ${command}`);
  }
});

test("parseToolResultPayload maps a PostToolUseFailure Bash payload to a failure event", () => {
  const fixture = {
    hook_event_name: "PostToolUseFailure",
    session_id: "s",
    tool_name: "Bash",
    tool_use_id: "t1",
    tool_input: { command: "npm test" },
    error: "Exit code 1\nError: Cannot find module 'express'\nSECRET_SECOND_LINE",
    is_interrupt: false,
    cwd: ABS_CWD,
    agent_id: "a1",
  };

  const event = parseToolResultPayload(encodePayload(fixture));
  assert.deepEqual(event, {
    kind: "failure",
    cmd: "npm test",
    cwd: ABS_CWD,
    exitCode: 1,
    body: "Error: Cannot find module 'express'\nSECRET_SECOND_LINE",
    agent: {
      vendor: "claude-code",
      session: "s",
      agentId: "a1",
      toolUseId: "t1",
    },
  });
});

test("parseToolResultPayload maps PostToolUse to pass for Bash and PowerShell", () => {
  for (const toolName of ["PowerShell", "Bash"] as const) {
    const event = parseToolResultPayload(encodePayload(basePassPayload({ tool_name: toolName })));
    assert.deepEqual(event, {
      kind: "pass",
      cmd: "npm test",
      cwd: ABS_CWD,
      agent: {
        vendor: "claude-code",
        session: "s",
        toolUseId: "t1",
      },
    });
  }
});

test("parseToolResultPayload skips with reasons and enforces wrap-before-other-skips ordering", () => {
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({ is_interrupt: true }))),
    { kind: "skip", reason: "interrupt" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: "npm test", run_in_background: true },
    }))),
    { kind: "skip", reason: "background" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({ error: "Command timed out after 2m" }))),
    { kind: "skip", reason: "no-exit-header" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: 'rocky run "npm test"' },
    }))),
    { kind: "skip", reason: "wrapped" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: 'rocky run "npm test" && npm i' },
    }))),
    { kind: "skip", reason: "undecidable" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(basePassPayload({
      tool_response: { interrupted: true },
    }))),
    { kind: "skip", reason: "interrupt" },
  );

  // Precedence: wrap runs before interrupt, interrupt before background, background before no-exit-header.
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: 'rocky run "npm test"', run_in_background: true },
      is_interrupt: true,
      error: "Command timed out",
    }))),
    { kind: "skip", reason: "wrapped" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: 'npm test | rocky run "cat"', run_in_background: true },
      is_interrupt: true,
    }))),
    { kind: "skip", reason: "undecidable" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: "npm test", run_in_background: true },
      is_interrupt: true,
      error: "Command timed out",
    }))),
    { kind: "skip", reason: "interrupt" },
  );
  assert.deepEqual(
    parseToolResultPayload(encodePayload(baseFailurePayload({
      tool_input: { command: "npm test", run_in_background: true },
      error: "Command timed out",
    }))),
    { kind: "skip", reason: "background" },
  );
});

test("parseToolResultPayload returns undefined for unusable input", () => {
  // Malformed JSON and JSON array.
  assert.equal(parseToolResultPayload(ENCODER.encode("{not json")), undefined);
  assert.equal(parseToolResultPayload(ENCODER.encode("[]")), undefined);

  // Unknown hook_event_name.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ hook_event_name: "SessionStart" }))),
    undefined,
  );

  // Unsupported tool_name.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ tool_name: "Edit" }))),
    undefined,
  );

  // Missing or empty tool_input.command.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ tool_input: {} }))),
    undefined,
  );
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ tool_input: { command: "" } }))),
    undefined,
  );
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ tool_input: { command: "   " } }))),
    undefined,
  );

  // Non-string error on PostToolUseFailure.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ error: 123 }))),
    undefined,
  );
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ error: null }))),
    undefined,
  );

  // Relative or control-char cwd.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ cwd: "relative/dir" }))),
    undefined,
  );
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ cwd: join(ABS_CWD, "bad\x00dir") }))),
    undefined,
  );
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ cwd: `${ABS_CWD}\n` }))),
    undefined,
  );

  // Unsafe session_id.
  assert.equal(
    parseToolResultPayload(encodePayload(baseFailurePayload({ session_id: "../x" }))),
    undefined,
  );

  // Stdin larger than TOOL_RESULT_STDIN_CAP_BYTES.
  assert.equal(TOOL_RESULT_STDIN_CAP_BYTES, 1024 * 1024);
  const oversized = new Uint8Array(TOOL_RESULT_STDIN_CAP_BYTES + 1);
  assert.equal(parseToolResultPayload(oversized), undefined);
});

test("parseToolResultPayload drops unsafe agent_id and tool_use_id but keeps the event", () => {
  const event = parseToolResultPayload(encodePayload(baseFailurePayload({
    agent_id: "a b",
    tool_use_id: "t1",
  })));
  assert.deepEqual(event, {
    kind: "failure",
    cmd: "npm test",
    cwd: ABS_CWD,
    exitCode: 1,
    body: "Error: boom\n",
    agent: {
      vendor: "claude-code",
      session: "s",
      toolUseId: "t1",
    },
  });
  assert.equal("agentId" in event.agent, false);

  const passEvent = parseToolResultPayload(encodePayload(basePassPayload({
    agent_id: "a1",
    tool_use_id: "../bad",
  })));
  assert.deepEqual(passEvent, {
    kind: "pass",
    cmd: "npm test",
    cwd: ABS_CWD,
    agent: {
      vendor: "claude-code",
      session: "s",
      agentId: "a1",
    },
  });
  assert.equal("toolUseId" in passEvent.agent, false);
});
