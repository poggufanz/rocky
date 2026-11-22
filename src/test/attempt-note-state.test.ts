import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import test, { beforeEach } from "node:test";
import {
  ADVISORY_LOG_MAX_BYTES,
  appendExposure,
  attemptArm,
  claimNoteSlot,
  cwdHash,
  exposureKeyHash,
  noteAdvisoryEnabled,
  type ExposureRow,
} from "../core/attempt-note-state.js";
import { cwdIdentityKey } from "../core/memory-read.js";
import { useTempRockyHome } from "./temp-rocky-home.js";

const home = useTempRockyHome("rocky-attempt-note-state-");

beforeEach(() => {
  for (const name of readdirSync(home.dir())) {
    rmSync(join(home.dir(), name), { recursive: true, force: true });
  }
});

function firstBitOfSha256(value: string): 0 | 1 {
  const firstByte = createHash("sha256").update(value, "utf8").digest()[0]!;
  return (firstByte & 0x80) === 0 ? 0 : 1;
}

function findSessionWithFirstBit(target: 0 | 1): string {
  for (let i = 1; i <= 100; i += 1) {
    const candidate = `sess-${String(i).padStart(2, "0")}`;
    if (firstBitOfSha256(candidate) === target) return candidate;
  }
  throw new Error(`No session id found with first bit ${target}`);
}

const SHOWN_SESSION = findSessionWithFirstBit(0);
const HELD_SESSION = findSessionWithFirstBit(1);

test("attemptArm uses the first bit of sha256(session) and stays deterministic", () => {
  assert.equal(firstBitOfSha256(SHOWN_SESSION), 0);
  assert.equal(firstBitOfSha256(HELD_SESSION), 1);

  assert.equal(attemptArm(SHOWN_SESSION, {}), "shown");
  assert.equal(attemptArm(SHOWN_SESSION, {}), "shown");
  assert.equal(attemptArm(HELD_SESSION, {}), "held");
  assert.equal(attemptArm(HELD_SESSION, {}), "held");
});

test("attemptArm without session returns unassigned in agent shell and human otherwise", () => {
  assert.equal(attemptArm(undefined, { CLAUDECODE: "1" }), "unassigned");
  assert.equal(attemptArm("", { CLAUDECODE: "1" }), "unassigned");
  assert.equal(attemptArm("   ", { CLAUDECODE: "1" }), "unassigned");

  assert.equal(attemptArm(undefined, {}), "human");
  assert.equal(attemptArm(undefined, { CLAUDECODE: "0" }), "human");
  assert.equal(attemptArm("", {}), "human");
});

test("attemptArm honors seam only when ROCKY_TEST_SEAMS is literally 1", () => {
  assert.equal(
    attemptArm(SHOWN_SESSION, { ROCKY_ATTEMPT_ARM: "held", ROCKY_TEST_SEAMS: "1" }),
    "held",
  );
  assert.equal(
    attemptArm(HELD_SESSION, { ROCKY_ATTEMPT_ARM: "shown", ROCKY_TEST_SEAMS: "1" }),
    "shown",
  );

  // Seam is ignored unless ROCKY_TEST_SEAMS is literally "1".
  assert.equal(
    attemptArm(SHOWN_SESSION, { ROCKY_ATTEMPT_ARM: "held", ROCKY_TEST_SEAMS: "true" }),
    "shown",
  );
  assert.equal(
    attemptArm(SHOWN_SESSION, { ROCKY_ATTEMPT_ARM: "held" }),
    "shown",
  );

  // Invalid seam values fall back to normal assignment.
  assert.equal(
    attemptArm(SHOWN_SESSION, { ROCKY_ATTEMPT_ARM: "unassigned", ROCKY_TEST_SEAMS: "1" }),
    "shown",
  );
  assert.equal(
    attemptArm(HELD_SESSION, { ROCKY_ATTEMPT_ARM: "invalid", ROCKY_TEST_SEAMS: "1" }),
    "held",
  );
});

test("noteAdvisoryEnabled disables only when ROCKY_ATTEMPT_ADVISORY is off", () => {
  assert.equal(noteAdvisoryEnabled({}), true);
  assert.equal(noteAdvisoryEnabled({ ROCKY_ATTEMPT_ADVISORY: "" }), true);
  assert.equal(noteAdvisoryEnabled({ ROCKY_ATTEMPT_ADVISORY: "on" }), true);
  assert.equal(noteAdvisoryEnabled({ ROCKY_ATTEMPT_ADVISORY: "off" }), false);
});

test("claimNoteSlot claims once per session and key and uses expected file shape", () => {
  const t = 1_795_300_000_000;
  const keyA = "output:aaaaaaaaaaaaaaaa:1111111111111111";
  const keyB = "output:bbbbbbbbbbbbbbbb:2222222222222222";

  assert.equal(claimNoteSlot(home.dir(), "sess-a", keyA, t), true);
  assert.equal(claimNoteSlot(home.dir(), "sess-a", keyA, t + 1000), false);
  // Session claims persist beyond 30 minutes within the session file.
  assert.equal(claimNoteSlot(home.dir(), "sess-a", keyA, t + 4 * 60 * 60_000), false);
  assert.equal(claimNoteSlot(home.dir(), "sess-a", keyB, t + 2000), true);
  assert.equal(claimNoteSlot(home.dir(), "sess-b", keyA, t + 3000), true);

  const fileA = join(home.dir(), "gate-state", "sess-a.attempts.json");
  assert.equal(existsSync(fileA), true);
  const parsed = JSON.parse(readFileSync(fileA, "utf8")) as { v: number; shown: Record<string, number> };
  assert.deepEqual(parsed, {
    v: 1,
    shown: {
      [keyA]: t,
      [keyB]: t + 2000,
    },
  });
});

test("claimNoteSlot keeps session named no-session separate from the no-session cooldown file", () => {
  const t = 1_795_300_000_000;
  const key = "output:cccccccccccccccc:3333333333333333";

  assert.equal(claimNoteSlot(home.dir(), "no-session", key, t), true);
  assert.equal(claimNoteSlot(home.dir(), undefined, key, t + 1000), true);

  const sessionFile = join(home.dir(), "gate-state", "no-session.attempts.json");
  const cooldownFile = join(home.dir(), "gate-state", "no-session.cooldown.json");
  assert.equal(existsSync(sessionFile), true);
  assert.equal(existsSync(cooldownFile), true);

  // Cooldown expires after 31 minutes without affecting the named session.
  assert.equal(claimNoteSlot(home.dir(), undefined, key, t + 32 * 60_000), true);
  assert.equal(claimNoteSlot(home.dir(), "no-session", key, t + 32 * 60_000), false);
});

test("claimNoteSlot without session uses a 30-minute cooldown", () => {
  const t = 1_795_300_000_000;
  const key = "output:dddddddddddddddd:4444444444444444";

  assert.equal(claimNoteSlot(home.dir(), undefined, key, t), true);
  assert.equal(claimNoteSlot(home.dir(), undefined, key, t + 29 * 60_000), false);
  assert.equal(claimNoteSlot(home.dir(), undefined, key, t + 31 * 60_000), true);
  assert.equal(claimNoteSlot(home.dir(), undefined, key, t + 32 * 60_000), false);

  const cooldownFile = join(home.dir(), "gate-state", "no-session.cooldown.json");
  assert.equal(existsSync(cooldownFile), true);
  const parsed = JSON.parse(readFileSync(cooldownFile, "utf8")) as { v: number; shown: Record<string, number> };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.shown[key], t + 31 * 60_000);
});

test("claimNoteSlot caps stored keys at 500 keeping the newest timestamps", () => {
  const baseTs = 1_795_300_000_000;
  const session = "sess-cap";

  for (let i = 0; i < 505; i += 1) {
    assert.equal(claimNoteSlot(home.dir(), session, `key-${i}`, baseTs + i), true);
  }

  const file = join(home.dir(), "gate-state", `${session}.attempts.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { v: number; shown: Record<string, number> };
  const keys = Object.keys(parsed.shown);
  assert.equal(keys.length, 500);

  // Oldest 5 keys were evicted; newest 500 remain.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(`key-${i}` in parsed.shown, false, `expected key-${i} to be evicted`);
  }
  assert.equal("key-5" in parsed.shown, true);
  assert.equal("key-504" in parsed.shown, true);

  assert.equal(claimNoteSlot(home.dir(), session, "key-504", baseTs + 600), false);
  assert.equal(claimNoteSlot(home.dir(), session, "key-0", baseTs + 601), true);
});

test("claimNoteSlot fails open on corrupt, oversized, or unwritable gate-state", () => {
  const t = 1_795_300_000_000;
  const gateStateDir = join(home.dir(), "gate-state");
  mkdirSync(gateStateDir, { recursive: true });

  writeFileSync(join(gateStateDir, "corrupt.attempts.json"), "{not-json", "utf8");
  assert.equal(claimNoteSlot(home.dir(), "corrupt", "k1", t), true);

  writeFileSync(join(gateStateDir, "badshape.attempts.json"), JSON.stringify({ v: 2, shown: [] }), "utf8");
  assert.equal(claimNoteSlot(home.dir(), "badshape", "k1", t), true);

  writeFileSync(join(gateStateDir, "oversized.attempts.json"), "x".repeat(300 * 1024), "utf8");
  assert.equal(claimNoteSlot(home.dir(), "oversized", "k1", t), true);

  // Replace gate-state with a regular file so directory creation fails.
  const blockedHome = join(home.dir(), "blocked");
  mkdirSync(blockedHome, { recursive: true });
  writeFileSync(join(blockedHome, "gate-state"), "not-a-directory", "utf8");
  assert.equal(claimNoteSlot(blockedHome, "sess-blocked", "k1", t), true);
  assert.equal(claimNoteSlot(blockedHome, undefined, "k1", t), true);
});

test("claimNoteSlot sanitizes path-traversal session ids so state stays inside gate-state", () => {
  const t = 1_795_300_000_000;
  const isolatedHome = join(home.dir(), "nested", "rocky-home");
  mkdirSync(isolatedHome, { recursive: true });

  assert.equal(claimNoteSlot(isolatedHome, "../../../evil", "k1", t), true);
  assert.equal(claimNoteSlot(isolatedHome, "../../../evil", "k1", t + 1000), false);

  const escapedGuess = join(dirname(dirname(isolatedHome)), "evil.attempts.json");
  assert.equal(existsSync(escapedGuess), false, "no file at naive path-traversal escape location");

  const gateStateDir = join(isolatedHome, "gate-state");
  assert.equal(existsSync(gateStateDir), true);
  const entries = readdirSync(gateStateDir);
  assert.equal(entries.length, 1);
  assert.ok(entries[0]!.endsWith(".attempts.json"));

  const realGateStateDir = realpathSync(gateStateDir);
  for (const entry of entries) {
    const realEntry = realpathSync(join(gateStateDir, entry));
    assert.ok(
      realEntry === realGateStateDir || realEntry.startsWith(realGateStateDir + sep),
      `state entry "${entry}" resolves inside gate-state/`,
    );
  }
});

test("appendExposure writes one JSON line per row and stops at ADVISORY_LOG_MAX_BYTES", () => {
  assert.equal(ADVISORY_LOG_MAX_BYTES, 8 * 1024 * 1024);

  const noteRow: ExposureRow = {
    v: 1,
    ts: 1_795_300_000_000,
    session: SHOWN_SESSION,
    lane: "tool-result",
    kind: "note",
    arm: "shown",
    key: "output:3f2a9c1e44d0b7a1:0123456789abcdef",
    cwdHash: cwdHash("/work/repo"),
    anchorFailureId: "fail-01",
    latencyMs: 42,
    delivered: true,
    bytes: 312,
  };
  const skipRow: ExposureRow = {
    v: 1,
    ts: 1_795_300_000_500,
    session: SHOWN_SESSION,
    lane: "tool-result",
    kind: "skip",
    arm: null,
    key: null,
    cwdHash: cwdHash("/work/repo"),
    anchorFailureId: null,
    latencyMs: 3,
    delivered: false,
    bytes: 0,
    reason: "lock_busy",
  };

  const expectedKeyHash = exposureKeyHash(noteRow.key!);
  assert.equal(expectedKeyHash, createHash("sha256").update(noteRow.key!, "utf8").digest("hex").slice(0, 16));
  appendExposure(home.dir(), noteRow);
  appendExposure(home.dir(), skipRow);

  const logFile = join(home.dir(), "advisories.jsonl");
  const lines = readFileSync(logFile, "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]!), { ...noteRow, key: expectedKeyHash });
  assert.deepEqual(JSON.parse(lines[1]!), skipRow);
  assert.equal(noteRow.key, "output:3f2a9c1e44d0b7a1:0123456789abcdef", "appendExposure must not mutate caller row");

  // Pre-fill to the byte cap: further appends stop without throwing.
  const cappedHome = join(home.dir(), "capped");
  mkdirSync(cappedHome, { recursive: true });
  const cappedLog = join(cappedHome, "advisories.jsonl");
  writeFileSync(cappedLog, Buffer.alloc(ADVISORY_LOG_MAX_BYTES, 0x20));
  assert.equal(statSync(cappedLog).size, ADVISORY_LOG_MAX_BYTES);

  assert.doesNotThrow(() => appendExposure(cappedHome, noteRow));
  assert.equal(statSync(cappedLog).size, ADVISORY_LOG_MAX_BYTES);

  // Unwritable target fails open without throwing.
  const brokenHome = join(home.dir(), "broken-log");
  mkdirSync(join(brokenHome, "advisories.jsonl"), { recursive: true });
  assert.doesNotThrow(() => appendExposure(brokenHome, noteRow));
});

test("appendExposure hashes non-null problem keys and omits cwd path segments", () => {
  const sampleCwd = process.platform === "win32"
    ? "C:\\Users\\Alice\\secret-project\\nested-dir"
    : "/home/alice/secret-project/nested-dir";
  const problemKey = `output:3f2a9c1e44d0b7a1:${sampleCwd}`;
  const otherProblemKey = `output:aaaaaaaaaaaaaaaa:${sampleCwd}`;
  const expectedHash = createHash("sha256").update(problemKey, "utf8").digest("hex").slice(0, 16);
  assert.equal(exposureKeyHash(problemKey), expectedHash);
  assert.equal(exposureKeyHash(problemKey), exposureKeyHash(problemKey));
  assert.match(exposureKeyHash(problemKey), /^[0-9a-f]{16}$/u);
  assert.notEqual(exposureKeyHash(otherProblemKey), expectedHash);

  const firstRow: ExposureRow = {
    v: 1,
    ts: 1_795_300_001_000,
    session: SHOWN_SESSION,
    lane: "run",
    kind: "note",
    arm: "shown",
    key: problemKey,
    cwdHash: cwdHash(sampleCwd),
    anchorFailureId: "fail-10",
    latencyMs: 12,
    delivered: true,
    bytes: 280,
  };
  const secondRow: ExposureRow = {
    ...firstRow,
    ts: 1_795_300_002_000,
    anchorFailureId: "fail-11",
    delivered: false,
  };
  const differentRow: ExposureRow = {
    ...firstRow,
    ts: 1_795_300_003_000,
    key: otherProblemKey,
    anchorFailureId: "fail-12",
  };
  const skipRow: ExposureRow = {
    v: 1,
    ts: 1_795_300_004_000,
    session: SHOWN_SESSION,
    lane: "tool-result",
    kind: "skip",
    arm: null,
    key: null,
    cwdHash: cwdHash(sampleCwd),
    anchorFailureId: null,
    latencyMs: 2,
    delivered: false,
    bytes: 0,
    reason: "wrapped",
  };

  appendExposure(home.dir(), firstRow);
  appendExposure(home.dir(), secondRow);
  appendExposure(home.dir(), differentRow);
  appendExposure(home.dir(), skipRow);

  const logFile = join(home.dir(), "advisories.jsonl");
  const rawLines = readFileSync(logFile, "utf8").split("\n").filter((line) => line.length > 0);
  assert.equal(rawLines.length, 4);

  const pathSegments = sampleCwd.split(/[\\/]+/).filter((seg) => seg.length > 0 && !/^[A-Za-z]:$/u.test(seg));
  for (const rawLine of rawLines) {
    const lower = rawLine.toLowerCase();
    assert.equal(lower.includes(sampleCwd.toLowerCase()), false, `cwd leaked in ${rawLine}`);
    assert.equal(lower.includes(sampleCwd.replace(/\\/g, "/").toLowerCase()), false, `cwd leaked in ${rawLine}`);
    for (const segment of pathSegments) {
      assert.equal(lower.includes(segment.toLowerCase()), false, `segment "${segment}" leaked in ${rawLine}`);
    }
  }

  const parsed = rawLines.map((line) => JSON.parse(line) as ExposureRow);
  assert.match(parsed[0]!.key!, /^[0-9a-f]{16}$/u);
  assert.equal(parsed[0]!.key, expectedHash);
  assert.equal(parsed[1]!.key, parsed[0]!.key);
  assert.match(parsed[2]!.key!, /^[0-9a-f]{16}$/u);
  assert.notEqual(parsed[2]!.key, parsed[0]!.key);
  assert.equal(parsed[3]!.key, null);
});

test("cwdHash never contains the path and uses cwdIdentityKey", () => {
  const sample = process.platform === "win32" ? "C:\\Users\\Alice\\secret-project" : "/home/alice/secret-project";
  const hashed = cwdHash(sample);
  const expected = createHash("sha256")
    .update(cwdIdentityKey(sample, process.platform), "utf8")
    .digest("hex")
    .slice(0, 16);

  assert.equal(hashed, expected);
  assert.match(hashed, /^[0-9a-f]{16}$/u);
  assert.equal(hashed.includes("secret-project"), false);
  assert.equal(hashed.includes("Alice"), false);
  assert.equal(hashed.includes("alice"), false);

  if (process.platform === "win32") {
    assert.equal(cwdHash("C:\\X"), cwdHash("c:\\x"));
    assert.equal(cwdHash("C:\\X"), cwdHash("C:/X/"));
  } else {
    assert.equal(cwdHash("/work/x"), cwdHash("/work/x"));
    assert.notEqual(cwdHash("/work/X"), cwdHash("/work/x"));
  }
});
