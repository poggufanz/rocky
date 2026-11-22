import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { prepareLaneOneNote } from "../dist/commands/attempt-note-lane.js";
import { priorAttemptsNote } from "../dist/core/attempt-note.js";
import {
  commandIdentity,
  fingerprint,
  FINGERPRINT_ALGORITHM_VERSION,
  fingerprintSignature,
  signatureLines,
} from "../dist/core/fingerprint.js";
import { recordAgentFailure } from "../dist/core/memory.js";
import { canonicalPath, loadMemoryChecked } from "../dist/core/memory-read.js";
import { quoteShellPath } from "../dist/core/shell-quote.js";
import { makeCardsFor, toolTextAllowed } from "../dist/desk/cards-read.js";
import { cardsFilePath } from "../dist/listening/cards-path.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(packageRoot, "dist", "index.js");

const TOTAL_RECORDS = 10_000;
const BACKGROUND_FINGERPRINTS = 200;
const BACKGROUND_CWDS = 20;
const EXTRA_CARDS = 45;
const NEAR_CAP_CARD_LOG_TARGET_BYTES = 15_500_000;
const LANE1_WARMUPS = 1;
const LANE1_IN_PROCESS_RUNS = 20;
const LANE1_PROCESS_RUNS = 5;
const LANE2_SPAWNS = 50;
const IN_PROCESS_AGENT_FAILURE_WARMUPS = 1;
const IN_PROCESS_AGENT_FAILURE_RUNS = 20;
const TARGET_LANE1_MS = 10;
const TARGET_LANE2_P95_MS = 300;
const PROCESS_TIMEOUT_MS = 30_000;

const TARGET_STDERR = "Error: benchmark token missing in auth middleware";
const TARGET_EXIT_CODE = 1;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const rounded = values.map((value) => Number(value.toFixed(3)));
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    min: Number(Math.min(...values).toFixed(3)),
    p50: Number(percentile(values, 50).toFixed(3)),
    p95: Number(percentile(values, 95).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
    mean: Number((sum / values.length).toFixed(3)),
    samples: rounded,
  };
}

function shownSessions(count, prefix) {
  const ids = [];
  let seq = 1;
  while (ids.length < count) {
    const candidate = `${prefix}-${seq}`;
    seq += 1;
    const firstByte = createHash("sha256").update(candidate, "utf8").digest()[0];
    if ((firstByte & 0x80) === 0) {
      ids.push(candidate);
    }
  }
  return ids;
}

function cleanEnv(rockyHome, extra = {}) {
  const env = { ...process.env, ROCKY_HOME: rockyHome };
  delete env.ROCKY_AGENT_SESSION;
  delete env.ROCKY_TEST_SEAMS;
  delete env.ROCKY_ATTEMPT_ARM;
  delete env.ROCKY_ATTEMPT_ADVISORY;
  delete env.CLAUDECODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function makeCard(cardId, root, overrides = {}) {
  return {
    v: 1,
    card_id: cardId,
    rev: 1,
    root,
    session_id: "bench-seed-s1",
    agent_id: "",
    started_ms: 0,
    ended_ms: 0,
    prompt: "inspect auth middleware check",
    blocks: [],
    flow: [],
    flow_more: 0,
    coverage: { state: "full", reasons: [] },
    ...overrides,
  };
}

function makeBlock(seq, path) {
  return {
    seq,
    path,
    labels: [{ id: "body_changed" }],
    importance: "medium",
  };
}

function seedFixture(rockyHome, repoDir, targetCmd, now, options = {}) {
  const targetCardLogBytes = options.targetCardLogBytes ?? 0;
  mkdirSync(rockyHome, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true });

  const targetIdentity = commandIdentity(targetCmd, { platform: process.platform });
  const targetFp = fingerprint(`${TARGET_STDERR}\n`, targetCmd, TARGET_EXIT_CODE);
  const targetSig = signatureLines(`${TARGET_STDERR}\n`);

  const otherErr = "Error: benchmark secondary validation mismatch";
  const otherFp = fingerprint(`${otherErr}\n`, targetCmd, TARGET_EXIT_CODE);
  const otherSig = signatureLines(`${otherErr}\n`);

  // Target history: 5 prior attempts for the same (fingerprint, cwd) plus 1 fix
  // record and 1 different-error failure (7 records total), placed at the end
  // of the 10,000-record log so they stay in the newest window.
  const baseTs = now - 20 * 60_000;
  const t1 = baseTs;
  const t2 = baseTs + 60_000;
  const t3 = baseTs + 120_000;
  const tFix = baseTs + 180_000;
  const t4 = baseTs + 240_000;
  const tOther = baseTs + 300_000;
  const t5 = baseTs + 360_000;

  const targetRecords = [
    {
      kind: "failure",
      id: "bench-target-fail-1",
      ts: t1,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: targetFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: targetSig,
      excerpt: TARGET_STDERR,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s1", toolUseId: "tu-bench-1" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "failure",
      id: "bench-target-fail-2",
      ts: t2,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: targetFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: targetSig,
      excerpt: TARGET_STDERR,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s1", toolUseId: "tu-bench-2" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "failure",
      id: "bench-target-fail-3",
      ts: t3,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: targetFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: targetSig,
      excerpt: TARGET_STDERR,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s1", toolUseId: "tu-bench-3" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "fix",
      id: "bench-target-fix-3",
      ts: tFix,
      cwd: repoDir,
      cmd: targetCmd,
      failureIds: ["bench-target-fail-3"],
      links: [{ id: "bench-target-fail-3", basis: "identity", confidence: "confirmed" }],
      agent: { vendor: "claude-code", session: "bench-seed-s1" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "failure",
      id: "bench-target-fail-4",
      ts: t4,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: targetFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: targetSig,
      excerpt: TARGET_STDERR,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s2", toolUseId: "tu-bench-4" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "failure",
      id: "bench-target-other-4",
      ts: tOther,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: otherFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: otherSig,
      excerpt: otherErr,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s2", toolUseId: "tu-bench-other" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
    {
      kind: "failure",
      id: "bench-target-fail-5",
      ts: t5,
      cwd: repoDir,
      cmd: targetCmd,
      exitCode: TARGET_EXIT_CODE,
      fingerprint: targetFp,
      fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
      signature: targetSig,
      excerpt: TARGET_STDERR,
      origin: "agent",
      agent: { vendor: "claude-code", session: "bench-seed-s2", toolUseId: "tu-bench-5" },
      commandIdentity: targetIdentity.value,
      identityV: targetIdentity.version,
      identityReliable: targetIdentity.reliable,
      platform: process.platform,
    },
  ];

  const backgroundCount = TOTAL_RECORDS - targetRecords.length;
  const cwds = Array.from({ length: BACKGROUND_CWDS }, (_, index) =>
    index === 0 ? repoDir : join(dirname(repoDir), `other-project-${index}`),
  );
  const cmds = Array.from({ length: 10 }, (_, index) => {
    const cmd = `npm run check-${index}`;
    const identity = commandIdentity(cmd, { platform: process.platform });
    return { cmd, commandIdentity: identity.value, identityV: identity.version, identityReliable: identity.reliable };
  });
  const families = Array.from({ length: BACKGROUND_FINGERPRINTS }, (_, index) => {
    const signature = [`error: benchmark background family ${index}`];
    const cmdMeta = cmds[index % cmds.length];
    return {
      fp: fingerprintSignature(signature, cmdMeta.cmd, 1),
      signature,
      excerpt: `Error: benchmark background family ${index}`,
    };
  });

  // Span ~14 hours before baseTs so oldestTs always covers the 8h+10m window in tail mode.
  let ts = baseTs - 50_000_000;
  const records = [];
  const lastFailureByKey = new Map();
  let seq = 0;

  while (records.length < backgroundCount) {
    ts += 4_500;
    const slot = Math.floor(seq / BACKGROUND_FINGERPRINTS) % 10;
    const fpIdx = seq % BACKGROUND_FINGERPRINTS;
    const cwdIdx = (Math.floor(fpIdx / 10) + Math.floor(seq / (BACKGROUND_FINGERPRINTS * 10))) % BACKGROUND_CWDS;
    const cwd = cwds[cwdIdx];
    const family = families[fpIdx];
    const cmdMeta = cmds[fpIdx % cmds.length];
    const key = `${cwdIdx}:${fpIdx}`;
    const prior = lastFailureByKey.get(key);

    if (slot === 7 && prior !== undefined) {
      records.push({
        kind: "fix",
        id: `bg-fix-${seq}`,
        ts,
        cwd,
        cmd: cmdMeta.cmd,
        failureIds: [prior.id],
        links: [{ id: prior.id, basis: "identity", confidence: "confirmed" }],
        commandIdentity: cmdMeta.commandIdentity,
        identityV: cmdMeta.identityV,
        identityReliable: cmdMeta.identityReliable,
        platform: process.platform,
      });
      lastFailureByKey.delete(key);
    } else if (slot === 9 && prior !== undefined) {
      records.push({
        kind: "association",
        id: `bg-assoc-${seq}`,
        ts,
        cwd,
        cmd: `${cmdMeta.cmd} -- --filter unit`,
        candidateFailureIds: [prior.id],
        links: [{ id: prior.id, basis: "program", confidence: "possible" }],
        commandIdentity: cmdMeta.commandIdentity,
        identityV: cmdMeta.identityV,
        identityReliable: cmdMeta.identityReliable,
        platform: process.platform,
      });
      lastFailureByKey.delete(key);
    } else {
      const failure = {
        kind: "failure",
        id: `bg-fail-${seq}`,
        ts,
        cwd,
        cmd: cmdMeta.cmd,
        exitCode: 1,
        fingerprint: family.fp,
        fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
        signature: family.signature,
        excerpt: family.excerpt,
        origin: "run",
        commandIdentity: cmdMeta.commandIdentity,
        identityV: cmdMeta.identityV,
        identityReliable: cmdMeta.identityReliable,
        platform: process.platform,
      };
      records.push(failure);
      lastFailureByKey.set(key, failure);
    }
    seq += 1;
  }

  for (const record of targetRecords) {
    records.push(record);
  }

  const memoryPath = join(rockyHome, "memory.jsonl");
  const memoryContent = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  writeFileSync(memoryPath, memoryContent, "utf8");

  // Populate the repo's desk change-card log with cards joined to the target
  // attempts plus realistic background cards for the same repo.
  const targetCards = [
    makeCard("bench-target-card-1", repoDir, {
      session_id: "bench-seed-s1",
      started_ms: t1 - 5_000,
      ended_ms: t2 + 10_000,
      blocks: [makeBlock(1, "src/auth.ts")],
      flow: [
        {
          kind: "cmd",
          text: targetCmd,
          ok: false,
          dur_ms: 1_000,
          seqs: [],
          exit_code: TARGET_EXIT_CODE,
          start_ms: t1 - 1_000,
          end_ms: t1,
          cwd: repoDir,
          tool_use_id: "tu-bench-1",
        },
        {
          kind: "edit",
          text: "edit",
          ok: true,
          dur_ms: 1_200,
          seqs: [1],
          start_ms: t1 + 15_000,
          end_ms: t1 + 16_200,
        },
      ],
    }),
    makeCard("bench-target-card-2", repoDir, {
      session_id: "bench-seed-s1",
      started_ms: t2 - 5_000,
      ended_ms: t3 + 10_000,
      blocks: [makeBlock(1, "src/token.ts")],
      flow: [
        {
          kind: "cmd",
          text: targetCmd,
          ok: false,
          dur_ms: 1_000,
          seqs: [],
          exit_code: TARGET_EXIT_CODE,
          start_ms: t2 - 1_000,
          end_ms: t2,
          cwd: repoDir,
          tool_use_id: "tu-bench-2",
        },
        {
          kind: "edit",
          text: "edit",
          ok: true,
          dur_ms: 1_200,
          seqs: [1],
          start_ms: t2 + 15_000,
          end_ms: t2 + 16_200,
        },
      ],
    }),
    makeCard("bench-target-card-3", repoDir, {
      session_id: "bench-seed-s1",
      started_ms: t3 - 5_000,
      ended_ms: tFix + 10_000,
      blocks: [makeBlock(1, "src/session.ts")],
      flow: [
        {
          kind: "cmd",
          text: targetCmd,
          ok: false,
          dur_ms: 1_000,
          seqs: [],
          exit_code: TARGET_EXIT_CODE,
          start_ms: t3 - 1_000,
          end_ms: t3,
          cwd: repoDir,
          tool_use_id: "tu-bench-3",
        },
        {
          kind: "edit",
          text: "edit",
          ok: true,
          dur_ms: 1_200,
          seqs: [1],
          start_ms: t3 + 15_000,
          end_ms: t3 + 16_200,
        },
      ],
    }),
  ];
  const targetCardLines = targetCards.map((card) => JSON.stringify(card));
  const targetCardBytes = targetCardLines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);

  const cardLines = [];
  let cardBytes = targetCardBytes;
  const makeBackgroundCardLine = (index, padBlocks) => {
    const start = baseTs - (index + 1) * 120_000;
    const blocks = [
      makeBlock(1, `src/module-${index % 12}.ts`),
      makeBlock(2, `src/test/module-${index % 12}.test.ts`),
    ];
    for (let b = 3; b <= padBlocks; b += 1) {
      blocks.push(makeBlock(b, `src/features/area-${index % 20}/component-${b}.ts`));
    }
    return JSON.stringify(
      makeCard(`bench-bg-card-${String(index + 1).padStart(5, "0")}`, repoDir, {
        session_id: `bg-session-${index % 5}`,
        started_ms: start,
        ended_ms: start + 45_000,
        prompt: `update module ${index}`,
        blocks,
        flow: [
          {
            kind: "edit",
            text: "edit",
            ok: true,
            dur_ms: 800,
            seqs: [1, 2],
            start_ms: start + 5_000,
            end_ms: start + 5_800,
          },
          {
            kind: "cmd",
            text: `npm run check-${index % 10}`,
            ok: true,
            dur_ms: 1_500,
            seqs: [],
            exit_code: 0,
            start_ms: start + 10_000,
            end_ms: start + 11_500,
            cwd: repoDir,
          },
        ],
      }),
    );
  };

  if (targetCardLogBytes > 0) {
    let idx = 0;
    while (cardBytes < targetCardLogBytes) {
      const line = makeBackgroundCardLine(idx, 20);
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (cardBytes + lineBytes >= 16 * 1024 * 1024) break;
      cardLines.push(line);
      cardBytes += lineBytes;
      idx += 1;
    }
  } else {
    for (let i = 0; i < EXTRA_CARDS; i += 1) {
      const line = makeBackgroundCardLine(i, 2);
      cardLines.push(line);
      cardBytes += Buffer.byteLength(line, "utf8") + 1;
    }
  }

  for (const line of targetCardLines) {
    cardLines.push(line);
  }

  const cardLogPath = cardsFilePath(canonicalPath(repoDir), rockyHome);
  mkdirSync(dirname(cardLogPath), { recursive: true });
  writeFileSync(cardLogPath, `${cardLines.join("\n")}\n`, "utf8");

  return {
    recordsCount: records.length,
    memoryPath,
    memoryContent,
    memoryBytes: Buffer.byteLength(memoryContent, "utf8"),
    cardLogPath,
    cardsCount: cardLines.length,
    cardLogBytes: cardBytes,
    targetFp,
  };
}

function resetMemoryFile(rockyHome, fixture) {
  writeFileSync(fixture.memoryPath, fixture.memoryContent, "utf8");
  rmSync(join(rockyHome, "memory.idx.jsonl"), { force: true });
  rmSync(join(rockyHome, "pending"), { force: true });
}

function readAdvisories(rockyHome) {
  const path = join(rockyHome, "advisories.jsonl");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

function writeFailingScript(repoDir) {
  const scriptPath = join(repoDir, "bench-fail.mjs");
  writeFileSync(
    scriptPath,
    `process.stderr.write(${JSON.stringify(`${TARGET_STDERR}\n`)});\nprocess.exit(${TARGET_EXIT_CODE});\n`,
    "utf8",
  );
  return `${quoteShellPath(process.execPath, process.platform)} ${quoteShellPath(scriptPath, process.platform)}`;
}

const root = realpathSync.native(mkdtempSync(join(os.tmpdir(), "rocky-bench-attempt-note-")));

try {
  const now = Date.now();
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, ".git"), { recursive: true });

  // 1. Lane 1: prepareLaneOneNote in-process + end-to-end inside `rocky run`
  const lane1Home = join(root, "home-lane1");
  const lane1Cmd = writeFailingScript(repoDir);
  const lane1Fixture = seedFixture(lane1Home, repoDir, lane1Cmd, now);

  const prevRockyHome = process.env.ROCKY_HOME;
  let loaded;
  try {
    process.env.ROCKY_HOME = lane1Home;
    loaded = loadMemoryChecked();
  } finally {
    if (prevRockyHome === undefined) delete process.env.ROCKY_HOME;
    else process.env.ROCKY_HOME = prevRockyHome;
  }

  const lane1Sessions = shownSessions(LANE1_WARMUPS + LANE1_IN_PROCESS_RUNS, "bench-l1");
  let sampleLane1Text = "";
  let sampleLane1Bytes = 0;

  for (let i = 0; i < LANE1_WARMUPS; i += 1) {
    prepareLaneOneNote({
      lane: "run",
      records: loaded.records,
      coverage: loaded.coverage,
      fingerprints: [lane1Fixture.targetFp],
      cwd: repoDir,
      now,
      env: cleanEnv(lane1Home, { ROCKY_AGENT_SESSION: lane1Sessions[i] }),
      home: lane1Home,
    });
  }

  const lane1Samples = [];
  for (let i = 0; i < LANE1_IN_PROCESS_RUNS; i += 1) {
    const session = lane1Sessions[LANE1_WARMUPS + i];
    const started = performance.now();
    const prepared = prepareLaneOneNote({
      lane: "run",
      records: loaded.records,
      coverage: loaded.coverage,
      fingerprints: [lane1Fixture.targetFp],
      cwd: repoDir,
      now,
      env: cleanEnv(lane1Home, { ROCKY_AGENT_SESSION: session }),
      home: lane1Home,
    });
    const elapsedMs = performance.now() - started;
    if (prepared.text === undefined) {
      throw new Error(`Lane-1 prepareLaneOneNote unexpectedly returned no note on iteration ${i}`);
    }
    if (!prepared.text.includes("src/session.ts") || !prepared.text.includes("src/auth.ts")) {
      throw new Error(`Lane-1 note did not join the populated card log: ${prepared.text}`);
    }
    sampleLane1Text = `rocky: ${prepared.text}`;
    sampleLane1Bytes = Buffer.byteLength(sampleLane1Text, "utf8");
    lane1Samples.push(elapsedMs);
  }

  // Real `rocky run` spawns to verify prepareLaneOneNote latency inside the CLI process.
  const lane1ProcHome = join(root, "home-lane1-proc");
  const lane1ProcFixture = seedFixture(lane1ProcHome, repoDir, lane1Cmd, now);
  const lane1ProcSessions = shownSessions(LANE1_PROCESS_RUNS, "bench-l1-proc");
  const lane1ProcWallMs = [];
  for (let i = 0; i < LANE1_PROCESS_RUNS; i += 1) {
    resetMemoryFile(lane1ProcHome, lane1ProcFixture);
    const started = performance.now();
    const result = spawnSync(process.execPath, [cliEntry, "run", lane1Cmd], {
      cwd: repoDir,
      env: cleanEnv(lane1ProcHome, { ROCKY_AGENT_SESSION: lane1ProcSessions[i] }),
      encoding: "utf8",
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true,
    });
    const elapsedMs = performance.now() - started;
    if (result.status !== TARGET_EXIT_CODE) {
      throw new Error(`rocky run exited ${result.status}, expected ${TARGET_EXIT_CODE}: ${result.stderr}`);
    }
    if (!result.stderr.includes("src/session.ts") || !result.stderr.includes("Rocky records order, not cause.")) {
      throw new Error(`rocky run did not emit the joined prior-attempts note on spawn ${i}: ${result.stderr}`);
    }
    lane1ProcWallMs.push(elapsedMs);
  }
  const lane1ProcRows = readAdvisories(lane1ProcHome).filter((row) => row.lane === "run" && row.kind === "note");
  const lane1ProcReportedMs = lane1ProcRows.map((row) => row.latencyMs);

  // 2. Lane 2: 50 spawns + in-process recordAgentFailure/note timing for both
  //    the standard card log (~30 KiB) and a card log near the 16 MiB cap.
  const lane2Cmd = "npm test";

  function measureLane2Variant(variantName, targetCardLogBytes) {
    const lane2Home = join(root, `home-lane2-${variantName}`);
    const lane2Fixture = seedFixture(lane2Home, repoDir, lane2Cmd, now, { targetCardLogBytes });
    const lane2Sessions = shownSessions(LANE2_SPAWNS, `bench-l2-${variantName}`);
    const lane2WallMs = [];
    let lane2Delivered = 0;
    let sampleLane2Context = "";

    for (let i = 0; i < LANE2_SPAWNS; i += 1) {
      resetMemoryFile(lane2Home, lane2Fixture);
      const payload = JSON.stringify({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: lane2Cmd },
        error: `Exit code ${TARGET_EXIT_CODE}\n${TARGET_STDERR}\n`,
        session_id: lane2Sessions[i],
        tool_use_id: `tu-bench-l2-${variantName}-${i + 1}`,
        cwd: repoDir,
      });
      const started = performance.now();
      const result = spawnSync(process.execPath, [cliEntry, "hook", "tool-result", "claude-code"], {
        cwd: repoDir,
        env: cleanEnv(lane2Home),
        input: payload,
        encoding: "utf8",
        timeout: PROCESS_TIMEOUT_MS,
        windowsHide: true,
      });
      const elapsedMs = performance.now() - started;
      if (result.status !== 0) {
        throw new Error(`hook tool-result (${variantName}) exited ${result.status} on spawn ${i}: ${result.stderr}`);
      }
      const parsed = JSON.parse(result.stdout.trim());
      const context = parsed?.hookSpecificOutput?.additionalContext;
      if (parsed?.hookSpecificOutput?.hookEventName === "PostToolUseFailure" && typeof context === "string") {
        if (!context.includes("src/session.ts") || !context.includes("src/auth.ts")) {
          throw new Error(`Lane-2 (${variantName}) additionalContext did not join the populated card log on spawn ${i}: ${context}`);
        }
        lane2Delivered += 1;
        sampleLane2Context = context;
      }
      lane2WallMs.push(elapsedMs);
    }
    if (lane2Delivered !== LANE2_SPAWNS) {
      throw new Error(`Expected ${LANE2_SPAWNS} delivered lane-2 (${variantName}) notes, got ${lane2Delivered}`);
    }
    const lane2Rows = readAdvisories(lane2Home).filter((row) => row.lane === "tool-result" && row.kind === "note");
    const lane2ReportedMs = lane2Rows.map((row) => row.latencyMs);

    // In-process timings mirroring tool-result-hook.ts:
    // - observe captures only the pre-append snapshot inside the lock
    // - recordAgentFailureTotal bounds lock hold (never reads the card log)
    // - noteBuildAfterLock computes the note and reads the card log outside the lock
    const inProcessHome = join(root, `home-in-process-${variantName}`);
    const inProcessFixture = seedFixture(inProcessHome, repoDir, lane2Cmd, now, { targetCardLogBytes });
    const recordAgentFailureTotalMs = [];
    const observeInsideLockMs = [];
    const noteBuildAfterLockMs = [];

    try {
      process.env.ROCKY_HOME = inProcessHome;
      for (let i = 0; i < IN_PROCESS_AGENT_FAILURE_WARMUPS + IN_PROCESS_AGENT_FAILURE_RUNS; i += 1) {
        resetMemoryFile(inProcessHome, inProcessFixture);
        let observeElapsed = 0;
        const started = performance.now();
        const outcome = recordAgentFailure(
          {
            cmd: lane2Cmd,
            exitCode: TARGET_EXIT_CODE,
            body: `${TARGET_STDERR}\n`,
            cwd: repoDir,
            agent: { vendor: "claude-code", session: `bench-inproc-${variantName}-${i}`, toolUseId: `tu-inproc-${variantName}-${i}` },
          },
          {
            lockWaitMs: 1_000,
            now: now + i + 1,
            observe: (snapshot) => {
              const obsStarted = performance.now();
              const captured = {
                records: snapshot.records,
                coverage: snapshot.coverage,
                fingerprint: snapshot.fingerprint,
              };
              observeElapsed = performance.now() - obsStarted;
              return captured;
            },
          },
        );
        const totalElapsed = performance.now() - started;
        if (outcome.status !== "written") {
          throw new Error(`In-process recordAgentFailure (${variantName}) did not write on iteration ${i}`);
        }
        const noteStarted = performance.now();
        const cardsFor = makeCardsFor({ home: inProcessHome, toolText: toolTextAllowed(inProcessHome) });
        const note = priorAttemptsNote(
          outcome.observed.records,
          outcome.observed.coverage,
          { fingerprints: [outcome.observed.fingerprint], cwd: repoDir },
          { now: now + i + 1, cardsFor, platform: process.platform },
        );
        const noteElapsed = performance.now() - noteStarted;
        if (note === undefined || !note.text.includes("src/session.ts") || !note.text.includes("src/auth.ts")) {
          throw new Error(`In-process note build (${variantName}) did not join cards on iteration ${i}`);
        }
        if (i >= IN_PROCESS_AGENT_FAILURE_WARMUPS) {
          recordAgentFailureTotalMs.push(totalElapsed);
          observeInsideLockMs.push(observeElapsed);
          noteBuildAfterLockMs.push(noteElapsed);
        }
      }
    } finally {
      if (prevRockyHome === undefined) delete process.env.ROCKY_HOME;
      else process.env.ROCKY_HOME = prevRockyHome;
    }

    return {
      fixture: {
        records: lane2Fixture.recordsCount,
        priorAttemptsForTarget: 5,
        memoryBytes: lane2Fixture.memoryBytes,
        cardsInRepoLog: lane2Fixture.cardsCount,
        cardLogBytes: lane2Fixture.cardLogBytes,
        targetFingerprint: lane2Fixture.targetFp,
      },
      targetP95Ms: TARGET_LANE2_P95_MS,
      targetEnforced: false,
      spawns: LANE2_SPAWNS,
      delivered: lane2Delivered,
      wallMs: summarize(lane2WallMs),
      hookReportedLatencyMs: summarize(lane2ReportedMs),
      sampleAdditionalContext: sampleLane2Context,
      recordAgentFailureTotal: {
        label: "recordAgentFailure total, an upper bound on lock hold (no card read inside lock)",
        measuredInProcess: true,
        warmups: IN_PROCESS_AGENT_FAILURE_WARMUPS,
        runs: IN_PROCESS_AGENT_FAILURE_RUNS,
        ms: summarize(recordAgentFailureTotalMs),
      },
      observeInsideLock: {
        label: "observe callback, captures pre-append snapshot inside the lock",
        measuredInProcess: true,
        warmups: IN_PROCESS_AGENT_FAILURE_WARMUPS,
        runs: IN_PROCESS_AGENT_FAILURE_RUNS,
        ms: summarize(observeInsideLockMs),
      },
      noteBuildAfterLock: {
        label: "priorAttemptsNote + card log read, runs after lock release",
        measuredInProcess: true,
        warmups: IN_PROCESS_AGENT_FAILURE_WARMUPS,
        runs: IN_PROCESS_AGENT_FAILURE_RUNS,
        ms: summarize(noteBuildAfterLockMs),
      },
    };
  }

  const lane2Standard = measureLane2Variant("standard", 0);
  const lane2NearCap = measureLane2Variant("near-16mib", NEAR_CAP_CARD_LOG_TARGET_BYTES);

  const report = {
    command: "node scripts/benchmark-attempt-note.mjs",
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    fixture: lane2Standard.fixture,
    lane1PrepareNote: {
      targetMs: TARGET_LANE1_MS,
      targetEnforced: false,
      inProcessPrepareLaneOneNoteMs: summarize(lane1Samples),
      rockyRunReportedPrepareMs: summarize(lane1ProcReportedMs),
      rockyRunTotalWallMs: summarize(lane1ProcWallMs),
      noteBytes: sampleLane1Bytes,
      sampleNote: sampleLane1Text,
    },
    lane2ToolResultHook: lane2Standard,
    lane2ToolResultHookNear16MiBCardLog: lane2NearCap,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
