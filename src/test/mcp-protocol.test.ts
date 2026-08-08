import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INITIAL_PROTOCOL_STATE,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  SERVER_INSTRUCTIONS,
  protocolError,
  resultResponse,
  routeProtocolMessage,
  type ProtocolState,
  type RoutedMessage,
} from "../mcp/protocol.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repoRoot, "test", "fixtures", "mcp", relativePath), "utf8")) as Record<string, unknown>;
}

function errorOf(routed: RoutedMessage) {
  assert.equal(routed.kind, "error");
  if (routed.kind !== "error") throw new Error("expected protocol error");
  return routed.response;
}

function requestOf(routed: RoutedMessage) {
  assert.equal(routed.kind, "request");
  if (routed.kind !== "request") throw new Error("expected routed request");
  return routed;
}

const serverInfo = { name: "@poggufanz/rocky-cli", version: "0.2.1-beta.1" };

test("modern discovery is stateless and stamps complete server identity", () => {
  const routed = routeProtocolMessage(fixture("modern/discover-request.json"), INITIAL_PROTOCOL_STATE);
  assert.equal(routed.kind, "request");
  if (routed.kind !== "request") return;
  assert.equal(routed.era, "modern");
  assert.equal(routed.method, "server/discover");
  assert.deepEqual(routed.nextState, INITIAL_PROTOCOL_STATE);
  const response = resultResponse(routed.id, routed.era, {
    supportedVersions: [MODERN_PROTOCOL_VERSION], capabilities: { tools: { listChanged: false } },
    instructions: SERVER_INSTRUCTIONS,
  }, serverInfo);
  assert.equal(response.result.resultType, "complete");
  assert.deepEqual(response.result._meta, {
    "io.modelcontextprotocol/serverInfo": serverInfo,
  });
});

test("modern response keeps method metadata while adding namespaced server identity", () => {
  const response = resultResponse("m-result", "modern", {
    tools: [],
    _meta: { "com.example/trace": "trace-1" },
  }, serverInfo);
  assert.deepEqual(response.result._meta, {
    "com.example/trace": "trace-1",
    "io.modelcontextprotocol/serverInfo": serverInfo,
  });
});

test("direct modern tool listing accepts omitted optional client info", () => {
  const routed = requestOf(routeProtocolMessage(fixture("modern/list-request.json"), INITIAL_PROTOCOL_STATE));
  assert.equal(routed.era, "modern");
  assert.equal(routed.method, "tools/list");
  assert.deepEqual(routed.nextState, { legacyPhase: "open" });
});

test("modern and ready legacy tool calls route in their own eras", () => {
  const modernCall = fixture("modern/list-request.json");
  modernCall.id = "m-call";
  modernCall.method = "tools/call";
  modernCall.params = {
    ...(modernCall.params as Record<string, unknown>),
    name: "stats",
    arguments: {},
  };
  const modern = requestOf(routeProtocolMessage(modernCall, INITIAL_PROTOCOL_STATE));
  assert.equal(modern.era, "modern");
  assert.equal(modern.method, "tools/call");
  assert.deepEqual(modern.nextState, { legacyPhase: "open" });

  for (const method of ["tools/list", "tools/call"] as const) {
    const legacy = requestOf(routeProtocolMessage({
      jsonrpc: "2.0", id: `legacy-${method}`, method, params: {},
    }, { legacyPhase: "ready" }));
    assert.equal(legacy.era, "legacy");
    assert.equal(legacy.method, method);
    assert.deepEqual(legacy.nextState, { legacyPhase: "ready" });
  }
});

test("unknown modern version uses exact MCP error", () => {
  const response = errorOf(routeProtocolMessage(fixture("modern/unsupported-request.json"), INITIAL_PROTOCOL_STATE));
  assert.deepEqual(response.error, {
    code: -32022,
    message: "Unsupported protocol version",
    data: { supported: ["2026-07-28"], requested: "1900-01-01" },
  });
});

test("modern requests require metadata and client capabilities", () => {
  const missingMeta = { jsonrpc: "2.0", id: "missing-meta", method: "tools/list", params: {} };
  const missingCapabilities = fixture("modern/list-request.json");
  missingCapabilities.params = { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION } };

  assert.deepEqual(errorOf(routeProtocolMessage(missingMeta, INITIAL_PROTOCOL_STATE)), {
    jsonrpc: "2.0", id: "missing-meta", error: { code: -32602, message: "Invalid params" },
  });
  assert.deepEqual(errorOf(routeProtocolMessage(missingCapabilities, INITIAL_PROTOCOL_STATE)), {
    jsonrpc: "2.0", id: "m-list", error: { code: -32602, message: "Invalid params" },
  });
});

test("modern optional client info is validated when present", () => {
  const malformed = fixture("modern/list-request.json");
  malformed.params = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "rocky-test-client", version: 1 },
    },
  };
  assert.deepEqual(errorOf(routeProtocolMessage(malformed, INITIAL_PROTOCOL_STATE)).error, {
    code: -32602, message: "Invalid params",
  });

  const malformedOptionalField = fixture("modern/list-request.json");
  malformedOptionalField.params = {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        name: "rocky-test-client", version: "1.0.0", title: 1,
      },
    },
  };
  assert.deepEqual(errorOf(routeProtocolMessage(malformedOptionalField, INITIAL_PROTOCOL_STATE)).error, {
    code: -32602, message: "Invalid params",
  });
});

test("modern ping is era-gated as method not found", () => {
  const ping = fixture("modern/list-request.json");
  ping.id = "m-ping";
  ping.method = "ping";
  assert.deepEqual(errorOf(routeProtocolMessage(ping, INITIAL_PROTOCOL_STATE)), {
    jsonrpc: "2.0", id: "m-ping", error: { code: -32601, message: "Method not found" },
  });
});

test("legacy initialize, initialized notification, and ping advance locked lifecycle", () => {
  const initialized = requestOf(routeProtocolMessage(fixture("legacy/initialize-request.json"), INITIAL_PROTOCOL_STATE));
  assert.equal(initialized.era, "legacy");
  assert.equal(initialized.method, "initialize");
  assert.deepEqual(initialized.nextState, { legacyPhase: "awaiting_initialized" });

  const initializeResponse = resultResponse(initialized.id, initialized.era, {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo,
    instructions: SERVER_INSTRUCTIONS,
  }, serverInfo);
  assert.deepEqual(initializeResponse, {
    jsonrpc: "2.0",
    id: "l-init",
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: SERVER_INSTRUCTIONS,
    },
  });

  const ready = routeProtocolMessage(fixture("legacy/initialized-notification.json"), initialized.nextState);
  assert.equal(ready.kind, "notification");
  assert.deepEqual(ready.nextState, { legacyPhase: "ready" });
  const ping = requestOf(routeProtocolMessage(fixture("legacy/ping-request.json"), ready.nextState));
  assert.equal(ping.era, "legacy");
  assert.equal(ping.method, "ping");
  assert.deepEqual(resultResponse(ping.id, ping.era, {}, serverInfo), {
    jsonrpc: "2.0", id: "l-ping", result: {},
  });
});

test("legacy initialize accepts an unknown proposal and answers with supported legacy version", () => {
  const proposed = fixture("legacy/initialize-request.json");
  proposed.params = {
    ...(proposed.params as Record<string, unknown>),
    protocolVersion: "1900-01-01",
  };
  const routed = requestOf(routeProtocolMessage(proposed, INITIAL_PROTOCOL_STATE));
  assert.equal(routed.era, "legacy");
  assert.deepEqual(routed.nextState, { legacyPhase: "awaiting_initialized" });
  assert.equal(resultResponse(routed.id, routed.era, {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo,
    instructions: SERVER_INSTRUCTIONS,
  }, serverInfo).result.protocolVersion, "2025-11-25");
});

test("legacy tools cannot run before initialized notification", () => {
  const awaiting: ProtocolState = { legacyPhase: "awaiting_initialized" };
  const call = { jsonrpc: "2.0", id: "early", method: "tools/call", params: { name: "stats", arguments: {} } };
  assert.deepEqual(errorOf(routeProtocolMessage(call, awaiting)), {
    jsonrpc: "2.0", id: "early", error: { code: -32600, message: "Invalid Request" },
  });
});

test("legacy ping remains unavailable until initialized notification", () => {
  const response = errorOf(routeProtocolMessage(
    fixture("legacy/ping-request.json"),
    { legacyPhase: "awaiting_initialized" },
  ));
  assert.deepEqual(response, {
    jsonrpc: "2.0", id: "l-ping", error: { code: -32600, message: "Invalid Request" },
  });
});

test("malformed initialized notification cannot unlock legacy tools", () => {
  const awaiting: ProtocolState = { legacyPhase: "awaiting_initialized" };
  for (const params of [null, []]) {
    const routed = routeProtocolMessage({
      jsonrpc: "2.0", method: "notifications/initialized", params,
    }, awaiting);
    assert.deepEqual(routed, { kind: "notification", nextState: awaiting });
  }
});

test("malformed initialized notification metadata cannot unlock legacy tools", () => {
  const awaiting: ProtocolState = { legacyPhase: "awaiting_initialized" };
  for (const _meta of [null, 1, []]) {
    const routed = routeProtocolMessage({
      jsonrpc: "2.0", method: "notifications/initialized", params: { _meta },
    }, awaiting);
    assert.deepEqual(routed, { kind: "notification", nextState: awaiting });
  }
});

test("initialized notification accepts absent params or object metadata", () => {
  const awaiting: ProtocolState = { legacyPhase: "awaiting_initialized" };
  const valid = [
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", method: "notifications/initialized", params: { _meta: { "com.example/trace": "trace-1" } } },
  ];
  for (const notification of valid) {
    assert.deepEqual(routeProtocolMessage(notification, awaiting), {
      kind: "notification", nextState: { legacyPhase: "ready" },
    });
  }
});

test("legacy lifecycle rejects duplicate initialize", () => {
  for (const legacyPhase of ["awaiting_initialized", "ready"] as const) {
    const response = errorOf(routeProtocolMessage(fixture("legacy/initialize-request.json"), { legacyPhase }));
    assert.deepEqual(response, {
      jsonrpc: "2.0", id: "l-init", error: { code: -32600, message: "Invalid Request" },
    });
  }
});

test("legacy lock rejects a metadata-bearing modern request", () => {
  const response = errorOf(routeProtocolMessage(fixture("modern/list-request.json"), { legacyPhase: "ready" }));
  assert.deepEqual(response, {
    jsonrpc: "2.0", id: "m-list", error: { code: -32601, message: "Method not found" },
  });
});

test("unknown request is method not found while unknown notification has no response", () => {
  const unknownRequest = fixture("modern/list-request.json");
  unknownRequest.id = "unknown";
  unknownRequest.method = "resources/list";
  assert.deepEqual(errorOf(routeProtocolMessage(unknownRequest, INITIAL_PROTOCOL_STATE)), {
    jsonrpc: "2.0", id: "unknown", error: { code: -32601, message: "Method not found" },
  });

  const unknownNotification = routeProtocolMessage({
    jsonrpc: "2.0", method: "notifications/resources/list_changed", params: {},
  }, INITIAL_PROTOCOL_STATE);
  assert.deepEqual(unknownNotification, { kind: "notification", nextState: INITIAL_PROTOCOL_STATE });
});

test("client-sent result is an invalid request", () => {
  assert.deepEqual(errorOf(routeProtocolMessage({ jsonrpc: "2.0", id: "response", result: {} }, INITIAL_PROTOCOL_STATE)), {
    jsonrpc: "2.0", id: "response", error: { code: -32600, message: "Invalid Request" },
  });
});

test("null, fractional, non-finite, and oversized string IDs are invalid", () => {
  const invalidIds: unknown[] = [null, 1.5, Number.POSITIVE_INFINITY, "🙂".repeat(65)];
  for (const id of invalidIds) {
    const response = errorOf(routeProtocolMessage({ jsonrpc: "2.0", id, method: "tools/list", params: {} }, INITIAL_PROTOCOL_STATE));
    assert.deepEqual(response, {
      jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
    });
  }
});

test("string IDs at exactly 256 UTF-8 bytes remain valid", () => {
  for (const id of ["x".repeat(256), "🙂".repeat(64)]) {
    const request = fixture("modern/list-request.json");
    request.id = id;
    assert.equal(requestOf(routeProtocolMessage(request, INITIAL_PROTOCOL_STATE)).id, id);
  }
});

test("cancellation needs no metadata and preserves numeric versus string IDs", () => {
  const state: ProtocolState = { legacyPhase: "ready" };
  const numeric = routeProtocolMessage({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "stop" },
  }, state);
  const textual = routeProtocolMessage({
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" },
  }, state);
  assert.deepEqual(numeric, { kind: "cancel", requestId: 1, reason: "stop", nextState: state });
  assert.deepEqual(textual, { kind: "cancel", requestId: "1", nextState: state });
  assert.notEqual(numeric.kind === "cancel" ? numeric.requestId : undefined, textual.kind === "cancel" ? textual.requestId : undefined);
});

test("protocol errors serialize an absent ID as null", () => {
  assert.deepEqual(protocolError(undefined, -32600, "Invalid Request"), {
    jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" },
  });
  assert.equal(JSON.stringify(protocolError(undefined, -32600, "Invalid Request")).includes("undefined"), false);
});
