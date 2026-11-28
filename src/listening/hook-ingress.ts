/**
 * One-shot native hook ingress. Installed as a static
 * command/argv the host validates; payload arrives only on stdin with a
 * size/deadline cap through an allowlist parser. No shell interpolation,
 * no PATH launcher lookup, fail-open with empty stdout, never throws.
 */
import { Buffer } from "node:buffer";
import type { EventEnvelope } from "./types.js";
import { isHarnessId } from "./types.js";
import { appendHostEvent, appendListeningEvent } from "./event-log.js";
import { isRepoCaptureAllowed } from "./repo-consent-read.js";
import { canonicalPath } from "../core/memory-read.js";
import { loadHarnessDecoder } from "../harnesses/index.js";
import { projectToListening } from "../harnesses/projections/to-listening.js";
import { asFields, readListeningFields } from "../harnesses/shared/field-extract.js";

/** PROPOSAL-adjacent stdin cap; fixed so oversized payloads fail closed. */
export const LISTEN_INGRESS_MAX_BYTES = 64 * 1024;

const ALLOWED_SURFACES = new Set(["cli", "ide", "local", "profile"]);

export interface IngressResult {
  exit: 0;
  stdout: "";
  appended: boolean;
  reason: string;
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
    const decoder = await loadHarnessDecoder(harnessRaw);
    // Registered harnesses without a native hook decoder still accept the
    // original allowlisted envelope fields.
    const decoded = decoder?.decodeHook(parsed) ?? {
      harnessId: harnessRaw, listening: readListeningFields(asFields(parsed)),
    };
    const root = canonicalPath(decoded.listening.repoRoot ?? "");
    const envelope = projectToListening(decoded, {
      hostConsent: ctx.hostConsent,
      repoConsent: root.length > 0 && isRepoCaptureAllowed(root, home),
      surface: surfaceRaw as NonNullable<EventEnvelope["surface"]>,
    });
    if (!envelope) return { exit: 0, stdout: "", appended: false, reason: "host-consent-required" };
    if (envelope.repoRoot !== undefined) {
      const result = appendListeningEvent(envelope.repoRoot, envelope, undefined, home);
      return { exit: 0, stdout: "", appended: result.ok, reason: result.ok ? "appended-repo" : result.reason };
    }
    const result = appendHostEvent(harnessRaw, envelope, home, ctx.hostConsent);
    return { exit: 0, stdout: "", appended: result.ok, reason: result.ok ? "appended-host" : result.reason };
  } catch {
    return { exit: 0, stdout: "", appended: false, reason: "ingress-failed" };
  }
}
