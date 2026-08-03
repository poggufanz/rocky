/**
 * Rocky's photographic memory.
 *
 * Every failure and every fix is appended to a local JSONL file
 * (~/.rocky/memory.jsonl). Nothing leaves the machine. Eridians remember
 * everything; so does this file.
 *
 * MVP notes: append-only JSONL, fully loaded into RAM per invocation.
 * Fine for years of normal use (a heavy week of failures is a few hundred KB).
 * Indexing can come later if anyone's memory file gets huge.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprint, signatureLines, similarity, tokens } from "./fingerprint.js";
const ROCKY_DIR = process.env.ROCKY_HOME ?? join(homedir(), ".rocky");
const MEMORY_FILE = join(ROCKY_DIR, "memory.jsonl");
export function memoryPath() {
    return MEMORY_FILE;
}
function ensureDir() {
    if (!existsSync(ROCKY_DIR))
        mkdirSync(ROCKY_DIR, { recursive: true });
}
export function loadMemory() {
    if (!existsSync(MEMORY_FILE))
        return [];
    const records = [];
    for (const line of readFileSync(MEMORY_FILE, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            records.push(JSON.parse(trimmed));
        }
        catch {
            // a corrupt line never kills the memory; skip it
        }
    }
    // link fixes back onto failures
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const r of records) {
        if (r.kind !== "fix")
            continue;
        for (const fid of r.failureIds) {
            const f = byId.get(fid);
            if (f && f.kind === "failure")
                f.resolvedBy = r.id;
        }
    }
    return records;
}
function append(record) {
    ensureDir();
    appendFileSync(MEMORY_FILE, JSON.stringify(record) + "\n", "utf8");
}
export function recordFailure(cmd, exitCode, stderr) {
    const rec = {
        kind: "failure",
        id: randomUUID(),
        ts: Date.now(),
        cwd: process.cwd(),
        cmd,
        exitCode,
        fingerprint: fingerprint(stderr),
        signature: signatureLines(stderr),
        excerpt: lastLines(stderr, 4),
    };
    append(rec);
    return rec;
}
export function recordFix(cmd, failures) {
    const rec = {
        kind: "fix",
        id: randomUUID(),
        ts: Date.now(),
        cwd: process.cwd(),
        cmd,
        failureIds: failures.map((f) => f.id),
    };
    append(rec);
    return rec;
}
/** All failures with this exact fingerprint, oldest first. */
export function findByFingerprint(records, fp) {
    return records.filter((r) => r.kind === "failure" && r.fingerprint === fp);
}
export function getFix(records, failure) {
    if (!failure.resolvedBy)
        return undefined;
    return records.find((r) => r.kind === "fix" && r.id === failure.resolvedBy);
}
/**
 * Unresolved failures from the same working directory whose command shares a
 * base program with `cmd`, within `windowMs`. Used to link a success to the
 * failures it just fixed.
 */
export function recentUnresolvedFailures(records, cmd, windowMs = 1000 * 60 * 60 * 48) {
    const base = cmd.trim().split(/\s+/)[0];
    const cutoff = Date.now() - windowMs;
    return records.filter((r) => r.kind === "failure" &&
        !r.resolvedBy &&
        r.ts >= cutoff &&
        r.cwd === process.cwd() &&
        r.cmd.trim().split(/\s+/)[0] === base);
}
/** Fuzzy search over remembered failures. One hit per distinct error. */
export function search(records, query, limit = 3) {
    const q = tokens(query);
    const best = new Map(); // fingerprint -> best hit
    for (const r of records) {
        if (r.kind !== "failure")
            continue;
        const bag = tokens([r.cmd, ...r.signature].join(" "));
        const score = similarity(q, bag);
        if (score <= 0.05)
            continue;
        const hit = { failure: r, fix: getFix(records, r), score };
        const prev = best.get(r.fingerprint);
        // prefer an occurrence that has a fix; then the newer one
        if (!prev || (!prev.fix && hit.fix) || (!!prev.fix === !!hit.fix && r.ts > prev.failure.ts)) {
            best.set(r.fingerprint, hit);
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
function lastLines(text, n) {
    const lines = text
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
    return lines.slice(-n).join("\n");
}
