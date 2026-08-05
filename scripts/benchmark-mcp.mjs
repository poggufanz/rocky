import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(packageRoot, "dist", "index.js");
const throwFetch = join(packageRoot, "test", "fixtures", "throw-fetch.cjs");
const SAMPLE_COUNT = 20;
const FIXTURE_RECORDS = 10_000;
const FIXTURE_BYTES = 5 * 1024 * 1024;
const FIXTURE_MIN_BYTES = 4.9 * 1024 * 1024;
const FIXTURE_MAX_BYTES = 5.1 * 1024 * 1024;
const COLD_GATE_MS = 1_000;
const RSS_GATE_BYTES = 100_000_000;
const REQUEST_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 3_000;
const MAX_PROTOCOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MODERN_VERSION = "2026-07-28";

class UsageError extends Error {}

function outputArgument(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new UsageError("usage: benchmark-mcp --output <absolute path outside package>");
  }
  if (!isAbsolute(argv[1])) throw new UsageError("output path must be absolute");
  const output = resolve(argv[1]);
  let ancestor = output;
  while (!existsSync(ancestor)) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) {
        try {
          realpathSync(ancestor);
        } catch {
          throw new UsageError("output path must not contain dangling symbolic links");
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let component = ancestor;
  while (true) {
    if (lstatSync(component).isSymbolicLink()) {
      try {
        realpathSync(component);
      } catch {
        throw new UsageError("output path must not contain dangling symbolic links");
      }
    }
    const parent = dirname(component);
    if (parent === component) break;
    component = parent;
  }
  const canonicalOutput = resolve(realpathSync(ancestor), relative(ancestor, output));
  const fromPackage = relative(realpathSync(packageRoot), canonicalOutput);
  if (fromPackage === "" || (!fromPackage.startsWith("..") && !isAbsolute(fromPackage))) {
    throw new UsageError("output path must be outside package");
  }
  return output;
}

function withTimeout(work, milliseconds, label) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function protocolMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "rocky-benchmark", version: "1" },
  };
}

function modernRequest(id, method, params = {}) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: protocolMeta() } };
}

class McpSession {
  constructor(home) {
    this.stderr = "";
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.pending = new Map();
    this.fatalError = undefined;
    this.finished = false;

    const env = isolatedEnvironment(home);
    this.child = spawn(process.execPath, ["--require", throwFetch, entry, "mcp"], {
      cwd: packageRoot,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (this.child.pid === undefined) throw new Error("MCP benchmark child has no pid");
    this.pid = this.child.pid;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.acceptOutput(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAX_PROTOCOL_OUTPUT_BYTES);
    });
    this.exit = new Promise((resolveExit) => {
      this.child.once("error", (error) => resolveExit({ error }));
      this.child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
  }

  acceptOutput(chunk) {
    if (this.fatalError !== undefined) return;
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stdoutBytes > MAX_PROTOCOL_OUTPUT_BYTES) {
      this.fail(new Error("MCP benchmark protocol output exceeded bound"));
      return;
    }
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("MCP benchmark received non-JSON stdout"));
        return;
      }
      const waiter = this.pending.get(message?.id);
      if (waiter !== undefined) {
        this.pending.delete(message.id);
        waiter.resolve(message);
      } else {
        this.fail(new Error(`MCP benchmark received unexpected response id: ${String(message?.id)}`));
        return;
      }
    }
  }

  fail(error) {
    if (this.fatalError !== undefined) return;
    this.fatalError = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async request(message) {
    if (this.fatalError !== undefined) throw this.fatalError;
    const response = new Promise((resolveResponse, reject) => {
      this.pending.set(message.id, { resolve: resolveResponse, reject });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.pending.delete(message.id);
          reject(error);
        }
      });
    });
    let received;
    try {
      received = await withTimeout(response, REQUEST_TIMEOUT_MS, `MCP request ${String(message.id)}`);
    } finally {
      this.pending.delete(message.id);
    }
    if (received === null || typeof received !== "object" || received.jsonrpc !== "2.0") {
      throw new Error(`MCP request ${String(message.id)} returned invalid JSON-RPC`);
    }
    if (received.error !== undefined) {
      throw new Error(`MCP request ${String(message.id)} failed: ${JSON.stringify(received.error)}`);
    }
    if (received.result === null || typeof received.result !== "object") {
      throw new Error(`MCP request ${String(message.id)} returned no result`);
    }
    return received.result;
  }

  async finish() {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const outcome = await withTimeout(this.exit, EXIT_TIMEOUT_MS, "MCP benchmark child exit");
    this.finished = true;
    if (outcome.error !== undefined) throw outcome.error;
    if (outcome.code !== 0 || outcome.signal !== null) {
      throw new Error(`MCP benchmark child failed (code ${String(outcome.code)}, signal ${String(outcome.signal)}): ${this.stderr}`);
    }
    if (this.fatalError !== undefined) throw this.fatalError;
    if (this.stdoutBuffer.trim().length > 0) throw new Error("MCP benchmark stdout ended with incomplete JSON");
    if (this.stderr.length > 0) throw new Error(`MCP benchmark wrote diagnostics: ${this.stderr}`);
  }

  async terminate() {
    if (this.finished) return;
    if (!this.child.stdin.destroyed) this.child.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    try {
      await withTimeout(this.exit, EXIT_TIMEOUT_MS, "MCP benchmark child termination");
    } catch {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      await withTimeout(this.exit, EXIT_TIMEOUT_MS, "MCP benchmark child forced termination");
    }
    this.finished = true;
  }
}

function isolatedEnvironment(root) {
  const paths = {
    home: join(root, "home"),
    appData: join(root, "appdata"),
    localAppData: join(root, "localappdata"),
    xdg: join(root, "xdg-config"),
    claude: join(root, "claude-config"),
    codex: join(root, "codex-home"),
    rocky: join(root, "rocky-home"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const env = {
    ...process.env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CONFIG_HOME: paths.xdg,
    CLAUDE_CONFIG_DIR: paths.claude,
    CODEX_HOME: paths.codex,
    ROCKY_HOME: paths.rocky,
    ROCKY_MCP_EXPOSURE: "sanitized",
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function fixtureLines() {
  const records = Array.from({ length: FIXTURE_RECORDS }, (_, index) => ({
    kind: "failure",
    id: `benchmark-${String(index).padStart(5, "0")}`,
    ts: 1_700_000_000_000 + index,
    cwd: `/benchmark/project-${index % 20}`,
    cmd: `node benchmark-case-${String(index).padStart(5, "0")}.mjs`,
    exitCode: (index % 9) + 1,
    fingerprint: index.toString(16).padStart(16, "0"),
    signature: [`benchmark deterministic error ${index % 100}`],
    excerpt: "",
    origin: "run",
  }));
  const baseBytes = records.reduce(
    (total, record) => total + Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8"),
    0,
  );
  const paddingBytes = FIXTURE_BYTES - baseBytes;
  if (paddingBytes < 0) throw new Error("benchmark fixture base records exceed target size");
  const paddingPerRecord = Math.floor(paddingBytes / records.length);
  const remainder = paddingBytes % records.length;
  return records.map((record, index) => JSON.stringify({
    ...record,
    excerpt: "x".repeat(paddingPerRecord + (index < remainder ? 1 : 0)),
  })).join("\n") + "\n";
}

function createStore(root, label, fixture) {
  const sampleRoot = join(root, label);
  const rockyHome = join(sampleRoot, "rocky-home");
  mkdirSync(rockyHome, { recursive: true });
  if (fixture !== undefined) copyFileSync(fixture, join(rockyHome, "memory.jsonl"));
  return sampleRoot;
}

function assertDiscovery(result) {
  if (!Array.isArray(result.supportedVersions) || !result.supportedVersions.includes(MODERN_VERSION)) {
    throw new Error("MCP discovery response omitted modern protocol version");
  }
}

async function coldStartSample(sampleRoot, index) {
  const startedAt = performance.now();
  const session = new McpSession(sampleRoot);
  try {
    assertDiscovery(await session.request(modernRequest(`cold-discover-${index}`, "server/discover")));
    const elapsed = performance.now() - startedAt;
    await session.finish();
    return Number(elapsed.toFixed(3));
  } finally {
    await session.terminate();
  }
}

function statsCount(result) {
  const structured = result.structuredContent;
  if (structured === null || typeof structured !== "object" || structured.failures !== FIXTURE_RECORDS) {
    throw new Error("MCP stats did not load exactly 10,000 fixture records");
  }
}

function rssBytes(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (match === null) throw new Error(`VmRSS missing for MCP process ${pid}`);
  return Number(match[1]) * 1024;
}

async function fixtureSample(sampleRoot, index, measureRss) {
  const session = new McpSession(sampleRoot);
  try {
    assertDiscovery(await session.request(modernRequest(`fixture-discover-${index}`, "server/discover")));
    const listed = await session.request(modernRequest(`fixture-list-${index}`, "tools/list"));
    if (!Array.isArray(listed.tools) || !listed.tools.some((tool) => tool?.name === "stats")) {
      throw new Error("MCP tool list omitted stats");
    }
    const stats = await session.request(modernRequest(
      `fixture-stats-${index}`,
      "tools/call",
      { name: "stats", arguments: {} },
    ));
    statsCount(stats);
    const rss = measureRss ? rssBytes(session.pid) : undefined;
    await session.finish();
    return rss;
  } finally {
    await session.terminate();
  }
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function median(values) {
  if (values.length === 0) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[middle - 1] + values[middle]) / 2
    : values[middle];
}

function p95(values) {
  if (values.length === 0) return null;
  return values[Math.ceil(0.95 * values.length) - 1];
}

function nodeMajor() {
  return Number(process.versions.node.split(".")[0]);
}

async function benchmark(output) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "rocky-mcp-benchmark-"));
  try {
    const fixturePath = join(temporaryRoot, "fixture.jsonl");
    const fixture = fixtureLines();
    const fixtureBytes = Buffer.byteLength(fixture, "utf8");
    if (fixtureBytes !== FIXTURE_BYTES || fixtureBytes < FIXTURE_MIN_BYTES || fixtureBytes > FIXTURE_MAX_BYTES) {
      throw new Error(`benchmark fixture size is outside 4.9-5.1 MiB: ${fixtureBytes}`);
    }
    writeFileSync(fixturePath, fixture, "utf8");

    const coldValues = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const store = createStore(temporaryRoot, `cold-${String(index).padStart(2, "0")}`);
      coldValues.push(await coldStartSample(store, index));
    }

    const measureRss = process.platform === "linux" && nodeMajor() === 22;
    const rssValues = [];
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const store = createStore(temporaryRoot, `fixture-${String(index).padStart(2, "0")}`, fixturePath);
      const rss = await fixtureSample(store, index, measureRss);
      if (rss !== undefined) rssValues.push(rss);
    }
    if (measureRss && rssValues.length !== SAMPLE_COUNT) {
      throw new Error(`expected ${SAMPLE_COUNT} RSS measurements, received ${rssValues.length}`);
    }

    const cold = sorted(coldValues);
    const rss = sorted(rssValues);
    const coldMedian = median(cold);
    const rssSupported = measureRss && rss.length === SAMPLE_COUNT;
    const report = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      samples: SAMPLE_COUNT,
      emptyColdStartMs: { median: coldMedian, p95: p95(cold), values: cold },
      fixture: { records: FIXTURE_RECORDS, bytes: fixtureBytes },
      steadyStateRssBytes: {
        median: median(rss),
        p95: p95(rss),
        values: rss,
        method: rssSupported
          ? "/proc/<pid>/status VmRSS (KiB converted to bytes)"
          : "unsupported: pending Node 22/Linux measurement",
      },
      gates: {
        coldStartMedianUnderMs: COLD_GATE_MS,
        idleRssUnderBytes: RSS_GATE_BYTES,
        passed: coldMedian !== null && coldMedian < COLD_GATE_MS && rssSupported && rss.every((value) => value < RSS_GATE_BYTES),
      },
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    if (!report.gates.passed && rssSupported) throw new Error("MCP benchmark acceptance gates failed");
    process.stdout.write(`${output}\n`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const output = outputArgument(process.argv.slice(2));
  await benchmark(output);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
