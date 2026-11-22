import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_SESSION_ENV, agentStampFromEnv, isSafeSessionId } from "../core/agent-session.js";
import { memoryPath, pendingPath, recordFailure, resolveFixOnSuccess } from "../core/memory.js";
import type { AgentStamp } from "../core/memory-read.js";
import { useTempRockyHome } from "./temp-rocky-home.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliEntry = join(packageRoot, "dist", "index.js");
const PROCESS_TIMEOUT_MS = 30_000;

const home = useTempRockyHome("rocky-agent-session-stamp-");

beforeEach(() => {
  for (const name of readdirSync(home.dir())) {
    rmSync(join(home.dir(), name), { recursive: true, force: true });
  }
});

function readRawJsonl(filePath = memoryPath()): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runCliWithSession(
  rockyHome: string,
  command: string,
  sessionEnv: string | undefined,
  extraEnv: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  mkdirSync(rockyHome, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROCKY_HOME: rockyHome,
    ...extraEnv,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  delete env[AGENT_SESSION_ENV];
  if (sessionEnv !== undefined) env[AGENT_SESSION_ENV] = sessionEnv;
  return spawnSync(process.execPath, [cliEntry, "run", command], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
}

test("agentStampFromEnv accepts valid session ids and rejects invalid or unset values", () => {
  assert.equal(AGENT_SESSION_ENV, "ROCKY_AGENT_SESSION");
  assert.deepEqual(
    agentStampFromEnv({ [AGENT_SESSION_ENV]: "3f2a-b_9" }),
    { vendor: "claude-code", session: "3f2a-b_9" },
  );

  const maxLen = "a".repeat(128);
  assert.equal(isSafeSessionId("a"), true);
  assert.equal(isSafeSessionId(maxLen), true);
  assert.deepEqual(
    agentStampFromEnv({ [AGENT_SESSION_ENV]: maxLen }),
    { vendor: "claude-code", session: maxLen },
  );

  const invalidValues: Array<string | undefined> = [
    undefined,
    "",
    "a b",
    "x'y",
    "-lead",
    "_lead",
    "a\nb",
    "a".repeat(129),
  ];
  for (const value of invalidValues) {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { [AGENT_SESSION_ENV]: value };
    assert.equal(agentStampFromEnv(env), undefined, `expected undefined for ${JSON.stringify(value)}`);
    assert.equal(isSafeSessionId(value), false, `expected isSafeSessionId=false for ${JSON.stringify(value)}`);
  }
  assert.equal(isSafeSessionId(null), false);
  assert.equal(isSafeSessionId(42), false);
});

test("resolveFixOnSuccess rejects cross-session links and leaves pending intact", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "sess-1" };
  const s2: AgentStamp = { vendor: "claude-code", session: "sess-2" };

  const failure = recordFailure("npm test", 1, "Error: boom", s1);
  assert.deepEqual(failure.agent, s1);

  const result = resolveFixOnSuccess("npm test", process.cwd(), { agent: s2 });
  assert.equal(result.confirmedResolved, 0);
  assert.equal(result.possibleAssociated, 0);
  assert.equal(result.fix, undefined);

  const raw = readRawJsonl();
  assert.equal(raw.filter((record) => record.kind === "fix").length, 0);
  assert.equal(existsSync(pendingPath()), true);
});

test("resolveFixOnSuccess links and stamps same-session fixes and clears pending", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "sess-1" };

  recordFailure("npm test", 1, "Error: boom", s1);
  const result = resolveFixOnSuccess("npm test", process.cwd(), { agent: s1 });

  assert.equal(result.confirmedResolved, 1);
  assert.deepEqual(result.fix?.agent, s1);
  assert.equal(existsSync(pendingPath()), false);

  const fixes = readRawJsonl().filter((record) => record.kind === "fix");
  assert.equal(fixes.length, 1);
  assert.deepEqual(fixes[0]?.agent, s1);
});

test("stamped pass links an unstamped failure and clears pending", () => {
  const s2: AgentStamp = { vendor: "claude-code", session: "sess-2" };

  const failure = recordFailure("npm test", 1, "Error: boom", undefined);
  assert.equal("agent" in failure, false);

  const result = resolveFixOnSuccess("npm test", process.cwd(), { agent: s2 });
  assert.equal(result.confirmedResolved, 1);
  assert.deepEqual(result.fix?.agent, s2);
  assert.equal(existsSync(pendingPath()), false);
});

test("same session links when agentId is present on only one side, rejects when both differ", () => {
  const withAgentA: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "a1" };
  const withoutAgent: AgentStamp = { vendor: "claude-code", session: "s1" };
  const withAgentB: AgentStamp = { vendor: "claude-code", session: "s1", agentId: "a2" };

  recordFailure("npm test", 1, "Error: boom", withAgentA);
  const rejected = resolveFixOnSuccess("npm test", process.cwd(), { agent: withAgentB });
  assert.equal(rejected.confirmedResolved, 0);
  assert.equal(existsSync(pendingPath()), true);

  const linked = resolveFixOnSuccess("npm test", process.cwd(), { agent: withoutAgent });
  assert.equal(linked.confirmedResolved, 1);
  assert.deepEqual(linked.fix?.agent, withoutAgent);
  assert.equal(existsSync(pendingPath()), false);
});

test("same-program possible association carries the pass stamp and blocks cross-session links", () => {
  const s1: AgentStamp = { vendor: "claude-code", session: "sess-1" };
  const s2: AgentStamp = { vendor: "claude-code", session: "sess-2" };

  recordFailure("npm run build", 1, "Error: boom", s1);

  const crossSession = resolveFixOnSuccess("npm rebuild sharp", process.cwd(), { agent: s2 });
  assert.equal(crossSession.confirmedResolved, 0);
  assert.equal(crossSession.possibleAssociated, 0);
  assert.equal(crossSession.association, undefined);

  const sameSession = resolveFixOnSuccess("npm rebuild sharp", process.cwd(), { agent: s1 });
  assert.equal(sameSession.confirmedResolved, 0);
  assert.equal(sameSession.possibleAssociated, 1);
  assert.deepEqual(sameSession.association?.agent, s1);

  const associations = readRawJsonl().filter((record) => record.kind === "association");
  assert.equal(associations.length, 1);
  assert.deepEqual(associations[0]?.agent, s1);
});

test("rocky run CLI stamps valid sessions, omits invalid or unset ones silently, and stamps fixes", () => {
  const cmd = 'node -e "process.exit(3)"';

  const stampedHome = join(home.dir(), "cli-stamped");
  const unsetHome = join(home.dir(), "cli-unset");
  const invalidHome = join(home.dir(), "cli-invalid");

  const stampedRun = runCliWithSession(stampedHome, cmd, "sess-1");
  const unsetRun = runCliWithSession(unsetHome, cmd, undefined);
  const invalidRun = runCliWithSession(invalidHome, cmd, "a b");

  assert.equal(stampedRun.status, 3);
  assert.equal(unsetRun.status, 3);
  assert.equal(invalidRun.status, 3);

  const stampedRecords = readRawJsonl(join(stampedHome, "memory.jsonl"));
  const unsetRecords = readRawJsonl(join(unsetHome, "memory.jsonl"));
  const invalidRecords = readRawJsonl(join(invalidHome, "memory.jsonl"));

  const stampedLast = stampedRecords.at(-1)!;
  const unsetLast = unsetRecords.at(-1)!;
  const invalidLast = invalidRecords.at(-1)!;

  assert.deepEqual(stampedLast.agent, { vendor: "claude-code", session: "sess-1" });
  assert.equal(stampedLast.origin, unsetLast.origin);
  assert.equal("origin" in stampedLast, "origin" in unsetLast);

  assert.equal("agent" in unsetLast, false);
  assert.equal("agent" in invalidLast, false);
  assert.equal(invalidRun.stderr, unsetRun.stderr);

  const fixHome = join(home.dir(), "cli-fix");
  const toggleCmd = 'node -e "process.exit(Number(process.env.ROCKY_TEST_EXIT || 0))"';
  const failRun = runCliWithSession(fixHome, toggleCmd, "sess-1", { ROCKY_TEST_EXIT: "3" });
  assert.equal(failRun.status, 3);
  const passRun = runCliWithSession(fixHome, toggleCmd, "sess-1", { ROCKY_TEST_EXIT: "0" });
  assert.equal(passRun.status, 0);

  const fixRecords = readRawJsonl(join(fixHome, "memory.jsonl"));
  const fixLast = fixRecords.at(-1)!;
  assert.equal(fixLast.kind, "fix");
  assert.deepEqual(fixLast.agent, { vendor: "claude-code", session: "sess-1" });
  assert.equal(existsSync(join(fixHome, "pending")), false);
});
