import { MAX_MEMORY_FILE_BYTES } from "../core/memory-read.js";

/** Weight for a line that must add up to the byte cap in fewer lines than the record cap. */
const FAT_EXCERPT = "x".repeat(4096);

/**
 * One failure record as a memory line, without its newline. The id is unique per
 * index, so every line is a record the reader keeps; `excerpt` only adds weight.
 */
export function failureLine(index: number, excerpt = "false"): string {
  return JSON.stringify({
    kind: "failure", id: `r${index}`, ts: 1, cwd: "/cap-fixture", cmd: "false", exitCode: 1,
    fingerprint: `r${index}`.padStart(16, "0"), signature: ["false"], excerpt,
  });
}

/** `count` newline-terminated failure lines, so memory reaches an exact record count without a slow writer. */
export function failureLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `${failureLine(index)}\n`).join("");
}

/**
 * Failure lines that pass the byte cap while staying under the record cap, so the
 * file size cap, not the record cap, is what stops the read.
 */
export function failureLinesPastByteCap(): string {
  const lineBytes = Buffer.byteLength(`${failureLine(0, FAT_EXCERPT)}\n`, "utf8");
  const count = Math.ceil(MAX_MEMORY_FILE_BYTES / lineBytes) + 1;
  return Array.from({ length: count }, (_, index) => `${failureLine(index, FAT_EXCERPT)}\n`).join("");
}
