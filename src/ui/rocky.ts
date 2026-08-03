/**
 * Rocky's face and voice.
 *
 * Speech rules (from the book):
 *  - questions end with ", question" — never "?"
 *  - emphasis by repetition: "good good good", "bad bad"
 *  - no articles, short sentences, present tense
 *  - he is blind; he never says "I see". He hears, he remembers, he checks.
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const amber = (s: string) => (useColor ? `\u001b[33m${s}\u001b[0m` : s);
const dim = (s: string) => (useColor ? `\u001b[2m${s}\u001b[0m` : s);
const bold = (s: string) => (useColor ? `\u001b[1m${s}\u001b[0m` : s);

/**
 * Rocky, seen from the front: pentagonal carapace, five radial legs,
 * breathing slits on top, no face. He hangs from the ceiling of his
 * habitat tunnel, as Eridians do.
 */
const FACE = [
  "  ═╦═══════╦═ ",
  "   ║ ┌───┐ ║  ",
  "   ╲_││││││_╱  ",
  "   ╱ ╲▔▔▔╱ ╲  ",
  "  ╱ ╱ ╲_╱ ╲ ╲ ",
];

export function face(): string {
  return FACE.map((l) => amber(l)).join("\n");
}

/** One Rocky line, prefixed. */
export function say(msg: string): void {
  process.stderr.write(`${amber("[Rocky]")} ${msg}\n`);
}

/** Rocky line without trailing newline context — for multi-line blocks. */
export function block(lines: string[]): void {
  for (const l of lines) process.stderr.write(`${amber("♫")} ${l}\n`);
}

export function heading(msg: string): void {
  process.stderr.write(`\n${bold(msg)}\n`);
}

export function detail(msg: string): void {
  process.stderr.write(`${dim(msg)}\n`);
}

/** "84 days ago", "3 hours ago", "just now" — Rocky counts precisely. */
export function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}
