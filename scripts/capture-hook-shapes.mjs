#!/usr/bin/env node
// capture-hook-shapes.mjs — Claude Code hook fixture capture.
//
// Modes:
//   init <outDir> <hookExe>       write sandbox settings (plain + async)
//   record <outDir> <hookExe>      hook entrypoint: merge key-shape, forward stdin to hook exe
//   finalize <outDir> <fixtureDir> copy shapes, merge spool into session.jsonl
//   --self-test                    assert shape-union + placeholder logic
//
// Node 18+ ESM, built-ins only. `record` always exits 0 with no stdout:
// hook failures must never block the agent session.

import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionEnd',
];
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const EVENT_NAME_RE = /^[A-Za-z0-9_.-]+$/;
// Raw ids shorter than this only replace whole values, never substrings,
// so a short id can never corrupt unrelated strings.
const MIN_SUBSTRING_ID_LEN = 8;

const fwd = (p) => p.replace(/\\/g, '/');
const absFwd = (p) => fwd(path.resolve(p));
const scriptAbs = () => absFwd(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Shapes: recursive key->type maps, no values. Arrays keep the first element's
// shape. Type conflicts become {$any:[...]} (deduped, canonically ordered).
// Real hook payloads have no `$any` keys, so the marker is unambiguous.

function shapeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? [] : [shapeOf(v[0])];
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = shapeOf(v[k]);
    return o;
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v;
  return 'unknown';
}

const isUnion = (s) => typeof s === 'object' && s !== null && !Array.isArray(s) && Array.isArray(s.$any);
const isPlain = (s) => typeof s === 'object' && s !== null && !Array.isArray(s) && !isUnion(s);

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const keyOf = (s) => JSON.stringify(canon(s));

function unionOf(variants) {
  const seen = new Map();
  const push = (v) => {
    if (isUnion(v)) {
      for (const w of v.$any) push(w);
      return;
    }
    const k = keyOf(v);
    if (!seen.has(k)) seen.set(k, v);
  };
  for (const v of variants) push(v);
  const out = [...seen.values()].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  return out.length === 1 ? out[0] : { $any: out };
}

function mergeShapes(a, b) {
  if (keyOf(a) === keyOf(b)) return a;
  if (isUnion(a) || isUnion(b)) return unionOf([a, b]);
  if (isPlain(a) && isPlain(b)) {
    const o = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      o[k] = k in a && k in b ? mergeShapes(a[k], b[k]) : k in a ? a[k] : b[k];
    }
    const sorted = {};
    for (const k of Object.keys(o).sort()) sorted[k] = o[k];
    return sorted;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    return [mergeShapes(a[0], b[0])];
  }
  return unionOf([a, b]);
}

// ---------------------------------------------------------------------------
// init

function buildSettings(outAbs, exeAbs, asyncPostToolUse) {
  const base = `node "${scriptAbs()}" record "${outAbs}" "${exeAbs}"`;
  const hooks = {};
  for (const ev of EVENTS) {
    const isAsyncProbe = asyncPostToolUse && ev === 'PostToolUse';
    // Git Bash (which runs hook commands on Windows) accepts VAR=val prefixes.
    const command = isAsyncProbe ? `ROCKY_CAPTURE_SLEEP_MS=3000 ${base}` : base;
    const entry = { type: 'command', command };
    if (isAsyncProbe) entry.async = true;
    const group = MATCHER_EVENTS.has(ev) ? { matcher: '*', hooks: [entry] } : { hooks: [entry] };
    hooks[ev] = [group];
  }
  return { hooks };
}

function cmdInit(outDir, hookExe) {
  if (!outDir || !hookExe) {
    console.error('usage: capture-hook-shapes.mjs init <outDir> <hookExe>');
    process.exit(2);
  }
  if (!fs.existsSync(hookExe)) {
    console.error(`hookExe not found: ${hookExe}`);
    process.exit(1);
  }
  const outAbs = absFwd(outDir);
  const exeAbs = absFwd(hookExe);
  fs.mkdirSync(outDir, { recursive: true });
  const plain = path.join(outDir, 'sandbox-settings.json');
  const asyncFile = path.join(outDir, 'sandbox-settings-async.json');
  fs.writeFileSync(plain, JSON.stringify(buildSettings(outAbs, exeAbs, false), null, 2) + '\n');
  fs.writeFileSync(asyncFile, JSON.stringify(buildSettings(outAbs, exeAbs, true), null, 2) + '\n');
  console.log(`wrote ${plain}`);
  console.log(`wrote ${asyncFile}`);
}

// ---------------------------------------------------------------------------
// record (silent, infallible)

function mergeShapeFile(outDir, data) {
  let payload;
  try {
    payload = JSON.parse(data.toString('utf8'));
  } catch {
    return;
  }
  const rawName = payload !== null && typeof payload === 'object' ? payload.hook_event_name : null;
  const name = typeof rawName === 'string' && EVENT_NAME_RE.test(rawName) ? rawName : 'unknown';
  const dir = path.join(outDir, 'shapes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    prev = null;
  }
  const next = prev === null ? shapeOf(payload) : mergeShapes(prev, shapeOf(payload));
  // Temp + rename: concurrent hooks may lose a merge, never corrupt the file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

async function cmdRecord(outDir, hookExe) {
  try {
    const sleepMs = Number.parseInt(process.env.ROCKY_CAPTURE_SLEEP_MS ?? '', 10);
    if (Number.isFinite(sleepMs) && sleepMs > 0) await sleep(sleepMs);
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const data = Buffer.concat(chunks);
    try {
      mergeShapeFile(outDir, data);
    } catch {
      // Shape merge must never break the spool write below.
    }
    try {
      spawnSync(hookExe, ['desk-hook', 'claude-code'], {
        input: data,
        env: { ...process.env, ROCKY_HOME: path.join(outDir, 'home') },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      // Hook exe failure still exits 0: never block the agent session.
    }
  } catch {
    // Stdin read failure etc: stay silent, exit 0.
  }
}

// ---------------------------------------------------------------------------
// finalize

// [prefix, placeholder] pairs, longest first. CLAUDE_CONFIG_DIR wins over the
// home dir so a relocated Claude profile (e.g. a per-profile UUID path) never
// lands in a committed fixture.
function homePrefixes(home = os.homedir(), claudeConfig = process.env.CLAUDE_CONFIG_DIR) {
  const seen = new Set();
  const out = [];
  for (const [base, ph] of [
    [claudeConfig, '<CLAUDE_CONFIG>'],
    [home, '<HOME>'],
  ]) {
    if (!base) continue;
    for (const f of [base, base.replace(/\\/g, '/')]) {
      if (!seen.has(f.toLowerCase())) {
        seen.add(f.toLowerCase());
        out.push([f, ph]);
      }
    }
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function collectIds(records) {
  const sess = new Map();
  const agent = new Map();
  const tool = new Map();
  const intern = (m, raw, prefix) => {
    if (typeof raw !== 'string' || raw.length === 0 || m.has(raw)) return;
    m.set(raw, `${prefix}${m.size + 1}`);
  };
  for (const r of records) {
    const e = r !== null && typeof r === 'object' ? r.event : null;
    if (e === null || typeof e !== 'object') continue;
    intern(sess, e.session_id, 'S');
    intern(agent, e.agent_id, 'A');
    intern(tool, e.tool_use_id, 'T');
  }
  // Longest raw first so overlapping ids replace correctly; assignment order
  // (first-seen) is already fixed in the maps.
  const all = [...sess, ...agent, ...tool].sort((a, b) => b[0].length - a[0].length);
  return all;
}

function replaceInString(s, idPairs, homes) {
  for (const [raw, ph] of idPairs) {
    if (s === raw) {
      s = ph;
      break;
    }
  }
  for (const [raw, ph] of idPairs) {
    if (raw.length >= MIN_SUBSTRING_ID_LEN && s.includes(raw)) s = s.split(raw).join(ph);
  }
  const low = s.toLowerCase();
  for (const [h, ph] of homes) {
    if (low.startsWith(h.toLowerCase())) {
      s = ph + s.slice(h.length);
      break;
    }
  }
  return s;
}

function transformValue(v, idPairs, homes) {
  if (typeof v === 'string') return replaceInString(v, idPairs, homes);
  if (Array.isArray(v)) return v.map((x) => transformValue(x, idPairs, homes));
  if (v !== null && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = transformValue(v[k], idPairs, homes);
    return o;
  }
  return v;
}

// Pure pipeline shared by cmdFinalize and --self-test.
function finalizeRecords(records, homes = homePrefixes()) {
  const idPairs = collectIds(records);
  const base = records.length > 0 && typeof records[0].recv_ms === 'number' ? records[0].recv_ms : 0;
  return records.map((r) => {
    const c = transformValue(r, idPairs, homes);
    if (typeof c.recv_ms === 'number') c.recv_ms -= base;
    return JSON.stringify(c);
  });
}

function cmdFinalize(outDir, fixtureDir) {
  if (!outDir || !fixtureDir) {
    console.error('usage: capture-hook-shapes.mjs finalize <outDir> <fixtureDir>');
    process.exit(2);
  }
  const spoolDir = path.join(outDir, 'home', 'desk', 'spool');
  let names = [];
  try {
    names = fs.readdirSync(spoolDir).filter((n) => n.endsWith('.json')).sort();
  } catch {
    names = [];
  }
  const records = [];
  for (const n of names) {
    try {
      records.push(JSON.parse(fs.readFileSync(path.join(spoolDir, n), 'utf8')));
    } catch {
      // Skip unreadable spool files; finalize stays total.
    }
  }
  const lines = finalizeRecords(records);
  fs.mkdirSync(path.join(fixtureDir, 'shapes'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'session.jsonl'), lines.length > 0 ? lines.join('\n') + '\n' : '');
  let copied = 0;
  try {
    for (const n of fs.readdirSync(path.join(outDir, 'shapes'))) {
      if (!n.endsWith('.json')) continue;
      fs.copyFileSync(path.join(outDir, 'shapes', n), path.join(fixtureDir, 'shapes', n));
      copied++;
    }
  } catch {
    // No shapes dir yet: session.jsonl is still written.
  }
  console.log(`finalized ${records.length} records, ${copied} shapes -> ${fixtureDir}`);
}

// ---------------------------------------------------------------------------
// --self-test

function cmdSelfTest() {
  // shapeOf: scalars, nesting, arrays keep the first element only.
  assert.deepStrictEqual(shapeOf({ a: 'x', n: 1, b: true, z: null }), {
    a: 'string',
    n: 'number',
    b: 'boolean',
    z: 'null',
  });
  assert.deepStrictEqual(shapeOf({ arr: [{ x: 1 }, { y: 2 }] }), { arr: [{ x: 'number' }] });
  assert.deepStrictEqual(shapeOf({ e: [] }), { e: [] });
  assert.deepStrictEqual(shapeOf({ o: { deep: { s: 'v' } } }), { o: { deep: { s: 'string' } } });

  // mergeShapes: key union incl. nested objects.
  assert.deepStrictEqual(
    mergeShapes({ a: 'string', o: { x: 'number' } }, { b: 'boolean', o: { y: 'string' } }),
    { a: 'string', b: 'boolean', o: { x: 'number', y: 'string' } },
  );
  // mergeShapes: array element shapes merge; empty absorbs.
  assert.deepStrictEqual(
    mergeShapes({ l: [{ x: 'number' }] }, { l: [{ y: 'string' }] }),
    { l: [{ x: 'number', y: 'string' }] },
  );
  assert.deepStrictEqual(mergeShapes({ l: [] }, { l: ['string'] }), { l: ['string'] });
  assert.deepStrictEqual(mergeShapes([], []), []);
  // mergeShapes: identical input is a no-op.
  assert.deepStrictEqual(mergeShapes({ k: 'string' }, { k: 'string' }), { k: 'string' });
  // mergeShapes: type conflicts (leaf, nested, union-absorb, array-vs-leaf).
  assert.deepStrictEqual(mergeShapes({ k: 'string' }, { k: 'number' }), {
    k: { $any: ['number', 'string'] },
  });
  assert.deepStrictEqual(mergeShapes({ o: { k: 'string' } }, { o: { k: 'number' } }), {
    o: { k: { $any: ['number', 'string'] } },
  });
  assert.deepStrictEqual(mergeShapes({ k: { $any: ['number', 'string'] } }, { k: 'boolean' }), {
    k: { $any: ['boolean', 'number', 'string'] },
  });
  assert.deepStrictEqual(mergeShapes({ k: { $any: ['number', 'string'] } }, { k: 'string' }), {
    k: { $any: ['number', 'string'] },
  });
  assert.deepStrictEqual(mergeShapes(['string'], 'number'), { $any: ['number', ['string']] });

  // finalizeRecords: placeholders (first-seen), ids embedded in paths, home
  // prefix in both separator styles + case-insensitive, recv_ms shift.
  const home = os.homedir();
  const homeSlash = home.replace(/\\/g, '/');
  const flipFirst = home.replace(/[A-Za-z]/, (c) =>
    c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
  const records = [
    {
      v: 1,
      harness: 'claude-code',
      recv_ms: 5000,
      kind: 'event',
      event: {
        hook_event_name: 'SessionStart',
        session_id: 'session-uuid-0001',
        cwd: `${home}\\scratch`,
        transcript_path: `${homeSlash}/.claude/projects/scratch/session-uuid-0001.jsonl`,
      },
    },
    {
      v: 1,
      harness: 'claude-code',
      recv_ms: 5007,
      kind: 'event',
      event: {
        hook_event_name: 'PreToolUse',
        session_id: 'session-uuid-0001',
        agent_id: 'agent-uuid-0002',
        tool_name: 'Edit',
        tool_use_id: 'tool-uuid-0003',
        target_path: `${homeSlash}/scratch/a.ts`,
        cwd: `${flipFirst}\\x`,
      },
    },
    {
      v: 1,
      harness: 'claude-code',
      recv_ms: 5010,
      kind: 'event',
      event: {
        hook_event_name: 'PostToolUse',
        session_id: 'session-uuid-0002',
        agent_id: 'agent-uuid-0004',
        tool_use_id: 'tool-uuid-0003',
        cwd: `${homeSlash}/scratch`,
      },
    },
    { v: 1, harness: 'claude-code', recv_ms: 5020, kind: 'dropped', reason: 'oversize', bytes: 9 },
  ];
  const lines = finalizeRecords(records);
  assert.equal(lines.length, 4);
  const [l0, l1, l2, l3] = lines.map((l) => JSON.parse(l));
  assert.equal(l0.recv_ms, 0);
  assert.equal(l0.event.session_id, 'S1');
  assert.equal(l0.event.cwd, '<HOME>\\scratch');
  assert.equal(l0.event.transcript_path, '<HOME>/.claude/projects/scratch/S1.jsonl');
  assert.equal(l1.recv_ms, 7);
  assert.equal(l1.event.session_id, 'S1');
  assert.equal(l1.event.agent_id, 'A1');
  assert.equal(l1.event.tool_use_id, 'T1');
  assert.equal(l1.event.target_path, '<HOME>/scratch/a.ts');
  assert.equal(l1.event.cwd, '<HOME>\\x');
  assert.equal(l2.recv_ms, 10);
  assert.equal(l2.event.session_id, 'S2');
  assert.equal(l2.event.agent_id, 'A2');
  assert.equal(l2.event.tool_use_id, 'T1');
  assert.equal(l3.recv_ms, 20);
  assert.equal(l3.reason, 'oversize');
  assert.deepStrictEqual(finalizeRecords([]), []);

  // A Claude config dir under home maps to <CLAUDE_CONFIG>, not <HOME>.
  const cfg = `${home}\\AppData\\profiles\\0000-uuid\\home`;
  const [cfgLine] = finalizeRecords(
    [{ v: 1, recv_ms: 1, kind: 'event', event: { transcript_path: `${cfg}\\projects\\x.jsonl` } }],
    homePrefixes(home, cfg),
  ).map((l) => JSON.parse(l));
  assert.equal(cfgLine.event.transcript_path, '<CLAUDE_CONFIG>\\projects\\x.jsonl');
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const [mode, a, b] = argv;
  switch (mode) {
    case '--self-test':
      cmdSelfTest();
      console.log('self-test: PASS');
      return;
    case 'init':
      cmdInit(a, b);
      return;
    case 'record':
      try {
        await cmdRecord(a, b);
      } catch {
        // Never throw: hooks always exit 0 silently.
      }
      return;
    case 'finalize':
      cmdFinalize(a, b);
      return;
    default:
      console.error(
        'usage: capture-hook-shapes.mjs (init <outDir> <hookExe> | record <outDir> <hookExe> | finalize <outDir> <fixtureDir> | --self-test)',
      );
      process.exit(2);
  }
}

await main(process.argv.slice(2));
