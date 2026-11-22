import {
  commandIdentity,
  FINGERPRINT_ALGORITHM_VERSION,
  fingerprintSignature,
} from "../dist/core/fingerprint.js";

const SIGNAL_TEMPLATES = [
  (tag, idx) => `error: family ${tag} check failed in service stage #`,
  (tag, idx) => `fatal: cannot connect to worker ${tag} on port ${4000 + idx}`,
  (tag, idx) => `exception: missing config entry for ${tag} pipeline`,
  (tag, idx) => `failed: invalid checksum while verifying ${tag} artifact`,
  (tag, idx) => `error: connection refused by upstream ${tag} gateway`,
  (tag, idx) => `unexpected token while parsing ${tag} manifest`,
  (tag, idx) => `unable to acquire lock for ${tag} deployment`,
  (tag, idx) => `traceback: panic in ${tag} handler dispatch`,
];

const LONG_CMD_PATH_RE = /(?:^|\s)\/(?:[^\s/]+\/)+[^\s/]+/;
const LONG_CMD_SHA_RE = /\b[0-9a-f]{40}\b/;
const LONG_CMD_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const LONG_CMD_PORT_RE = /\b127\.0\.0\.1:\d{4,5}\b/;
const LONG_CMD_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/;

export function alphaTag(index) {
  let n = index;
  let out = "";
  for (let i = 0; i < 3; i += 1) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

export function deterministicHex(seedA, seedB, length) {
  let state = ((seedA * 2654435761) ^ (seedB * 2246822519) ^ 0x9e3779b9) >>> 0;
  let out = "";
  while (out.length < length) {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
    z ^= (z + Math.imul(z ^ (z >>> 7), z | 61)) >>> 0;
    z = (z ^ (z >>> 14)) >>> 0;
    out += z.toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

export function makeRealisticCommand(fpIdx, seq, ts) {
  const tag = alphaTag(fpIdx);
  const port = 4000 + fpIdx;
  const sha = deterministicHex(fpIdx + 1, seq + 11, 40);
  const u = deterministicHex(fpIdx + 101, seq + 997, 32);
  const uuid = `${u.slice(0, 8)}-${u.slice(8, 12)}-4${u.slice(13, 16)}-8${u.slice(17, 20)}-${u.slice(20, 32)}`;
  const iso = new Date(ts).toISOString();
  // Varying path segments shifts command byte length across 300..1,200 bytes
  // while keeping `normalizeLine(cmd)` identical within a command family.
  const segments = 1 + ((seq * 7 + fpIdx * 13) % 42);
  const deepDir = Array.from({ length: segments }, (_, idx) => `seg-${(seq + idx) % 97}-${idx}`).join("/");
  const entryPath = `/workspace/services/svc-${alphaTag(fpIdx % 25)}/${deepDir}/runner-${seq}.mjs`;
  const logPath = `/var/log/rocky/runs/${deepDir}/job-${seq}.log`;
  return (
    `node ${entryPath} --family fam-${tag} --commit ${sha} --request-id ${uuid} ` +
    `--endpoint http://127.0.0.1:${port}/api/v1/run --listen 127.0.0.1:${port} ` +
    `--started-at ${iso} --pid ${10000 + (seq % 50000)} --attempt ${1 + (seq % 99)} ` +
    `--log ${logPath}`
  );
}

export function makeSignalSignature(fpIdx) {
  const tag = alphaTag(fpIdx);
  const lineCount = 1 + (fpIdx % 8);
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push(SIGNAL_TEMPLATES[i](tag, fpIdx));
  }
  return lines;
}

export function measureDatasetMix(records) {
  let totalFailures = 0;
  let emptySignatureFailures = 0;
  let signalLineFailures = 0;
  let minSignalLines = Infinity;
  let maxSignalLines = 0;
  let longCommandBytesMin = Infinity;
  let longCommandBytesMax = 0;
  const distinctLongCommands = new Set();
  const distinctAllCommands = new Set();

  for (const record of records) {
    if (record.kind !== "failure") continue;
    totalFailures += 1;
    distinctAllCommands.add(record.cmd);
    const sigLen = record.signature.length;
    if (sigLen === 0) {
      emptySignatureFailures += 1;
    } else if (sigLen >= 1 && sigLen <= 8) {
      signalLineFailures += 1;
      if (sigLen < minSignalLines) minSignalLines = sigLen;
      if (sigLen > maxSignalLines) maxSignalLines = sigLen;
    }
    const bytes = Buffer.byteLength(record.cmd, "utf8");
    if (
      bytes >= 300 &&
      bytes <= 1200 &&
      LONG_CMD_PATH_RE.test(record.cmd) &&
      LONG_CMD_SHA_RE.test(record.cmd) &&
      LONG_CMD_UUID_RE.test(record.cmd) &&
      LONG_CMD_PORT_RE.test(record.cmd) &&
      LONG_CMD_TS_RE.test(record.cmd)
    ) {
      distinctLongCommands.add(record.cmd);
      if (bytes < longCommandBytesMin) longCommandBytesMin = bytes;
      if (bytes > longCommandBytesMax) longCommandBytesMax = bytes;
    }
  }

  return {
    totalFailures,
    distinctCommands: distinctAllCommands.size,
    distinctLongCommands: distinctLongCommands.size,
    distinctLongCommandPct: Number(((distinctLongCommands.size / totalFailures) * 100).toFixed(2)),
    longCommandBytesMin: Number.isFinite(longCommandBytesMin) ? longCommandBytesMin : 0,
    longCommandBytesMax,
    emptySignatureFailures,
    emptySignaturePct: Number(((emptySignatureFailures / totalFailures) * 100).toFixed(2)),
    signalLineFailures,
    signalLinePct: Number(((signalLineFailures / totalFailures) * 100).toFixed(2)),
    minSignalLines: Number.isFinite(minSignalLines) ? minSignalLines : 0,
    maxSignalLines,
  };
}

export function assertDatasetMix(records) {
  const mix = measureDatasetMix(records);
  if (mix.distinctLongCommandPct < 60) {
    throw new Error(`Expected >=60% distinct 300-1200B commands, got ${mix.distinctLongCommandPct}%`);
  }
  if (mix.emptySignaturePct < 29 || mix.emptySignaturePct > 31) {
    throw new Error(`Expected ~30% empty-signature failures, got ${mix.emptySignaturePct}%`);
  }
  if (mix.emptySignatureFailures + mix.signalLineFailures !== mix.totalFailures) {
    throw new Error("Unexpected signature lengths outside 0 or 1..8");
  }
  return mix;
}

export function generateRealisticRecords({
  recordCount,
  fingerprintCount,
  cwds,
  platform,
  startTs,
  stepMs,
  sampleTs,
  idPrefix = "",
  excerptPrefix = "Error: benchmark failure family",
  patchResolvedBy = false,
  includeFixLinks = false,
}) {
  const shortCmds = Array.from({ length: 10 }, (_, index) => {
    const cmd = `npm run check-${index}`;
    const identity = commandIdentity(cmd, { platform });
    return {
      cmd,
      commandIdentity: identity.value,
      identityV: identity.version,
      identityReliable: identity.reliable,
    };
  });

  const fingerprints = Array.from({ length: fingerprintCount }, (_, index) => {
    const isCommandFamily = index % 10 < 3;
    const usesLongCmd = index % 10 < 7;
    const signature = isCommandFamily ? [] : makeSignalSignature(index);
    const sampleCmd = usesLongCmd ? makeRealisticCommand(index, 0, sampleTs) : shortCmds[index % shortCmds.length].cmd;
    return {
      fp: fingerprintSignature(signature, sampleCmd, 1),
      signature,
      usesLongCmd,
      isCommandFamily,
      excerpt: isCommandFamily ? "" : `${excerptPrefix} ${alphaTag(index)}`,
    };
  });

  const records = [];
  const lastFailureByKey = new Map();
  let seq = 0;
  let ts = startTs;
  let verifiedCommandFamilyCount = 0;

  while (records.length < recordCount) {
    ts += stepMs;
    const slot = Math.floor(seq / fingerprintCount) % 10;
    const fpIdx = seq % fingerprintCount;
    const cwdIdx = (Math.floor(fpIdx / 10) + Math.floor(seq / (fingerprintCount * 10))) % cwds.length;
    const cwd = cwds[cwdIdx];
    const family = fingerprints[fpIdx];
    const key = `${cwdIdx}:${fpIdx}`;
    const prior = lastFailureByKey.get(key);

    if (slot === 7 && prior !== undefined) {
      const fixId = `${idPrefix}fix-${seq}`;
      if (patchResolvedBy) {
        prior.resolvedBy = fixId;
      }
      const fixRecord = {
        kind: "fix",
        id: fixId,
        ts,
        cwd,
        cmd: prior.cmd,
        failureIds: [prior.id],
        ...(includeFixLinks ? { links: [{ id: prior.id, basis: "identity", confidence: "confirmed" }] } : {}),
        commandIdentity: prior.commandIdentity,
        identityV: prior.identityV,
        identityReliable: prior.identityReliable,
        platform,
      };
      records.push(fixRecord);
      lastFailureByKey.delete(key);
    } else if (slot === 9 && prior !== undefined) {
      const assocCmd = `${shortCmds[fpIdx % shortCmds.length].cmd} -- --filter unit`;
      const assocId = commandIdentity(assocCmd, { platform });
      records.push({
        kind: "association",
        id: `${idPrefix}assoc-${seq}`,
        ts,
        cwd,
        cmd: assocCmd,
        candidateFailureIds: [prior.id],
        links: [{ id: prior.id, basis: "program", confidence: "possible" }],
        commandIdentity: assocId.value,
        identityV: assocId.version,
        identityReliable: assocId.reliable,
        platform,
      });
      lastFailureByKey.delete(key);
    } else {
      let cmd;
      let identityValue;
      let identityV;
      let identityReliable;
      if (family.usesLongCmd) {
        cmd = makeRealisticCommand(fpIdx, seq, ts);
        const identity = commandIdentity(cmd, { platform });
        identityValue = identity.value;
        identityV = identity.version;
        identityReliable = identity.reliable;
      } else {
        const shortMeta = shortCmds[fpIdx % shortCmds.length];
        cmd = shortMeta.cmd;
        identityValue = shortMeta.commandIdentity;
        identityV = shortMeta.identityV;
        identityReliable = shortMeta.identityReliable;
      }
      if (family.isCommandFamily && verifiedCommandFamilyCount < fingerprintCount) {
        const checkFp = fingerprintSignature([], cmd, 1);
        if (checkFp !== family.fp) {
          throw new Error(`Command-family fingerprint drift for fpIdx=${fpIdx}, seq=${seq}: ${checkFp} !== ${family.fp}`);
        }
        verifiedCommandFamilyCount += 1;
      }
      const failure = {
        kind: "failure",
        id: `${idPrefix}fail-${seq}`,
        ts,
        cwd,
        cmd,
        exitCode: 1,
        fingerprint: family.fp,
        fingerprintV: FINGERPRINT_ALGORITHM_VERSION,
        signature: family.signature,
        excerpt: family.excerpt,
        origin: "run",
        commandIdentity: identityValue,
        identityV,
        identityReliable,
        platform,
      };
      records.push(failure);
      lastFailureByKey.set(key, failure);
    }
    seq += 1;
  }

  return { records, fingerprints };
}
