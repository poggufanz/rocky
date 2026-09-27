/**
 * GUI-owned collector loop (spec §3, §6). While the foreground GUI lives,
 * every consented repo gets one lease-guarded owner that reconciles on a
 * bounded interval. A process that loses the lease skips that repo; a
 * revoked repo is released and stops capturing, its history stays. MCP
 * never imports this module (mcp-import-boundary): MCP stays read-only.
 */
import { randomBytes } from "node:crypto";
import { releaseCollector, tryAcquireCollector, type CollectorOwner } from "./collector.js";
import { listConsentedRepos } from "./repo-consent-read.js";
import { reconcileRepo } from "./watcher.js";

// ponytail: interval reconcile, no fs.watch trigger; add one when edit latency under a tick matters.
// Must stay under COLLECTOR_LEASE_MS (30s): each tick's acquire renews the lease.
export const COLLECTOR_TICK_MS = 10_000;

export interface CollectorLoop {
  /** Run one tick soon, e.g. right after a consent change. */
  kick(): void;
  /** Stop ticking and release every owned lease. */
  stop(): void;
}

export function startCollectorLoop(opts: { proc: CollectorOwner["proc"]; home?: string; tickMs?: number }): CollectorLoop {
  const owner: CollectorOwner = { proc: opts.proc, pid: process.pid, token: randomBytes(16).toString("hex") };
  const owned = new Set<string>();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    let roots: string[];
    try {
      roots = listConsentedRepos(opts.home);
    } catch {
      roots = [];
    }
    const consented = new Set(roots);
    for (const root of [...owned]) {
      if (consented.has(root)) continue;
      releaseCollector(root, owner.token, opts.home);
      owned.delete(root);
    }
    for (const root of roots) {
      try {
        if (!tryAcquireCollector(root, owner, opts.home).owner) {
          owned.delete(root);
          continue;
        }
        owned.add(root);
        reconcileRepo(root, undefined, opts.home);
      } catch {
        // fail-open: one unreadable repo never stops the others
      }
    }
  };

  const timers = new Set<NodeJS.Timeout>();
  const soon = (): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      tick();
    }, 0);
    t.unref();
    timers.add(t);
  };
  const interval = setInterval(tick, opts.tickMs ?? COLLECTOR_TICK_MS);
  interval.unref();
  soon();

  return {
    kick: () => {
      if (!stopped) soon();
    },
    stop: () => {
      stopped = true;
      clearInterval(interval);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const root of owned) releaseCollector(root, owner.token, opts.home);
      owned.clear();
    },
  };
}
