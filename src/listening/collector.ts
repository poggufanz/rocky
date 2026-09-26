/**
 * Single-owner collector lease (spec §3). GUI-foreground and MCP-stdio
 * race for one owner per repo; the loser reads durable state only.
 * Ownership hands off after stop/crash without a daemon: the next
 * process checks the durable lease, steals when expired or owner-dead,
 * then reconciles. Ambiguity yields partial coverage, never dual writers.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collectorPath, repoDir } from "./store-paths.js";

export interface CollectorOwner {
  proc: "gui" | "mcp";
  pid: number;
  token: string;
}

interface Lease {
  proc: "gui" | "mcp";
  pid: number;
  token: string;
  expires: number;
}

/** PROPOSAL-adjacent lease length; fixed for recovery liveness. */
export const COLLECTOR_LEASE_MS = 30_000;

function readLease(repoRoot: string, home?: string): Lease | undefined {
  try {
    const raw = readFileSync(collectorPath(repoRoot, home), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const candidate = parsed as Record<string, unknown>;
    if ((candidate["proc"] !== "gui" && candidate["proc"] !== "mcp")
      || typeof candidate["pid"] !== "number"
      || typeof candidate["token"] !== "string"
      || typeof candidate["expires"] !== "number") {
      return undefined;
    }
    return candidate as unknown as Lease;
  } catch {
    return undefined;
  }
}

function writeLease(repoRoot: string, lease: Lease, home?: string): boolean {
  try {
    mkdirSync(repoDir(repoRoot, home), { recursive: true, mode: 0o700 });
    const target = collectorPath(repoRoot, home);
    try {
      const existing = lstatSync(target);
      if (!existing.isFile() || existing.isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const tmp = join(repoDir(repoRoot, home), `collector.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

/** True when the PID is observably alive. ESRCH/unknown means dead. */
function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM/EACCES: process exists, we only lack signal rights.
    if (code === "EPERM" || code === "EACCES") return true;
    return false;
  }
}

function validOwner(owner: CollectorOwner): boolean {
  return (owner.proc === "gui" || owner.proc === "mcp")
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.token === "string"
    && owner.token.length > 0;
}

export function tryAcquireCollector(
  repoRoot: string,
  owner: CollectorOwner,
  home?: string,
  now: number = Date.now(),
): { owner: boolean; leaseMs: number } {
  if (!validOwner(owner) || typeof repoRoot !== "string" || repoRoot.length === 0) {
    return { owner: false, leaseMs: COLLECTOR_LEASE_MS };
  }
  const current = readLease(repoRoot, home);
  if (current !== undefined && current.token === owner.token) {
    const renewed: Lease = { ...current, proc: owner.proc, pid: owner.pid, expires: now + COLLECTOR_LEASE_MS };
    writeLease(repoRoot, renewed, home);
    return { owner: true, leaseMs: COLLECTOR_LEASE_MS };
  }
  if (current !== undefined && current.expires > now && pidAlive(current.pid)) {
    return { owner: false, leaseMs: Math.max(0, current.expires - now) };
  }
  const lease: Lease = { proc: owner.proc, pid: owner.pid, token: owner.token, expires: now + COLLECTOR_LEASE_MS };
  if (!writeLease(repoRoot, lease, home)) return { owner: false, leaseMs: COLLECTOR_LEASE_MS };
  return { owner: true, leaseMs: COLLECTOR_LEASE_MS };
}

export function heartbeatCollector(
  repoRoot: string,
  token: string,
  home?: string,
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const current = readLease(repoRoot, home);
  if (current === undefined || current.token !== token) return false;
  return writeLease(repoRoot, { ...current, expires: now + COLLECTOR_LEASE_MS }, home);
}

export function releaseCollector(repoRoot: string, token: string, home?: string): void {
  if (typeof token !== "string" || token.length === 0) return;
  const current = readLease(repoRoot, home);
  if (current === undefined || current.token !== token) return;
  const released: Lease = { ...current, expires: 0 };
  writeLease(repoRoot, released, home);
}
