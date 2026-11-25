export function failurePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    error: "Exit code 1\nError: Cannot find module 'express'\n",
    session_id: "s1",
    tool_use_id: "toolu_fail_1",
    ...overrides,
  });
}

export function passPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stdout: "all green\n", stderr: "", interrupted: false },
    session_id: "s1",
    tool_use_id: "toolu_pass_1",
    ...overrides,
  });
}
