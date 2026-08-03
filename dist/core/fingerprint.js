/**
 * Error fingerprinting.
 *
 * Rocky "hears" errors, he doesn't read them. Two stack traces from the same
 * bug are never byte-identical (paths, line numbers, timestamps, memory
 * addresses all shift), so we normalize stderr down to the lines and tokens
 * that carry meaning, then hash that into a stable fingerprint.
 */
import { createHash } from "node:crypto";
/** Lines that usually carry the actual error meaning. */
const SIGNAL = /error|exception|fail|fatal|cannot|unable|not found|missing|denied|refused|invalid|unexpected|undefined|panic|traceback/i;
/** Strip ANSI escape sequences (colors, cursor movement). */
export function stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}
/** Normalize one line: mask the volatile parts, keep the meaning. */
export function normalizeLine(line) {
    return stripAnsi(line)
        .trim()
        // windows + posix absolute paths -> <path>
        .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+)+/g, "<path>")
        // urls -> <url>
        .replace(/https?:\/\/\S+/g, "<url>")
        // hex addresses / hashes -> <hex>
        .replace(/0x[0-9a-fA-F]+/g, "<hex>")
        .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
        // iso timestamps and clock times -> <time>
        .replace(/\d{4}-\d{2}-\d{2}[T ]?[\d:.]*Z?/g, "<time>")
        .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, "<time>")
        // remaining numbers (line numbers, ports, pids) -> #
        .replace(/\d+/g, "#")
        // collapse whitespace
        .replace(/\s+/g, " ")
        .toLowerCase();
}
/**
 * Pick the lines that define this error. Prefer lines that look like errors;
 * fall back to the tail of stderr (where most tools print their conclusion).
 */
export function signatureLines(stderr) {
    const lines = stripAnsi(stderr)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const signal = lines.filter((l) => SIGNAL.test(l));
    const chosen = signal.length > 0 ? signal.slice(0, 8) : lines.slice(-5);
    return chosen.map(normalizeLine).filter((l) => l.length > 0);
}
/** Stable hash for exact re-occurrence detection. */
export function fingerprint(stderr) {
    const sig = signatureLines(stderr).join("\n");
    return createHash("sha1").update(sig).digest("hex").slice(0, 16);
}
/** Token bag for fuzzy matching (recall search, near-miss detection). */
export function tokens(text) {
    const stop = new Set(["the", "a", "an", "at", "in", "on", "of", "to", "is", "was", "for", "and", "or"]);
    const bag = new Set();
    for (const raw of normalizeLine(text).split(/[^a-z<>#_.-]+/)) {
        if (raw.length <= 2 || stop.has(raw))
            continue;
        bag.add(raw);
        // "some-missing-package" also yields "some", "missing", "package"
        for (const part of raw.split(/[-_.]+/)) {
            if (part.length > 2 && !stop.has(part))
                bag.add(part);
        }
    }
    return bag;
}
/** Jaccard similarity between two token bags. 0..1 */
export function similarity(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let inter = 0;
    for (const t of a)
        if (b.has(t))
            inter++;
    return inter / (a.size + b.size - inter);
}
