/**
 * One-shot native hook ingress (spec §7). Installed as a static
 * command/argv the host validates; payload arrives only on stdin with a
 * size/deadline cap through an allowlist parser. No shell interpolation,
 * no PATH launcher lookup, fail-open with empty stdout, never throws.
 */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { EventEnvelope, HarnessId } from "./types.js";
import { isHarnessId } from "./types.js";
import { appendHostEvent, appendListeningEvent } from "./event-log.js";
import { isRepoCaptureAllowed } from "./repo-consent-read.js";
import { canonicalPath } from "../core/memory-read.js";

/** PROPOSAL-adjacent stdin cap; fixed so oversized payloads fail closed. */
export const LISTEN_INGRESS_MAX_BYTES = 64 * 1024;

const ALLOWED_SURFACES = new Set(["cli", "ide", "local", "profile"]);

export interface IngressResult {
  exit: 0;
  stdout: "";
  appended: boolean;
  reason: string;
}

/** Fields the allowlist parser keeps. Everything else is dropped. */
interface IngressPayload {
  nativeId?: string;
  sessionId?: string;
  toolName?: string;
  episode?: string;
  fileRel?: string;
  summaryRef?: string;
  repoRoot?: string;
  ts?: number;
}

function pickPayload(value: unknown): IngressPayload {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: IngressPayload = {};
  if (typeof raw["nativeId"] === "string" && raw["nativeId"].length > 0) out.nativeId = raw["nativeId"].slice(0, 256);
  if (typeof raw["sessionId"] === "string" && raw["sessionId"].length > 0) out.sessionId = raw["sessionId"].slice(0, 256);
  if (typeof raw["toolName"] === "string" && raw["toolName"].length > 0) out.toolName = raw["toolName"].slice(0, 256);
  if (typeof raw["episode"] === "string" && raw["episode"].length > 0) out.episode = raw["episode"].slice(0, 256);
  if (typeof raw["summaryRef"] === "string" && raw["summaryRef"].length > 0) out.summaryRef = raw["summaryRef"].slice(0, 256);
  if (typeof raw["fileRel"] === "string" && raw["fileRel"].length > 0) {
    const rel = canonicalPath(raw["fileRel"]);
    if (rel.length > 0 && !rel.startsWith("..")) out.fileRel = rel.slice(0, 1024);
  }
  if (typeof raw["repoRoot"] === "string" && raw["repoRoot"].length > 0) {
    out.repoRoot = raw["repoRoot"].slice(0, 4096);
  }
  if (typeof raw["ts"] === "number" && Number.isSafeInteger(raw["ts"]) && raw["ts"] > 0) {
    out.ts = raw["ts"];
  }
  // NOTE: generic `reason`, `prompt`, `args`, `response`, `transcript`,
  // and `thinking` fields are deliberately never read here. Hook policy
  // reasons land in hookPolicyReason only when the host provides a
  // dedicated, verified field; they are never agent-stated why.
  return out;
}

/**
 * Handle `rocky hook listen-event <harnessId> --surface <surface>`.
 * Frontend owns dispatch in src/index.ts; this export is the logic seam.
 */
export async function handleListenEvent(
  argv: string[],
  stdinBytes: Uint8Array,
  ctx: { hostConsent: boolean },
  home?: string,
): Promise<IngressResult> {
  try {
    if (argv.length !== 4 || argv[0] !== "listen-event" || argv[2] !== "--surface") {
      return { exit: 0, stdout: "", appended: false, reason: "bad-argv" };
    }
    const harnessRaw = argv[1];
    const surfaceRaw = argv[3];
    if (!isHarnessId(harnessRaw)) return { exit: 0, stdout: "", appended: false, reason: "bad-harness-id" };
    if (!ALLOWED_SURFACES.has(surfaceRaw)) return { exit: 0, stdout: "", appended: false, reason: "bad-surface" };
    if (ctx.hostConsent !== true) return { exit: 0, stdout: "", appended: false, reason: "host-consent-required" };
    if (stdinBytes.byteLength > LISTEN_INGRESS_MAX_BYTES) {
      return { exit: 0, stdout: "", appended: false, reason: "stdin-oversized" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(stdinBytes).toString("utf8"));
    } catch {
      return { exit: 0, stdout: "", appended: false, reason: "stdin-malformed" };
    }
    const payload = pickPayload(parsed);
    const harnessId: HarnessId = harnessRaw;
    const surface = surfaceRaw as "cli" | "ide" | "local" | "profile";
    const envelope: EventEnvelope = {
      v: 1,
      eventId: randomUUID(),
      source: "hook",
      harnessId,
      surface,
      ts: payload.ts ?? Date.now(),
      adapterVersion: "listening-hook-ingress/1",
      ...(payload.nativeId !== undefined ? { nativeId: payload.nativeId } : {}),
      ...(payload.sessionId !== undefined ? { node: "agent_session" as const, nodeId: payload.sessionId } : {}),
      consent: { host: true, repo: false, rawTrace: false },
      redaction: { applied: false, truncated: false },
      coverage: "partial",
      refs: {
        ...(payload.sessionId !== undefined ? { session: payload.sessionId } : {}),
        ...(payload.episode !== undefined ? { episode: payload.episode } : {}),
        ...(payload.fileRel !== undefined ? { fileRel: payload.fileRel } : {}),
        ...(payload.summaryRef !== undefined ? { summaryRef: payload.summaryRef } : {}),
      },
    };
    // Repo-scoped payloads join the repo log only under repo consent;
    // otherwise the evidence lands in the host log, never forced in.
    if (payload.repoRoot !== undefined) {
      const root = canonicalPath(payload.repoRoot);
      if (root.length > 0 && isRepoCaptureAllowed(root, home)) {
        const result = appendListeningEvent(root, { ...envelope, repoRoot: root, consent: { host: true, repo: true, rawTrace: false } }, undefined, home);
        return { exit: 0, stdout: "", appended: result.ok, reason: result.ok ? "appended-repo" : result.reason };
      }
      const result = appendHostEvent(harnessId, envelope, home, true);
      return { exit: 0, stdout: "", appended: result.ok, reason: result.ok ? "appended-host" : result.reason };
    }
    const result = appendHostEvent(harnessId, envelope, home, true);
    return { exit: 0, stdout: "", appended: result.ok, reason: result.ok ? "appended-host" : result.reason };
  } catch {
    return { exit: 0, stdout: "", appended: false, reason: "ingress-failed" };
  }
}
