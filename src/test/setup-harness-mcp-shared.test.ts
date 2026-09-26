import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeRockyMcpServer,
  removeRockyMcpServer,
  parseVersionOutput,
  notFoundDetection,
  verifyMcpAfterWrite,
} from "../setup/harness-mcp-shared.js";
import type { McpRegistration } from "../setup/clients.js";

const REGISTRATION: McpRegistration = {
  name: "rocky",
  command: "/usr/local/bin/node",
  args: ["/home/user/.rocky/dist/index.js", "mcp"],
  env: { ROCKY_HOME: "/home/user/.rocky", ROCKY_MCP_EXPOSURE: "sanitized" },
};

function stdioEntry(r: McpRegistration): Record<string, unknown> {
  return { type: "stdio", command: r.command, args: [...r.args], env: { ...r.env } };
}

test("merge preserves foreign servers and key order, appends rocky last", () => {
  const existing = { mcpServers: { other: { command: "x" } } };
  const { value, changed } = mergeRockyMcpServer(existing, "mcpServers", REGISTRATION, stdioEntry);
  assert.equal(changed, true);
  assert.deepEqual(Object.keys((value.mcpServers as Record<string, unknown>)), ["other", "rocky"]);
  assert.deepEqual((value.mcpServers as Record<string, unknown>).other, { command: "x" });
});

test("merge is a no-op when an identical rocky entry already exists", () => {
  const existing = { mcpServers: { rocky: stdioEntry(REGISTRATION) } };
  const { changed } = mergeRockyMcpServer(existing, "mcpServers", REGISTRATION, stdioEntry);
  assert.equal(changed, false);
});

test("remove deletes only the rocky-owned entry and reports ownership", () => {
  const existing = {
    mcpServers: { other: { command: "x" }, rocky: { command: "impostor" } },
  };
  const { value, changed, owned } = removeRockyMcpServer(existing, "mcpServers", REGISTRATION);
  assert.equal(changed, false);
  assert.equal(owned, false);
  assert.deepEqual(Object.keys((value.mcpServers as Record<string, unknown>)), ["other", "rocky"]);
});

test("parseVersionOutput takes the first semver token and never invents one", () => {
  assert.equal(parseVersionOutput("gemini version 0.9.0 (darwin)"), "0.9.0");
  assert.equal(parseVersionOutput("no version here"), undefined);
});

test("notFound writes-nothing contract carries tried names and hint", () => {
  const detection = notFoundDetection("gemini-cli", ["gemini"], "~/.gemini/settings.json");
  assert.equal(detection.status, "not-found");
  assert.equal(detection.executable, undefined);
  assert.equal(detection.configPath, undefined);
  assert.match(detection.detail, /gemini/);
});

function fakeRunner(listOutput: { status: number | null; stdout: string }): {
  run: (command: string, args: readonly string[]) => Promise<{ status: number | null; stdout: string; stderr: string }>;
} {
  return {
    run: () => Promise.resolve({ status: listOutput.status, stdout: listOutput.stdout, stderr: "" }),
  };
}

test("verify reports unverified when the list probe hides rocky", async () => {
  const outcome = await verifyMcpAfterWrite({
    runner: fakeRunner({ status: 0, stdout: "other-server" }) as never,
    registration: REGISTRATION,
    listCommand: { command: "/bin/gemini", args: ["mcp", "list"], timeoutMs: 5000 },
    mustContain: "rocky",
  });
  assert.equal(outcome.verified, false);
  assert.match(outcome.detail, /does not show rocky/);
});

test("verify reports unverified when the list probe exits nonzero", async () => {
  const outcome = await verifyMcpAfterWrite({
    runner: fakeRunner({ status: 1, stdout: "" }) as never,
    registration: REGISTRATION,
    listCommand: { command: "/bin/copilot", args: ["mcp", "list"], timeoutMs: 5000 },
  });
  assert.equal(outcome.verified, false);
  assert.match(outcome.detail, /failed/);
});
