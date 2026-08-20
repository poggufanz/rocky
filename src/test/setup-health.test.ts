import test from "node:test";
import assert from "node:assert/strict";
import type { McpRegistration } from "../setup/clients.js";
import type { ProcessRunner } from "../setup/process.js";
import { checkMcpRegistration } from "../setup/health.js";
import { JSON_RPC_ERROR, MODERN_PROTOCOL_VERSION } from "../mcp/protocol.js";

const registration: McpRegistration = {
  name: "rocky",
  command: "/opt/node",
  args: ["/opt/rocky/dist/index.js", "mcp"],
  env: { ROCKY_MCP_EXPOSURE: "sanitized", ROCKY_HOME: "/home/ada/.rocky" },
};

const HEALTHY_TOOLS = [
  "recall", "recent_failures", "stats", "recall_with_ai",
  "search_knowledge", "fetch_record", "why_file",
] as const;

test("health check is unhealthy when interactive transport is unavailable", async () => {
  const runner: ProcessRunner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
  };

  const result = await checkMcpRegistration(registration, runner, 50);

  assert.equal(result.healthy, false);
  assert.match(result.detail, /interactive protocol transport is unavailable/i);
});

interface WrittenMessage {
  id?: string | number;
  method: string;
}

class FakeSession {
  readonly messages: WrittenMessage[] = [];
  readonly queuedLines: string[] = [];
  ended = false;
  killed = false;
  waited = false;

  constructor(private readonly respond: (message: WrittenMessage) => unknown | { rawLines: string[] } | undefined) {}

  async writeLine(line: string): Promise<void> {
    const message = JSON.parse(line) as WrittenMessage;
    this.messages.push(message);
    const response = this.respond(message);
    if (response !== undefined
      && typeof response === "object"
      && response !== null
      && "rawLines" in response
      && Array.isArray(response.rawLines)
      && response.rawLines.every((value) => typeof value === "string")) {
      this.queuedLines.push(...response.rawLines);
    } else if (response !== undefined) {
      this.queuedLines.push(JSON.stringify(response));
    }
  }

  async readLine(): Promise<string | undefined> {
    return this.queuedLines.shift();
  }

  end(): void {
    this.ended = true;
  }

  kill(): void {
    this.killed = true;
  }

  async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    this.waited = true;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class PendingReadFakeSession extends FakeSession {
  override async readLine(): Promise<string | undefined> {
    return new Promise<string | undefined>(() => {});
  }
}

function healthyLegacySession(tools = [...HEALTHY_TOOLS]): FakeSession {
  return new FakeSession((message) => {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "rocky", version: "0.2.1" },
        },
      };
    }
    if (message.method === "notifications/initialized") return undefined;
    if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id: message.id, result: { tools: tools.map((name) => ({ name })) } };
    }
    throw new Error(`unexpected legacy method: ${message.method}`);
  });
}

class StickyFakeSession extends FakeSession {
  private releaseWait: () => void = () => {};
  private readonly completion = new Promise<void>((resolve) => {
    this.releaseWait = resolve;
  });

  override kill(): void {
    super.kill();
    this.releaseWait?.();
  }

  override async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    this.waited = true;
    await this.completion;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class HardKillFakeSession extends FakeSession {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  private releaseWait: () => void = () => {};
  private readonly completion = new Promise<void>((resolve) => {
    this.releaseWait = resolve;
  });

  override kill(signal?: NodeJS.Signals | number): void {
    super.kill();
    this.signals.push(signal);
    if (signal === "SIGKILL") this.releaseWait();
  }

  forceRelease(): void {
    this.releaseWait();
  }

  override async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    this.waited = true;
    await this.completion;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class UnkillableFakeSession extends FakeSession {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  private releaseWait: () => void = () => {};
  private readonly completion = new Promise<void>((resolve) => {
    this.releaseWait = resolve;
  });

  override kill(signal?: NodeJS.Signals | number): void {
    super.kill();
    this.signals.push(signal);
  }

  forceRelease(): void {
    this.releaseWait();
  }

  override async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    this.waited = true;
    await this.completion;
    return { status: 0, stdout: "", stderr: "" };
  }
}

class NonZeroExitFakeSession extends FakeSession {
  override async wait(): Promise<{ status: number; stdout: string; stderr: string }> {
    this.waited = true;
    return { status: 7, stdout: "", stderr: "probe failed after response" };
  }
}

test("modern health sends discovery then list and validates Rocky tools without invoking any tool", async () => {
  const session = new FakeSession((message) => {
    if (message.method === "server/discover") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false } },
        },
      };
    }
    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: HEALTHY_TOOLS.map((name) => ({ name })),
        },
      };
    }
    throw new Error(`unexpected health method: ${message.method}`);
  });
  const opened: Array<{ command: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const runner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) {
      opened.push({ command, args: [...args], env: options?.env });
      return session;
    },
  } satisfies ProcessRunner & {
    openSession(command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }): Promise<FakeSession>;
  };

  const result = await checkMcpRegistration(registration, runner, 200);

  assert.deepEqual(result, { healthy: true, era: "modern", detail: "Rocky MCP tools are healthy" });
  assert.deepEqual(session.messages.map((message) => message.method), ["server/discover", "tools/list"]);
  assert.deepEqual(opened.map(({ command, args }) => ({ command, args })), [{
    command: registration.command,
    args: registration.args,
  }]);
  assert.equal(opened[0]?.env?.ROCKY_MCP_EXPOSURE, "sanitized");
  assert.equal(opened[0]?.env?.ROCKY_HOME, "/home/ada/.rocky");
  assert.equal(session.ended, true);
  assert.equal(session.waited, true);
  assert.equal(session.killed, false);
});

test("health rejects a JSON-RPC response containing both result and error", async () => {
  const session = new FakeSession((message) => message.method === "server/discover"
    ? {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
        },
      }
    : {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: HEALTHY_TOOLS.map((name) => ({ name })),
        },
        error: { code: -32000, message: "contradictory response" },
      });
  const runner = {
    async run() { throw new Error("batch runner must not be used"); },
    async openSession() { return session; },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const result = await checkMcpRegistration(registration, runner, 200);

  assert.equal(result.healthy, false);
  assert.equal(result.era, "modern");
});

test("health requires a clean child exit after successful protocol responses", async () => {
  const session = new NonZeroExitFakeSession((message) => message.method === "server/discover"
    ? {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
        },
      }
    : {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: HEALTHY_TOOLS.map((name) => ({ name })),
        },
      });
  const runner = {
    async run() { throw new Error("batch runner must not be used"); },
    async openSession() { return session; },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const result = await checkMcpRegistration(registration, runner, 200);

  assert.deepEqual(result, {
    healthy: false,
    era: "modern",
    detail: "Rocky MCP probe did not exit cleanly",
  });
});

test("recognized unsupported modern version locks modern without legacy fallback", async () => {
  const session = new FakeSession((message) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: JSON_RPC_ERROR.UNSUPPORTED_PROTOCOL_VERSION,
      message: "Unsupported protocol version",
      data: { supported: [MODERN_PROTOCOL_VERSION], requested: "2099-01-01" },
    },
  }));
  let opens = 0;
  const runner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession() {
      opens += 1;
      return session;
    },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const result = await checkMcpRegistration(registration, runner, 200);

  assert.deepEqual(result, {
    healthy: false,
    era: "modern",
    detail: "Rocky MCP modern protocol version is unsupported",
  });
  assert.equal(opens, 1);
  assert.deepEqual(session.messages.map(({ method }) => method), ["server/discover"]);
  assert.equal(session.ended, true);
  assert.equal(session.waited, true);
});

test("discovery success without the requested modern version stays modern-unhealthy", async () => {
  const modern = new FakeSession((message) => ({
    jsonrpc: "2.0",
    id: message.id,
    result: {
      supportedVersions: ["2099-01-01"],
      capabilities: { tools: { listChanged: false } },
    },
  }));
  let opens = 0;
  const runner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession() {
      opens += 1;
      return modern;
    },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const result = await checkMcpRegistration(registration, runner, 200);

  assert.deepEqual(result, {
    healthy: false,
    era: "modern",
    detail: "Rocky MCP modern protocol version is unsupported",
  });
  assert.equal(opens, 1);
  assert.deepEqual(modern.messages.map(({ method }) => method), ["server/discover"]);
  assert.equal(modern.ended, true);
  assert.equal(modern.waited, true);
});

test("every valid modern discovery success locks modern even when its result is incomplete", async (t) => {
  const cases: Array<{ name: string; result: unknown }> = [
    {
      name: "missing tools capability",
      result: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        capabilities: {},
      },
    },
    { name: "structurally incomplete result", result: {} },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const modern = new FakeSession((message) => ({
        jsonrpc: "2.0",
        id: message.id,
        result: entry.result,
      }));
      const sessions = [modern, healthyLegacySession()];
      let opens = 0;
      const runner = {
        async run() { throw new Error("batch runner must not be used"); },
        async openSession() {
          const session = sessions[opens];
          opens += 1;
          if (session === undefined) throw new Error("unexpected probe child");
          return session;
        },
      } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

      const result = await checkMcpRegistration(registration, runner, 200);

      assert.equal(result.healthy, false);
      assert.equal(result.era, "modern");
      assert.equal(opens, 1);
      assert.deepEqual(modern.messages.map(({ method }) => method), ["server/discover"]);
    });
  }
});

test("method-not-found closes and awaits modern child before a fresh legacy lifecycle", async () => {
  const events: string[] = [];
  const modern = new StickyFakeSession((message) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
  }));
  const legacy = new FakeSession((message) => {
    if (message.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "rocky", version: "0.2.1" },
        },
      };
    }
    if (message.method === "notifications/initialized") return undefined;
    if (message.method === "ping") return { jsonrpc: "2.0", id: message.id, result: {} };
    if (message.method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: HEALTHY_TOOLS.map((name) => ({ name })),
        },
      };
    }
    throw new Error(`unexpected legacy method: ${message.method}`);
  });
  const originalModernWait = modern.wait.bind(modern);
  let modernCleanRecorded = false;
  modern.wait = async () => {
    const result = await originalModernWait();
    if (!modernCleanRecorded) {
      modernCleanRecorded = true;
      events.push("modern-clean");
    }
    return result;
  };
  const sessions = [modern, legacy];
  const runner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession() {
      if (sessions.length === 1) {
        assert.deepEqual(events, ["modern-clean"]);
        events.push("legacy-open");
      }
      const session = sessions.shift();
      if (session === undefined) throw new Error("unexpected third probe");
      return session;
    },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const result = await checkMcpRegistration(registration, runner, 250);

  assert.deepEqual(result, { healthy: true, era: "legacy", detail: "Rocky MCP tools are healthy" });
  assert.deepEqual(events, ["modern-clean", "legacy-open"]);
  assert.equal(modern.ended, true);
  assert.equal(modern.killed, true);
  assert.equal(modern.waited, true);
  assert.deepEqual(modern.messages.map(({ method }) => method), ["server/discover"]);
  assert.deepEqual(legacy.messages.map(({ method }) => method), [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
  ]);
  assert.equal(legacy.ended, true);
  assert.equal(legacy.waited, true);
});

test("expired graceful cleanup force-kills only the owned child before legacy fallback", async () => {
  const modern = new HardKillFakeSession((message) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
  }));
  const legacy = healthyLegacySession();
  const sessions = [modern, legacy];
  let opens = 0;
  const runner = {
    async run() {
      throw new Error("batch runner must not be used for protocol health");
    },
    async openSession() {
      const session = sessions[opens];
      opens += 1;
      if (session === undefined) throw new Error("unexpected health child");
      return session;
    },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const checking = checkMcpRegistration(registration, runner, 80);
  const timeoutMarker = Symbol("timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    checking,
    new Promise<typeof timeoutMarker>((resolve) => {
      timeout = setTimeout(() => resolve(timeoutMarker), 1000);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  modern.forceRelease();
  await checking;

  assert.notEqual(raced, timeoutMarker);
  assert.deepEqual(modern.signals, ["SIGKILL"]);
  assert.equal(opens, 2);
});

test("post-kill cleanup remains bounded and never opens legacy while the modern child is unreaped", async () => {
  const modern = new UnkillableFakeSession((message) => ({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
  }));
  let opens = 0;
  const runner = {
    async run() { throw new Error("batch runner must not be used"); },
    async openSession() {
      opens += 1;
      return modern;
    },
  } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

  const checking = checkMcpRegistration(registration, runner, 80);
  const timeoutMarker = Symbol("timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    checking,
    new Promise<typeof timeoutMarker>((resolve) => {
      timeout = setTimeout(() => resolve(timeoutMarker), 200);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  modern.forceRelease();

  assert.notEqual(raced, timeoutMarker);
  assert.deepEqual(modern.signals, ["SIGKILL"]);
  assert.equal(opens, 1);
  assert.equal((raced as { healthy: boolean }).healthy, false);
});

test("non-modern errors malformed output silence and modern timeout each retry in a fresh legacy child", async (t) => {
  const cases: Array<{ name: string; modern: FakeSession }> = [
    {
      name: "invalid params",
      modern: new FakeSession((message) => ({
        jsonrpc: "2.0", id: message.id, error: { code: JSON_RPC_ERROR.INVALID_PARAMS, message: "Invalid params" },
      })),
    },
    {
      name: "arbitrary error",
      modern: new FakeSession((message) => ({
        jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Other server" },
      })),
    },
    { name: "malformed JSON", modern: new FakeSession(() => ({ rawLines: ["{"] })) },
    { name: "silence", modern: new FakeSession(() => undefined) },
    { name: "timeout", modern: new PendingReadFakeSession(() => undefined) },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const legacy = healthyLegacySession();
      const sessions: FakeSession[] = [entry.modern, legacy];
      const runner = {
        async run() { throw new Error("batch runner must not be used"); },
        async openSession() {
          const session = sessions.shift();
          if (session === undefined) throw new Error("unexpected third probe");
          return session;
        },
      } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

      const result = await checkMcpRegistration(registration, runner, 100);

      assert.equal(result.healthy, true);
      assert.equal(result.era, "legacy");
      assert.equal(sessions.length, 0);
      assert.equal(entry.modern.ended, true);
      assert.equal(entry.modern.waited, true);
      assert.deepEqual(legacy.messages.map(({ method }) => method), [
        "initialize", "notifications/initialized", "ping", "tools/list",
      ]);
    });
  }
});

test("locked modern and legacy catalogs reject a missing Rocky tool without cross-era continuation", async (t) => {
  await t.test("modern", async () => {
    const modern = new FakeSession((message) => message.method === "server/discover"
      ? {
        jsonrpc: "2.0",
        id: message.id,
        result: { supportedVersions: [MODERN_PROTOCOL_VERSION], capabilities: { tools: {} } },
      }
      : {
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: ["recall", "recent_failures", "stats"].map((name) => ({ name })) },
      });
    let opens = 0;
    const runner = {
      async run() { throw new Error("batch runner must not be used"); },
      async openSession() { opens += 1; return modern; },
    } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

    const result = await checkMcpRegistration(registration, runner, 100);

    assert.deepEqual(result, {
      healthy: false,
      era: "modern",
      detail: "Rocky MCP tool catalog is incomplete; upgrade needed",
    });
    assert.equal(opens, 1);
  });

  await t.test("legacy", async () => {
    const sessions = [
      new FakeSession((message) => ({
        jsonrpc: "2.0", id: message.id, error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
      })),
      healthyLegacySession(["recall", "recent_failures", "stats"]),
    ];
    const runner = {
      async run() { throw new Error("batch runner must not be used"); },
      async openSession() {
        const session = sessions.shift();
        if (session === undefined) throw new Error("unexpected third probe");
        return session;
      },
    } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

    const result = await checkMcpRegistration(registration, runner, 100);

    assert.deepEqual(result, {
      healthy: false,
      era: "legacy",
      detail: "Rocky MCP legacy tool catalog is incomplete; upgrade needed",
    });
  });
});

test("legacy malformed timeout and missing tools capability are unhealthy and cleaned up", async (t) => {
  const cases: Array<{ name: string; legacy: FakeSession }> = [
    { name: "malformed", legacy: new FakeSession(() => ({ rawLines: ["not-json"] })) },
    { name: "timeout", legacy: new PendingReadFakeSession(() => undefined) },
    {
      name: "no tools capability",
      legacy: new FakeSession((message) => ({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "rocky", version: "0.2.1" } },
      })),
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const modern = new FakeSession((message) => ({
        jsonrpc: "2.0", id: message.id, error: { code: JSON_RPC_ERROR.METHOD_NOT_FOUND, message: "Method not found" },
      }));
      const sessions = [modern, entry.legacy];
      const runner = {
        async run() { throw new Error("batch runner must not be used"); },
        async openSession() {
          const session = sessions.shift();
          if (session === undefined) throw new Error("unexpected third probe");
          return session;
        },
      } satisfies ProcessRunner & { openSession(): Promise<FakeSession> };

      const result = await checkMcpRegistration(registration, runner, 100);

      assert.equal(result.healthy, false);
      assert.equal(result.era, "legacy");
      assert.equal(entry.legacy.ended, true);
      assert.equal(entry.legacy.waited, true);
    });
  }
});
